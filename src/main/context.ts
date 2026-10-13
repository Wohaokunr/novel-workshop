import type { Workspace, CharacterContext, ReaderContext, SourceReference, CanvasCard, NovelObject, NarrativeScene, Passage, StateChange } from '../shared/types.js';
import { entityRecall, openThreads, storySoFar, StoryView } from './agent/story-view.js';
import { writerStyle } from './agent/style.js';
import { extractSummary } from './agent/story-index.js';
import { isSettingLike, objectNames, sceneElements } from '../shared/story-elements.js';
import { chapterPassages, chapterTarget, orderedChapters, proseChars } from '../shared/structure.js';
import { labelledAspects, sceneSubjects, storyTimeline } from '../shared/story-state.js';

/** Raw prose immediately before the target passage; everything earlier reaches the writer as layered digests. */
export const RECENT_TEXT_CHARS = 6000;
/** Writer budget: big enough for the target passage, style samples, the prose just before and the book's memory together, small
 * enough to stay cheap on a million-word book. */
export const WRITER_CONTEXT_CHARS = 40_000;
/** Memories each character on stage brings to the writer, most recent first kept; older ones are counted, not listed. */
export const WRITER_MEMORIES = 16;
/** Books with this few settings still hand all of them to a scene that names none. */
export const ALL_SETTINGS_UP_TO = 6;
/** People and places whose state the writer is shown for one scene. */
export const SCENE_STATE_SUBJECTS = 12;
/** What survives when the budget runs out, first to last: the passage, its scene and voice, where everyone stands, the prose it
 * continues, the plan, what came earlier in the book, then who knows what; reference material goes last. */
export const WRITER_PRIORITY = ['passage', 'scene', 'sceneElements', 'sceneState', 'selectedText', 'style', 'authorRules', 'recentText', 'sceneSoFar', 'outlinePlan', 'sceneLater', 'storySoFar', 'openThreads', 'eventContexts', 'upstream', 'entityRecall', 'novel', 'initialCharacters', 'relatedObjects', 'initialFacts', 'materials'];

export function resolveReferences(workspace: Workspace, references: SourceReference[] = []) {
  if (!Array.isArray(references)) throw new Error('参考资料必须是列表');
  const cards = new Map<string, CanvasCard>(), objects = new Map<string, NovelObject>(), scenes = new Map<string, NarrativeScene>();
  const sources = new Set<string>();
  const add = (reference: SourceReference): void => {
    if (!reference || !['card', 'object', 'scene'].includes(reference.kind) || typeof reference.id !== 'string') throw new Error('参考资料引用无效');
    const key = `${reference.kind}:${reference.id}`;
    if (sources.has(key)) return;
    const item = workspace[reference.kind === 'card' ? 'cards' : reference.kind === 'object' ? 'objects' : 'scenes'].find(item => item.id === reference.id);
    if (!item) throw new Error(`参考资料已删除：${key}，请重新选择`);
    sources.add(key);
    if (reference.kind === 'object') objects.set(item.id, item as NovelObject);
    else if (reference.kind === 'scene') scenes.set(item.id, item as NarrativeScene);
    else {
      const card = item as CanvasCard;
      cards.set(card.id, card);
      if (card.kind === 'group') for (const child of workspace.cards.filter(child => child.groupId === card.id)) add({ kind: 'card', id: child.id });
      else if (card.kind === 'object' || card.kind === 'scene') add({ kind: card.kind, id: card.refId! });
    }
  };
  for (const reference of references) add(reference);
  return { cards: [...cards.values()], objects: [...objects.values()], scenes: [...scenes.values()], sources: [...sources] };
}

/** How long this passage should run: the chapter's target, less what its other passages already hold, shared among the passages
 * still unwritten. */
