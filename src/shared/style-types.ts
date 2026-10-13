import type { TokenUsage } from './types.js';
/** The author's voice: what the writer imitates and what the stylist reviews against. */
export type StylePerson = 'first' | 'third-limited' | 'third-omniscient' | 'free';
export type StyleScale = 1 | 2 | 3 | 4 | 5;
export const STYLE_SCALES = ['distance', 'sentence', 'ornament', 'dialogue', 'interiority', 'register', 'pace'] as const;
export type StyleScaleId = typeof STYLE_SCALES[number];
/** null means the author has not decided; the writer then follows the samples. */
export type StyleDials = { person: StylePerson | null } & { [K in StyleScaleId]: StyleScale | null };

export interface StyleSample {
  id: string; label: string; text: string;
  /** own: the author's writing; reference: someone else's, imitated for technique only. */
  source: 'own' | 'reference';
  sceneId?: string; author?: string; note?: string; pinned?: boolean;
}
export type StyleOrigin = 'author' | 'samples' | 'edits' | 'rejection' | 'blindtest' | 'choice';
export interface StyleRule { id: string; kind: 'do' | 'avoid'; content: string; origin: StyleOrigin; evidence?: string }
/** Learned from edits / rejections; becomes a rule or word only when the author adopts it. */
export interface StyleSuggestion extends StyleRule {
  status: 'pending' | 'dismissed'; createdAt: string;
  /** Adopting as a word list entry instead of a rule. */
  word?: { list: 'preferWords' | 'avoidWords'; value: string };
}
export interface CharacterVoice { characterId: string; voice: string }
export interface StyleProfile {
  summary: string; dials: StyleDials; rules: StyleRule[];
  preferWords: string[]; avoidWords: string[]; blockAiCliches: boolean;
  samples: StyleSample[]; voices: CharacterVoice[]; suggestions: StyleSuggestion[];
}
export const STYLE_KEYS = ['summary', 'dials', 'rules', 'preferWords', 'avoidWords', 'blockAiCliches', 'samples', 'voices', 'suggestions'] as const;
export type StyleKey = typeof STYLE_KEYS[number];

export const STYLE_LIMITS = { samples: 20, sampleChars: 4000, samplesTotal: 30_000, rules: 60, words: 200, suggestions: 80, summary: 2000, voice: 600 } as const;

export function emptyDials(): StyleDials {
  return { person: null, distance: null, sentence: null, ornament: null, dialogue: null, interiority: null, register: null, pace: null };
}
export function emptyStyle(): StyleProfile {
  return { summary: '', dials: emptyDials(), rules: [], preferWords: [], avoidWords: [], blockAiCliches: true, samples: [], voices: [], suggestions: [] };
}
/** Fill defaults for workspaces created before the style profile existed. */
export function styleProfile(workspace: { style?: Partial<StyleProfile> }): StyleProfile {
  const base = emptyStyle(), style = workspace.style ?? {};
  return { ...base, ...style, dials: { ...base.dials, ...(style.dials ?? {}) } };
}

export const personNames: Record<StylePerson, string> = { first: '第一人称', 'third-limited': '第三人称限知', 'third-omniscient': '第三人称全知', free: '视角自由切换' };
/** [label, low end, high end] — each scale is a five-step range between the two ends. */
export const scaleNames: Record<StyleScaleId, [string, string, string]> = {
  distance: ['叙述距离', '贴身', '疏离'],
  sentence: ['句子长短', '短促', '绵长'],
  ornament: ['修辞浓度', '白描', '浓丽'],
  dialogue: ['对白比重', '少对白', '对白驱动'],
  interiority: ['心理描写', '外显动作', '深入内心'],
  register: ['语言质地', '口语网感', '书面典雅'],
  pace: ['叙事节奏', '紧凑', '舒缓'],
};
export const originNames: Record<StyleOrigin, string> = { author: '作者', samples: '范文', edits: '改稿', rejection: '拒稿', blindtest: '盲测', choice: '方案取舍' };

/** Edits made to AI prose, collected without a model call. */
export interface StyleEditPair { key: string; sceneId: string; sceneTitle: string; hunks: Array<{ before: string; after: string }>; at: string }
export interface StyleRejection { key: string; reason: string; label: string; at: string }
/** One adoption among several companion options: what the author took and what they passed over in the same reply. */
export interface StyleChoice { key: string; mode: string; chosen: string[]; passedOver: string[]; at: string }
export interface StyleLearningStatus {
  projectId: string; pendingEdits: number; pendingRejections: number; running: boolean; lastError?: string;
  /** Companion replies where the author adopted some options over others, not yet learned from. */
  pendingChoices: number;
  /** Repeatedly deleted words, a zero-token hint. */
  deletedWords: Array<{ word: string; count: number }>;
  /** Tokens style learning used since the app started. */
  usage: TokenUsage;
}
export interface StyleAPI {
  getStyleLearning(projectId: string): Promise<StyleLearningStatus>;
  /** Collect pending edits / rejections and ask the summary model for suggestions. */
  learnStyle(projectId: string): Promise<StyleLearningStatus>;
}
