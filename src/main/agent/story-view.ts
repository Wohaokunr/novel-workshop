import type { Chapter, NarrativeScene, Workspace } from '../../shared/types.js';
import type { RollupDigest, SceneDigest, StoryDigest, StoryThread } from '../../shared/story-types.js';
import { extractSummary, mentionExcerpt, sceneHash, sceneMentions, sketchSimilarity, storyIndex, textHash, textSketch, type Mention, type StoryIndex } from './story-index.js';

/** fresh: digest of this exact text; drifted: digest of an earlier, mostly similar version; extract: zero-token fallback. */
export type Freshness = 'fresh' | 'drifted' | 'extract';
export const DRIFT_SIMILARITY = 0.7;
export const VOLUME_CHAPTERS = 10;
export interface SceneMemory { title?: string; freshness: Freshness; summary: string; events?: string[]; changes?: SceneDigest['changes']; facts?: string[] }
export interface Volume { id: string; title: string; chapterIds: string[] }

function clip(text: string, length: number): string { return text.length > length ? `${text.slice(0, length)}…` : text; }

/** Read-only projection of a workspace plus its stored digests. Pure: works on candidate workspaces too. */
export class StoryView {
  readonly index: StoryIndex;
  readonly order: NarrativeScene[];
  readonly chapters: Chapter[];
  private readonly position = new Map<string, number>();
  private readonly chapterPosition = new Map<string, number>();
  private readonly sceneDigests = new Map<string, SceneDigest>();
  private readonly rollups = new Map<string, RollupDigest>();
  private readonly freshnessCache = new Map<string, Freshness>();
  private volumeCache?: Volume[];

  constructor(readonly workspace: Workspace, digests: StoryDigest[] = []) {
    this.index = storyIndex(workspace);
    this.chapters = [...workspace.chapters].sort((a, b) => a.order - b.order);
    this.chapters.forEach((chapter, index) => this.chapterPosition.set(chapter.id, index));
    this.order = this.chapters.flatMap(chapter => workspace.scenes.filter(scene => scene.chapterId === chapter.id).sort((a, b) => a.order - b.order));
    this.order.forEach((scene, index) => this.position.set(scene.id, index));
    for (const digest of digests) {
      if (digest.kind === 'scene') this.sceneDigests.set(digest.sceneId, digest);
      else this.rollups.set(`${digest.kind}:${digest.targetId}`, digest);
    }
  }

  scene(id: string): NarrativeScene | undefined { const at = this.position.get(id); return at === undefined ? undefined : this.order[at]; }
  positionOf(id: string): number { return this.position.get(id) ?? -1; }
  chapterIndex(id: string): number { return this.chapterPosition.get(id) ?? -1; }

  freshness(sceneId: string): Freshness {
    const cached = this.freshnessCache.get(sceneId);
    if (cached) return cached;
    const scene = this.scene(sceneId), digest = this.sceneDigests.get(sceneId);
    let result: Freshness = 'extract';
    if (scene?.text.trim() && digest) {
      if (digest.textHash === sceneHash(this.index, sceneId)) result = 'fresh';
      else if (sketchSimilarity(digest.sketch, textSketch(scene.text)) >= DRIFT_SIMILARITY) result = 'drifted';
    }
    this.freshnessCache.set(sceneId, result);
    return result;
  }
  digest(sceneId: string): SceneDigest | undefined { return this.freshness(sceneId) === 'extract' ? undefined : this.sceneDigests.get(sceneId); }
  storedDigest(sceneId: string): SceneDigest | undefined { return this.sceneDigests.get(sceneId); }
  rollup(kind: RollupDigest['kind'], id: string): RollupDigest | undefined { return this.rollups.get(`${kind}:${id}`); }

  /** readerSafe omits titles and outlines (author material); digests themselves derive from prose only. */
  sceneMemory(sceneId: string, readerSafe = false): SceneMemory {
    const scene = this.scene(sceneId)!, digest = this.digest(sceneId), freshness = this.freshness(sceneId);
    const title = readerSafe ? undefined : scene.title;
    if (digest) return { title, freshness, summary: digest.summary, events: digest.events, changes: digest.changes, facts: digest.facts };
    const { opening, closing } = extractSummary(scene.text);
    const parts = [!readerSafe && scene.outline.trim() ? `大纲：${clip(scene.outline.trim(), 120)}` : '', opening ? `开头：${opening}` : '', closing ? `结尾：${closing}` : ''].filter(Boolean);
    return { title, freshness, summary: parts.join(' / ') || (readerSafe ? '' : '（尚无正文）') };
  }

