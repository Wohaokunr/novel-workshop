import type { NarrativeScene, NovelObject, Workspace } from './types.js';

/** The three elements of a novel: who (人物), what happens (情节), where (环境). */
export type StoryElement = 'people' | 'plot' | 'place';
export const elementNames: Record<StoryElement, string> = { people: '人物', plot: '情节', place: '环境' };

/** Places, organisations, props and custom types: anything that is neither a character nor a world event. */
/** The name and aliases a text may use for an object. Single characters are too ambiguous to count as a mention. */
export function objectNames(object: Pick<NovelObject, 'name' | 'aliases'>): string[] {
  return [...new Set([object.name, ...(object.aliases ?? [])].map(value => value.trim()).filter(value => Array.from(value).length >= 2))];
}
export const isSettingLike = (object: Pick<NovelObject, 'typeId' | 'event'>) => object.typeId !== 'character' && object.typeId !== 'event' && !object.event;
export const elementOf = (object: Pick<NovelObject, 'typeId' | 'event'>): StoryElement => object.typeId === 'character' ? 'people' : object.event ? 'plot' : 'place';

const nameCache = new WeakMap<NovelObject[], Map<string, string>>();
function namesOf(workspace: Workspace): Map<string, string> {
  let names = nameCache.get(workspace.objects);
  if (!names) nameCache.set(workspace.objects, names = new Map(workspace.objects.map(object => [object.id, object.name])));
  return names;
}

export interface SceneElements { pov: string | null; cast: string[]; places: string[]; events: string[]; missing: StoryElement[] }

/** Names of a scene's people, places and events, and which of the three elements it still lacks. Zero-token. */
export function sceneElements(workspace: Workspace, scene: NarrativeScene): SceneElements {
  const names = namesOf(workspace);
  const list = (ids: readonly string[] = []) => ids.flatMap(id => names.has(id) ? [names.get(id)!] : []);
  const pov = scene.povId ? names.get(scene.povId) ?? null : null;
  const cast = list((scene.castIds ?? []).filter(id => id !== scene.povId));
  const places = list(scene.settingIds), events = list(scene.eventIds);
  const missing: StoryElement[] = [];
  if (!pov && !cast.length) missing.push('people');
  if (!events.length && !scene.outline.trim()) missing.push('plot');
  if (!places.length) missing.push('place');
  return { pov, cast, places, events, missing };
}

const usageCache = new WeakMap<NarrativeScene[], Map<string, string[]>>();
/** Object id → ids of the scenes that put it on stage: POV or cast, presented events and their participants, settings. */
export function elementUsage(workspace: Workspace): Map<string, string[]> {
  let usage = usageCache.get(workspace.scenes);
  if (usage) return usage;
  usage = new Map();
  const participants = new Map(workspace.objects.filter(object => object.event).map(object => [object.id, object.event!.participants]));
  for (const scene of workspace.scenes) {
    const ids = new Set([...(scene.povId ? [scene.povId] : []), ...(scene.castIds ?? []), ...scene.eventIds, ...(scene.settingIds ?? []),
      ...scene.eventIds.flatMap(id => participants.get(id) ?? [])]);
    for (const id of ids) { const scenes = usage.get(id); if (scenes) scenes.push(scene.id); else usage.set(id, [scene.id]); }
  }
  usageCache.set(workspace.scenes, usage);
  return usage;
}

const filled = (value: unknown) => typeof value === 'string' ? !!value.trim() : Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined;

/** Short hints about what an object still lacks to work as one of the three elements. Zero-token. */
export function objectHealth(workspace: Workspace, object: NovelObject): string[] {
  const hints: string[] = [];
  const used = (elementUsage(workspace).get(object.id)?.length ?? 0) > 0;
  const type = workspace.objectTypes.find(item => item.id === object.typeId);
  const has = (field: string) => type?.fields.some(item => item.id === field);
  if (object.typeId === 'character') {
    if (has('description') && !filled(object.fields.description)) hints.push('缺作者设定');
    if (has('goal') && !filled(object.fields.goal)) hints.push('缺创作目标');
    if (!used) hints.push('还没在场景出场');
  } else if (object.event) {
    if (has('description') && !filled(object.fields.description)) hints.push('缺事件描述');
    if (!object.event.participants.length) hints.push('缺参与人物');
    if (!used) hints.push('还没有场景呈现');
  } else {
    if (has('description') && !filled(object.fields.description)) hints.push('缺环境设定');
    if (has('rules') && !filled(object.fields.rules)) hints.push('缺世界规则');
    if (!used) hints.push('还没有场景发生在这里');
  }
  return hints;
}
