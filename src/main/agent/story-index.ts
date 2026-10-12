import { createHash } from 'node:crypto';
import type { Workspace } from '../../shared/types.js';

/** Zero-token index over prose: paragraph chunks, an inverted bigram index and entity mentions.
 * Rebuilt incrementally per scene; nothing here calls a model or leaves the process. */
export const CHUNK_CHARS = 500;
const MAX_CACHED_PROJECTS = 3;

export interface IndexChunk { id: number; sceneId: string; start: number; end: number; terms: string[] }
export interface Mention { count: number; first: number; last: number }
interface SceneEntry { text: string; hash: string; chunks: number[]; mentions: Map<string, Mention> }
export interface StoryIndex {
  projectId: string; scenes: Map<string, SceneEntry>; chunks: Map<number, IndexChunk>;
  postings: Map<string, Set<number>>; nextChunk: number; namesKey: string; names: Array<{ id: string; name: string }>;
}

export function textHash(text: string): string { return createHash('sha1').update(text, 'utf8').digest('hex'); }

/** Index terms: Han bigrams (single Han characters for one-letter runs) and lowercase non-Han words. */
export function indexTerms(text: string): string[] {
  const lower = text.toLowerCase(), terms = new Set<string>();
  for (const word of lower.match(/[\p{L}\p{N}_]+/gu) ?? []) if (!/\p{Script=Han}/u.test(word) && word.length <= 32) terms.add(word);
  for (const run of lower.match(/\p{Script=Han}+/gu) ?? []) {
    const letters = Array.from(run);
    if (letters.length === 1) terms.add(run);
    for (let index = 0; index < letters.length - 1; index++) terms.add(letters[index]! + letters[index + 1]!);
  }
  return [...terms];
}