function chapterPlan(workspace: Workspace, view: StoryView, passage: Passage) {
  const target = chapterTarget(workspace), passages = chapterPassages(workspace, passage.chapterId);
  const others = passages.filter(item => item.id !== passage.id);
  const writtenChars = others.reduce((sum, item) => sum + proseChars(item.text), 0);
  const unwritten = passages.filter(item => item.id === passage.id || !item.text.trim()).length;
  return {
    targetChars: target, writtenChars, suggestedChars: Math.max(800, Math.round(Math.max(0, target - writtenChars) / Math.max(1, unwritten) / 100) * 100),
    passages: passages.map(item => ({ scene: view.label(item.id), ...(item.id === passage.id ? { current: true } : { chars: proseChars(item.text) }), ...(item.beat?.trim() ? { beat: item.beat } : {}) })),
  };
}

/** Where the people and places of a scene stand as this passage begins (what earlier plot left them with), and the changes the author
 * set for this passage, for the scene as a whole, and for the scene's later passages. Labels are the author's (心理、视角、认知…). */
export function sceneState(workspace: Workspace, scene: NarrativeScene, passage: Passage) {
  const timeline = storyTimeline(workspace), changes = timeline.sceneChanges(scene.id, passage.id);
  const events = new Map(workspace.objects.filter(object => object.event).map(object => [object.id, object.name]));
  const shown = (change: StateChange) => ({ becomes: labelledAspects(change.aspects), ...(change.eventId && events.has(change.eventId) ? { event: events.get(change.eventId)! } : {}),
    ...(change.note?.trim() ? { note: change.note } : {}) });
  const used = new Set<string>();
  const subjects = sceneSubjects(workspace, scene).slice(0, SCENE_STATE_SUBJECTS).map(subject => {
    const held = [...timeline.stateAt(subject.id, { passageId: passage.id }).values()];
    const own = (list: StateChange[]) => list.filter(change => change.subjectId === subject.id);
    const here = own(changes.here), whole = own(changes.scene), later = own(changes.later);
    for (const change of [...held.map(item => item.change), ...here, ...whole, ...later]) used.add(change.id);
    return { id: subject.id, name: subject.name, kind: subject.typeId === 'character' ? '人物' : '环境',
      before: Object.fromEntries(held.map(item => [item.label, item.value])),
      ...(here.length ? { here: here.map(shown) } : {}), ...(whole.length ? { byEndOfScene: whole.map(shown) } : {}), ...(later.length ? { later: later.map(shown) } : {}) };
  });
  return {
    notice: 'before 是本段开始时人物与环境的状态，由此前的情节造成；here 是作者为本段记录的变化，byEndOfScene 是整场结束前要完成的变化（本段是这场的最后一段时须在本段完成），later 留给本场后面几段，本段不要提前写到。状态与变化是作者的规划：通过行动、对话、细节逐步呈现，不要直接写出这些词。',
    subjects, sources: [...used].map(id => `stateChange:${id}`),
  };
}

/** Author context is resolved from real entities; role knowledge retains its own time boundary. The writer writes one passage: the part
 * of a scene that falls in one chapter (a scene running through several chapters has one passage in each). */
