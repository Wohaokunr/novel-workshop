import type { Chapter, NarrativeScene, Passage, Workspace } from '../../shared/types.js';
import type { PassageDigest, RollupDigest, StoryDigest, StoryThread } from '../../shared/story-types.js';
import { orderedChapters, orderedPassages, passageLabel } from '../../shared/structure.js';
import { extractSummary, indexTerms, mentionExcerpt, passageHash, passageMentions, sketchSimilarity, storyIndex, textHash, textSketch, type Mention, type StoryIndex } from './story-index.js';

/** fresh: digest of this exact text; drifted: digest of an earlier, mostly similar version; extract: zero-token fallback. */
export type Freshness = 'fresh' | 'drifted' | 'extract';
export const DRIFT_SIMILARITY = 0.7;
export const VOLUME_CHAPTERS = 10;
/** Two threads worded this alike (bigram Jaccard) are the same thread opened twice. Short titles need more: 「她为何离开」 and
 * 「他为何离开」 share most bigrams but are different threads. */
export function sameThread(a: string, b: string): boolean {
  return threadSimilarity(a, b) >= (Math.min(termSet(a).size, termSet(b).size) >= 8 ? 0.5 : 0.75);
}
/** A minor thread no passage summary has touched for this many chapters is stale: listed after everything else, so it only gives way
 * when the list is crowded. Major threads never go stale. */
export const THREAD_EXPIRY_CHAPTERS = 30;
/** An open thread with the passage that opened it and the last chapter whose summary picked up its wording. */
export interface LedgerThread extends StoryThread { passageId: string; chapterIndex: number; lastChapterIndex: number }

function termSet(text: string): Set<string> { return new Set(indexTerms(text)); }
function sharedTerms(a: string, b: string) {
  const left = termSet(a), right = termSet(b);
  let shared = 0;
  for (const term of left) if (right.has(term)) shared++;
  return { shared, left: left.size, right: right.size };
}
export function threadSimilarity(a: string, b: string): number {
  const { shared, left, right } = sharedTerms(a, b);
  return left && right ? shared / (left + right - shared) : 0;
}
/** How much of the shorter wording the other one contains; a rewording usually adds words rather than replacing them. */
export function threadOverlap(a: string, b: string): number {
  const { shared, left, right } = sharedTerms(a, b);
  return left && right ? shared / Math.min(left, right) : 0;
}
export interface PassageMemory { title?: string; freshness: Freshness; summary: string; events?: string[]; changes?: PassageDigest['changes']; facts?: string[] }
export interface Volume { id: string; title: string; chapterIds: string[] }

function clip(text: string, length: number): string { return text.length > length ? `${text.slice(0, length)}…` : text; }

/** Read-only projection of a workspace plus its stored digests. Pure: works on candidate workspaces too. The prose is read as passages
 * in reading order (chapters in order, passages in chapter order); a scene running through several chapters is several passages. */
export class StoryView {
  readonly index: StoryIndex;
  readonly order: Passage[];
  readonly chapters: Chapter[];
  private readonly position = new Map<string, number>();
  private readonly chapterPosition = new Map<string, number>();
  private readonly scenes: Map<string, NarrativeScene>;
  private readonly passageDigests = new Map<string, PassageDigest>();
  private readonly rollups = new Map<string, RollupDigest>();
  private readonly freshnessCache = new Map<string, Freshness>();
  private volumeCache?: Volume[];

  constructor(readonly workspace: Workspace, digests: StoryDigest[] = []) {
    this.index = storyIndex(workspace);
    this.chapters = orderedChapters(workspace);
    this.chapters.forEach((chapter, index) => this.chapterPosition.set(chapter.id, index));
    this.order = orderedPassages(workspace);
    this.order.forEach((passage, index) => this.position.set(passage.id, index));
    this.scenes = new Map(workspace.scenes.map(scene => [scene.id, scene]));
    for (const digest of digests) {
      if (digest.kind === 'passage') this.passageDigests.set(digest.passageId, digest);
      else this.rollups.set(`${digest.kind}:${digest.targetId}`, digest);
    }
  }

