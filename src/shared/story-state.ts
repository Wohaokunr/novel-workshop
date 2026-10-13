import type { NarrativeScene, NovelObject, Passage, StateChange, Workspace } from './types.js';
import { orderedChapters, orderedPassages, passageLabel } from './structure.js';

export interface StateAspect { key: string; label: string; hint: string; subjects: 'character' | 'setting' | 'any' }
/** The aspects every character or setting can change in; authors add their own under any short label (境界、伤势、与某人的关系…). */
export const STATE_ASPECTS: readonly StateAspect[] = [
  { key: 'psychology', label: '心理', hint: '情绪、心态与内心冲突', subjects: 'character' },
  { key: 'perspective', label: '视角', hint: '看待人与事的立场和眼光', subjects: 'character' },
  { key: 'cognition', label: '认知', hint: '知道、相信或误解了什么', subjects: 'character' },
  { key: 'motivation', label: '动机', hint: '此刻想要什么、打算做什么', subjects: 'character' },
  { key: 'condition', label: '状态', hint: '伤势、处境、持有物等其它状态', subjects: 'any' },
  { key: 'atmosphere', label: '氛围', hint: '此刻给人的感觉：天气、气氛、秩序', subjects: 'setting' },
];
export const MAX_STATE_ASPECTS = 12;
export const ASPECT_KEY_CHARS = 20, ASPECT_VALUE_CHARS = 2000;
export function aspectLabel(key: string): string { return STATE_ASPECTS.find(aspect => aspect.key === key)?.label ?? key; }
/** What the author typed: a built-in label (or key) maps to its key, anything else is its own key. */
export function aspectKey(label: string): string {
  const value = label.trim();
  return STATE_ASPECTS.find(aspect => aspect.label === value || aspect.key === value)?.key ?? value;
}
export function aspectsFor(subject: Pick<NovelObject, 'typeId'>): StateAspect[] {
  const kind = subject.typeId === 'character' ? 'character' : 'setting';
  return STATE_ASPECTS.filter(aspect => aspect.subjects === kind || aspect.subjects === 'any');
}
/** Aspects as label → value, built-in ones first in their usual order. */
export function labelledAspects(aspects: Record<string, string>): Record<string, string> {
  const rank = (key: string) => { const index = STATE_ASPECTS.findIndex(aspect => aspect.key === key); return index < 0 ? STATE_ASPECTS.length : index; };
  return Object.fromEntries(Object.entries(aspects).sort((a, b) => rank(a[0]) - rank(b[0])).map(([key, value]) => [aspectLabel(key), value]));
}

/** Where a state is asked for: entering a scene, at the start of one of its passages, just before a world event, or after everything. */
export type StatePoint = { passageId: string } | { sceneId: string } | { eventId: string } | { end: true };
export interface HeldAspect { key: string; label: string; value: string; change: StateChange }
type Key = readonly [time: number, position: number];

const INF = Number.POSITIVE_INFINITY;
function compare(a: Key, b: Key): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

/**
 * The order in which state changes take effect. A change happens at a world time and a reading position:
 * - time: its event's world time; else its scene's (the earliest event the scene shows); else the story clock, the latest world time
 *   narrated up to that point, so undated prose never happens before what was told before it;
 * - position: by the end of its passage, or of its scene's last passage; an event-only change sits with the first scene that shows it.
 * Changes are ordered by time, then position, so a flashback scene sees the state of its own time rather than the state reached by the
 * chapters before it. Inside a scene only its changes on earlier passages have happened yet; the rest is what the scene changes.
 */
export class StoryTimeline {
  private readonly passages: Map<string, Passage>;
  private readonly scenes: Map<string, NarrativeScene>;
  /** Reading position of each passage. */
  private readonly position = new Map<string, number>();
  private readonly span = new Map<string, { first: number; last: number }>();
  private readonly eventTime = new Map<string, number>();
  private readonly sceneTime = new Map<string, number>();
  private readonly clock: number[] = [];
  private readonly presented = new Map<string, number>();
  private readonly keys = new Map<string, Key>();
  /** Every change in the order it takes effect. */
  readonly ordered: StateChange[];