export function buildWriterContext(workspace: Workspace, passageId: string, references: SourceReference[] = [], story?: StoryView) {
  const passage = workspace.passages.find(item => item.id === passageId);
  if (!passage) throw new Error('目标场景段已被删除');
  const scene = workspace.scenes.find(item => item.id === passage.sceneId)!;
  const chapter = workspace.chapters.find(item => item.id === passage.chapterId)!;
  const materials = resolveReferences(workspace, references);
  const act = chapter.actId ? (workspace.acts ?? []).find(item => item.id === chapter.actId) : undefined;
  const view = story ?? new StoryView(workspace);
  const chapterTitle = (item: Passage) => view.chapters[view.chapterIndex(item.chapterId)]?.title ?? '';
  const recentText: Array<{ passageId: string; chapter: string; scene: string; text: string }> = [];
  let remaining = RECENT_TEXT_CHARS;
  for (const previous of view.order.slice(0, Math.max(0, view.positionOf(passage.id))).reverse()) {
    if (remaining <= 0) break;
    if (!previous.text.trim()) continue;
    const text = previous.text.slice(-remaining);
    recentText.unshift({ passageId: previous.id, chapter: chapterTitle(previous), scene: view.label(previous.id), text });
    remaining -= text.length;
  }
  const shown = new Set(recentText.map(item => item.passageId));
  // The scene before and after this passage, when it runs through other chapters: where it left off, and what is kept for later.
  const parts = view.scenePassages(scene.id), at = parts.findIndex(item => item.id === passage.id);
  const earlier = parts.slice(0, at).filter(item => item.text.trim() && !shown.has(item.id)).slice(-6), later = parts.slice(at + 1);
  const sceneSoFar = earlier.length ? {
    notice: '这一场在前面章节里已经写下的部分（不在 recentText 中）。本段从它停下的地方接着写，不重复已写的内容。',
    parts: earlier.map((item, index) => ({ chapter: chapterTitle(item), summary: view.passageMemory(item.id).summary, ...(index === earlier.length - 1 ? { lastLines: item.text.slice(-800) } : {}) })),
  } : undefined;
  const sceneLater = later.length ? {
    notice: '这一场在后面章节里还有这些部分。本段不要写到它们的内容，结尾为它们留出余地；已经写下的，要能自然接上它的开头。',
    parts: later.map(item => ({ chapter: chapterTitle(item), ...(item.beat?.trim() ? { beat: item.beat } : {}), ...(item.text.trim() ? { opening: extractSummary(item.text).opening } : {}) })),
  } : undefined;
  // Only the places this scene happens in: bound by the author, or named in its outline, chapter plan or the prose just before.
  const settings = workspace.objects.filter(isSettingLike);
  const nearby = [scene.title, scene.outline, passage.beat ?? '', chapter.summary ?? '', recentText.map(item => item.text).join('\n').slice(-1500)].join('\n');
  const named = settings.filter(object => objectNames(object).some(name => nearby.includes(name))).map(object => object.id);
  const sceneSettings = (scene.settingIds?.length || named.length) ? [...(scene.settingIds ?? []), ...named]
    : settings.length <= ALL_SETTINGS_UP_TO ? settings.map(object => object.id) : [];
  const objectIds = new Set<string>([
    ...scene.eventIds, ...(scene.povId ? [scene.povId] : []), ...(scene.castIds ?? []), ...materials.objects.map(object => object.id),
    ...workspace.stateChanges.filter(change => change.sceneId === scene.id).map(change => change.subjectId),
    ...materials.scenes.flatMap(scene => [...scene.eventIds, ...(scene.povId ? [scene.povId] : []), ...(scene.castIds ?? []), ...(scene.settingIds ?? [])]),
    ...sceneSettings,
  ]);
  for (const id of objectIds) {
    const object = workspace.objects.find(object => object.id === id)!;
    for (const related of [...(object.event?.participants ?? []), ...(object.event?.causes ?? [])]) objectIds.add(related);
    for (const field of workspace.objectTypes.find(type => type.id === object.typeId)!.fields.filter(field => field.kind === 'reference')) {
      const value = object.fields[field.id];
      for (const related of typeof value === 'string' ? [value] : Array.isArray(value) ? value : []) objectIds.add(related);
    }
  }
  const relatedObjects = workspace.objects.filter(object => objectIds.has(object.id));
  const relatedFacts = workspace.facts.filter(fact => objectIds.has(fact.subjectId));
  const sceneEvents = scene.eventIds.map(id => workspace.objects.find(object => object.id === id)!).sort((a, b) => a.event!.worldOrder - b.event!.worldOrder);
  const initialCharacters = sceneEvents.length ? [] : relatedObjects.filter(object => object.typeId === 'character').map(character => ({
    characterId: character.id, name: character.name,
    selfKnowledge: typeof character.fields.selfKnowledge === 'string' ? character.fields.selfKnowledge : '',
    memories: workspace.knowledge.filter(item => item.characterId === character.id && item.learnedAt === null)
      .map(item => ({ id: item.id, content: item.content, source: item.source, learnedAt: item.learnedAt })),
  }));
  const eventContexts = sceneEvents.map(event => {
    const activeFacts = relatedFacts.filter(fact => fact.fromEventId === null || workspace.objects.find(object => object.id === fact.fromEventId)!.event!.worldOrder <= event.event!.worldOrder);
    const replaced = new Set(activeFacts.flatMap(fact => fact.replacesId ? [fact.replacesId] : []));
    const characterIds = new Set([...event.event!.participants, ...(scene.povId ? [scene.povId] : []), ...(scene.castIds ?? [])]);
    return {
      eventId: event.id, facts: activeFacts.filter(fact => !replaced.has(fact.id)),
      characters: [...characterIds].filter(id => workspace.objects.find(object => object.id === id)?.typeId === 'character').map(id => {
        const character = buildCharacterContext(workspace, id, event.id), kept = character.memories.slice(-WRITER_MEMORIES);
        const dropped = new Set(character.memories.slice(0, character.memories.length - kept.length).map(item => `knowledge:${item.id}`));
        return { ...character, memories: kept, ...(character.memories.length > kept.length ? { earlierMemories: character.memories.length - kept.length } : {}),
          sources: character.sources.filter(source => !dropped.has(source)) };
      }),
    };
  });
  const state = sceneState(workspace, scene, passage);
  const people = [...new Set([...(scene.povId ? [scene.povId] : []), ...sceneEvents.flatMap(event => event.event!.participants),
    ...relatedObjects.filter(object => !object.event).map(object => object.id)])];
  const recall = entityRecall(view, passage.id, people, new Set([...shown, ...view.order.filter(item => item.chapterId === passage.chapterId || item.sceneId === scene.id).map(item => item.id)]));
  const threads = openThreads(view, passage.id, people.flatMap(id => { const object = workspace.objects.find(item => item.id === id); return object ? objectNames(object) : []; }));
  const initialFacts = relatedFacts.filter(fact => fact.fromEventId === null);
  const sources = [...new Set([
    `scene:${scene.id}`, `passage:${passage.id}`, 'novel:theme', 'style', ...materials.sources, ...relatedObjects.map(object => `object:${object.id}`),
    ...initialFacts.map(fact => `fact:${fact.id}`), ...eventContexts.flatMap(event => [...event.facts.map(fact => `fact:${fact.id}`), ...event.characters.flatMap(character => character.sources)]),
    ...state.sources,
    ...initialCharacters.flatMap(character => [`object:${character.characterId}:selfKnowledge`, ...character.memories.map(item => `knowledge:${item.id}`)]),
    ...recentText.map(item => `passage:${item.passageId}:text`), ...earlier.map(item => `passage:${item.id}:text`), ...later.map(item => `passage:${item.id}`),
    ...recall.map(item => `passage:${item.lastSeen.passageId}:text`),
  ])];
  // Source labels are bookkeeping for the run record, not material for the writer; each character's state before the event is
  // already in sceneState, where it reads as the state on entering this passage.
  const writerEvents = eventContexts.map(event => ({ ...event, characters: event.characters.map(({ sources: _sources, state: _state, ...character }) => character) }));
  const { sources: _stateSources, ...sceneStateForWriter } = state;
  return {
    novel: { title: workspace.title, brief: workspace.brief, genre: workspace.genre, audience: workspace.audience, theme: workspace.theme ?? '', logline: workspace.logline ?? '' },
    outlinePlan: {
      volume: act ? { title: act.title, purpose: act.purpose, summary: act.summary } : null,
      chapter: { title: chapter.title, summary: chapter.summary ?? '', ...chapterPlan(workspace, view, passage) },
      notice: '作者大纲中本卷、本章要完成的任务；是计划而非已发生事实，通过本段行动逐步落实。一章是一次连载更新，chapter.passages 是本章的场景段，current 是这次要写的。',
    },
    sceneElements: (({ missing: _missing, ...names }) => ({ ...names, notice: '本场的人物、环境与世界事件；环境的样貌与规则见 relatedObjects。' }))(sceneElements(workspace, scene)),
    style: writerStyle(workspace, scene, passage.text),
    storySoFar: storySoFar(view, passage.id, { exclude: shown }), openThreads: threads.map(thread => thread.title), entityRecall: recall,
    scene,
    passage: { id: passage.id, chapter: chapter.title, ...(parts.length > 1 ? { part: `${at + 1}/${parts.length}` } : {}), beat: passage.beat ?? '', text: passage.text },
    sceneState: sceneStateForWriter, ...(sceneSoFar ? { sceneSoFar } : {}), ...(sceneLater ? { sceneLater } : {}),
    materials, relatedObjects, initialFacts, initialCharacters, eventContexts: writerEvents, recentText, sources,
  };
}

