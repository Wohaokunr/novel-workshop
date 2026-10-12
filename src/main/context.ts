import type { Workspace, CharacterContext, ReaderContext, SourceReference, CanvasCard, NovelObject, NarrativeScene } from '../shared/types.js';
import { entityRecall, openThreads, storySoFar, StoryView } from './agent/story-view.js';
import { writerStyle } from './agent/style.js';
import { isSettingLike, sceneElements } from '../shared/story-elements.js';

/** Raw prose immediately before the target scene; everything earlier reaches the writer as layered digests. */
export const RECENT_TEXT_CHARS = 6000;
/** Writer budget: big enough for the target scene plus memory, small enough to stay cheap on a million-word book. */
export const WRITER_CONTEXT_CHARS = 28_000;
/** Books with this few settings still hand all of them to a scene that names none. */
export const ALL_SETTINGS_UP_TO = 6;
export const WRITER_PRIORITY = ['scene', 'sceneElements', 'selectedText', 'style', 'authorRules', 'recentText', 'eventContexts', 'upstream', 'outlinePlan', 'novel', 'storySoFar', 'entityRecall', 'openThreads', 'initialCharacters'];

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

/** Author context is resolved from real entities; role knowledge retains its own time boundary. */
export function buildWriterContext(workspace: Workspace, sceneId: string, references: SourceReference[] = [], story?: StoryView) {
  const scene = workspace.scenes.find(scene => scene.id === sceneId);
  if (!scene) throw new Error('目标场景已被删除');
  const chapter = workspace.chapters.find(chapter => chapter.id === scene.chapterId)!;
  const materials = resolveReferences(workspace, references);
  const act = chapter.actId ? (workspace.acts ?? []).find(item => item.id === chapter.actId) : undefined;
  const view = story ?? new StoryView(workspace);
  const recentText: Array<{ sceneId: string; title: string; text: string }> = [];
  let remaining = RECENT_TEXT_CHARS;
  for (const previous of view.order.slice(0, Math.max(0, view.positionOf(scene.id))).reverse()) {
    if (remaining <= 0) break;
    if (!previous.text.trim()) continue;
    const text = previous.text.slice(-remaining);
    recentText.unshift({ sceneId: previous.id, title: previous.title, text });
    remaining -= text.length;
  }
  // Only the places this scene happens in: bound by the author, or named in its outline, chapter plan or the prose just before.
  const settings = workspace.objects.filter(isSettingLike);
  const nearby = [scene.title, scene.outline, chapter.summary ?? '', recentText.map(item => item.text).join('\n').slice(-1500)].join('\n');
  const named = settings.filter(object => Array.from(object.name.trim()).length >= 2 && nearby.includes(object.name.trim())).map(object => object.id);
  const sceneSettings = (scene.settingIds?.length || named.length) ? [...(scene.settingIds ?? []), ...named]
    : settings.length <= ALL_SETTINGS_UP_TO ? settings.map(object => object.id) : [];
  const objectIds = new Set<string>([
    ...scene.eventIds, ...(scene.povId ? [scene.povId] : []), ...(scene.castIds ?? []), ...materials.objects.map(object => object.id),
    ...(workspace.characterStates ?? []).filter(state => scene.eventIds.includes(state.eventId)).map(state => state.characterId),
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
    const characterTransitions = (workspace.characterStates ?? []).filter(state => state.eventId === event.id);
    const characterIds = new Set([...event.event!.participants, ...characterTransitions.map(state => state.characterId), ...(scene.povId ? [scene.povId] : []), ...(scene.castIds ?? [])]);
    return {
      eventId: event.id, facts: activeFacts.filter(fact => !replaced.has(fact.id)),
      characters: [...characterIds].filter(id => workspace.objects.find(object => object.id === id)?.typeId === 'character').map(id => buildCharacterContext(workspace, id, event.id)),
      characterTransitions,
    };
  });
  const shown = new Set(recentText.map(item => item.sceneId));
  const people = [...new Set([...(scene.povId ? [scene.povId] : []), ...sceneEvents.flatMap(event => event.event!.participants),
    ...relatedObjects.filter(object => !object.event).map(object => object.id)])];
  const recall = entityRecall(view, scene.id, people, new Set([...shown, ...view.order.filter(item => item.chapterId === scene.chapterId).map(item => item.id)]));
  const threads = openThreads(view, scene.id, people.map(id => workspace.objects.find(object => object.id === id)?.name ?? ''));
  const initialFacts = relatedFacts.filter(fact => fact.fromEventId === null);
  const sources = [...new Set([
    `scene:${scene.id}`, 'novel:theme', 'style', ...materials.sources, ...relatedObjects.map(object => `object:${object.id}`),
    ...initialFacts.map(fact => `fact:${fact.id}`), ...eventContexts.flatMap(event => [
      ...event.facts.map(fact => `fact:${fact.id}`), ...event.characters.flatMap(character => character.sources),
      ...event.characterTransitions.flatMap(state => [`characterState:${state.id}`, ...state.sceneIds.map(id => `scene:${id}:text`)]),
    ]),
    ...initialCharacters.flatMap(character => [`object:${character.characterId}:selfKnowledge`, ...character.memories.map(item => `knowledge:${item.id}`)]),
    ...recentText.map(item => `scene:${item.sceneId}:text`),
    ...recall.map(item => `scene:${item.lastSeen.sceneId}:text`),
  ])];
  return {
    novel: { title: workspace.title, brief: workspace.brief, genre: workspace.genre, audience: workspace.audience, theme: workspace.theme ?? '', logline: workspace.logline ?? '' },
    outlinePlan: { chapter: { title: chapter.title, summary: chapter.summary ?? '' }, act: act ? { title: act.title, purpose: act.purpose, summary: act.summary } : null,
      notice: '作者大纲中本章/本幕要完成的任务；是计划而非已发生事实，通过本场行动逐步落实。' },
    sceneElements: (({ missing: _missing, ...names }) => ({ ...names, notice: '本场的人物、环境与世界事件；环境的样貌与规则见 relatedObjects。' }))(sceneElements(workspace, scene)),
    style: writerStyle(workspace, scene),
    storySoFar: storySoFar(view, scene.id, { exclude: shown }), openThreads: threads.map(thread => thread.title), entityRecall: recall,
    scene, materials, relatedObjects, initialFacts, initialCharacters, eventContexts, recentText, sources,
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
  const previousState = (workspace.characterStates ?? []).filter(state => state.characterId === characterId
    && (events.get(state.eventId)?.worldOrder ?? Infinity) < anchor.event!.worldOrder)
    .sort((a, b) => events.get(b.eventId)!.worldOrder - events.get(a.eventId)!.worldOrder)[0];
  // Evidence explains the transition to the author, rather than a memory the character acquired.
  const state = previousState ? { ...previousState, evidence: '', sceneIds: [] } : undefined;
  return {
    characterId, name: character.name,
    selfKnowledge: typeof character.fields.selfKnowledge === 'string' ? character.fields.selfKnowledge : '',
    eventId, perception: anchor.event.observations[characterId] ?? '', memories,
    ...(state ? { state } : {}),
    sources: [`object:${characterId}:selfKnowledge`, `event:${eventId}:observations:${characterId}`, ...memories.map(item => `knowledge:${item.id}`), ...(state ? [`characterState:${state.id}`] : [])],
  };
}

/** A reader sees narrative text through the selected scene, never its referenced world events. */
export function buildReaderContext(workspace: Workspace, chapterId: string, sceneId?: string): ReaderContext {
  const chapter = workspace.chapters.find(item => item.id === chapterId);
  if (!chapter) throw new Error('阅读章节不存在');
  const anchor = sceneId ? workspace.scenes.find(item => item.id === sceneId && item.chapterId === chapterId) : undefined;
  if (sceneId && !anchor) throw new Error('阅读场景不属于选定章节');
  const chapters = [...workspace.chapters].filter(item => item.order <= chapter.order).sort((a, b) => a.order - b.order);
  const sources: string[] = [];
  const text = chapters.map(item => {
    const scenes = workspace.scenes.filter(scene => scene.chapterId === item.id && (
      item.id !== chapterId || !anchor || scene.order <= anchor.order
    )).sort((a, b) => a.order - b.order);
    sources.push(...scenes.filter(scene => scene.text.trim()).map(scene => `scene:${scene.id}:text`));
    return [item.title, ...scenes.map(scene => scene.text).filter(text => text.trim())].join('\n\n');
  }).join('\n\n');
  return { title: workspace.title, text, sources };
}
