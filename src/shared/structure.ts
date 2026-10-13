import type { Act, Chapter, Command, NarrativeScene, Passage, Workspace } from './types.js';

/** One chapter is one daily installment of a serial: about this many characters unless the author sets their own target. */
export const DEFAULT_CHAPTER_CHARS = 3500;
export function chapterTarget(workspace: Pick<Workspace, 'chapterTarget'>): number { return workspace.chapterTarget ?? DEFAULT_CHAPTER_CHARS; }
/** Characters as a serial counts them: everything but whitespace. */
export function proseChars(text: string | undefined): number { return (text ?? '').replace(/\s/g, '').length; }

export function orderedChapters(workspace: Pick<Workspace, 'chapters'>): Chapter[] { return [...workspace.chapters].sort((a, b) => a.order - b.order); }
export function chapterPassages(workspace: Pick<Workspace, 'passages'>, chapterId: string): Passage[] {
  return workspace.passages.filter(passage => passage.chapterId === chapterId).sort((a, b) => a.order - b.order);
}
const readingCache = new WeakMap<Passage[], WeakMap<Chapter[], Passage[]>>();
/** Every passage in reading order: chapters by order, then passages by order within the chapter. */
export function orderedPassages(workspace: Pick<Workspace, 'chapters' | 'passages'>): Passage[] {
  let byChapters = readingCache.get(workspace.passages);
  if (!byChapters) readingCache.set(workspace.passages, byChapters = new WeakMap());
  let result = byChapters.get(workspace.chapters);
  if (!result) {
    const rank = new Map(orderedChapters(workspace).map((chapter, index) => [chapter.id, index]));
    result = [...workspace.passages].sort((a, b) => (rank.get(a.chapterId) ?? Infinity) - (rank.get(b.chapterId) ?? Infinity) || a.order - b.order);
    byChapters.set(workspace.chapters, result);
  }
  return result;
}
/** A scene's passages in reading order; empty for a scene not placed in any chapter yet. */
export function scenePassages(workspace: Pick<Workspace, 'chapters' | 'passages'>, sceneId: string): Passage[] {
  return orderedPassages(workspace).filter(passage => passage.sceneId === sceneId);
}
export function sceneOf(workspace: Pick<Workspace, 'scenes'>, passage: Pick<Passage, 'sceneId'>): NarrativeScene | undefined {
  return workspace.scenes.find(scene => scene.id === passage.sceneId);
}
/** The scene's title, with 「（2/3）」 when the scene runs across several passages. */
export function passageLabel(workspace: Pick<Workspace, 'chapters' | 'passages' | 'scenes'>, passage: Passage): string {
  const title = sceneOf(workspace, passage)?.title ?? '场景';
  const parts = scenePassages(workspace, passage.sceneId);
  return parts.length > 1 ? `${title}（${parts.findIndex(item => item.id === passage.id) + 1}/${parts.length}）` : title;
}
export function chapterChars(workspace: Pick<Workspace, 'passages'>, chapterId: string): number {
  return workspace.passages.reduce((sum, passage) => sum + (passage.chapterId === chapterId ? proseChars(passage.text) : 0), 0);
}
/** A chapter's prose: its passages joined by blank lines. */
export function chapterProse(workspace: Pick<Workspace, 'passages'>, chapterId: string): string {
  return chapterPassages(workspace, chapterId).map(passage => passage.text).filter(text => text.trim()).join('\n\n');
}
/** Scenes in story order: by where their first passage is read, then scenes not placed in any chapter in the order they were made. */
export function orderedScenes(workspace: Pick<Workspace, 'chapters' | 'passages' | 'scenes'>): NarrativeScene[] {
  const first = new Map<string, number>();
  orderedPassages(workspace).forEach((passage, index) => { if (!first.has(passage.sceneId)) first.set(passage.sceneId, index); });
  return workspace.scenes.map((scene, index) => ({ scene, at: first.get(scene.id) ?? workspace.passages.length + index })).sort((a, b) => a.at - b.at).map(item => item.scene);
}

/** Consecutive chapters of the same volume (卷), in reading order; chapters outside any volume form runs without an act. */
export function volumeRuns(workspace: Pick<Workspace, 'chapters' | 'acts'>): Array<{ act?: Act; chapters: Chapter[] }> {
  const acts = new Map((workspace.acts ?? []).map(act => [act.id, act]));
  const runs: Array<{ act?: Act; chapters: Chapter[] }> = [];
  for (const chapter of orderedChapters(workspace)) {
    const act = chapter.actId ? acts.get(chapter.actId) : undefined, last = runs.at(-1);
    if (last && last.act?.id === act?.id) last.chapters.push(chapter); else runs.push({ ...(act ? { act } : {}), chapters: [chapter] });
  }
  return runs;
}

