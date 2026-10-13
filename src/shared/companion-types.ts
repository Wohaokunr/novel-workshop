import type { SourceReference, TokenUsage } from './types.js';

/** Lightweight creative partner modes; each surface of the app summons one of them. */
export type CompanionMode = 'diverge' | 'causality' | 'structure' | 'outline' | 'beat' | 'develop' | 'style';
export type CompanionSurface = 'canvas' | 'world' | 'story' | 'outline' | 'writer' | 'panel' | 'style';
/** How far the partner may depart from what the author already has. */
export type CompanionIntensity = 'steady' | 'bold' | 'wild';
export type OutlineNodeKind = 'book' | 'act' | 'chapter' | 'scene';
/** What the develop mode should infer and fill in. */
export type CompanionFocus = 'profile' | 'theme' | 'logline' | 'brief' | 'cast' | 'setting' | 'distill' | 'blindtest';
/** Work fields the partner may propose values for. */
export const companionNovelFields = ['theme', 'logline', 'brief', 'genre', 'audience'] as const;
export type CompanionNovelField = typeof companionNovelFields[number];

export interface CompanionAnchor {
  surface: CompanionSurface;
  references: SourceReference[];
  /** Absolute canvas / graph position used to place adopted cards. */
  point?: { x: number; y: number };
  outlineNode?: { kind: OutlineNodeKind; id?: string };
  /** The scene the author is at; in the writer, the scene of passageId, the passage being written. */
  sceneId?: string;
  passageId?: string;
  focus?: CompanionFocus;
}

/** options: 0–4 concrete answers the author can pick instead of typing. */
export interface CompanionQuestion { id: string; question: string; why: string; options?: string[] }
export type CompanionIdeaKind = 'whatif' | 'twist' | 'conflict' | 'character' | 'setting' | 'theme' | 'beat';
export interface CompanionIdea { id: string; kind: CompanionIdeaKind; title: string; content: string; hook: string }
export type CompanionOpKind = 'addAct' | 'updateAct' | 'addChapter' | 'updateChapter' | 'addScene' | 'updateScene' | 'moveScene' | 'continueScene' | 'changeState'
  | 'addEvent' | 'addCard' | 'updateNovel' | 'addCharacter' | 'updateCharacter' | 'addSetting' | 'updateSetting' | 'link' | 'addCause' | 'updateStyle';
/** Flat, strict-schema friendly operation. Empty / null fields mean "not provided" or "unchanged". */
export interface CompanionOp {
  id: string; op: CompanionOpKind;
  /** Temporary handle for new items so later ops can reference them. */
  ref: string | null;
  /** Existing entity id for update / move ops (a scene, or one passage of it), the effect event for a new cause, the chapter a new
   * chapter follows, the scene a continueScene carries on, or the character / setting whose state changeState records. */
  targetId: string | null;
  /** The parent: a chapter's volume, a scene's chapter, a link's other end, or the scene (or passage) where changeState happens. */
  parentRef: string | null; parentId: string | null;
  title: string | null; content: string | null; purpose: string | null;
  /** 1-based position among siblings (for scene ops, among the chapter's passages); null appends. */
  order: number | null;
  povName: string | null;
  causes: string[];
  /** Characters: event participants, or a scene's cast. */
  people: string[];
  /** Scene ops: settings (names, ids or refs) where the scene happens. Missing on older stored threads. */
  places?: string[];
  /** Scene ops: world events (ids, refs or names) the scene presents; changeState: the event the change comes with. */
  events?: string[];
  /** updateNovel: which work field content replaces; updateStyle: summary, dial:<id>, rule:do, rule:avoid, preferWords, avoidWords or voice;
   * changeState: the aspect that changes (心理、视角、认知、动机、状态、氛围 or the author's own, such as 境界). */
  field?: string | null;
}
/** Result of applying a proposal to the work right after it was generated: ops adoption would skip, or why it cannot apply at all. */
export interface ProposalCheck { skipped: Array<{ opId: string; reason: string }>; error?: string }
export interface CompanionProposal { id: string; title: string; summary: string; ops: CompanionOp[]; check?: ProposalCheck }
export interface CompanionResponse {
  reply: string; questions: CompanionQuestion[]; ideas: CompanionIdea[]; proposals: CompanionProposal[]; followUps: string[];
}