/** Paragraph-aligned chunks of roughly CHUNK_CHARS; long paragraphs split at the nearest sentence end. */
export function chunkText(text: string): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_CHARS);
    if (end < text.length) {
      const paragraph = text.lastIndexOf('\n', end);
      if (paragraph > start + CHUNK_CHARS / 2) end = paragraph + 1;
      else {
        const window = text.slice(start + CHUNK_CHARS / 2, Math.min(text.length, start + CHUNK_CHARS * 1.5));
        const stop = window.search(/[。！？!?…][”」』"）)]*/);
        if (stop >= 0) end = start + CHUNK_CHARS / 2 + stop + (window.slice(stop).match(/^[。！？!?…]+[”」』"）)]*/)?.[0].length ?? 1);
      }
    }
    if (text.slice(start, end).trim()) result.push({ start, end });
    start = end;
  }
  return result;
}

/** 16-value MinHash over character bigrams; estimates how much of a scene changed since its digest. */
export function textSketch(text: string): number[] {
  const sketch = new Array<number>(16).fill(0xffffffff);
  const letters = Array.from(text.replace(/\s+/g, ''));
  for (let index = 0; index < letters.length - 1; index++) {
    const gram = letters[index]! + letters[index + 1]!;
    let base = 0x811c9dc5;
    for (let char = 0; char < gram.length; char++) base = Math.imul(base ^ gram.charCodeAt(char), 0x01000193) >>> 0;
    for (let seed = 0; seed < 16; seed++) {
      const value = Math.imul(base ^ Math.imul(seed + 1, 0x9e3779b1), 0x85ebca6b) >>> 0;
      if (value < sketch[seed]!) sketch[seed] = value;
    }
  }
  return sketch;
}
export function sketchSimilarity(a: number[] | undefined, b: number[]): number {
  if (!a || a.length !== b.length) return 0;
  return a.filter((value, index) => value === b[index]).length / a.length;
}

const cache = new Map<string, StoryIndex>();

function mentionsOf(text: string, names: StoryIndex['names']): Map<string, Mention> {
  const result = new Map<string, Mention>();
  for (const { id, name } of names) {
    let at = text.indexOf(name), count = 0, first = -1, last = -1;
    while (at >= 0) { count++; if (first < 0) first = at; last = at; at = text.indexOf(name, at + name.length); }
    if (count) result.set(id, { count, first, last });
  }
  return result;
}

function removeScene(index: StoryIndex, sceneId: string) {
  const entry = index.scenes.get(sceneId);
  if (!entry) return;
  for (const id of entry.chunks) {
    for (const term of index.chunks.get(id)?.terms ?? []) {
      const posting = index.postings.get(term);
      posting?.delete(id);
      if (posting && !posting.size) index.postings.delete(term);
    }
    index.chunks.delete(id);
  }
  index.scenes.delete(sceneId);
}

/** The shared index for this workspace's scenes; a candidate workspace re-syncs only the scenes that differ. */
export function storyIndex(workspace: Workspace): StoryIndex {
  let index = cache.get(workspace.id);
  if (index) cache.delete(workspace.id);
  else index = { projectId: workspace.id, scenes: new Map(), chunks: new Map(), postings: new Map(), nextChunk: 0, namesKey: '', names: [] };
  cache.set(workspace.id, index);
  while (cache.size > MAX_CACHED_PROJECTS) cache.delete(cache.keys().next().value!);

  const names = workspace.objects.filter(object => Array.from(object.name.trim()).length >= 2).map(object => ({ id: object.id, name: object.name.trim() }));
  const namesKey = names.map(item => `${item.id}\u0000${item.name}`).join('\u0001');
  const renamed = namesKey !== index.namesKey;
  index.names = names; index.namesKey = namesKey;
  const live = new Set<string>();
  for (const scene of workspace.scenes) {
    live.add(scene.id);
    const entry = index.scenes.get(scene.id);
    if (entry && entry.text === scene.text) { if (renamed) entry.mentions = mentionsOf(scene.text, names); continue; }
    removeScene(index, scene.id);
    const chunks: number[] = [];
    for (const range of chunkText(scene.text)) {
      const id = index.nextChunk++, terms = indexTerms(scene.text.slice(range.start, range.end));
      index.chunks.set(id, { id, sceneId: scene.id, ...range, terms });
      for (const term of terms) { let posting = index.postings.get(term); if (!posting) index.postings.set(term, posting = new Set()); posting.add(id); }
      chunks.push(id);
    }
    index.scenes.set(scene.id, { text: scene.text, hash: textHash(scene.text), chunks, mentions: mentionsOf(scene.text, names) });
  }
  for (const id of [...index.scenes.keys()]) if (!live.has(id)) removeScene(index, id);
  return index;
}

export function sceneHash(index: StoryIndex, sceneId: string): string | undefined { return index.scenes.get(sceneId)?.hash; }
export function sceneMentions(index: StoryIndex, sceneId: string): Map<string, Mention> { return index.scenes.get(sceneId)?.mentions ?? new Map(); }

export interface ChunkHit { sceneId: string; start: number; end: number; score: number; matchedTerms: number; containsNeedle: boolean }

/** BM25 over candidate chunks. `allowed` filters scenes before any scoring, so query words never widen access. */
export function searchChunks(index: StoryIndex, workspace: Workspace, query: string, options: { allowed?: Set<string>; limit: number; perScene?: number }): ChunkHit[] {
  const needle = query.trim().slice(0, 256).toLowerCase();
  const terms = indexTerms(needle).filter(term => index.postings.has(term)).slice(0, 128);
  if (!needle || !terms.length) return [];
  const total = Math.max(1, index.chunks.size);
  const candidates = new Set<number>();
  for (const term of terms) for (const id of index.postings.get(term)!) {
    const chunk = index.chunks.get(id)!;
    if (!options.allowed || options.allowed.has(chunk.sceneId)) candidates.add(id);
  }
  const texts = new Map(workspace.scenes.map(scene => [scene.id, scene.text]));
  const hits: ChunkHit[] = [];
  for (const id of candidates) {
    const chunk = index.chunks.get(id)!;
    const text = (texts.get(chunk.sceneId) ?? '').slice(chunk.start, chunk.end).toLowerCase();
    let score = 0, matchedTerms = 0;
    for (const term of terms) {
      const posting = index.postings.get(term)!;
      if (!posting.has(id)) continue;
      let frequency = 0, at = text.indexOf(term);
      while (at >= 0) { frequency++; at = text.indexOf(term, at + term.length); }
      matchedTerms++;
      const df = posting.size, idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      score += idf * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * text.length / CHUNK_CHARS));
    }
    const containsNeedle = text.includes(needle);
    if (containsNeedle) score += 4;
    hits.push({ sceneId: chunk.sceneId, start: chunk.start, end: chunk.end, score, matchedTerms, containsNeedle });
  }
  hits.sort((a, b) => b.score - a.score);
  const perScene = new Map<string, number>(), result: ChunkHit[] = [];
  for (const hit of hits) {
    const used = perScene.get(hit.sceneId) ?? 0;
    if (used >= (options.perScene ?? 2)) continue;
    perScene.set(hit.sceneId, used + 1); result.push(hit);
    if (result.length >= options.limit) break;
  }
  return result;
}

/** A short raw excerpt around an entity's last mention in a scene. */
export function mentionExcerpt(text: string, mention: Mention, radius = 150): { start: number; end: number; text: string } {
  const start = Math.max(0, mention.last - radius), end = Math.min(text.length, mention.last + radius);
  return { start, end, text: text.slice(start, end) };
}

/** Zero-token stand-in for a missing digest: the opening sentence and the closing lines. */
export function extractSummary(text: string): { opening: string; closing: string } {
  const trimmed = text.trim();
  const opening = (trimmed.match(/^[^。！？!?\n]{0,80}[。！？!?]?/)?.[0] ?? trimmed.slice(0, 80)).trim();
  const closing = trimmed.length > opening.length ? trimmed.slice(-120).trim() : '';
  return { opening, closing };
}