  constructor(readonly workspace: Workspace) {
    this.passages = new Map(workspace.passages.map(passage => [passage.id, passage]));
    this.scenes = new Map(workspace.scenes.map(scene => [scene.id, scene]));
    for (const object of workspace.objects) if (object.event) this.eventTime.set(object.id, object.event.worldOrder);
    for (const scene of workspace.scenes) {
      const times = scene.eventIds.flatMap(id => this.eventTime.has(id) ? [this.eventTime.get(id)!] : []);
      if (times.length) this.sceneTime.set(scene.id, Math.min(...times));
    }
    orderedPassages(workspace).forEach((passage, index) => {
      this.position.set(passage.id, index);
      const span = this.span.get(passage.sceneId);
      if (span) span.last = index; else this.span.set(passage.sceneId, { first: index, last: index });
      this.clock.push(Math.max(this.clock.at(-1) ?? -INF, this.sceneTime.get(passage.sceneId) ?? -INF));
    });
    for (const [sceneId, span] of [...this.span].sort((a, b) => a[1].first - b[1].first)) {
      for (const eventId of this.scenes.get(sceneId)?.eventIds ?? []) if (!this.presented.has(eventId)) this.presented.set(eventId, span.last);
    }
    for (const change of workspace.stateChanges) this.keys.set(change.id, this.changeKey(change));
    this.ordered = workspace.stateChanges.map((change, index) => ({ change, index }))
      .sort((a, b) => compare(this.keys.get(a.change.id)!, this.keys.get(b.change.id)!) || a.index - b.index).map(item => item.change);
  }

  private clockAt(position: number): number {
    if (!this.clock.length || position < 0) return -INF;
    return this.clock[Math.min(this.clock.length - 1, Math.floor(position))]!;
  }
  private changeKey(change: StateChange): Key {
    const passage = change.passageId !== undefined ? this.position.get(change.passageId) : undefined;
    const position = (passage ?? (change.sceneId !== undefined ? this.span.get(change.sceneId)?.last
      : change.eventId !== undefined ? this.presented.get(change.eventId) : undefined) ?? INF) + 0.5;
    const time = change.eventId !== undefined && this.eventTime.has(change.eventId) ? this.eventTime.get(change.eventId)!
      : change.sceneId !== undefined && this.sceneTime.has(change.sceneId) ? this.sceneTime.get(change.sceneId)! : this.clockAt(position);
    return [time, position];
  }
  private sceneAt(point: StatePoint): string | undefined {
    return 'passageId' in point ? this.passages.get(point.passageId)?.sceneId : 'sceneId' in point ? point.sceneId : undefined;
  }
  private pointKey(point: StatePoint): Key | undefined {
    if ('end' in point) return [INF, INF];
    if ('eventId' in point) { const time = this.eventTime.get(point.eventId); return time === undefined ? undefined : [time, -INF]; }
    const sceneId = this.sceneAt(point);
    if (sceneId === undefined || !this.scenes.has(sceneId)) return undefined;
    const position = 'passageId' in point ? this.position.get(point.passageId) ?? INF : this.span.get(sceneId)?.first ?? INF;
    return [this.sceneTime.get(sceneId) ?? this.clockAt(position), position];
  }

