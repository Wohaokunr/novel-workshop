import { randomUUID } from 'node:crypto';
import type { AgentEvent, ProviderSecret, Workspace } from '../../shared/types.js';
import type {
  CompanionAdoptRequest, CompanionAdoptResult, CompanionAskRequest, CompanionIdea, CompanionMode, CompanionOp, CompanionProposal,
  CompanionResponse, CompanionThread, CompanionTurn,
} from '../../shared/companion-types.js';
import { companionModeNames } from '../../shared/companion-types.js';
import { companionCommands, selectCompanionItems } from '../../shared/companion.js';
import { outlineTemplate } from '../../shared/outline-templates.js';
import { storyGaps } from '../../shared/story-flow.js';
import { companionNovelFields } from '../../shared/companion-types.js';
import { NovelStore } from '../store.js';
import { resolveReferences, sceneState } from '../context.js';
import { applyCommands, DomainValidationError } from '../domain.js';
import { addUsage, emptyUsage, objectSchema, runAgent, type JsonSchema, type ResponseTransport } from '../responses.js';
import { boundedContext, refreshMemories, selectAuthorRules } from './memory.js';
import { passageMentions } from './story-index.js';
import { entityRecall, openThreads, storyOverview, StoryView } from './story-view.js';
import { personNames, scaleNames, styleProfile } from '../../shared/style-types.js';
import { elementNames, isSettingLike, objectNames, sceneElements } from '../../shared/story-elements.js';
import { styleFingerprint } from '../../shared/style-metrics.js';
import { chapterTarget, proseChars } from '../../shared/structure.js';
import { companionCommonPrompt, companionIntensityPrompts, companionModePrompts } from '../prompts/companion.js';

const MODES: CompanionMode[] = ['diverge', 'causality', 'structure', 'outline', 'beat', 'develop', 'style'];
const HISTORY_TURNS = 12;
/** Characters of earlier decisions (author messages and adopted items before the history window) kept in context. */
const DECISION_LOG_CHARS = 3000;
const string: JsonSchema = { type: 'string' };
const nullableString: JsonSchema = { type: ['string', 'null'] };
const strings: JsonSchema = { type: 'array', items: string };
const opNames = ['addAct', 'updateAct', 'addChapter', 'updateChapter', 'addScene', 'updateScene', 'moveScene', 'continueScene', 'changeState', 'addEvent', 'addCard',
  'updateNovel', 'addCharacter', 'updateCharacter', 'addSetting', 'updateSetting', 'link', 'addCause', 'updateStyle'];
export const companionSchema: JsonSchema = objectSchema({
  // reply first: the UI streams it while the rest of the JSON is still arriving.
  reply: string,
  questions: { type: 'array', items: objectSchema({ question: string, why: string, options: strings }) },
  ideas: { type: 'array', items: objectSchema({ kind: { type: 'string', enum: ['whatif', 'twist', 'conflict', 'character', 'setting', 'theme', 'beat'] }, title: string, content: string, hook: string }) },
  proposals: { type: 'array', items: objectSchema({ title: string, summary: string, ops: { type: 'array', items: objectSchema({
    op: { type: 'string', enum: opNames }, ref: nullableString, targetId: nullableString, parentRef: nullableString, parentId: nullableString,
    title: nullableString, content: nullableString, purpose: nullableString, order: { type: ['number', 'null'] }, povName: nullableString,
    causes: strings, people: strings, places: strings, events: strings, field: nullableString,
  }) } }) },
  followUps: strings,
});


function stamp() { return new Date().toISOString(); }
function fail(message: string): never { throw new DomainValidationError(message); }