/** Author fields and event outcomes must never be exposed through this role context. */
export function buildCharacterContext(workspace: Workspace, characterId: string, eventId: string): CharacterContext {
  const character = workspace.objects.find(object => object.id === characterId && object.typeId === 'character');
  const anchor = workspace.objects.find(object => object.id === eventId && object.typeId === 'event');
  if (!character || !anchor?.event) throw new Error('人物或目标事件不存在');
  const events = new Map(workspace.objects.filter(object => object.event).map(object => [object.id, object.event!]));
  const memories = workspace.knowledge.filter(item => item.characterId === characterId && (
    item.learnedAt === null || (events.get(item.learnedAt)?.worldOrder ?? Infinity) < anchor.event!.worldOrder
  )).map(item => ({ id: item.id, content: item.content, source: item.source, learnedAt: item.learnedAt }));
  // The state the plot has left the character in just before the event; the author's notes explain changes and stay out.
  const held = [...storyTimeline(workspace).stateAt(characterId, { eventId }).values()];
  const state = held.length ? labelledAspects(Object.fromEntries(held.map(item => [item.key, item.value]))) : undefined;
  return {
    characterId, name: character.name,
    selfKnowledge: typeof character.fields.selfKnowledge === 'string' ? character.fields.selfKnowledge : '',
    eventId, perception: anchor.event.observations[characterId] ?? '', memories,
    ...(state ? { state } : {}),
    sources: [`object:${characterId}:selfKnowledge`, `event:${eventId}:observations:${characterId}`, ...memories.map(item => `knowledge:${item.id}`),
      ...[...new Set(held.map(item => item.change.id))].map(id => `stateChange:${id}`)],
  };
}

/** A reader sees narrative text up to the selected passage (or the whole chapter), never the world events it presents. */
export function buildReaderContext(workspace: Workspace, chapterId: string, passageId?: string): ReaderContext {
  const chapter = workspace.chapters.find(item => item.id === chapterId);
  if (!chapter) throw new Error('阅读章节不存在');
  const anchor = passageId ? workspace.passages.find(item => item.id === passageId && item.chapterId === chapterId) : undefined;
  if (passageId && !anchor) throw new Error('阅读的场景段不属于选定章节');
  const chapters = orderedChapters(workspace).filter(item => item.order <= chapter.order);
  const sources: string[] = [];
  const text = chapters.map(item => {
    const passages = chapterPassages(workspace, item.id).filter(passage => item.id !== chapterId || !anchor || passage.order <= anchor.order);
    sources.push(...passages.filter(passage => passage.text.trim()).map(passage => `passage:${passage.id}:text`));
    return [item.title, ...passages.map(passage => passage.text).filter(text => text.trim())].join('\n\n');
  }).join('\n\n');
  return { title: workspace.title, text, sources };
}