  /** Scenes whose prose has no up-to-date digest, in reading order. */
  pending(): NarrativeScene[] { return this.order.filter(scene => scene.text.trim() && this.freshness(scene.id) !== 'fresh'); }
  coverage() {
    let scenesWithText = 0, fresh = 0, drifted = 0, pendingChars = 0;
    for (const scene of this.order) {
      if (!scene.text.trim()) continue;
      scenesWithText++;
      const freshness = this.freshness(scene.id);
      if (freshness === 'fresh') fresh++; else { if (freshness === 'drifted') drifted++; pendingChars += scene.text.length; }
    }
    return { scenesWithText, fresh, drifted, pending: scenesWithText - fresh, pendingChars };
  }

  /** Hash of the digests a chapter rollup summarises; undefined until every written scene has one. */
  chapterInput(chapterId: string): { hash: string; scenes: Array<{ summary: string; events: string[] }> } | undefined {
    const scenes = this.order.filter(scene => scene.chapterId === chapterId && scene.text.trim());
    if (!scenes.length || scenes.some(scene => !this.digest(scene.id))) return undefined;
    const value = scenes.map(scene => { const digest = this.digest(scene.id)!; return { summary: digest.summary, events: digest.events }; });
    return { hash: textHash(JSON.stringify(value)), scenes: value };
  }
  chapterSummary(chapterId: string, readerSafe = false): { summary: string; freshness: Freshness } {
    const rollup = this.rollup('chapter', chapterId);
    if (rollup) return { summary: rollup.summary, freshness: rollup.inputHash === this.chapterInput(chapterId)?.hash ? 'fresh' : 'drifted' };
    const chapter = this.chapters[this.chapterIndex(chapterId)];
    const joined = this.order.filter(scene => scene.chapterId === chapterId && scene.text.trim()).map(scene => this.sceneMemory(scene.id, readerSafe).summary).join(' ');
    return { summary: clip(joined || (!readerSafe ? chapter?.summary ?? '' : ''), 300), freshness: 'extract' };
  }

  /** Acts are volumes; chapters outside any act form volumes of VOLUME_CHAPTERS consecutive chapters. */
  volumes(): Volume[] {
    if (this.volumeCache) return this.volumeCache;
    const acts = new Map((this.workspace.acts ?? []).map(act => [act.id, act]));
    const result: Volume[] = [];
    let run: Volume | undefined;
    for (const chapter of this.chapters) {
      const act = chapter.actId ? acts.get(chapter.actId) : undefined;
      if (act) {
        run = undefined;
        let volume = result.find(item => item.id === `act:${act.id}`);
        if (!volume) result.push(volume = { id: `act:${act.id}`, title: act.title, chapterIds: [] });
        volume.chapterIds.push(chapter.id);
      } else {
        if (!run || run.chapterIds.length >= VOLUME_CHAPTERS) result.push(run = { id: `range:${chapter.id}`, title: '', chapterIds: [] });
        run.chapterIds.push(chapter.id);
      }
    }
    for (const volume of result) if (!volume.title) {
      const first = this.chapters[this.chapterIndex(volume.chapterIds[0]!)]!, last = this.chapters[this.chapterIndex(volume.chapterIds.at(-1)!)]!;
      volume.title = volume.chapterIds.length > 1 ? `${first.title} — ${last.title}` : first.title;
    }
    return this.volumeCache = result;
  }
  volumeOf(chapterId: string): Volume | undefined { return this.volumes().find(volume => volume.chapterIds.includes(chapterId)); }
  volumeInput(volumeId: string): { hash: string; chapters: Array<{ title: string; summary: string }> } | undefined {
    const volume = this.volumes().find(item => item.id === volumeId);
    const chapters = volume?.chapterIds.map(id => ({ id, rollup: this.rollup('chapter', id) })).filter(item => item.rollup || this.order.some(scene => scene.chapterId === item.id && scene.text.trim()));
    if (!chapters?.length || chapters.some(item => !item.rollup)) return undefined;
    const value = chapters.map(item => ({ title: this.chapters[this.chapterIndex(item.id)]!.title, summary: item.rollup!.summary }));
    return { hash: textHash(JSON.stringify(value)), chapters: value };
  }
  volumeSummary(volumeId: string, readerSafe = false): string {
    const rollup = this.rollup('volume', volumeId);
    if (rollup) return rollup.summary;
    const volume = this.volumes().find(item => item.id === volumeId);
    return clip(volume?.chapterIds.map(id => this.rollup('chapter', id)?.summary ?? (readerSafe ? '' : this.chapters[this.chapterIndex(id)]?.summary ?? '')).filter(Boolean).join(' ') ?? '', 300);
  }
  bookInput(): { hash: string; volumes: Array<{ title: string; summary: string }> } | undefined {
    const volumes = this.volumes().map(volume => ({ title: volume.title, rollup: this.rollup('volume', volume.id) })).filter(item => item.rollup);
    if (!volumes.length) return undefined;
    const value = volumes.map(item => ({ title: item.title, summary: item.rollup!.summary }));
    return { hash: textHash(JSON.stringify(value)), volumes: value };
  }
  bookSummary(): string { return this.rollup('book', this.workspace.id)?.summary ?? ''; }

