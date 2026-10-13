import type { AgentRuntimeAPI, AgentRuntimeSummary } from './agent-types.js';
import type { CompanionAPI, CompanionThread } from './companion-types.js';
import type { StoryMemoryAPI, StoryMemoryStatus } from './story-types.js';
import type { StyleAPI, StyleLearningStatus, StyleProfile } from './style-types.js';
export type FieldValue = string | number | boolean | null | string[];
export type FieldKind = 'text' | 'number' | 'choice' | 'reference';
export interface ObjectField { id: string; label: string; kind: FieldKind; options?: string[] }
export interface ObjectType { id: string; name: string; builtin?: boolean; fields: ObjectField[] }
export interface EventData {
  worldOrder: number; timeLabel: string; thread: string; participants: string[];
  causes: string[]; critical: boolean; observations: Record<string, string>;
}
export interface NovelObject {
  id: string; typeId: string; name: string; fields: Record<string, FieldValue>; event?: EventData;
  /** Other names the prose uses (nicknames, titles, forms of address); used to find where the object appears. */
  aliases?: string[];
}
export interface Chapter { id: string; title: string; order: number; actId?: string; summary?: string }
/** A volume / act in the layered outline; chapters opt in through actId. */
export interface Act { id: string; title: string; order: number; purpose: string; summary: string }
export interface NarrativeScene {
  id: string; chapterId: string; order: number; title: string; povId: string | null;
  eventIds: string[]; outline: string; text: string;
  /** Characters on stage besides the POV; optional on older workspaces. */
  castIds?: string[];
  /** Where the scene happens: setting-like objects (neither characters nor events). */
  settingIds?: string[];
}
export interface WorldFact { id: string; subjectId: string; key: string; value: string; fromEventId: string | null; replacesId?: string }
export interface CharacterKnowledge {
  id: string; characterId: string; content: string; learnedAt: string | null;
  source: 'initial' | 'witness' | 'told' | 'belief'; factId?: string; fromCharacterId?: string;
}
/** A character's state after a world event; evidence belongs to the author. */
export interface CharacterState {
  id: string; characterId: string; eventId: string;
  perspective: string; psychology: string; motivation: string; evidence: string; sceneIds: string[];
}
export interface CanvasCard {
  id: string; kind: 'note' | 'object' | 'scene' | 'group'; refId?: string;
  title: string; content: string; x: number; y: number; groupId?: string;
  width?: number; height?: number; collapsed?: boolean;
}
export interface CanvasLink { id: string; source: string; target: string }
export interface ReadingSettings { chapterId?: string; scroll: number; fontSize: number; lineHeight: number; theme: 'paper' | 'dark' }
export interface Workspace {
  schemaVersion: 1; id: string; title: string; brief: string; genre: string; audience: string; theme?: string; revision: number;
  /** One-sentence premise and chosen structure template for the layered outline. */
  logline?: string; structureTemplate?: string; acts?: Act[];
  objectTypes: ObjectType[]; objects: NovelObject[]; chapters: Chapter[]; scenes: NarrativeScene[];
  facts: WorldFact[]; knowledge: CharacterKnowledge[]; cards: CanvasCard[]; canvasLinks: CanvasLink[];
  characterStates?: CharacterState[];
  /** The author's voice; missing on older workspaces (see styleProfile). */
  style?: StyleProfile;
  layouts: Record<string, { x: number; y: number }>; reading: ReadingSettings;
}
export type Command =
  | { type: 'updateNovel'; patch: Partial<Pick<Workspace, 'title' | 'brief' | 'genre' | 'audience' | 'theme' | 'logline' | 'structureTemplate'>> }
  | { type: 'updateStyle'; patch: Partial<StyleProfile> }
  | { type: 'putAct'; value: Act } | { type: 'deleteAct'; id: string }
  | { type: 'putObjectType'; value: ObjectType } | { type: 'deleteObjectType'; id: string }
  | { type: 'putObject'; value: NovelObject } | { type: 'deleteObject'; id: string }
  | { type: 'putChapter'; value: Chapter } | { type: 'deleteChapter'; id: string }
  | { type: 'putScene'; value: NarrativeScene } | { type: 'deleteScene'; id: string }
  | { type: 'putFact'; value: WorldFact } | { type: 'deleteFact'; id: string }
  | { type: 'putKnowledge'; value: CharacterKnowledge } | { type: 'deleteKnowledge'; id: string }
  | { type: 'putCharacterState'; value: CharacterState } | { type: 'deleteCharacterState'; id: string }
  | { type: 'putCard'; value: CanvasCard } | { type: 'deleteCard'; id: string }
  | { type: 'putCanvasLink'; value: CanvasLink } | { type: 'deleteCanvasLink'; id: string }
  | { type: 'setLayout'; key: string; value: { x: number; y: number } }
  | { type: 'setReading'; value: ReadingSettings };