  passage(id: string): Passage | undefined { const at = this.position.get(id); return at === undefined ? undefined : this.order[at]; }
  scene(id: string): NarrativeScene | undefined { return this.scenes.get(id); }
  /** The scene a passage belongs to. */
  sceneOf(passageId: string): NarrativeScene | undefined { const passage = this.passage(passageId); return passage && this.scenes.get(passage.sceneId); }
  /** 「雨夜对峙（2/3）」: the scene title, and which of its passages this is when the scene runs through several chapters. */
  label(passageId: string): string { const passage = this.passage(passageId); return passage ? passageLabel(this.workspace, passage) : ''; }
  positionOf(passageId: string): number { return this.position.get(passageId) ?? -1; }
  chapterIndex(id: string): number { return this.chapterPosition.get(id) ?? -1; }
  /** Passages of a scene in reading order. */
  scenePassages(sceneId: string): Passage[] { return this.order.filter(passage => passage.sceneId === sceneId); }

  freshness(passageId: string): Freshness {
    const cached = this.freshnessCache.get(passageId);
    if (cached) return cached;
    const passage = this.passage(passageId), digest = this.passageDigests.get(passageId);
    let result: Freshness = 'extract';
    if (passage?.text.trim() && digest) {
      if (digest.textHash === passageHash(this.index, passageId)) result = 'fresh';
      else if (sketchSimilarity(digest.sketch, textSketch(passage.text)) >= DRIFT_SIMILARITY) result = 'drifted';
    }
    this.freshnessCache.set(passageId, result);
    return result;
  }
  digest(passageId: string): PassageDigest | undefined { return this.freshness(passageId) === 'extract' ? undefined : this.passageDigests.get(passageId); }
  storedDigest(passageId: string): PassageDigest | undefined { return this.passageDigests.get(passageId); }
  rollup(kind: RollupDigest['kind'], id: string): RollupDigest | undefined { return this.rollups.get(`${kind}:${id}`); }

  /** readerSafe omits titles, outlines and beats (author material); digests themselves derive from prose only. */
  passageMemory(passageId: string, readerSafe = false): PassageMemory {
    const passage = this.passage(passageId)!, scene = this.scenes.get(passage.sceneId), digest = this.digest(passageId), freshness = this.freshness(passageId);
    const title = readerSafe ? undefined : this.label(passageId);
    if (digest) return { title, freshness, summary: digest.summary, events: digest.events, changes: digest.changes, facts: digest.facts };
    const { opening, closing } = extractSummary(passage.text);
    const plan = readerSafe ? '' : [scene?.outline.trim() ? `大纲：${clip(scene.outline.trim(), 120)}` : '', passage.beat?.trim() ? `本段：${clip(passage.beat.trim(), 80)}` : ''].filter(Boolean).join(' / ');
    const parts = [plan, opening ? `开头：${opening}` : '', closing ? `结尾：${closing}` : ''].filter(Boolean);
    return { title, freshness, summary: parts.join(' / ') || (readerSafe ? '' : '（尚无正文）') };
  }

  /** Passages whose prose has no up-to-date digest, in reading order. */
  pending(): Passage[] { return this.order.filter(passage => passage.text.trim() && this.freshness(passage.id) !== 'fresh'); }
  coverage() {
    let passagesWithText = 0, fresh = 0, drifted = 0, pendingChars = 0;
    for (const passage of this.order) {
      if (!passage.text.trim()) continue;
      passagesWithText++;
      const freshness = this.freshness(passage.id);
      if (freshness === 'fresh') fresh++; else { if (freshness === 'drifted') drifted++; pendingChars += passage.text.length; }
    }
    return { passagesWithText, fresh, drifted, pending: passagesWithText - fresh, pendingChars };
  }

