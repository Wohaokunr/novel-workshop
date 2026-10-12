import type { AgentStep, Change, Command, RunRequest, TokenUsage, Workspace } from './types.js';

export type AgentRole = 'coordinator' | 'theme' | 'planner' | 'world' | 'narrative' | 'canvas' | 'cast' | 'writer' | 'character' | 'evolution' | 'reader' | 'continuity' | 'stylist';
export interface AgentBudget {
  maxModelCalls: number; maxToolCalls: number; maxChildren: number; maxParallel: number;
  maxReplans: number; maxRevisions: number; maxActiveMs: number; maxTokens: number;
  modelCalls: number; toolCalls: number; children: number; replans: number; revisions: number;
  activeMs: number; tokens: number; usageUnknown: boolean;
}
export interface PlanNode {
  id: string; role: Exclude<AgentRole, 'coordinator'>; objective: string; dependsOn: string[];
  sceneId?: string; characterId?: string; eventId?: string; chapterId?: string;
  acceptance: string; status: 'pending' | 'running' | 'completed' | 'failed'; artifactId?: string;
}
export interface AgentPlan { version: number; summary: string; nodes: PlanNode[] }
export interface EvidenceSource { projectId: string; kind: string; id: string; hash: string; start?: number; end?: number }
export interface CandidateReview {
  candidateHash: string; role: 'reader' | 'continuity' | 'style'; verdict: 'pass' | 'revise';
  issues: string[]; recommendation: string; sources: EvidenceSource[]; stepId: string;
}
export interface AgentCandidate {
  id: string; runId: string; projectId: string; label: string; baseRevision: number; version: number;
  hash: string; commands: Command[]; changes: Change[]; workspace: Workspace;
  sources: EvidenceSource[]; reviews: CandidateReview[];
  status: 'draft' | 'awaitingApproval' | 'applied' | 'rejected' | 'stale';
  /** Artifacts whose commands this cumulative candidate already contains. */
  artifactIds?: string[];
  batchId?: string; appliedRevision?: number; commitCallKey?: string; createdAt: string;
}
export interface AgentArtifact {
  id: string; nodeId?: string; role: AgentRole; label: string; text: string; structured?: unknown;
  stepId: string; sources: EvidenceSource[]; createdAt: string;
}
export interface AgentWaiting {
  kind: 'approval' | 'input'; callKey: string; callId: string; stepId: string;
  turn: number; argumentsHash: string; candidateId?: string; candidateHash?: string; question?: string;
  /** Answers the author can pick for an ask_author question. */
  options?: string[];
}
export interface AgentSession {
  id: string; projectId: string; title: string; createdAt: string; updatedAt: string;
  messages: Array<{ id: string; role: 'author' | 'agent'; text: string; runId?: string; at: string }>;
}
export interface AgentState {
  version: 1; runId: string; projectId: string; sessionId: string; toolVersion: string;
  providerFingerprint?: string; baseWorkspace: Workspace; plan?: AgentPlan; planVersion?: number; reservedChildren?: string[];
  candidates: AgentCandidate[]; artifacts: AgentArtifact[];
  checkpoints: Record<string, unknown>; budget: AgentBudget; countedResponses: string[];
  waiting?: AgentWaiting; pauseReason?: string; interrupted?: boolean;
  currentStepId?: string; finalSummary?: string; updatedAt: string;
}
/** Persisted form of a run's state. The base snapshot is stored once in its own table and candidate workspaces are
 * rebuilt from base + commands when a run is loaded, so a save writes neither copy of the book. */
export type StoredAgentCandidate = Omit<AgentCandidate, 'workspace'>;
export type StoredAgentState = Omit<AgentState, 'baseWorkspace' | 'candidates'> & { candidates: StoredAgentCandidate[] };
export interface AgentReceipt {
  key: string; runId: string; projectId: string; argumentsHash: string;
  status: 'pending' | 'completed' | 'denied'; result?: unknown; at: string;
}
export interface AgentMemory {
  id: string; projectId: string; kind: 'preference' | 'constraint' | 'summary' | 'experience';
  content: string; confirmed: boolean; sources: EvidenceSource[]; sourceMessageId?: string;
  status: 'active' | 'suggested' | 'stale'; createdAt: string; updatedAt: string;
}
export interface AgentRuntimeSummary {
  sessionId: string; plan?: AgentPlan; artifacts: AgentArtifact[];
  candidates: Array<Omit<AgentCandidate, 'workspace' | 'commands'>>;
  budget: AgentBudget; waiting?: Pick<AgentWaiting, 'kind' | 'question' | 'options' | 'candidateId' | 'candidateHash'>;
  pauseReason?: string; uncertain: boolean; finalSummary?: string;
}
export interface AgentDecision { runId: string; candidateId: string; candidateHash: string; approve: boolean; reason?: string }
export interface AgentRuntimeAPI {
  getSession(projectId: string): Promise<AgentSession>;
  pauseRun(id: string): Promise<void>;
  resumeRun(id: string, confirmUncertain?: boolean): Promise<void>;
  decideCandidate(decision: AgentDecision): Promise<void>;
  answerRun(id: string, answer: string): Promise<void>;
  getMemories(projectId: string): Promise<AgentMemory[]>;
  saveMemory(projectId: string, content: string, kind: AgentMemory['kind']): Promise<AgentMemory>;
  confirmMemory(projectId: string, id: string): Promise<void>;
  deleteMemory(projectId: string, id: string): Promise<void>;
}
/** A finished dependency's conclusion handed to a dependent author-side node. */
export interface UpstreamResult { nodeId: string; role: Exclude<AgentRole, 'coordinator'>; label: string; objective: string; result: unknown }
export interface SpecialistResult { step: AgentStep; text: string; structured?: unknown; commands?: Command[] }
export interface SpecialistRequest { role: Exclude<AgentRole, 'coordinator'>; node: PlanNode; project: Workspace; request: RunRequest }
export interface SearchChunk { source: EvidenceSource; title: string; text: string; score: number }
export type RuntimeUsage = TokenUsage;
