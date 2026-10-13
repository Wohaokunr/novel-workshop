import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentMemory, AgentRole, EvidenceSource, SearchChunk } from '../../shared/agent-types.js';
import type { Change, NarrativeScene, Passage, RunRequest, Workspace } from '../../shared/types.js';
import { diffText } from '../../shared/text-diff.js';
import { styleProfile } from '../../shared/style-types.js';
import { chapterPassages, chapterTarget, orderedChapters, orderedPassages, proseChars } from '../../shared/structure.js';
import { labelledAspects, storyTimeline } from '../../shared/story-state.js';
import { buildCharacterContext, buildReaderContext, resolveReferences } from '../context.js';
import { cardContent, DomainValidationError } from '../domain.js';
import { canReadAuthor, isRole } from './policy.js';
import type { SemanticHit } from './semantic.js';
import { passageMentions, searchChunks, storyIndex } from './story-index.js';
import { storyOverview, StoryView } from './story-view.js';

export const MAX_CONTEXT_CHARS = 32_000;
export const MAX_SEARCH_RESULTS = 12;
export const MAX_SEARCH_CHUNK_CHARS = 1200;
export interface ContextAnchor { passageId?: string; chapterId?: string; characterId?: string; eventId?: string }

/** Canonical JSON-compatible data; object key order is immaterial, array order is meaningful.
 * Unsupported values and cycles fail closed rather than producing ambiguous evidence hashes. */