  /** Hash of the digests a chapter rollup summarises; undefined until every written passage has one. */
  chapterInput(chapterId: string): { hash: string; passages: Array<{ summary: string; events: string[] }> } | undefined {
    const passages = this.order.filter(passage => passage.chapterId === chapterId && passage.text.trim());
    if (!passages.length || passages.some(passage => !this.digest(passage.id))) return undefined;
    const value = passages.map(passage => { const digest = this.digest(passage.id)!; return { summary: digest.summary, events: digest.events }; });
    return { hash: textHash(JSON.stringify(value)), passages: value };
  }
  chapterSummary(chapterId: string, readerSafe = false): { summary: string; freshness: Freshness } {
    const rollup = this.rollup('chapter', chapterId);
    if (rollup) return { summary: rollup.summary, freshness: rollup.inputHash === this.chapterInput(chapterId)?.hash ? 'fresh' : 'drifted' };
    const chapter = this.chapters[this.chapterIndex(chapterId)];
    const joined = this.order.filter(passage => passage.chapterId === chapterId && passage.text.trim()).map(passage => this.passageMemory(passage.id, readerSafe).summary).join(' ');
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
    const chapters = volume?.chapterIds.map(id => ({ id, rollup: this.rollup('chapter', id) })).filter(item => item.rollup || this.order.some(passage => passage.chapterId === item.id && passage.text.trim()));
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

  /** Threads opened and not yet closed before this passage (or anywhere when omitted), oldest first. A thread worded like one
   * already open is merged into it (closing either closes it, and it is major if either is). */
  ledgerBefore(passageId?: string): LedgerThread[] {
    const end = passageId === undefined ? this.order.length : Math.max(0, this.positionOf(passageId));
    const open = new Map<string, LedgerThread>(), alias = new Map<string, string>();
    const terms = new Map<string, Set<string>>(), postings = new Map<string, Set<string>>();
    const remove = (id: string) => {
      for (const term of terms.get(id) ?? []) postings.get(term)?.delete(id);
      terms.delete(id); open.delete(id);
    };
    for (let index = 0; index < end; index++) {
      const passage = this.order[index]!, digest = this.digest(passage.id);
      if (!digest) continue;
      const chapterIndex = this.chapterIndex(passage.chapterId), hits = new Map<string, number>();
      for (const term of termSet([digest.summary, ...digest.events].join(' '))) for (const id of postings.get(term) ?? []) hits.set(id, (hits.get(id) ?? 0) + 1);
      for (const [id, count] of hits) if (count * 2 >= terms.get(id)!.size) open.set(id, { ...open.get(id)!, lastChapterIndex: chapterIndex });
      for (const id of digest.threadsClosed) remove(alias.get(id) ?? id);
      for (const thread of digest.threadsOpened) {
        const own = termSet(thread.title), candidates = new Set<string>();
        for (const term of own) for (const id of postings.get(term) ?? []) candidates.add(id);
        const same = [...candidates].find(id => sameThread(open.get(id)!.title, thread.title));
        if (same) {
          alias.set(thread.id, same);
          if (thread.major && !open.get(same)!.major) open.set(same, { ...open.get(same)!, major: true });
          continue;
        }
        open.set(thread.id, { ...thread, passageId: passage.id, chapterIndex, lastChapterIndex: chapterIndex });
        terms.set(thread.id, own);
        for (const term of own) { let posting = postings.get(term); if (!posting) postings.set(term, posting = new Set()); posting.add(thread.id); }
      }
    }
    return [...open.values()];
  }

  lastAppearanceBefore(objectId: string, passageId: string): { passage: Passage; mention: Mention } | undefined {
    for (let index = this.positionOf(passageId) - 1; index >= 0; index--) {
      const passage = this.order[index]!, mention = passageMentions(this.index, passage.id).get(objectId);
      if (mention) return { passage, mention };
    }
    return undefined;
  }
  timeline(objectId: string): Array<{ passage: Passage; mention: Mention }> {
    return this.order.flatMap(passage => { const mention = passageMentions(this.index, passage.id).get(objectId); return mention ? [{ passage, mention }] : []; });
  }
  mentionCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const passage of this.order) for (const [id, mention] of passageMentions(this.index, passage.id)) counts.set(id, (counts.get(id) ?? 0) + mention.count);
    return counts;
  }
  /** The latest chapter that has prose: the default focus when no target is given. */
  frontierChapterId(): string | undefined { return [...this.order].reverse().find(passage => passage.text.trim())?.chapterId ?? this.chapters[0]?.id; }

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

