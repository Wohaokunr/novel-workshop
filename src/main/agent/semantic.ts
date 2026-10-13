import type { Workspace } from '../../shared/types.js';
import type { NovelStore } from '../store.js';
import { checkCancelled, ModelOutputError, type EmbeddingTransport } from '../responses.js';
import { storyIndex, textHash } from './story-index.js';

/** Chunks embedded per request. */
const EMBED_BATCH = 64;
const DEMO_DIMENSIONS = 256;
const RELATIVE_FLOOR = 0.7;

export interface SemanticHit { sceneId: string; start: number; end: number; similarity: number }
export interface VectorChunk { sceneId: string; start: number; end: number; text: string; textHash: string }

/** The paragraph chunks of the keyword index, with the hash that tells whether a stored vector still describes them. */
export function vectorChunks(workspace: Workspace): VectorChunk[] {
  const index = storyIndex(workspace);
  return workspace.scenes.flatMap(scene => (index.scenes.get(scene.id)?.chunks ?? []).map(id => {
    const chunk = index.chunks.get(id)!, text = scene.text.slice(chunk.start, chunk.end);
    return { sceneId: scene.id, start: chunk.start, end: chunk.end, text, textHash: textHash(text) };
  }));
}
const key = (chunk: { sceneId: string; start: number }) => `${chunk.sceneId}:${chunk.start}`;

/** Embeds chunks that have no current vector and drops vectors of chunks that no longer exist. Returns the coverage afterwards. */
export async function indexVectors(store: NovelStore, projectId: string, embedder: EmbeddingTransport, model: string, signal: AbortSignal,
  onTokens: (tokens: number) => void): Promise<{ indexed: number; total: number }> {
  const chunks = vectorChunks(store.getProject(projectId));
  const stored = new Map(store.getStoryVectors(projectId, model).map(row => [key(row), row]));
  const missing = chunks.filter(chunk => { const row = stored.get(key(chunk)); return !row || row.textHash !== chunk.textHash || row.end !== chunk.end; });
  for (let at = 0; at < missing.length; at += EMBED_BATCH) {
    checkCancelled(signal);
    const batch = missing.slice(at, at + EMBED_BATCH), { vectors, tokens } = await embedder.embed(batch.map(chunk => chunk.text), signal);
    onTokens(tokens);
    if (vectors.length !== batch.length) throw new ModelOutputError('向量服务返回的数量与段落数量不一致');
    store.putStoryVectors(projectId, model, batch.map((chunk, index) => ({ ...chunk, vector: Float32Array.from(vectors[index]!) })));
  }
  store.pruneStoryVectors(projectId, model, new Set(chunks.map(key)));
  return { indexed: chunks.length, total: chunks.length };
}

/** How many of the book's chunks have a vector for their current text. */
export function vectorCoverage(store: NovelStore, workspace: Workspace, model: string): { indexed: number; total: number } {
  const chunks = vectorChunks(workspace), stored = new Map(store.getStoryVectors(workspace.id, model).map(row => [key(row), row.textHash]));
  return { indexed: chunks.filter(chunk => stored.get(key(chunk)) === chunk.textHash).length, total: chunks.length };
}

function cosine(a: Float32Array, b: number[]): number {
  let dot = 0, left = 0, right = 0;
  for (let index = 0; index < a.length; index++) { dot += a[index]! * b[index]!; left += a[index]! * a[index]!; right += b[index]! * b[index]!; }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

/** Chunks closest in meaning to the query vector, at most two per scene, and only those within RELATIVE_FLOOR of the best match:
 * similarity scales differ between models, so the cut is relative. A vector counts only while its chunk text is unchanged in this
 * (possibly candidate) workspace, and `allowed` filters scenes before scoring. */
export function nearestChunks(store: NovelStore, workspace: Workspace, model: string, query: number[], options: { allowed?: Set<string>; limit: number }): SemanticHit[] {
  const texts = new Map(workspace.scenes.map(scene => [scene.id, scene.text]));
  const scored = store.getStoryVectors(workspace.id, model).flatMap(row => {
    const text = texts.get(row.sceneId);
    if (text === undefined || (options.allowed && !options.allowed.has(row.sceneId)) || row.vector.length !== query.length || textHash(text.slice(row.start, row.end)) !== row.textHash) return [];
    return [{ sceneId: row.sceneId, start: row.start, end: row.end, similarity: cosine(row.vector, query) }];
  }).sort((a, b) => b.similarity - a.similarity).filter((hit, _index, all) => hit.similarity > 0 && hit.similarity >= all[0]!.similarity * RELATIVE_FLOOR);
  const perScene = new Map<string, number>(), result: SemanticHit[] = [];
  for (const hit of scored) {
    if ((perScene.get(hit.sceneId) ?? 0) >= 2) continue;
    perScene.set(hit.sceneId, (perScene.get(hit.sceneId) ?? 0) + 1); result.push(hit);
    if (result.length >= options.limit) break;
  }
  return result;
}

/** Offline stand-in for demo mode and tests: character bigrams hashed into a fixed number of dimensions. Not semantic, but it runs
 * the whole indexing and recall path without a model or network. */
export class DemoEmbeddingTransport implements EmbeddingTransport {
  async embed(texts: string[], signal: AbortSignal) {
    checkCancelled(signal);
    return { vectors: texts.map(text => {
      const vector = new Array<number>(DEMO_DIMENSIONS).fill(0), letters = Array.from(text.replace(/\s+/g, ''));
      for (let index = 0; index < letters.length - 1; index++) {
        let hash = 0x811c9dc5;
        for (const char of letters[index]! + letters[index + 1]!) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
        vector[hash % DEMO_DIMENSIONS]! += 1;
      }
      return vector;
    }), tokens: 0 };
  }
}