  /** Threads opened and not yet closed before this scene (or anywhere when omitted), oldest first. */
  ledgerBefore(sceneId?: string): StoryThread[] {
    const end = sceneId === undefined ? this.order.length : Math.max(0, this.positionOf(sceneId));
    const open = new Map<string, StoryThread>();
    for (let index = 0; index < end; index++) {
      const digest = this.digest(this.order[index]!.id);
      if (!digest) continue;
      for (const id of digest.threadsClosed) open.delete(id);
      for (const thread of digest.threadsOpened) open.set(thread.id, thread);
    }
    return [...open.values()];
  }

  lastAppearanceBefore(objectId: string, sceneId: string): { scene: NarrativeScene; mention: Mention } | undefined {
    for (let index = this.positionOf(sceneId) - 1; index >= 0; index--) {
      const scene = this.order[index]!, mention = sceneMentions(this.index, scene.id).get(objectId);
      if (mention) return { scene, mention };
    }
    return undefined;
  }
  timeline(objectId: string): Array<{ scene: NarrativeScene; mention: Mention }> {
    return this.order.flatMap(scene => { const mention = sceneMentions(this.index, scene.id).get(objectId); return mention ? [{ scene, mention }] : []; });
  }
  mentionCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const scene of this.order) for (const [id, mention] of sceneMentions(this.index, scene.id)) counts.set(id, (counts.get(id) ?? 0) + mention.count);
    return counts;
  }
  /** The latest chapter that has prose: the default focus when no target is given. */
  frontierChapterId(): string | undefined { return [...this.order].reverse().find(scene => scene.text.trim())?.chapterId ?? this.chapters[0]?.id; }

  /** Chapters within `radius` of the anchor in full, plus a sparse skeleton of the rest. */
  focusChapters(anchorChapterId: string | undefined, radius: number, skeleton = 12): { near: Chapter[]; skeleton: Chapter[]; omitted: number } {
    const center = Math.max(0, this.chapterIndex(anchorChapterId ?? this.frontierChapterId() ?? ''));
    const near = this.chapters.slice(Math.max(0, center - radius), center + radius + 1);
    const rest = this.chapters.filter(chapter => !near.includes(chapter));
    const step = Math.max(1, Math.ceil(rest.length / skeleton));
    const sparse = rest.filter((_, index) => index % step === 0);
    return { near, skeleton: sparse, omitted: rest.length - sparse.length };
  }
}

export const storyNotice = '故事记忆是由正文生成的辅助摘要，不是正式事实；与原文冲突时以原文和领域记录为准。drifted 表示摘要基于该场较早版本。';