/** The order that puts a new passage at the end (or start) of a chapter. */
export function passageOrderAt(workspace: Pick<Workspace, 'passages'>, chapterId: string, at: 'start' | 'end' = 'end'): number {
  const orders = workspace.passages.filter(passage => passage.chapterId === chapterId).map(passage => passage.order);
  if (!orders.length) return 0;
  return at === 'end' ? Math.max(...orders) + 1 : Math.min(...orders) - 1;
}
/** Default title for a chapter added at the end of the book. */
export function nextChapterTitle(workspace: Pick<Workspace, 'chapters'>): string { return `第${workspace.chapters.length + 1}章`; }
/** A new chapter right after `after` (in its volume), or at the end of the book. */
export function newChapter(workspace: Pick<Workspace, 'chapters'>, id: string, after?: Chapter): Chapter {
  const sorted = orderedChapters(workspace), index = after ? sorted.findIndex(chapter => chapter.id === after.id) : sorted.length - 1;
  const previous = sorted[index], next = sorted[index + 1];
  const order = !previous ? 0 : next ? (previous.order + next.order) / 2 : previous.order + 1;
  const actId = (after ?? previous)?.actId;
  return { id, title: next ? '新章节' : nextChapterTitle(workspace), order, ...(actId ? { actId } : {}) };
}

/** The chapter after this one, created (in the same volume) when it is the last. */
function followingChapter(workspace: Workspace, chapterId: string, newId: () => string): { chapter: Chapter; commands: Command[] } {
  const sorted = orderedChapters(workspace), index = sorted.findIndex(chapter => chapter.id === chapterId);
  const next = sorted[index + 1];
  if (next) return { chapter: next, commands: [] };
  const chapter = newChapter(workspace, newId(), sorted[index]);
  return { chapter, commands: [{ type: 'putChapter', value: chapter }] };
}

/** A chapter break at `offset` inside a passage: the rest of its text, and the passages after it in this chapter, move to the start of
 * the next chapter (created when this is the last). The scene goes on in the next chapter as a new passage of the same scene. */
export function splitChapterCommands(workspace: Workspace, passageId: string, offset: number, newId: () => string): { commands: Command[]; chapterId: string } {
  const passage = workspace.passages.find(item => item.id === passageId);
  if (!passage) throw new Error('场景段不存在');
  const { chapter, commands } = followingChapter(workspace, passage.chapterId, newId);
  const cut = Math.max(0, Math.min(passage.text.length, Math.floor(offset)));
  const head = passage.text.slice(0, cut).replace(/\s+$/u, ''), tail = passage.text.slice(cut).replace(/^\s+/u, '');
  const following = chapterPassages(workspace, passage.chapterId).filter(item => item.order > passage.order);
  const moving: Passage[] = [];
  // Nothing before the cursor: the whole passage moves rather than leaving an empty one behind.
  if (!head.trim()) moving.push({ ...passage, text: tail });
  else {
    if (head !== passage.text) commands.push({ type: 'putPassage', value: { ...passage, text: head } });
    if (tail.trim()) moving.push({ id: newId(), sceneId: passage.sceneId, chapterId: chapter.id, order: 0, text: tail });
  }
  moving.push(...following);
  if (!moving.length) throw new Error('光标后没有可移到下一章的正文');
  // Ahead of what the next chapter already holds, in the order they were read.
  const start = workspace.passages.some(item => item.chapterId === chapter.id) ? passageOrderAt(workspace, chapter.id, 'start') + 1 - moving.length : 0;
  moving.forEach((item, index) => commands.push({ type: 'putPassage', value: { ...item, chapterId: chapter.id, order: start + index } }));
  return { commands, chapterId: chapter.id };
}

/** The scene goes on in the next chapter: a new, empty passage of it at the start of that chapter (created when needed). */
export function continueSceneCommands(workspace: Workspace, passageId: string, newId: () => string): { commands: Command[]; passage: Passage } {
  const passage = workspace.passages.find(item => item.id === passageId);
  if (!passage) throw new Error('场景段不存在');
  const { chapter, commands } = followingChapter(workspace, passage.chapterId, newId);
  const value: Passage = { id: newId(), sceneId: passage.sceneId, chapterId: chapter.id, order: passageOrderAt(workspace, chapter.id, 'start'), text: '' };
  commands.push({ type: 'putPassage', value });
  return { commands, passage: value };
}

/** Move a passage one step in reading order: within its chapter, or across the chapter boundary at either end. */
export function movePassageCommands(workspace: Workspace, passageId: string, direction: -1 | 1): Command[] {
  const passage = workspace.passages.find(item => item.id === passageId);
  if (!passage) throw new Error('场景段不存在');
  const siblings = chapterPassages(workspace, passage.chapterId), index = siblings.findIndex(item => item.id === passageId);
  const neighbour = siblings[index + direction];
  if (neighbour) return [{ type: 'putPassage', value: { ...passage, order: neighbour.order } }, { type: 'putPassage', value: { ...neighbour, order: passage.order } }];
  const chapters = orderedChapters(workspace), at = chapters.findIndex(chapter => chapter.id === passage.chapterId);
  const target = chapters[at + direction];
  if (!target) return [];
  return [{ type: 'putPassage', value: { ...passage, chapterId: target.id, order: passageOrderAt(workspace, target.id, direction < 0 ? 'end' : 'start') } }];
}