  /** Reading position of a passage, -1 when unknown. */
  positionOf(passageId: string): number { return this.position.get(passageId) ?? -1; }
  /** Whether `change` has already happened at `point`. */
  happenedBefore(change: StateChange, point: StatePoint): boolean {
    const key = this.pointKey(point), sceneId = this.sceneAt(point);
    if (!key) return false;
    if (sceneId !== undefined && change.sceneId === sceneId) {
      const here = 'passageId' in point ? this.position.get(point.passageId) : undefined;
      const at = change.passageId !== undefined ? this.position.get(change.passageId) : undefined;
      return here !== undefined && at !== undefined && at < here;
    }
    return compare(this.keys.get(change.id) ?? this.changeKey(change), key) < 0;
  }
  /** The subject's state at a point: for each aspect, the latest change that has happened by then. */
  stateAt(subjectId: string, point: StatePoint): Map<string, HeldAspect> {
    const held = new Map<string, HeldAspect>();
    for (const change of this.ordered) {
      if (change.subjectId !== subjectId || !this.happenedBefore(change, point)) continue;
      for (const [key, value] of Object.entries(change.aspects)) held.set(key, { key, label: aspectLabel(key), value, change });
    }
    return held;
  }
  /** The subject's changes in the order they take effect. */
  history(subjectId: string): StateChange[] { return this.ordered.filter(change => change.subjectId === subjectId); }
  /** What a scene changes, seen from one of its passages (or the whole scene): changes on this passage, on earlier and on later passages
   * of the scene, and those set for the scene as a whole. */
  sceneChanges(sceneId: string, passageId?: string) {
    const here = passageId !== undefined ? this.position.get(passageId) : undefined;
    const own = this.ordered.filter(change => change.sceneId === sceneId);
    const at = (change: StateChange) => change.passageId !== undefined ? this.position.get(change.passageId) : undefined;
    return {
      here: own.filter(change => change.passageId !== undefined && change.passageId === passageId),
      earlier: own.filter(change => here !== undefined && (at(change) ?? INF) < here),
      later: own.filter(change => change.passageId !== undefined && change.passageId !== passageId && (here === undefined || (at(change) ?? INF) > here)),
      scene: own.filter(change => change.passageId === undefined),
    };
  }
}

const timelineCache = new WeakMap<Workspace, StoryTimeline>();
/** One timeline per workspace snapshot (workspaces are replaced, never mutated, once built). */
export function storyTimeline(workspace: Workspace): StoryTimeline {
  let timeline = timelineCache.get(workspace);
  if (!timeline) timelineCache.set(workspace, timeline = new StoryTimeline(workspace));
  return timeline;
}

/** Characters and settings a scene puts on stage, viewpoint first; plus anyone a change in this scene is about. */
export function sceneSubjects(workspace: Workspace, scene: NarrativeScene): NovelObject[] {
  const ids = [...new Set([...(scene.povId ? [scene.povId] : []), ...(scene.castIds ?? []), ...(scene.settingIds ?? []),
    ...workspace.stateChanges.filter(change => change.sceneId === scene.id).map(change => change.subjectId)])];
  return ids.flatMap(id => { const object = workspace.objects.find(item => item.id === id && !item.event); return object ? [object] : []; });
}

/** Where a change sits, for people: 「第3章 · 雨夜对峙（2/3）」, a scene not yet placed, or a world event. */
export function changePlace(workspace: Workspace, change: StateChange): string {
  const event = change.eventId ? workspace.objects.find(object => object.id === change.eventId) : undefined;
  const passage = change.passageId ? workspace.passages.find(item => item.id === change.passageId) : undefined;
  const scene = change.sceneId ? workspace.scenes.find(item => item.id === change.sceneId) : undefined;
  const chapterTitle = (id: string) => orderedChapters(workspace).find(chapter => chapter.id === id)?.title ?? '';
  let place = '';
  if (passage) place = `${chapterTitle(passage.chapterId)} · ${passageLabel(workspace, passage)}`;
  else if (scene) {
    const first = orderedPassages(workspace).find(item => item.sceneId === scene.id);
    place = first ? `${chapterTitle(first.chapterId)} · ${scene.title}` : `${scene.title}（未排入章节）`;
  }
  return [place, event ? `事件「${event.name}」` : ''].filter(Boolean).join(' · ');
}