function canonical(value: unknown, parents = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('证据哈希不接受非有限数字');
    return JSON.stringify(value);
  }
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') throw new TypeError('证据哈希只接受可序列化数据');
  if (parents.has(value)) throw new TypeError('证据哈希不接受循环引用');
  parents.add(value);
  let result: string;
  if (Array.isArray(value)) result = `[${Array.from(value, item => canonical(item, parents)).join(',')}]`;
  else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('证据哈希只接受普通对象');
    result = `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], parents)}`).join(',')}}`;
  }
  parents.delete(value);
  return result;
}
export function fingerprint(value: unknown): string { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }

const entities = {
  objectType: 'objectTypes', object: 'objects', act: 'acts', chapter: 'chapters', scene: 'scenes', passage: 'passages', fact: 'facts',
  knowledge: 'knowledge', stateChange: 'stateChanges', card: 'cards', canvasLink: 'canvasLinks',
} as const;
function novel(workspace: Workspace) {
  return { title: workspace.title, brief: workspace.brief, genre: workspace.genre, audience: workspace.audience, theme: workspace.theme ?? '',
    logline: workspace.logline ?? '', structureTemplate: workspace.structureTemplate ?? '' };
}
function semanticProject(workspace: Workspace) {
  return { ...novel(workspace), chapterTarget: workspace.chapterTarget ?? null, objectTypes: workspace.objectTypes, objects: workspace.objects, acts: workspace.acts ?? [],
    chapters: workspace.chapters, scenes: workspace.scenes, passages: workspace.passages, facts: workspace.facts, knowledge: workspace.knowledge,
    stateChanges: workspace.stateChanges, cards: workspace.cards.map(cardContent), canvasLinks: workspace.canvasLinks, style: styleProfile(workspace) };
}
function sourceValue(workspace: Workspace, kind: string, id: string): unknown {
  if (kind === 'project') return id === workspace.id ? semanticProject(workspace) : undefined;
  if (kind === 'novel') return id === workspace.id ? novel(workspace) : undefined;
  if (kind === 'novel:title') return id === workspace.id ? workspace.title : undefined;
  if (kind === 'novel:theme') return id === workspace.id ? workspace.theme ?? '' : undefined;
  if (kind === 'style') return id === workspace.id ? styleProfile(workspace) : undefined;
  if (kind === 'passage:text') return workspace.passages.find(item => item.id === id)?.text;
  if (kind === 'scene:outline') return workspace.scenes.find(item => item.id === id)?.outline;
  if (kind === 'knowledge:content') return workspace.knowledge.find(item => item.id === id)?.content;
  if (kind === 'chapter:title') return workspace.chapters.find(item => item.id === id)?.title;
  if (kind === 'object:selfKnowledge') {
    const object = workspace.objects.find(item => item.id === id && item.typeId === 'character');
    return object ? { name: object.name, selfKnowledge: typeof object.fields.selfKnowledge === 'string' ? object.fields.selfKnowledge : '' } : undefined;
  }
  if (kind.startsWith('event:observation:')) {
    const event = workspace.objects.find(item => item.id === id && item.typeId === 'event')?.event;
    return event ? event.observations[kind.slice('event:observation:'.length)] ?? '' : undefined;
  }
  if (kind === 'event:time') {
    const event = workspace.objects.find(item => item.id === id && item.typeId === 'event');
    return event?.event ? { id: event.id, name: event.name, worldOrder: event.event.worldOrder } : undefined;
  }
  if (kind === 'stateChange:character') {
    // The change as the character lives it: the author's note explains it and is left out.
    const change = workspace.stateChanges.find(item => item.id === id);
    if (!change) return undefined;
    const { note: _note, ...rest } = change;
    return rest;
  }
  if (Object.hasOwn(entities, kind)) {
    const collection = entities[kind as keyof typeof entities];
    const item = (workspace[collection] ?? []).find(item => item.id === id);
    return collection === 'cards' && item ? cardContent(item as Workspace['cards'][number]) : item;
  }
  return undefined;
}

/** Projection kinds deliberately distinguish reader text / character knowledge from author records. */
export function sourceFor(workspace: Workspace, kind: string, id: string): EvidenceSource | undefined {
  const value = sourceValue(workspace, kind, id);
  return value === undefined ? undefined : { projectId: workspace.id, kind, id, hash: fingerprint({ projectId: workspace.id, kind, id, value }) };
}
export function sourcesForWorkspace(workspace: Workspace): EvidenceSource[] {
  return [sourceFor(workspace, 'project', workspace.id)!, sourceFor(workspace, 'novel', workspace.id)!,
    ...Object.entries(entities).flatMap(([kind, collection]) => (workspace[collection] ?? []).map(item => sourceFor(workspace, kind, item.id)!))];
}
const bookSourceCache = new WeakMap<Workspace, EvidenceSource[]>();
/** Whole-book provenance in two fingerprints (the semantic project and the novel fields): any edit to the book invalidates it.
 * Memoized per snapshot object, since hashing the project reads all the prose. */
export function bookSources(workspace: Workspace): EvidenceSource[] {
  let sources = bookSourceCache.get(workspace);
  if (!sources) bookSourceCache.set(workspace, sources = [sourceFor(workspace, 'project', workspace.id)!, sourceFor(workspace, 'novel', workspace.id)!]);
  return sources;
}
const kindOfCollection = new Map<string, string>(Object.entries(entities).map(([kind, collection]) => [collection, kind]));
/** Evidence for a candidate: the book fingerprint plus the base version of every existing entity it changes. */
export function changeSources(workspace: Workspace, changes: Change[]): EvidenceSource[] {
  const touched = changes.flatMap(change => {
    const kind = change.collection === 'metadata' ? 'novel' : change.collection === 'style' ? 'style' : kindOfCollection.get(change.collection);
    const source = kind ? sourceFor(workspace, kind, kind === 'novel' || kind === 'style' ? workspace.id : change.key) : undefined;
    return source ? [source] : [];
  });
  return [...new Map([...bookSources(workspace), ...touched].map(source => [`${source.kind}\u0000${source.id}`, source])).values()];
}
export function sourceValid(workspace: Workspace, source: EvidenceSource): boolean {
  if (!source || source.projectId !== workspace.id || typeof source.kind !== 'string' || typeof source.id !== 'string') return false;
  const current = sourceFor(workspace, source.kind, source.id);
  if (!current || current.hash !== source.hash) return false;
  if (source.start !== undefined || source.end !== undefined) {
    if (!Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end) || source.start! < 0 || source.end! < source.start!) return false;
    const value = sourceValue(workspace, source.kind, source.id);
    const text = typeof value === 'string' ? value : canonical(value);
    if (source.end! > text.length) return false;
  }
  return true;
}

/** Translate the established context builders' labels without splitting entity IDs on colons. */
export function sourcesForLabels(workspace: Workspace, labels: string[], role: AgentRole = 'coordinator'): EvidenceSource[] {
  const wanted = new Set(labels), found: EvidenceSource[] = [];
  const add = (label: string, kind: string, id: string) => {
    if (wanted.has(label)) { const source = sourceFor(workspace, kind, id); if (source) found.push(source); }
  };
  if (canReadAuthor(role)) { add('novel:theme', 'novel:theme', workspace.id); add(`project:${workspace.id}@${workspace.revision}`, 'project', workspace.id); }
  add('style', 'style', workspace.id);
  if (canReadAuthor(role)) for (const scene of workspace.scenes) { add(`scene:${scene.id}`, 'scene', scene.id); add(`scene:${scene.id}:outline`, 'scene:outline', scene.id); }
  for (const passage of workspace.passages) {
    if (canReadAuthor(role)) add(`passage:${passage.id}`, 'passage', passage.id);
    if (role !== 'character') add(`passage:${passage.id}:text`, 'passage:text', passage.id);
  }
  for (const object of workspace.objects) {
    if (canReadAuthor(role)) add(`object:${object.id}`, 'object', object.id);
    if (role !== 'reader') add(`object:${object.id}:selfKnowledge`, 'object:selfKnowledge', object.id);
    if (object.event && role !== 'reader') for (const characterId of Object.keys(object.event.observations)) {
      add(`event:${object.id}:observations:${characterId}`, `event:observation:${characterId}`, object.id);
    }
  }
  if (role !== 'reader') for (const item of workspace.knowledge) add(`knowledge:${item.id}`, 'knowledge', item.id);
  if (role !== 'reader') for (const change of workspace.stateChanges) add(`stateChange:${change.id}`, role === 'character' ? 'stateChange:character' : 'stateChange', change.id);
  if (canReadAuthor(role)) {
    for (const fact of workspace.facts) add(`fact:${fact.id}`, 'fact', fact.id);
    for (const card of workspace.cards) add(`card:${card.id}`, 'card', card.id);
  }
  return [...new Map(found.map(source => [JSON.stringify([source.kind, source.id]), source])).values()];
}

interface SearchDocument { source: EvidenceSource; title: string; text: string }
export interface SearchFilter { chapterFrom?: string | null; chapterTo?: string | null; entityId?: string | null }
function readerPassages(workspace: Workspace, anchor: ContextAnchor): Set<string> {
  const passage = anchor.passageId ? workspace.passages.find(item => item.id === anchor.passageId) : undefined;
  if (anchor.passageId && !passage) throw new DomainValidationError('阅读目标场景段不存在');
  const chapterId = anchor.chapterId ?? passage?.chapterId ?? orderedChapters(workspace).at(-1)?.id;
  if (!chapterId) return new Set();
  const visible = new Set(buildReaderContext(workspace, chapterId, anchor.passageId).sources);
  return new Set(workspace.passages.filter(item => visible.has(`passage:${item.id}:text`)).map(item => item.id));
}
function characterDocuments(workspace: Workspace, anchor: ContextAnchor): SearchDocument[] {
  if (!anchor.characterId || !anchor.eventId) throw new DomainValidationError('人物检索需要明确人物和当前事件，不能退回作者上下文');
  const context = buildCharacterContext(workspace, anchor.characterId, anchor.eventId);
  const result: SearchDocument[] = [{ source: sourceFor(workspace, 'object:selfKnowledge', context.characterId)!, title: context.name,
    text: canonical(sourceValue(workspace, 'object:selfKnowledge', context.characterId)) },
  { source: sourceFor(workspace, `event:observation:${context.characterId}`, context.eventId)!, title: '当场亲见亲闻', text: context.perception },
  ...context.memories.map(memory => ({ source: sourceFor(workspace, 'knowledge:content', memory.id)!, title: `${context.name}的已获知记忆`, text: memory.content }))];
  // The state the plot has left the character in, one document per change it comes from.
  const held = new Map<string, Record<string, string>>();
  for (const item of storyTimeline(workspace).stateAt(context.characterId, { eventId: context.eventId }).values()) {
    held.set(item.change.id, { ...held.get(item.change.id), [item.label]: item.value });
  }
  for (const [id, state] of held) result.push({ source: sourceFor(workspace, 'stateChange:character', id)!, title: '此前的心理、视角与认知', text: canonical(state) });
  return result;
}
/** Author records except prose, which the story index serves chunk-wise. A passage filter keeps only the outlines of their scenes. */
function authorDocuments(workspace: Workspace, passages?: Set<string>): SearchDocument[] {
  const result: SearchDocument[] = passages ? [] : [{ source: sourceFor(workspace, 'novel', workspace.id)!, title: workspace.title, text: canonical(novel(workspace)) }];
  const scenes = passages && new Set(workspace.passages.filter(passage => passages.has(passage.id)).map(passage => passage.sceneId));
  for (const [kind, collection] of Object.entries(entities)) for (const item of workspace[collection] ?? []) {
    if (kind === 'scene') {
      const scene = item as NarrativeScene;
      if (!scenes || scenes.has(scene.id)) result.push({ source: sourceFor(workspace, 'scene:outline', scene.id)!, title: scene.title, text: scene.outline });
    } else if (kind === 'stateChange') {
      const change = item as Workspace['stateChanges'][number];
      if (!scenes || (change.sceneId && scenes.has(change.sceneId))) result.push({ source: sourceFor(workspace, kind, change.id)!,
        title: `${workspace.objects.find(object => object.id === change.subjectId)?.name ?? ''}的变化`, text: canonical({ ...labelledAspects(change.aspects), ...(change.note ? { note: change.note } : {}) }) });
    } else if (!scenes && kind !== 'passage') {
      const fields = item as unknown as { name?: string; title?: string; key?: string; content?: string };
      result.push({ source: sourceFor(workspace, kind, item.id)!, title: fields.name ?? fields.title ?? fields.key ?? kind, text: canonical(sourceValue(workspace, kind, item.id)) });
    }
  }
  return result;
}
/** Passages in a chapter range, and when an entity is given, those that mention it or whose scene puts it on stage or changes it. */
export function filteredPassages(workspace: Workspace, filter: SearchFilter): Set<string> | undefined {
  if (!filter.chapterFrom && !filter.chapterTo && !filter.entityId) return undefined;
  const chapters = orderedChapters(workspace);
  const from = filter.chapterFrom ? chapters.findIndex(chapter => chapter.id === filter.chapterFrom) : 0;
  const to = filter.chapterTo ? chapters.findIndex(chapter => chapter.id === filter.chapterTo) : chapters.length - 1;
  if (from < 0 || to < 0) throw new DomainValidationError('检索章节范围不存在');
  const entityId = filter.entityId;
  if (entityId && !workspace.objects.some(object => object.id === entityId)) throw new DomainValidationError('检索对象不存在');
  const range = new Set(chapters.slice(Math.min(from, to), Math.max(from, to) + 1).map(chapter => chapter.id));
  const index = storyIndex(workspace), scenes = new Map(workspace.scenes.map(scene => [scene.id, scene]));
  const onStage = (passage: Passage) => {
    const scene = scenes.get(passage.sceneId);
    return !!scene && (scene.povId === entityId || scene.eventIds.includes(entityId!) || !!scene.castIds?.includes(entityId!) || !!scene.settingIds?.includes(entityId!)
      || workspace.stateChanges.some(change => change.subjectId === entityId && change.sceneId === scene.id && (!change.passageId || change.passageId === passage.id)));
  };
  return new Set(workspace.passages.filter(passage => range.has(passage.chapterId) && (!entityId || passageMentions(index, passage.id).has(entityId) || onStage(passage)))
    .map(passage => passage.id));
}
function queryTerms(query: string): string[] {
  const terms = new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? []);
  for (const run of query.match(/\p{Script=Han}+/gu) ?? []) {
    const letters = Array.from(run);
    if (letters.length === 1) terms.add(run);
    for (let index = 0; index < letters.length - 1; index++) terms.add(letters[index]! + letters[index + 1]!);
  }
  return [...terms].slice(0, 128);
}

/** Filter the corpus before matching. Query words never grant access to an author or future document.
 * Prose comes from the paragraph-chunk index (BM25, at most two chunks per passage); small records are scored directly.
 * `semantic`: chunks nearest in meaning (optional vector index); they join the prose results and lift keyword hits they overlap. */
export function searchContext(workspace: Workspace, query: string, limit = 6, role: AgentRole = 'coordinator', anchor: ContextAnchor = {}, filter: SearchFilter = {},
  semantic: SemanticHit[] = [], filtered?: Set<string>): SearchChunk[] {
  if (!isRole(role)) throw new DomainValidationError('检索角色无效');
  // filtered: filteredPassages(workspace, filter) when the caller has already worked it out.
  const scoped = role === 'reader' || role === 'character' ? undefined : filtered ?? filteredPassages(workspace, filter);
  const allowed = role === 'reader' ? readerPassages(workspace, anchor) : role === 'character' ? new Set<string>() : scoped;
  const documents = role === 'reader' ? [] : role === 'character' ? characterDocuments(workspace, anchor) : authorDocuments(workspace, scoped);
  if (typeof query !== 'string' || !query.trim()) return [];
  const requested = Number.isFinite(limit) ? Math.max(0, Math.min(MAX_SEARCH_RESULTS, Math.floor(limit))) : 6;
  if (!requested) return [];
  const needle = query.trim().slice(0, 256).toLowerCase(), terms = queryTerms(needle);
  const strictPhrase = /^\p{Script=Han}{4,}$/u.test(needle);
  const matches: Array<SearchChunk & { index: number }> = [];
  for (const [index, document] of documents.entries()) {
    const title = document.title.toLowerCase(), text = document.text.toLowerCase();
    let score = (title.includes(needle) ? 20 : 0) + (text.includes(needle) ? 12 : 0);
    let position = text.indexOf(needle), matchedTerms = 0;
    for (const term of terms) {
      if (title.includes(term) || text.includes(term)) matchedTerms++;
      if (title.includes(term)) score += 4;
      const at = text.indexOf(term);
      if (at >= 0) { score += 1; if (position < 0 || at < position) position = at; }
    }
    if (!score || !document.text.trim() || (strictPhrase && !title.includes(needle) && !text.includes(needle) && matchedTerms < 2)) continue;
    // Use raw source offsets even when case conversion changes code-unit lengths.
    const start = Math.max(0, Math.min(document.text.length, position < 0 ? 0 : position) - 160);
    const end = Math.min(document.text.length, start + MAX_SEARCH_CHUNK_CHARS);
    matches.push({ source: { ...document.source, start, end }, title: document.title.slice(0, 160), text: document.text.slice(start, end), score, index });
  }
  if (!allowed || allowed.size) {
    const view = new StoryView(workspace), chapterTitles = new Map(workspace.chapters.map(chapter => [chapter.id, chapter.title]));
    // Scene titles are author material; readers see the chapter heading instead.
    const titleOf = (passage: Passage) => role === 'reader' ? chapterTitles.get(passage.chapterId) ?? '' : view.label(passage.id);
    for (const hit of searchChunks(view.index, workspace, needle, { allowed, limit: requested * 3, perPassage: 2 })) {
      const passage = view.passage(hit.passageId)!;
      const title = titleOf(passage), lower = title.toLowerCase();
      if (strictPhrase && !lower.includes(needle) && !hit.containsNeedle && hit.matchedTerms < 2) continue;
      const score = (lower.includes(needle) ? 20 : 0) + (hit.containsNeedle ? 12 : 0) + terms.filter(term => lower.includes(term)).length * 4 + hit.matchedTerms + hit.score * 2;
      const end = Math.min(hit.end, hit.start + MAX_SEARCH_CHUNK_CHARS);
      matches.push({ source: { ...sourceFor(workspace, 'passage:text', passage.id)!, start: hit.start, end }, title: title.slice(0, 160),
        text: passage.text.slice(hit.start, end), score, index: documents.length + view.positionOf(passage.id) });
    }
    for (const hit of semantic) {
      const passage = view.passage(hit.passageId);
      if (!passage || (allowed && !allowed.has(passage.id))) continue;
      const source = sourceFor(workspace, 'passage:text', passage.id)!;
      const overlapping = matches.find(match => match.source.kind === source.kind && match.source.id === passage.id && match.source.start! < hit.end && hit.start < match.source.end!);
      if (overlapping) { overlapping.score += hit.similarity * 10; continue; }
      const title = titleOf(passage), end = Math.min(hit.end, hit.start + MAX_SEARCH_CHUNK_CHARS);
      matches.push({ source: { ...source, start: hit.start, end }, title: title.slice(0, 160), text: passage.text.slice(hit.start, end), score: hit.similarity * 30,
        index: documents.length + view.positionOf(passage.id) });
    }
  }
  return matches.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, requested).map(({ index: _index, ...chunk }) => chunk);
}

/** A shared output cap for model context, with explicit omission paths instead of silent whole-book truncation. */
export function boundedContext(context: Record<string, unknown>, maxChars = MAX_CONTEXT_CHARS, priority: string[] = []): Record<string, unknown> {
  // MAX_CONTEXT_CHARS is the default; the writer asks for more room on purpose (WRITER_CONTEXT_CHARS).
  const cap = Math.max(2000, Math.floor(maxChars));
  let remaining = cap - 1800, omittedCount = 0;
  const paths: string[] = [];
  const omit = (path: string) => { omittedCount++; if (paths.length < 12) paths.push(path.slice(0, 100)); };
  const clip = (value: unknown, path: string, depth: number): unknown => {
    if (value === undefined) return undefined;
    if (remaining < 32 || depth > 12) { omit(path); return undefined; }
    if (typeof value === 'string') {
      let result = value;
      if (JSON.stringify(result).length > remaining) {
        let low = 0, high = Math.min(result.length, remaining);
        while (low < high) { const middle = Math.ceil((low + high) / 2); if (JSON.stringify(result.slice(0, middle)).length <= remaining - 20) low = middle; else high = middle - 1; }
        result = result.slice(0, low) + '（其余内容已省略）'; omit(path);
      }
      remaining -= JSON.stringify(result).length;
      return result;
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') { remaining -= JSON.stringify(value).length; return value; }
    if (Array.isArray(value)) {
      remaining -= 2;
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        if (index >= 80 || remaining < 64) { omit(`${path}[${index}…${value.length - 1}]`); break; }
        remaining--; const item = clip(value[index], `${path}[${index}]`, depth + 1); if (item !== undefined) result.push(item);
      }
      return result;
    }
    if (typeof value === 'object') {
      remaining -= 2;
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        const overhead = JSON.stringify(key).length + 2;
        if (remaining < overhead + 32) { omit(`${path}.${key}`); continue; }
        remaining -= overhead;
        const clipped = clip(item, `${path}.${key}`, depth + 1);
        if (clipped !== undefined) Object.defineProperty(result, key, { value: clipped, enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
    omit(path); return undefined;
  };
  // Priority keys get the budget first, but output keeps the declared order so stable material stays a cacheable prefix.
  const ordered = [...priority.filter(key => Object.hasOwn(context, key)), ...Object.keys(context).filter(key => !priority.includes(key))];
  const clipped = clip(Object.fromEntries(ordered.map(key => [key, context[key]])), 'context', 0) as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(context)) if (Object.hasOwn(clipped, key)) Object.defineProperty(result, key, { value: clipped[key], enumerable: true, writable: true, configurable: true });
  result.contextOmissions = { limited: omittedCount > 0, omittedCount, paths, maxChars: cap, notice: '仅提供有界上下文。被省略的材料不是不存在；需要时按角色权限检索原文。' };
  return result;
}

export function refreshMemories(workspace: Workspace, memories: AgentMemory[]): AgentMemory[] {
  return memories.map(memory => {
    const refreshed = structuredClone(memory);
    const invalidSources = memory.projectId !== workspace.id || memory.sources.some(source => !sourceValid(workspace, source));
    const unsupportedAuthorRule = (memory.kind === 'preference' || memory.kind === 'constraint') && !memory.sources.length
      && (!memory.confirmed || !memory.sourceMessageId?.trim());
    if (invalidSources || (memory.status === 'active' && unsupportedAuthorRule)) {
      refreshed.status = 'stale';
      if (memory.status !== 'stale') refreshed.updatedAt = new Date().toISOString();
    }
    return refreshed;
  });
}

/** Character budget for confirmed author rules in any context; a fixed count silently dropped the oldest rules. */
export const AUTHOR_RULES_CHARS = 6000;
const AUTHOR_RULE_CHARS = 1000;
/** Active, confirmed preferences and constraints: constraints first, then newest first (the store's order), within a character budget. */
export function selectAuthorRules(memories: AgentMemory[], maxChars = AUTHOR_RULES_CHARS): { rules: AgentMemory[]; omitted: number } {
  const active = memories.filter(memory => memory.status === 'active' && memory.confirmed && (memory.kind === 'constraint' || memory.kind === 'preference'));
  const ordered = [...active.filter(memory => memory.kind === 'constraint'), ...active.filter(memory => memory.kind === 'preference')];
  const rules: AgentMemory[] = [];
  let remaining = maxChars;
  for (const memory of ordered) {
    const content = memory.content.length > AUTHOR_RULE_CHARS ? `${memory.content.slice(0, AUTHOR_RULE_CHARS)}…` : memory.content;
    if (content.length > remaining) continue;
    remaining -= content.length; rules.push({ ...memory, content });
  }
  return { rules, omitted: ordered.length - rules.length };
}

/** Coordinator overview: small catalogs centred on the target + layered story memory, never JSON.stringify(the entire book). */
export function collectContext(workspace: Workspace, request: RunRequest, memories: AgentMemory[], story?: StoryView): unknown {
  if (workspace.id !== request.projectId) throw new DomainValidationError('上下文项目与任务不匹配');
  const materials = resolveReferences(workspace, request.references);
  const active = refreshMemories(workspace, memories).filter(memory => memory.projectId === workspace.id && memory.status === 'active');
  const take = <T>(items: T[], limit: number) => items.slice(0, limit);
  const authorRules = selectAuthorRules(active);
  const view = story ?? new StoryView(workspace);
  const passagesOf = (scene: NarrativeScene) => view.scenePassages(scene.id);
  const briefPassage = (passage: Passage) => ({ id: passage.id, chapterId: passage.chapterId, order: passage.order, ...(passage.beat ? { beat: passage.beat.slice(0, 300) } : {}), writtenChars: proseChars(passage.text) });
  const briefScene = (scene: NarrativeScene) => ({ id: scene.id, title: scene.title, povId: scene.povId, castIds: scene.castIds ?? [], settingIds: scene.settingIds ?? [],
    eventIds: scene.eventIds, outline: scene.outline.slice(0, 1000), passages: passagesOf(scene).map(briefPassage),
    omitted: { outlineChars: Math.max(0, scene.outline.length - 1000) } });
  const targetPassage = (passage: Passage) => ({ id: passage.id, sceneId: passage.sceneId, scene: view.label(passage.id), chapterId: passage.chapterId, order: passage.order,
    beat: passage.beat ?? '', text: passage.text.slice(0, 1800), omitted: { textChars: Math.max(0, passage.text.length - 1800) } });
  const selected = request.passageId ? workspace.passages.find(passage => passage.id === request.passageId) : undefined;
  const scoped = selected ? [selected] : request.chapterId ? chapterPassages(workspace, request.chapterId) : [];
  const firstPassage = (scene: NarrativeScene) => passagesOf(scene)[0];
  const anchorChapter = selected?.chapterId ?? request.chapterId ?? materials.scenes.map(firstPassage).find(Boolean)?.chapterId;
  const focus = view.focusChapters(anchorChapter, 10);
  const near = new Set(focus.near.map(chapter => chapter.id));
  // Scenes read in the chapters around the target, then scenes not placed in any chapter yet.
  const placed = new Set(workspace.passages.map(passage => passage.sceneId));
  const nearScenes = [...new Set(view.order.filter(passage => near.has(passage.chapterId)).map(passage => passage.sceneId))]
    .flatMap(id => { const scene = view.scene(id); return scene ? [scene] : []; });
  const unplaced = workspace.scenes.filter(scene => !placed.has(scene.id));
  // Objects tied to the target first, then those the prose mentions most: a long book's cast is not "the first 60 created".
  const counts = view.mentionCounts(), focusIds = new Set<string>();
  const targetScenes = [...new Set(scoped.map(passage => passage.sceneId))].flatMap(id => { const scene = view.scene(id); return scene ? [scene] : []; });
  for (const scene of [...targetScenes, ...materials.scenes]) {
    if (scene.povId) focusIds.add(scene.povId);
    for (const id of [...scene.eventIds, ...(scene.castIds ?? []), ...(scene.settingIds ?? [])]) focusIds.add(id);
    for (const passage of passagesOf(scene)) for (const id of passageMentions(view.index, passage.id).keys()) focusIds.add(id);
  }
  for (const object of materials.objects) focusIds.add(object.id);
  const objects = [...workspace.objects].sort((a, b) => Number(focusIds.has(b.id)) - Number(focusIds.has(a.id)) || (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
  const chapterBrief = (chapter: Workspace['chapters'][number]) => ({ ...chapter, ...(chapter.summary ? { summary: chapter.summary.slice(0, 200) } : {}), writtenChars: chapterPassages(workspace, chapter.id).reduce((sum, passage) => sum + proseChars(passage.text), 0) });
  const catalogScenes = [...nearScenes, ...unplaced];
  return boundedContext({
    project: { id: workspace.id, revision: workspace.revision, ...novel(workspace), chapterTarget: chapterTarget(workspace) },
    scope: { stage: request.stage, tool: request.tool, passageId: request.passageId, chapterId: request.chapterId, selection: request.selection,
      references: request.references ?? [], referencesAreWriteAuthorization: false,
      writeRule: request.stage === 'rewrite' ? '只允许目标场景段的正文选区；保护前后缀，不附带任何设定修改。' : request.stage === 'chapter' ? '只写目标章节/场景段中空白的场景段；保护正式正文；状态变化只能记在目标场景段所属的场景上。' : '可提出项目领域修改候选；必须经校验/审阅/作者批准，AI 不移动人工布局。',
      structure: '卷（acts）由连续的章组成；章（chapters）是一次连载更新，约 chapterTarget 字；场景（scenes）独立于章，一个场景可以跨越几章；场景段（passages）是一个场景在一章里的正文，正文按章、再按场景段的顺序阅读；状态变化（stateChanges）记录人物与环境在某个场景（段）里的变化。' },
    confirmedAuthorRules: authorRules.rules.map(memory => ({ id: memory.id, kind: memory.kind, content: memory.content, sourceMessageId: memory.sourceMessageId, sources: memory.sources.slice(0, 8) })),
    storyMemory: storyOverview(view, anchorChapter),
    targetPassages: take(scoped, 12).map(targetPassage),
    targetScenes: take(targetScenes, 12).map(briefScene),
    materials: { cards: take(materials.cards, 12).map(card => ({ ...cardContent(card), content: card.content.slice(0, 1200) })),
      objects: take(materials.objects, 12), scenes: take(materials.scenes, 12).map(briefScene) },
    catalog: { objectTypes: take(workspace.objectTypes, 12), objects: take(objects, 60).map(object => ({ id: object.id, typeId: object.typeId, name: object.name, worldOrder: object.event?.worldOrder, mentions: counts.get(object.id) ?? 0 })),
      acts: take(workspace.acts ?? [], 20).map(act => ({ id: act.id, title: act.title, order: act.order, purpose: act.purpose.slice(0, 200) })),
      chapters: focus.near.map(chapterBrief), chapterSkeleton: focus.skeleton.map(chapter => ({ id: chapter.id, title: chapter.title, order: chapter.order, ...(chapter.actId ? { actId: chapter.actId } : {}) })),
      scenes: take(catalogScenes, 60).map(scene => ({ id: scene.id, title: scene.title, povId: scene.povId, castIds: scene.castIds ?? [], settingIds: scene.settingIds ?? [], eventIds: scene.eventIds,
        passages: passagesOf(scene).filter(passage => near.has(passage.chapterId)).map(briefPassage), ...(placed.has(scene.id) ? {} : { unplaced: true }) })),
      cards: take(workspace.cards, 40).map(card => ({ id: card.id, kind: card.kind, refId: card.refId, title: card.title })) },
    advisoryMemories: take(active.filter(memory => memory.kind === 'summary' || memory.kind === 'experience'), 6).map(memory => ({
      id: memory.id, kind: memory.kind, content: memory.content.slice(0, 700), formalTruth: false, notice: '摘要/经验仅是辅助，正式事实以仍有效的原始正文与领域记录为准。' })),
    omitted: { materialCards: Math.max(0, materials.cards.length - 12), materialObjects: Math.max(0, materials.objects.length - 12), materialScenes: Math.max(0, materials.scenes.length - 12),
      catalogObjects: Math.max(0, workspace.objects.length - 60), catalogScenes: Math.max(0, workspace.scenes.length - Math.min(60, catalogScenes.length)),
      catalogChapters: focus.omitted, authorRules: authorRules.omitted,
      unselectedPassageBodies: workspace.passages.filter(passage => !scoped.includes(passage)).length,
      notice: '非选定场景段的正文未载入；目录以目标章节为中心，其余章节只给骨架。逐层放大：read_story_memory 看章节/场景段摘要或人物时间线，search_context 检索片段，read_text 读原文窗口，read_entities 读 stateChanges 等记录。' },
  }, MAX_CONTEXT_CHARS, ['project', 'scope', 'confirmedAuthorRules', 'targetPassages', 'targetScenes', 'materials', 'storyMemory']);
}

const DIFF_EXCERPT_CHARS = 1500, FIELD_CHARS = 300;
function clipValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length > FIELD_CHARS ? `${value.slice(0, FIELD_CHARS)}…（共 ${value.length} 字）` : value;
  if (Array.isArray(value)) return value.length > 20 ? [...value.slice(0, 20).map(clipValue), `…共 ${value.length} 项`] : value.map(clipValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipValue(item)]));
  return value;
}
/** Changed text as `[-删除-]{+新增+}` with a little surrounding context. */
function textChange(before: string, after: string) {
  let excerpt = '';
  for (const part of diffText(before, after)) {
    if (excerpt.length >= DIFF_EXCERPT_CHARS) { excerpt += '…'; break; }
    excerpt += part.kind === 'same' ? (part.text.length > 60 ? `${part.text.slice(0, 30)}…${part.text.slice(-30)}` : part.text)
      : part.kind === 'add' ? `{+${part.text}+}` : `[-${part.text}-]`;
  }
  return { beforeChars: before.length, afterChars: after.length, diff: excerpt.slice(0, DIFF_EXCERPT_CHARS + 1) };
}
/** Field-level change summary for tool results; the full before/after would be replayed on every later turn. */
export function compactChanges(changes: Change[]): unknown[] {
  return changes.map(({ collection, key, before, after }) => {
    const op = before === undefined ? 'create' : after === undefined ? 'delete' : 'update';
    if (op !== 'update' || typeof before !== 'object' || typeof after !== 'object' || !before || !after) {
      if (typeof before === 'string' && typeof after === 'string') return { collection, key, op, ...(before.length + after.length > FIELD_CHARS ? textChange(before, after) : { before, after }) };
      return { collection, key, op, value: clipValue(after ?? before) };
    }
    const fields: Record<string, unknown> = {};
    const left = before as Record<string, unknown>, right = after as Record<string, unknown>;
    for (const field of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (isDeepStrictEqual(left[field], right[field])) continue;
      fields[field] = typeof left[field] === 'string' && typeof right[field] === 'string' && String(left[field]).length + String(right[field]).length > FIELD_CHARS
        ? textChange(String(left[field]), String(right[field])) : { before: clipValue(left[field]), after: clipValue(right[field]) };
    }
    return { collection, key, op, fields };
  });
}