export interface CommandRequest { projectId: string; expectedRevision?: number; commands: Command[]; actor: 'human' | 'ai'; taskId?: string; label?: string }
export interface ProjectSummary { id: string; title: string; revision: number; updatedAt: string }
export interface Change { collection: string; key: string; before: unknown; after: unknown }
export interface OperationBatch { id: string; projectId: string; actor: 'human' | 'ai'; taskId?: string; label: string; at: string; changes: Change[]; undone: boolean }
export interface TokenUsage { input: number; output: number; total: number; reasoning: number; cached: number; provided: boolean }
export type RunStatus = 'queued' | 'running' | 'pausing' | 'paused' | 'awaitingApproval' | 'awaitingInput' | 'completed' | 'failed' | 'cancelled';
export interface ToolActivity { name: string; arguments: unknown; result: unknown; at: string; callId?: string; turn?: number }
export interface AgentStep {
  id: string; agentId: string; label: string; status: RunStatus; input: unknown; output: string;
  structured?: unknown; tools: ToolActivity[]; usage: TokenUsage; startedAt: string; finishedAt?: string;
  contextSources: string[]; responseIds: string[];
  /** Version (text hash) of the instructions this step ran with; see src/main/prompts. */
  promptVersion?: string;
}
export type AssistTool = 'character' | 'world' | 'narrative' | 'canvas' | 'theme' | 'continuity';
export interface RunRequest {
  projectId: string; stage: 'agent' | 'idea' | 'outline' | 'chapter' | 'rewrite' | 'assist'; objective: string; tool?: AssistTool;
  chapterId?: string; sceneId?: string; selection?: { start: number; end: number };
  references?: SourceReference[];
}
export interface SourceReference { kind: 'card' | 'object' | 'scene'; id: string }
export interface AgentRun extends RunRequest {
  id: string; status: RunStatus; startedAt: string; finishedAt?: string; steps: AgentStep[]; usage: TokenUsage; error?: string;
  runtime?: AgentRuntimeSummary; eventVersion?: number;
}
export interface AgentEvent { projectId: string; runId: string; type: 'run' | 'delta' | 'projectChanged' | 'companion' | 'storyMemory' | 'styleLearning'; run?: AgentRun; stepId?: string; delta?: string; version?: number; offset?: number; thread?: CompanionThread; story?: StoryMemoryStatus; style?: StyleLearningStatus }
export interface ProviderSettings {
  name: string; baseURL: string; model: string; reasoningEffort?: string; hasKey: boolean; mode: 'mock' | 'live';
  /** Optional cheaper model for story-memory digests; empty uses the main model. */
  summaryModel?: string;
  /** auto: digest prose in the background after edits; manual: only when the author asks. */
  storyMemory?: 'auto' | 'manual';
  /** Output token cap per request, reasoning included; empty uses a default (see outputTokenLimit). Not applied to a separate summary model. */
  maxOutputTokens?: number;
  /** Optional embedding model: story memory then keeps a local semantic index and searches recall by meaning as well as by words. */
  embeddingModel?: string;
}
export interface ProviderInput extends Omit<ProviderSettings, 'hasKey'> { apiKey?: string }
export interface ProviderSecret extends Omit<ProviderSettings, 'hasKey'> { apiKey: string }
export interface CharacterContext {
  characterId: string; name: string; selfKnowledge: string; eventId: string; perception: string;
  memories: Array<{ id: string; content: string; source: string; learnedAt: string | null }>;
  state?: CharacterState;
  sources: string[];
}
export interface ReaderContext { title: string; text: string; sources: string[] }
export interface DesktopAPI extends AgentRuntimeAPI, CompanionAPI, StoryMemoryAPI, StyleAPI {
  listProjects(): Promise<ProjectSummary[]>;
  createProject(title: string): Promise<Workspace>;
  loadProject(id: string): Promise<Workspace>;
  execute(request: CommandRequest): Promise<Workspace>;
  deleteImpact(projectId: string, command: Command): Promise<string[]>;
  history(projectId: string): Promise<OperationBatch[]>;
  undo(projectId: string, batchOrTaskId: string): Promise<Workspace>;
  getRuns(projectId: string): Promise<AgentRun[]>;
  startRun(request: RunRequest): Promise<AgentRun>;
  cancelRun(id: string): Promise<void>;
  retryRun(id: string, expectedRevision: number): Promise<AgentRun>;
  getProvider(): Promise<ProviderSettings>;
  saveProvider(input: ProviderInput): Promise<ProviderSettings>;
  testProvider(): Promise<string>;
  exportProject(projectId: string): Promise<string | null>;
  importProject(): Promise<Workspace | null>;
  exportText(projectId: string): Promise<string | null>;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  onCloseRequested(listener: () => void): () => void;
  confirmClose(): Promise<void>;
}
declare global { interface Window { novel: DesktopAPI } }