/** Choices the author makes in the interface. The message text never triggers them. */
export interface CompanionAskOptions {
  /** Outline mode: draft all three layers (acts → chapters → scenes) at once; a large, costly answer. */
  fullDraft?: boolean;
  /** Develop mode: give versions now instead of asking questions first. */
  versions?: boolean;
}
export interface CompanionTurn {
  id: string; role: 'author' | 'companion'; text: string; at: string;
  intensity?: CompanionIntensity;
  /** Author turns: the explicit choices sent with this message. */
  options?: CompanionAskOptions;
  /** Companion turns: tokens this reply used. */
  usage?: TokenUsage;
  response?: CompanionResponse;
  /** Adopted item id (idea id or `${proposalId}#${opId}`) → operation batch id, so the author can undo it. */
  adopted?: Record<string, string>;
  /** `${proposalId}:${ref}` → created entity, so later partial adoptions attach to parents adopted earlier. */
  created?: Record<string, { id: string; batchId: string }>;
}
export interface CompanionThread {
  id: string; projectId: string; mode: CompanionMode; anchor: CompanionAnchor; title: string;
  turns: CompanionTurn[]; status: 'idle' | 'streaming' | 'failed'; error?: string;
  /** Tokens of every reply in this conversation, failed requests excluded. */
  usage?: TokenUsage;
  /** Raw streamed text of the reply in progress; cleared when the turn is saved. */
  streaming?: string;
  createdAt: string; updatedAt: string;
}

export interface CompanionAskRequest {
  projectId: string; threadId?: string; mode: CompanionMode; anchor: CompanionAnchor;
  message: string; intensity: CompanionIntensity;
  options?: CompanionAskOptions;
  /** Re-send the last unanswered author message after a failure. */
  retry?: boolean;
}
/** Item ids: an idea id, a proposal id, or `${proposalId}#${opId}` for part of a proposal. */
export interface CompanionAdoptRequest {
  projectId: string; threadId: string; turnId: string; itemIds: string[];
  /** Where adopted ideas land: canvas notes (default) or appended to the anchor scene outline. */
  target?: 'canvas' | 'sceneOutline';
  placement?: { x: number; y: number };
  /** Wrap adopted canvas ideas in a new group. */
  group?: boolean;
  /** Adopt character / setting ideas as real characters or settings instead of canvas notes. */
  as?: 'character' | 'setting';
}
export interface CompanionAdoptResult { batchId?: string; skipped: string[]; thread: CompanionThread }

export interface CompanionAPI {
  askCompanion(request: CompanionAskRequest): Promise<CompanionThread>;
  cancelCompanion(projectId: string, threadId: string): Promise<void>;
  getCompanionThreads(projectId: string): Promise<CompanionThread[]>;
  adoptCompanion(request: CompanionAdoptRequest): Promise<CompanionAdoptResult>;
  undoCompanion(projectId: string, threadId: string, batchId: string): Promise<CompanionThread>;
  deleteCompanionThread(projectId: string, threadId: string): Promise<void>;
}

export const companionModeNames: Record<CompanionMode, string> = {
  diverge: '发散灵感', causality: '推演因果', structure: '结构诊断', outline: '大纲展开', beat: '下一拍', develop: '补全构想', style: '文风',
};
export const intensityNames: Record<CompanionIntensity, string> = { steady: '稳妥', bold: '大胆', wild: '天马行空' };
export const ideaKindNames: Record<CompanionIdeaKind, string> = {
  whatif: 'What-if', twist: '反转', conflict: '冲突升级', character: '人物', setting: '设定', theme: '立意', beat: '情节点',
};
export const focusNames: Record<CompanionFocus, string> = { profile: '作品信息', theme: '立意', logline: '一句话梗概', brief: '创作简述', cast: '人物阵容', setting: '故事环境', distill: '提炼文风', blindtest: '文风盲测' };
export const novelFieldNames: Record<CompanionNovelField, string> = { theme: '立意', logline: '一句话梗概', brief: '创作简述', genre: '题材', audience: '目标读者' };