/** Extract the reply value from partially streamed JSON so the author sees words, not braces. */
export function partialReply(raw: string): string {
  const match = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!match) return '';
  const body = match[1]!.replace(/\\$/, '');
  try { return JSON.parse(`"${body}"`) as string; } catch { return body.replace(/\\n/g, '\n').replace(/\\"/g, '"'); }
}

/** Assign stable local ids; model-provided ids are never trusted. */
export function normalizeResponse(value: unknown): CompanionResponse {
  const raw = value as Omit<CompanionResponse, 'questions' | 'ideas' | 'proposals'> & {
    questions: Array<Omit<CompanionResponse['questions'][number], 'id'>>; ideas: Array<Omit<CompanionIdea, 'id'>>;
    proposals: Array<Omit<CompanionProposal, 'id' | 'ops'> & { ops: Array<Omit<CompanionOp, 'id'>> }>;
  };
  return {
    reply: raw.reply.trim(),
    questions: raw.questions.slice(0, 3).map((item, index) => ({ ...item, options: (item.options ?? []).map(option => option.trim()).filter(Boolean).slice(0, 4), id: `q${index + 1}` })),
    ideas: raw.ideas.slice(0, 12).map((item, index) => ({ ...item, id: `i${index + 1}` })),
    proposals: raw.proposals.slice(0, 4).map((proposal, index) => ({ ...proposal, id: `p${index + 1}`,
      ops: proposal.ops.slice(0, 120).map((op, opIndex) => ({ ...op, id: `o${opIndex + 1}` })) })),
    followUps: raw.followUps.slice(0, 4),
  };
}

function excerpt(value: unknown, length: number): string {
  const text = typeof value === 'string' ? value : '';
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

/** Bounded, mode-specific author context. The partner is author-side and may read everything the author wrote. */
export function companionContext(workspace: Workspace, thread: CompanionThread, memoriesRules: Array<{ kind: string; content: string }>, request: { fullDraft?: boolean; direct?: boolean }, story?: StoryView) {
  const anchor = thread.anchor;
  const materials = resolveReferences(workspace, anchor.references);
  const view = story ?? new StoryView(workspace);
  const name = (id: string | null | undefined) => workspace.objects.find(object => object.id === id)?.name ?? null;
  const description = (fields: Record<string, unknown>) => excerpt(fields.description, 300);
  const events = workspace.objects.filter(object => object.event).sort((a, b) => a.event!.worldOrder - b.event!.worldOrder);
  const chapters = view.chapters;
  const template = outlineTemplate(workspace.structureTemplate);
  const chapterTitle = (id: string) => chapters[view.chapterIndex(id)]?.title ?? '';
  /** The passage the author is writing, else the last passage of the scene they are at. */
  const anchorPassage = (anchor.passageId ? view.passage(anchor.passageId) : undefined) ?? (anchor.sceneId ? view.scenePassages(anchor.sceneId).at(-1) : undefined);
  const anchorScene = anchorPassage ? view.sceneOf(anchorPassage.id) : workspace.scenes.find(scene => scene.id === anchor.sceneId);
  // Centre the catalog on where the author is working, not on the first chapters of a long book.
  const node = anchor.outlineNode;
  const firstChapter = (sceneId: string | undefined) => sceneId ? view.scenePassages(sceneId)[0]?.chapterId : undefined;
  const anchorChapter = anchorPassage?.chapterId
    ?? (node?.kind === 'chapter' ? node.id : node?.kind === 'scene' ? firstChapter(node.id)
      : node?.kind === 'act' ? chapters.find(chapter => chapter.actId === node.id)?.id : undefined)
    ?? firstChapter(materials.scenes[0]?.id) ?? view.frontierChapterId();
  const focus = view.focusChapters(anchorChapter, 12);
  const near = new Set(focus.near.map(chapter => chapter.id));
  const nearPassages = view.order.filter(passage => near.has(passage.chapterId));
  // Scenes read in the chapters shown, then scenes not yet placed in any chapter.
  const placed = new Set(workspace.passages.map(passage => passage.sceneId));
  const nearScenes = [...new Set(nearPassages.map(passage => passage.sceneId))].flatMap(id => { const scene = view.scene(id); return scene ? [scene] : []; })
    .concat(workspace.scenes.filter(scene => !placed.has(scene.id)));
  const focusIds = new Set<string>([...materials.objects.map(object => object.id), ...nearScenes.flatMap(scene => [...scene.eventIds, ...(scene.povId ? [scene.povId] : [])]),
    ...nearPassages.flatMap(passage => [...passageMentions(view.index, passage.id).keys()])]);
  const counts = view.mentionCounts();
  const rank = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => Number(focusIds.has(b.id)) - Number(focusIds.has(a.id)) || (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
  const shownEvents = new Set(rank(events).slice(0, 60).map(event => event.id));
  const chapterParts = new Map<string, { scenes: number; chars: number }>();
  for (const passage of nearPassages) {
    const entry = chapterParts.get(passage.chapterId) ?? { scenes: 0, chars: 0 };
    entry.scenes++; entry.chars += proseChars(passage.text); chapterParts.set(passage.chapterId, entry);
  }
  // A passage's place in its chapter, counted from 1 like moveScene's order.
  const position = new Map<string, number>(), counted = new Map<string, number>();
  for (const passage of view.order) { const n = (counted.get(passage.chapterId) ?? 0) + 1; counted.set(passage.chapterId, n); position.set(passage.id, n); }
  /** Where a scene is read: one passage per chapter it runs through (a scene can also come back later in the same chapter). */
  const partsOf = (sceneId: string) => view.scenePassages(sceneId).map(passage => ({ passageId: passage.id, chapterId: passage.chapterId, order: position.get(passage.id)!, writtenChars: proseChars(passage.text),
    ...(passage.beat?.trim() ? { beat: excerpt(passage.beat, 200) } : {}) }));
  /** The end of a scene's latest written prose. */
  const proseTail = (sceneId: string, length: number) => [...view.scenePassages(sceneId)].reverse().find(passage => passage.text.trim())?.text.slice(-length) ?? '';
  const typeName = (id: string) => workspace.objectTypes.find(type => type.id === id)?.name ?? id;
  /** Names only, a few each: enough to see which of 人物 / 情节 / 环境 a scene lacks. */
  const elements = (scene: Workspace['scenes'][number]) => {
    const value = sceneElements(workspace, scene);
    return { cast: value.cast.slice(0, 6), places: value.places.slice(0, 4), events: value.events.slice(0, 4), missing: value.missing.map(item => elementNames[item]) };
  };
  const base: Record<string, unknown> = {
    project: { title: workspace.title, brief: workspace.brief, genre: workspace.genre, audience: workspace.audience, theme: workspace.theme ?? '',
      logline: workspace.logline ?? '', structureTemplate: template ? { name: template.name, stages: template.stages } : null, chapterTarget: chapterTarget(workspace) },
    structure: '卷是数十到数百章组成的情节阶段；章是一次连载，约 chapterTarget 字；场景独立于章节：一章可以有几场，一场也可以跨几章（每章里是它的一个场景段）。',
    authorRules: memoriesRules,
    catalog: {
      characters: rank(workspace.objects.filter(object => object.typeId === 'character')).slice(0, 30).map(object => ({ id: object.id, name: object.name, description: description(object.fields), goal: excerpt(object.fields.goal, 160) })),
      settings: rank(workspace.objects.filter(isSettingLike)).slice(0, 20).map(object => ({ id: object.id, name: object.name, type: typeName(object.typeId), description: description(object.fields), rules: excerpt(object.fields.rules, 160) })),
      events: events.filter(event => shownEvents.has(event.id)).map(object => ({ id: object.id, name: object.name, worldOrder: object.event!.worldOrder, thread: object.event!.thread, causes: object.event!.causes, participants: object.event!.participants.map(name), description: excerpt(object.fields.description, 200) })),
      acts: [...(workspace.acts ?? [])].sort((a, b) => a.order - b.order).map(act => ({ id: act.id, title: act.title, purpose: act.purpose, summary: excerpt(act.summary, 400) })),
      // index is the reading position, so "insert after chapter X" has something to point at.
      chapters: focus.near.map(chapter => ({ id: chapter.id, index: view.chapterIndex(chapter.id) + 1, title: chapter.title, actId: chapter.actId ?? null,
        scenes: chapterParts.get(chapter.id)?.scenes ?? 0, writtenChars: chapterParts.get(chapter.id)?.chars ?? 0, summary: excerpt(chapter.summary, 300) })),
      chapterSkeleton: focus.skeleton.map(chapter => ({ id: chapter.id, index: view.chapterIndex(chapter.id) + 1, title: chapter.title, actId: chapter.actId ?? null })),
      omitted: { chapters: focus.omitted, scenes: workspace.scenes.length - Math.min(120, nearScenes.length), events: events.length - shownEvents.size },
      // passages: where the scene is read, in reading order; empty while it is not placed in any chapter.
      scenes: nearScenes.slice(0, 120).map(scene => ({ id: scene.id, title: scene.title, pov: name(scene.povId) ?? '全知', ...elements(scene),
        outline: excerpt(scene.outline, thread.mode === 'structure' ? 500 : 200), passages: partsOf(scene.id) })),
      canvasNotes: workspace.cards.filter(card => card.kind === 'note' || card.kind === 'group').slice(0, 60).map(card => ({ id: card.id, kind: card.kind, title: card.title })),
    },
    gaps: storyGaps(workspace),
    storyMemory: storyOverview(view, anchorChapter),
    anchor: { surface: anchor.surface,
      cards: materials.cards.slice(0, 12).map(card => ({ id: card.id, kind: card.kind, title: card.title, content: excerpt(card.content, 800) })),
      objects: materials.objects.slice(0, 12).map(object => ({ id: object.id, typeId: object.typeId, name: object.name, fields: object.fields, event: object.event })),
      scenes: materials.scenes.slice(0, 12).map(scene => ({ id: scene.id, title: scene.title, outline: scene.outline,
        chapters: view.scenePassages(scene.id).map(passage => chapterTitle(passage.chapterId)), textTail: proseTail(scene.id, 1500) })) },
  };
  if (thread.mode === 'diverge') {
    const anchorIds = new Set(materials.cards.map(card => card.id));
    base.neighbors = workspace.canvasLinks.filter(link => anchorIds.has(link.source) || anchorIds.has(link.target))
      .map(link => workspace.cards.find(card => card.id === (anchorIds.has(link.source) ? link.target : link.source)))
      .filter(Boolean).slice(0, 12).map(card => ({ title: card!.title, content: excerpt(card!.content, 300) }));
    base.groupMembers = workspace.cards.filter(card => card.groupId && anchorIds.has(card.groupId)).slice(0, 20).map(card => ({ title: card.title, content: excerpt(card.content, 300) }));
  }
  if (thread.mode === 'causality') {
    const anchorEvents = new Set(materials.objects.filter(object => object.event).map(object => object.id));
    base.causalChain = events.filter(event => anchorEvents.has(event.id) || event.event!.causes.some(id => anchorEvents.has(id))
      || [...anchorEvents].some(id => workspace.objects.find(object => object.id === id)?.event?.causes.includes(event.id)))
      .map(event => ({ id: event.id, name: event.name, worldOrder: event.event!.worldOrder, causes: event.event!.causes, description: excerpt(event.fields.description, 500), purpose: excerpt(event.fields.purpose, 300) }));
  }
  if (thread.mode === 'outline') {
    const node = anchor.outlineNode ?? { kind: 'book' as const };
    const scene = node.kind === 'scene' ? workspace.scenes.find(item => item.id === node.id) : undefined;
    base.target = { kind: node.kind, id: node.id ?? null, fullDraft: !!request.fullDraft,
      item: node.kind === 'act' ? (workspace.acts ?? []).find(act => act.id === node.id) : node.kind === 'chapter' ? workspace.chapters.find(chapter => chapter.id === node.id)
        : scene ? { ...scene, passages: partsOf(scene.id) } : null };
    // A scene's people and places as they stand when it begins, so planned changes start from there.
    const first = scene ? view.scenePassages(scene.id)[0] : undefined;
    if (scene && first) base.sceneState = sceneState(workspace, scene, first).subjects;
  }
  if (thread.mode === 'develop') {
    // Code decides whether to ask first: once the author has answered, or asked for drafts, always draft.
    const answered = thread.turns.some(turn => turn.role === 'companion');
    base.target = { focus: anchor.focus ?? 'profile', round: answered || request.direct || !(base.gaps as ReturnType<typeof storyGaps>).sparse ? 'draft' : 'ask',
      emptyFields: companionNovelFields.filter(field => !(workspace[field] ?? '').trim()),
      current: Object.fromEntries(companionNovelFields.map(field => [field, workspace[field] ?? ''])) };
  }
  if (thread.mode === 'style') {
    const profile = styleProfile(workspace);
    const characterName = (id: string) => workspace.objects.find(object => object.id === id)?.name ?? id;
    let budget = 9000;
    const samples = [...profile.samples].sort((a, b) => Number(b.source === 'own') - Number(a.source === 'own') || Number(!!b.pinned) - Number(!!a.pinned)).flatMap(sample => {
      if (budget < 300) return [];
      const text = sample.text.slice(0, Math.min(1800, budget)); budget -= text.length;
      return [{ label: sample.label, source: sample.source, author: sample.author ?? null, text }];
    });
    const own = profile.samples.filter(sample => sample.source === 'own').map(sample => sample.text).join('\n');
    const reference = profile.samples.filter(sample => sample.source === 'reference').map(sample => sample.text).join('\n');
    base.style = {
      current: { summary: profile.summary, dials: profile.dials, rules: profile.rules.map(rule => ({ kind: rule.kind, content: rule.content })),
        preferWords: profile.preferWords, avoidWords: profile.avoidWords, voices: profile.voices.map(voice => ({ characterId: voice.characterId, name: characterName(voice.characterId), voice: voice.voice })) },
      scales: Object.fromEntries(Object.entries(scaleNames).map(([id, [label, low, high]]) => [id, `${label}：1=${low} … 5=${high}`])), persons: personNames,
      samples, fingerprint: { own: own.trim() ? styleFingerprint(own) : null, reference: reference.trim() ? styleFingerprint(reference) : null },
    };
    base.target = { focus: anchor.focus === 'blindtest' ? 'blindtest' : 'distill' };
    if (anchor.focus === 'blindtest') {
      const scene = anchorScene ?? [...view.order].reverse().map(passage => view.sceneOf(passage.id)!).find(item => item.outline.trim() || proseTail(item.id, 1))
        ?? workspace.scenes.find(item => item.outline.trim());
      const tail = anchorPassage?.text.trim() ? anchorPassage.text.slice(-800) : scene ? proseTail(scene.id, 800) : '';
      base.blindtest = { beat: scene ? { title: scene.title, pov: name(scene.povId) ?? '全知', outline: excerpt(scene.outline, 600), textTail: tail }
        : { premise: workspace.logline || workspace.brief || workspace.title } };
    }
  }
  if (thread.mode === 'beat') {
    const scene = anchorScene, passage = anchorPassage;
    const index = passage ? view.positionOf(passage.id) : -1;
    const next = index >= 0 ? view.order[index + 1] : undefined, previous = index > 0 ? view.order[index - 1] : undefined;
    const pov = workspace.objects.find(object => object.id === scene?.povId);
    base.currentScene = scene ? { id: scene.id, title: passage ? view.label(passage.id) : scene.title, chapter: passage ? chapterTitle(passage.chapterId) : '', pov: name(scene.povId) ?? '全知',
      outline: scene.outline, beat: passage?.beat ?? '', textTail: passage?.text.slice(-3000) ?? '',
      // How the people and places stand as this passage begins, and the changes the author planned for this scene.
      state: passage ? sceneState(workspace, scene, passage).subjects : [],
      nextScene: next ? { title: view.label(next.id), outline: excerpt(view.sceneOf(next.id)?.outline, 600), ...(next.beat?.trim() ? { beat: excerpt(next.beat, 300) } : {}) } : null,
      previousScene: previous ? { title: view.label(previous.id), ...view.passageMemory(previous.id) } : null,
      openThreads: openThreads(view, passage?.id, pov ? objectNames(pov) : [], 10).map(thread => thread.title),
      entityRecall: passage ? entityRecall(view, passage.id, [...(scene.povId ? [scene.povId] : []), ...passageMentions(view.index, passage.id).keys(), ...scene.eventIds.flatMap(id => workspace.objects.find(object => object.id === id)?.event?.participants ?? [])],
        new Set(previous ? [previous.id] : []), 6) : [] } : null;
  }
  // Adopted items carry their content, not just a title: they are what the author decided.
  base.conversation = thread.turns.slice(-HISTORY_TURNS).map(turn => turn.role === 'author' ? { author: turn.text } : {
    companion: turn.response?.reply ?? turn.text,
    ideas: turn.response?.ideas.map(idea => turn.adopted?.[idea.id] ? `${idea.title}（已采纳）：${excerpt(idea.content, 160)}` : idea.title) ?? [],
    questions: turn.response?.questions.map(question => question.question) ?? [],
    proposals: turn.response?.proposals.map(proposal => adoptedProposal(turn, proposal.id) ? `${proposal.title}（已采纳）：${excerpt(proposal.summary, 200)}` : proposal.title) ?? [],
  });
  const earlier = decisionLog(thread.turns.slice(0, -HISTORY_TURNS));
  if (earlier.entries.length) base.earlierDecisions = { ...earlier, notice: '更早轮次的要点：作者的原话与已采纳的内容，按时间顺序。' };
  return boundedContext(base, 24_000);
}

function adoptedProposal(turn: CompanionTurn, proposalId: string): boolean {
  return Object.keys(turn.adopted ?? {}).some(key => key === proposalId || key.startsWith(`${proposalId}#`));
}
/** A rolling, deterministic record of what the author said and adopted before the history window, newest kept within budget. */
export function decisionLog(turns: CompanionTurn[]): { entries: string[]; omitted?: number } {
  const all = turns.flatMap(turn => turn.role === 'author' ? (turn.text.trim() ? [`作者：${excerpt(turn.text.trim(), 200)}`] : []) : [
    ...(turn.response?.ideas ?? []).filter(idea => turn.adopted?.[idea.id]).map(idea => `采纳点子：${idea.title}——${excerpt(idea.content, 120)}`),
    ...(turn.response?.proposals ?? []).filter(proposal => adoptedProposal(turn, proposal.id)).map(proposal => `采纳方案：${proposal.title}——${excerpt(proposal.summary, 160)}`),
  ]);
  const kept: string[] = [];
  let budget = DECISION_LOG_CHARS;
  for (const entry of [...all].reverse()) { if (entry.length > budget) break; kept.unshift(entry); budget -= entry.length; }
  return { entries: kept, ...(kept.length < all.length ? { omitted: all.length - kept.length } : {}) };
}

/** Applies each proposal to the current work the way adoption would, without saving, and records the ops adoption would skip or
 * why the proposal cannot apply at all, so the author sees it before choosing. */
export function checkProposals(project: Workspace, thread: Pick<CompanionThread, 'mode' | 'anchor'>, response: CompanionResponse): void {
  for (const proposal of response.proposals) {
    const message = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);
    try {
      const { commands, skippedOps } = companionCommands(project, selectCompanionItems(response, [proposal.id]),
        { mode: thread.mode, anchor: thread.anchor, target: thread.mode === 'beat' ? 'sceneOutline' : 'canvas' });
      let error: string | undefined;
      if (commands.length) { try { applyCommands(project, commands); } catch (failure) { error = message(failure); } }
      proposal.check = { skipped: skippedOps.filter(item => item.proposalId === proposal.id).map(({ opId, reason }) => ({ opId, reason })), ...(error ? { error } : {}) };
    } catch (failure) { proposal.check = { skipped: [], error: message(failure) }; }
  }
}

export class CompanionService {
  private active = new Map<string, AbortController>();
  constructor(private store: NovelStore, private getProvider: () => ProviderSecret | Promise<ProviderSecret>,
    private onEvent: (event: AgentEvent) => void, private transportFactory: (provider: ProviderSecret) => ResponseTransport) {}

  threads(projectId: string) { return this.store.getCompanionThreads(projectId); }

  private emit(thread: CompanionThread) {
    try { this.onEvent({ type: 'companion', projectId: thread.projectId, runId: thread.id, thread: structuredClone(thread) }); } catch { /* The stored thread stays authoritative. */ }
  }
  private save(thread: CompanionThread) { thread.updatedAt = stamp(); this.store.saveCompanionThread(thread); this.emit(thread); }
  private thread(projectId: string, id: string) { return this.store.getCompanionThread(projectId, id) ?? fail('对话不存在或已删除'); }

  ask(request: CompanionAskRequest): CompanionThread {
    const project = this.store.getProject(request.projectId);
    if (!MODES.includes(request.mode)) fail('创作伙伴模式无效');
    if (!['steady', 'bold', 'wild'].includes(request.intensity)) fail('发散强度无效');
    if (typeof request.message !== 'string' || request.message.length > 8000 || (!request.retry && !request.message.trim())) fail('请输入不超过 8000 字的内容');
    resolveReferences(project, request.anchor?.references ?? []);
    let thread: CompanionThread;
    if (request.threadId) {
      thread = this.thread(project.id, request.threadId);
      if (this.active.has(thread.id)) fail('伙伴还在回答上一条消息');
    } else {
      const at = stamp();
      thread = { id: randomUUID(), projectId: project.id, mode: request.mode, anchor: structuredClone(request.anchor),
        title: excerpt(request.message.trim(), 24) || companionModeNames[request.mode], turns: [], status: 'idle', createdAt: at, updatedAt: at };
    }
    if (request.options !== undefined && (typeof request.options !== 'object' || request.options === null)) fail('选项无效');
    const options = { ...(request.options?.fullDraft === true ? { fullDraft: true } : {}), ...(request.options?.versions === true ? { versions: true } : {}) };
    if (request.retry) {
      if (thread.turns.at(-1)?.role !== 'author') fail('没有需要重试的消息');
    } else thread.turns.push({ id: randomUUID(), role: 'author', text: request.message.trim(), intensity: request.intensity, at: stamp(), ...(Object.keys(options).length ? { options } : {}) });
    thread.status = 'streaming'; thread.streaming = ''; delete thread.error;
    this.save(thread);
    const controller = new AbortController();
    this.active.set(thread.id, controller);
    void this.respond(thread, request, controller).finally(() => this.active.delete(thread.id));
    return structuredClone(thread);
  }

  private async respond(thread: CompanionThread, request: CompanionAskRequest, controller: AbortController) {
    let provider: ProviderSecret | undefined;
    let raw = '', shown = '', lastEmit = 0, reply: CompanionTurn | undefined, error: string | undefined;
    try {
      provider = await this.getProvider();
      if (provider.mode === 'live' && !provider.apiKey) throw new Error('请先在模型设置中填写 API Key');
      const project = this.store.getProject(thread.projectId);
      const rules = selectAuthorRules(refreshMemories(project, this.store.getAgentMemories(project.id))).rules.map(memory => ({ kind: memory.kind, content: memory.content }));
      const last = thread.turns.at(-1)!;
      // Costly or question-skipping answers come only from an explicit choice in the interface, never from words in the message.
      const fullDraft = thread.mode === 'outline' && !!last.options?.fullDraft, direct = !!last.options?.versions;
      const context = companionContext(project, { ...thread, turns: thread.turns.slice(0, -1) }, rules, { fullDraft, direct }, new StoryView(project, this.store.getStoryDigests(project.id)));
      const step = await runAgent({ id: `companion:${thread.mode}`, label: companionModeNames[thread.mode],
        instructions: `${companionCommonPrompt.text}\n${companionModePrompts[thread.mode].text}\n${companionIntensityPrompts[last.intensity ?? request.intensity].text}`, outputSchema: companionSchema }, {
        transport: this.transportFactory(provider), context, objective: last.text || '请继续。', signal: controller.signal, contextSources: [],
        onDelta: (_id, delta) => {
          raw += delta;
          const text = partialReply(raw);
          if (text !== shown && Date.now() - lastEmit > 100) { lastEmit = Date.now(); shown = text; this.emit({ ...thread, streaming: text }); }
        },
      });
      const response = normalizeResponse(step.structured);
      checkProposals(this.store.getProject(thread.projectId), thread, response);
      reply = { id: randomUUID(), role: 'companion', text: response.reply, response, adopted: {}, at: stamp(), usage: step.usage };
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      error = controller.signal.aborted ? '已停止' : provider?.apiKey ? message.replaceAll(provider.apiKey, '[API Key 已隐藏]') : message;
    }
    // Re-read: the author may have adopted earlier ideas or deleted the thread while this reply streamed.
    try {
      const latest = this.store.getCompanionThread(thread.projectId, thread.id);
      if (!latest) return;
      delete latest.streaming;
      if (reply) {
        latest.turns.push(reply); latest.status = 'idle'; delete latest.error;
        const usage = latest.usage ?? emptyUsage(); addUsage(usage, reply.usage!); latest.usage = usage;
      }
      else { latest.status = 'failed'; latest.error = error; }
      this.save(latest);
    } catch { /* The project may have been removed meanwhile. */ }
  }

  cancel(projectId: string, threadId: string) {
    this.thread(projectId, threadId);
    this.active.get(threadId)?.abort();
  }

  adopt(request: CompanionAdoptRequest): CompanionAdoptResult {
    const thread = this.thread(request.projectId, request.threadId);
    const turn = thread.turns.find(item => item.id === request.turnId && item.role === 'companion');
    if (!turn?.response) fail('这条建议不存在');
    if (!Array.isArray(request.itemIds) || !request.itemIds.length) fail('请选择要采纳的内容');
    if (request.as !== undefined && request.as !== 'character' && request.as !== 'setting') fail('采纳方式无效');
    const adopted = turn.adopted ??= {}, created = turn.created ??= {};
    const selected = selectCompanionItems(turn.response, request.itemIds);
    if (selected.unknown.length) fail('选择的建议不存在');
    // Already adopted items stay put; their created ids still anchor newly adopted children.
    const selection = { ideas: selected.ideas.filter(idea => !adopted[idea.id]), ops: selected.ops.filter(({ proposal, op }) => !adopted[`${proposal.id}#${op.id}`]) };
    if (!selection.ideas.length && !selection.ops.length) return { batchId: adopted[request.itemIds[0]!] ?? adopted[`${request.itemIds[0]}#o1`], skipped: [], thread };
    const project = this.store.getProject(request.projectId);
    const target = request.target ?? (thread.mode === 'beat' ? 'sceneOutline' : 'canvas');
    const { commands, skipped, refs } = companionCommands(project, selection, {
      mode: thread.mode, anchor: thread.anchor, target, placement: request.placement, group: request.group, ideasAs: request.as,
      knownRefs: Object.fromEntries(Object.entries(created).map(([key, value]) => [key, value.id])),
    });
    if (!commands.length) return { skipped: skipped.length ? skipped : ['没有可以写入的内容'], thread };
    const { batch } = this.store.executeBatch({ projectId: project.id, expectedRevision: project.revision, actor: 'ai', commands,
      taskId: `companion:${thread.id}`, label: `采纳创作伙伴 · ${companionModeNames[thread.mode]}` });
    if (batch) {
      for (const idea of selection.ideas) adopted[idea.id] = batch.id;
      for (const { proposal, op } of selection.ops) adopted[`${proposal.id}#${op.id}`] = batch.id;
      for (const [key, id] of Object.entries(refs)) created[key] = { id, batchId: batch.id };
    }
    this.save(thread);
    this.onEvent({ type: 'projectChanged', projectId: project.id, runId: thread.id });
    return { batchId: batch?.id, skipped, thread };
  }

  undo(projectId: string, threadId: string, batchId: string): CompanionThread {
    const thread = this.thread(projectId, threadId);
    const owned = thread.turns.some(turn => Object.values(turn.adopted ?? {}).includes(batchId));
    if (!owned) fail('这次采纳不属于该对话');
    this.store.undo(projectId, batchId);
    for (const turn of thread.turns) {
      for (const [id, batch] of Object.entries(turn.adopted ?? {})) if (batch === batchId) delete turn.adopted![id];
      for (const [key, value] of Object.entries(turn.created ?? {})) if (value.batchId === batchId) delete turn.created![key];
    }
    this.save(thread);
    this.onEvent({ type: 'projectChanged', projectId, runId: thread.id });
    return thread;
  }

  delete(projectId: string, threadId: string) {
    this.active.get(threadId)?.abort();
    this.store.deleteCompanionThread(projectId, threadId);
  }

  shutdown() { for (const controller of this.active.values()) controller.abort(); }
}