export const storyNotice = '故事记忆是由正文生成的辅助摘要，不是正式事实；与原文冲突时以原文和领域记录为准。drifted 表示摘要基于该段较早版本。';

/** Layered "story so far" for a passage: book → earlier volumes → recent chapters → earlier passages of this chapter. */
export function storySoFar(view: StoryView, passageId: string, options: { readerSafe?: boolean; recentChapters?: number; exclude?: Set<string> } = {}) {
  const passage = view.passage(passageId)!, readerSafe = !!options.readerSafe;
  const chapterAt = view.chapterIndex(passage.chapterId), volume = view.volumeOf(passage.chapterId);
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
    thisChapterEarlierPassages: view.order.slice(0, view.positionOf(passageId)).filter(item => item.chapterId === passage.chapterId && !options.exclude?.has(item.id)).slice(-12)
      .map(item => { const memory = view.passageMemory(item.id, readerSafe); return { ...memory, summary: clip(memory.summary, 240) }; }),
  };
}

/** Open threads before the passage: those naming the given people/things, then major threads, then recently active ones, newest first;
 * stale minor threads (see THREAD_EXPIRY_CHAPTERS) come last, so they no longer crowd out live ones. */
export function openThreads(view: StoryView, passageId: string | undefined, names: string[], limit = 15): StoryThread[] {
  const open = view.ledgerBefore(passageId).reverse();
  const here = passageId ? view.chapterIndex(view.passage(passageId)?.chapterId ?? '') : view.chapters.length - 1;
  const relevant = open.filter(thread => names.some(name => name && thread.title.includes(name)));
  const live = open.filter(thread => here - thread.lastChapterIndex <= THREAD_EXPIRY_CHAPTERS);
  return [...new Set([...relevant, ...open.filter(thread => thread.major), ...live, ...open])].slice(0, limit).map(({ id, title, major }) => ({ id, title, ...(major ? { major } : {}) }));
}

/** What the digest model is shown to close: major threads, threads whose wording the batch's prose picks up, then the most recent.
 * Unlike a recency window this lets an early main-line mystery be closed hundreds of chapters later. Oldest first. */
export function ledgerForDigest(open: LedgerThread[], prose: string, limit = 60): LedgerThread[] {
  const text = termSet(prose);
  const relevance = (thread: LedgerThread) => { const own = termSet(thread.title); let shared = 0; for (const term of own) if (text.has(term)) shared++; return own.size ? shared / own.size : 0; };
  const newest = [...open].reverse();
  const picked = new Set([...new Set([...newest.filter(thread => thread.major).slice(0, limit / 2),
    ...newest.map(thread => ({ thread, score: relevance(thread) })).filter(item => item.score >= 0.5).sort((a, b) => b.score - a.score).map(item => item.thread), ...newest])].slice(0, limit));
  return open.filter(thread => picked.has(thread));
}

/** Where each entity was last seen, when that is outside the window the caller already shows in full. */
export function entityRecall(view: StoryView, passageId: string, objectIds: string[], shown: Set<string>, limit = 8) {
  const result: Array<{ objectId: string; name: string; lastSeen: { passageId: string; chapter: string; scene: string; summary: string }; excerpt: string; passagesAgo: number }> = [];
  for (const objectId of [...new Set(objectIds)]) {
    if (result.length >= limit) break;
    const object = view.workspace.objects.find(item => item.id === objectId);
    const last = object && view.lastAppearanceBefore(objectId, passageId);
    if (!object || !last || shown.has(last.passage.id)) continue;
    const memory = view.passageMemory(last.passage.id);
    result.push({ objectId, name: object.name,
      lastSeen: { passageId: last.passage.id, chapter: view.chapters[view.chapterIndex(last.passage.chapterId)]?.title ?? '', scene: view.label(last.passage.id), summary: clip(memory.summary, 200) },
      excerpt: mentionExcerpt(last.passage.text, last.mention).text, passagesAgo: view.positionOf(passageId) - view.positionOf(last.passage.id) });
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
