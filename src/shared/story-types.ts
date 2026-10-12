import type { TokenUsage } from './types.js';

/** A thread (伏笔 / 悬念 / 承诺) the prose has opened. Ids are assigned locally, never by the model. */
export interface StoryThread { id: string; title: string }

/** Model-written digest of one scene. Derived from prose only, so it is safe for reader-side use up to that scene. */
export interface SceneDigest {
  kind: 'scene'; sceneId: string; textHash: string; chars: number;
  /** MinHash of the digested text, to tell a light revision (drifted) from a rewrite. */
  sketch: number[];
  summary: string; events: string[]; changes: Array<{ who: string; change: string }>;
  threadsOpened: StoryThread[]; threadsClosed: string[]; facts: string[];
  model: string; updatedAt: string;
}
/** Chapter / volume / book summaries rolled up from lower digests; recomputed only when inputHash changes. */
export interface RollupDigest {
  kind: 'chapter' | 'volume' | 'book'; targetId: string; inputHash: string; title: string;
  summary: string; model: string; updatedAt: string;
}
export type StoryDigest = SceneDigest | RollupDigest;

export interface StoryMemoryStatus {
  projectId: string; scenesWithText: number; fresh: number; drifted: number; pending: number; pendingChars: number;
  running: boolean; auto: boolean;
  /** Auto mode found a backlog too large to spend on silently; the author starts it explicitly. */
  awaitingConfirmation: boolean;
  lastError?: string; usage: TokenUsage; updatedAt?: string;
}

export interface StoryMemoryAPI {
  getStoryMemory(projectId: string): Promise<StoryMemoryStatus>;
  runStoryMemory(projectId: string): Promise<StoryMemoryStatus>;
  stopStoryMemory(projectId: string): Promise<StoryMemoryStatus>;
}