/** Layered "story so far" for a scene: book → earlier volumes → recent chapters → earlier scenes of this chapter. */
export function storySoFar(view: StoryView, sceneId: string, options: { readerSafe?: boolean; recentChapters?: number; exclude?: Set<string> } = {}) {
  const scene = view.scene(sceneId)!, readerSafe = !!options.readerSafe;
  const chapterAt = view.chapterIndex(scene.chapterId), volume = view.volumeOf(scene.chapterId);
  const volumes = view.volumes(), volumeAt = volume ? volumes.indexOf(volume) : volumes.length;
  const recentCount = options.recentChapters ?? 5;
  const earlierChapters = view.chapters.slice(0, chapterAt);
  const recent = earlierChapters.slice(-recentCount);
  // Chapters of the current volume older than the recent window are summarised briefly; earlier volumes by rollup.
  const inVolume = earlierChapters.slice(0, -recentCount || undefined).filter(chapter => volume?.chapterIds.includes(chapter.id)).slice(-15);
  const chapterLine = (chapter: Chapter, length: number) => ({ ...(readerSafe ? {} : { title: chapter.title }), summary: clip(view.chapterSummary(chapter.id, readerSafe).summary, length) });
  return {
    notice: storyNotice,
    book: view.bookSummary(),
    earlierVolumes: volumes.slice(Math.max(0, volumeAt - 8), volumeAt).map(item => ({ ...(readerSafe ? {} : { title: item.title }), summary: clip(view.volumeSummary(item.id, readerSafe), 300) })).filter(item => item.summary),
    ...(volumeAt > 8 ? { omittedVolumes: volumeAt - 8 } : {}),
    currentVolumeEarlierChapters: inVolume.map(chapter => chapterLine(chapter, 120)).filter(item => item.summary),
    recentChapters: recent.map(chapter => chapterLine(chapter, 300)),
    thisChapterEarlierScenes: view.order.slice(0, view.positionOf(sceneId)).filter(item => item.chapterId === scene.chapterId && !options.exclude?.has(item.id)).slice(-12)
      .map(item => { const memory = view.sceneMemory(item.id, readerSafe); return { ...memory, summary: clip(memory.summary, 240) }; }),
  };
}

/** Open threads before the scene; threads naming the given people/things first, then the most recent. */
export function openThreads(view: StoryView, sceneId: string | undefined, names: string[], limit = 15): StoryThread[] {
  const open = view.ledgerBefore(sceneId).reverse();
  const relevant = open.filter(thread => names.some(name => name && thread.title.includes(name)));
  return [...new Set([...relevant, ...open])].slice(0, limit);
}

/** Where each entity was last seen, when that is outside the window the caller already shows in full. */
export function entityRecall(view: StoryView, sceneId: string, objectIds: string[], shown: Set<string>, limit = 8) {
  const result: Array<{ objectId: string; name: string; lastSeen: { sceneId: string; chapter: string; scene: string; summary: string }; excerpt: string; scenesAgo: number }> = [];
  for (const objectId of [...new Set(objectIds)]) {
    if (result.length >= limit) break;
    const object = view.workspace.objects.find(item => item.id === objectId);
    const last = object && view.lastAppearanceBefore(objectId, sceneId);
    if (!object || !last || shown.has(last.scene.id)) continue;
    const memory = view.sceneMemory(last.scene.id);
    result.push({ objectId, name: object.name,
      lastSeen: { sceneId: last.scene.id, chapter: view.chapters[view.chapterIndex(last.scene.chapterId)]?.title ?? '', scene: last.scene.title, summary: clip(memory.summary, 200) },
      excerpt: mentionExcerpt(last.scene.text, last.mention).text, scenesAgo: view.positionOf(sceneId) - view.positionOf(last.scene.id) });
  }
  return result;
}

/** Compact whole-book memory for overview contexts (coordinator, partner). */
export function storyOverview(view: StoryView, anchorChapterId?: string) {
  const volumes = view.volumes(), anchor = anchorChapterId ?? view.frontierChapterId();
  const at = Math.max(0, volumes.findIndex(volume => anchor && volume.chapterIds.includes(anchor)));
  const nearby = volumes.slice(Math.max(0, at - 5), at + 3);
  return {
    notice: storyNotice, book: view.bookSummary(),
    volumes: nearby.map(volume => ({ id: volume.id, title: volume.title, chapters: volume.chapterIds.length, summary: clip(view.volumeSummary(volume.id), 200) })),
    omittedVolumes: volumes.length - nearby.length,
    openThreads: openThreads(view, undefined, [], 10).map(thread => thread.title),
    coverage: view.coverage(),
  };
}
