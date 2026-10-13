import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type { ResponseInputItem, ResponseOutputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { ReasoningEffort } from 'openai/resources/shared';
import type { AgentStep, ProviderSecret, TokenUsage } from '../shared/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { DomainValidationError } from './domain.js';
import { promptVersion } from './prompts/prompt.js';

export class ToolValidationError extends Error {}
/** The service reported an error, so the request produced nothing: sending it again repeats no billed result. */
export class ModelServiceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ModelServiceError';
  }
}
/** The model answered with nothing usable (a refusal, a content filter); the same input tends to get the same answer. */
export class ModelOutputError extends Error {}
/** The answer hit the output token limit. Plain-text answers are continued instead; anything else reports this error. */
export class OutputLimitError extends ModelOutputError {}

export type JsonSchema = Record<string, unknown>;
export interface ToolCallContext {
  key: string;
  callId: string;
  stepId: string;
  turn: number;
  argumentsHash: string;
}
export class AgentSuspended extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = 'AgentSuspended';
  }
}
export interface AgentCheckpoint {
  step: AgentStep;
  input: ResponseInputItem[];
  /** Zero-based current request turn; incremented only after all its tool results are saved. */
  turn: number;
  phase: 'ready' | 'requesting' | 'tools' | 'completed';
  pendingCalls: ResponseOutputItem[];
  cursor: number;
  uncertain?: boolean;
  /** Input items already written to the turn log; the next turn's record starts at `end` (see the runtime's turnRecord). */
  logged?: { turn: number; from: number; end: number };
  /** Text of a plain-text answer cut at the output limit; the continuation's output is appended to it. */
  continued?: string;
}
export interface AgentTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(argumentsValue: Record<string, unknown>, signal: AbortSignal, context?: ToolCallContext): unknown | Promise<unknown>;
}
export interface AgentDefinition {
  id: string;
  label: string;
  instructions: string;
  tools?: AgentTool[];
  outputSchema?: JsonSchema;
  /** Send long multi-paragraph strings (prose, style samples) as plain text after the JSON instead of escaped inside it. */
  proseBlocks?: boolean;
}
export interface ModelResponse {
  id: string;
  status?: string;
  output: ResponseOutputItem[];
  output_text?: string;
  usage?: {
    input_tokens: number; output_tokens: number; total_tokens: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  } | null;
  error?: { message: string } | null;
  incomplete_details?: { reason?: string } | null;
}
export interface ModelRequest {
  agentId: string;
  /** Overrides the provider's model for this request (a role's own model). */
  model?: string;
  instructions: string;
  input: ResponseInputItem[];
  tools: Array<{ type: 'function'; name: string; description: string; parameters: JsonSchema; strict: true }>;
  outputSchema?: JsonSchema;
}
export interface ModelStream {
  events: AsyncIterable<ResponseStreamEvent>;
  finalResponse(): Promise<ModelResponse>;
}
export interface ResponseTransport {
  stream(request: ModelRequest, signal: AbortSignal): ModelStream | Promise<ModelStream>;
}

export const MAX_AGENT_TURNS = 12;
/** Retries before any output, for connection errors, 408/409/429 and 5xx; the SDK backs off and honours Retry-After. */
export const MODEL_RETRIES = 4;
/** Continuation requests for a plain-text answer cut at the output limit. */
export const MAX_OUTPUT_CONTINUATIONS = 2;
export const CONTINUE_NOTICE = '运行时提示：上一条回复达到单次输出上限被截断。请从上一条回复的最后一个字之后直接接着写，不要重复已写内容，不要加任何说明。';
/** Reasoning tokens count toward the cap, so a reasoning configuration gets more room. Neither default exceeds what current
 * models accept; a service with a lower ceiling sets its own limit in the model settings. */
export function outputTokenLimit(provider: Pick<ProviderSecret, 'maxOutputTokens' | 'reasoningEffort'>): number {
  return provider.maxOutputTokens ?? (provider.reasoningEffort ? 32_000 : 16_000);
}
export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, total: 0, reasoning: 0, cached: 0, provided: false });
export function addUsage(target: TokenUsage, source: TokenUsage): void {
  target.input += source.input;
  target.output += source.output;
  target.total += source.total;
  target.reasoning += source.reasoning;
  target.cached += source.cached;
  target.provided ||= source.provided;
}
export function objectSchema(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('任务已取消');
}

/** Validate the small JSON Schema subset used by the application before invoking any command. */
export function validateSchema(value: unknown, schema: JsonSchema, path = '结果'): void {
  if (Array.isArray(schema.anyOf)) {
    for (const option of schema.anyOf as JsonSchema[]) {
      try { validateSchema(value, option, path); return; } catch { /* Try the next declared union member. */ }
    }
    throw new ToolValidationError(`${path}不符合约定类型`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new ToolValidationError(`${path}不在允许值中`);
  const kinds = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (kinds.includes('null') && value === null) return;
  if (kinds.includes('object')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ToolValidationError(`${path}必须是对象`);
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in record)) throw new ToolValidationError(`${path}缺少${key}`);
    }
    for (const [key, child] of Object.entries(record)) {
      if (properties[key]) validateSchema(child, properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new ToolValidationError(`${path}包含未知字段${key}`);
    }
    return;
  }
  if (kinds.includes('array')) {
    if (!Array.isArray(value)) throw new ToolValidationError(`${path}必须是数组`);
    for (const child of value) validateSchema(child, schema.items as JsonSchema, path);
    return;
  }
  if (kinds.includes('integer') && typeof value === 'number' && Number.isSafeInteger(value)) return;
  if (kinds.includes('number') && typeof value === 'number' && Number.isFinite(value)) return;
  if (kinds.includes(typeof value)) return;
  throw new ToolValidationError(`${path}不符合约定类型`);
}

/** Background requests (story memory) to one endpoint go one at a time, and only while none of the author's requests is in
 * flight; the author's requests never wait. Digests then add little to the rate limits a running task is using. */
export class RequestGate {
  private foreground = 0;
  private background = false;
  private readonly waiting: Array<() => void> = [];
  async enter(background: boolean, signal: AbortSignal): Promise<() => void> {
    checkCancelled(signal);
    if (!background) {
      this.foreground++;
      return once(() => { this.foreground--; this.wake(); });
    }
    if (this.background || this.foreground) {
      await new Promise<void>((resolve, reject) => {
        const start = () => { signal.removeEventListener('abort', cancel); resolve(); };
        const cancel = () => { this.waiting.splice(this.waiting.indexOf(start), 1); reject(new Error('任务已取消')); };
        signal.addEventListener('abort', cancel, { once: true });
        this.waiting.push(start);
      });
    } else this.background = true;
    return once(() => { this.background = false; this.wake(); });
  }
  private wake() {
    if (this.background || this.foreground) return;
    const next = this.waiting.shift();
    if (next) { this.background = true; next(); }
  }
}
function once(action: () => void) {
  let done = false;
  return () => { if (!done) { done = true; action(); } };
}
const gates = new Map<string, RequestGate>();
function gateFor(baseURL: string) {
  let gate = gates.get(baseURL);
  if (!gate) gates.set(baseURL, gate = new RequestGate());
  return gate;
}
/** Errors the service itself reported. Connection failures keep their meaning (the outcome is unknown), as do cancellations. */
function serviceError(error: unknown, retries: number): unknown {
  if (!(error instanceof APIError) || error instanceof APIConnectionError || error instanceof APIUserAbortError) return error;
  const status = error.status, retried = retries > 0 && status !== undefined && (status === 408 || status === 409 || status === 429 || status >= 500);
  return new ModelServiceError(`模型服务出错${retried ? `（已自动重试 ${retries} 次）` : ''}：${error.message}`, status);
}

export class OpenAIResponseTransport implements ResponseTransport {
  private readonly client: OpenAI;
  private readonly retries: number;
  /** `retries: 0` suits the connection test, which should report a wrong address at once rather than back off. */
  constructor(private readonly provider: ProviderSecret, private readonly options: { background?: boolean; retries?: number } = {}) {
    this.retries = options.retries ?? MODEL_RETRIES;
    this.client = new OpenAI({ baseURL: provider.baseURL, apiKey: provider.apiKey, maxRetries: this.retries });
  }
  async stream(request: ModelRequest, signal: AbortSignal): Promise<ModelStream> {
    checkCancelled(signal);
    const exit = await gateFor(this.provider.baseURL).enter(!!this.options.background, signal);
    const release = () => { signal.removeEventListener('abort', release); exit(); };
    signal.addEventListener('abort', release, { once: true });
    let stream: ReturnType<OpenAI['responses']['stream']>;
    try {
      stream = this.client.responses.stream({
        model: request.model || this.provider.model,
        instructions: request.instructions,
        // With store: false the service keeps nothing, so a reasoning item can only be replayed with its encrypted content.
        input: request.input.filter(item => item.type !== 'reasoning' || !!item.encrypted_content),
        tools: request.tools,
        store: false,
        parallel_tool_calls: false,
        max_output_tokens: outputTokenLimit(this.provider),
        ...(this.provider.reasoningEffort ? {
          reasoning: { effort: this.provider.reasoningEffort as ReasoningEffort }, include: ['reasoning.encrypted_content' as const],
        } : {}),
        ...(request.outputSchema ? {
          text: { format: { type: 'json_schema' as const, name: 'agent_result', schema: request.outputSchema, strict: true } },
        } : {}),
      }, { signal });
    } catch (error) {
      release();
      throw serviceError(error, this.retries);
    }
    const retries = this.retries;
    const events = (async function* () {
      try { for await (const event of stream) yield event; } catch (error) { throw serviceError(error, retries); } finally { release(); }
    })();
    return { events, finalResponse: () => stream.finalResponse().catch(error => { throw serviceError(error, retries); }).finally(release) };
  }
}

/** Turns texts into vectors for the optional semantic index. Usage is reported in tokens. */
export interface EmbeddingTransport { embed(texts: string[], signal: AbortSignal): Promise<{ vectors: number[][]; tokens: number }> }
export class OpenAIEmbeddingTransport implements EmbeddingTransport {
  private readonly client: OpenAI;
  constructor(private readonly provider: ProviderSecret & { embeddingModel: string }, private readonly options: { background?: boolean } = {}) {
    this.client = new OpenAI({ baseURL: provider.baseURL, apiKey: provider.apiKey, maxRetries: MODEL_RETRIES });
  }
  async embed(texts: string[], signal: AbortSignal) {
    checkCancelled(signal);
    const exit = await gateFor(this.provider.baseURL).enter(!!this.options.background, signal);
    try {
      const response = await this.client.embeddings.create({ model: this.provider.embeddingModel, input: texts }, { signal });
      return { vectors: [...response.data].sort((a, b) => a.index - b.index).map(item => item.embedding), tokens: response.usage?.prompt_tokens ?? 0 };
    } catch (error) {
      throw serviceError(error, MODEL_RETRIES);
    } finally { exit(); }
  }
}

function responseText(response: ModelResponse): string {
  if (response.output_text !== undefined) return response.output_text;
  return response.output.flatMap(item => item.type === 'message'
    ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : []).join('\n');
}
function usageOf(response: ModelResponse): TokenUsage {
  if (!response.usage) return emptyUsage();
  return {
    input: response.usage.input_tokens, output: response.usage.output_tokens, total: response.usage.total_tokens,
    reasoning: response.usage.output_tokens_details?.reasoning_tokens ?? 0,
    cached: response.usage.input_tokens_details?.cached_tokens ?? 0, provided: true,
  };
}

export interface RunAgentOptions {
  transport: ResponseTransport;
  context: unknown;
  objective: string;
  signal: AbortSignal;
  contextSources: string[];
  onStep?(step: AgentStep): void;
  onDelta?(stepId: string, delta: string): void;
  checkpoint?: AgentCheckpoint;
  /** Persist synchronously: returning before the write completes is not a durable checkpoint. */
  onCheckpoint?(cp: AgentCheckpoint): void;
  beforeRequest?(): void | Promise<void>;
  maxTurns?: number;
  /** The model this agent's requests go to; absent uses the transport's provider model. */
  model?: string;
  /** Deterministic work in place of the next model turn: calls to execute as if the model had made them (recorded in the
   * conversation like its own), `true` to finish without another request, or nothing to ask the model. */
  next?(cp: AgentCheckpoint): RuntimeCall[] | true | undefined;
}
export interface RuntimeCall { name: string; arguments: Record<string, unknown> }
/** Runtime-owned calls carry no item id: the service validates ids it issued, and these were never issued by it. */
export function runtimeCalls(calls: RuntimeCall[]): FunctionCall[] {
  return calls.map(call => ({ type: 'function_call', call_id: `runtime-${randomUUID()}`, name: call.name, arguments: JSON.stringify(call.arguments) }));
}

type FunctionCall = Extract<ResponseOutputItem, { type: 'function_call' }>;
type AgentTrace = { input?: ResponseInputItem[]; turn?: number; output?: ModelResponse };

/** JSON argument objects have no executable values; recursively sort keys, preserving array order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function toolActivity(cp: AgentCheckpoint, call: FunctionCall) {
  const existing = cp.step.tools.find(activity => activity.callId === call.call_id && activity.turn === cp.turn);
  if (existing) return existing;
  const activity = {
    name: call.name, callId: call.call_id, turn: cp.turn,
    arguments: call.arguments as unknown, result: { status: 'running' } as unknown, at: new Date().toISOString(),
  };
  cp.step.tools.push(activity);
  return activity;
}

/** Only look after the latest call: providers may reuse a call ID in later turns. */
function savedToolOutput(cp: AgentCheckpoint, callId: string) {
  let start = 0;
  for (let index = cp.input.length - 1; index >= 0; index--) {
    const item = cp.input[index]!;
    if (item.type === 'function_call' && item.call_id === callId) { start = index + 1; break; }
  }
  return cp.input.slice(start).find(item => item.type === 'function_call_output' && item.call_id === callId);
}

function recordToolResult(cp: AgentCheckpoint, call: FunctionCall, result: unknown): void {
  const existing = savedToolOutput(cp, call.call_id);
  // Serialize before mutating the checkpoint so an invalid receipt cannot partially settle a call.
  const output = existing?.type === 'function_call_output' ? existing.output : JSON.stringify(result) ?? 'null';
  if (existing?.type === 'function_call_output') {
    try { result = typeof output === 'string' ? JSON.parse(output) : output; } catch { result = output; }
  }
  const activity = toolActivity(cp, call);
  try { activity.arguments = JSON.parse(call.arguments); } catch { /* Keep the original invalid argument string. */ }
  activity.result = result;
  if (!existing) cp.input.push({ type: 'function_call_output', call_id: call.call_id, output });
  cp.cursor++;
}

/** Pure checkpoint update for the parent's atomic approval/receipt transaction; never invokes a tool. */
export function settleCheckpointTool(cp: AgentCheckpoint, callId: string, result: unknown): AgentCheckpoint {
  const call = cp.pendingCalls[cp.cursor];
  if (cp.phase !== 'tools' || call?.type !== 'function_call' || call.call_id !== callId) {
    // A repeated submission is harmless, but an out-of-order or unrelated submission is rejected.
    if (savedToolOutput(cp, callId)) return cp;
    throw new Error('检查点当前没有对应的待处理工具调用');
  }
  const next = structuredClone(cp);
  recordToolResult(next, call, result);
  return next;
}

function isContinuation(item: ResponseInputItem): boolean {
  return 'role' in item && item.role === 'user' && item.content === CONTINUE_NOTICE;
}
/** A continuation sometimes restates the last few characters before going on; drop that overlap. */
export function joinContinuation(previous: string, next: string): string {
  for (let size = Math.min(200, previous.length, next.length); size >= 8; size--) {
    if (previous.endsWith(next.slice(0, size))) return previous + next.slice(size);
  }
  return previous + next;
}
function limitReason(response: ModelResponse): string {
  const output = response.usage?.output_tokens, reasoning = response.usage?.output_tokens_details?.reasoning_tokens;
  return `模型输出达到单次上限被截断${output ? `（本次输出 ${output} tokens${reasoning ? `，其中推理 ${reasoning}` : ''}）` : ''}`;
}

/** Strings this long with a paragraph break are prose: worth keeping their line breaks visible to the model. */
export const PROSE_BLOCK_CHARS = 200;
/** Moves prose out of the context into numbered plain-text blocks, leaving a pointer in its place. JSON escapes every line
 * break as \n, which hides exactly the paragraphing and rhythm a writer is asked to imitate or continue. */
export function liftProse(context: unknown): { context: unknown; blocks: Array<{ label: string; path: string; text: string }> } {
  const blocks: Array<{ label: string; path: string; text: string }> = [];
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      if (value.length < PROSE_BLOCK_CHARS || !value.includes('\n')) return value;
      const label = `原文${blocks.length + 1}`;
      blocks.push({ label, path, text: value });
      return `〔见下方【${label}】〕`;
    }
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}[${index}]`));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, `${path}.${key}`)]));
    return value;
  };
  return { context: walk(context, 'context'), blocks };
}
const PROSE_HEADER = '以下是上面资料中引用的原文，按原样分段：';
/** The context a proseBlocks request carried, with each pointer replaced by its text again (offline fixtures read it). */
export function restoreProse(input: ResponseInputItem[]): Record<string, any> {
  const messages = input.filter(item => 'role' in item && item.role === 'user' && typeof item.content === 'string') as Array<{ content: string }>;
  if (!messages[0]) return {};
  const context = JSON.parse(messages[0].content).context ?? {};
  const blocks = messages[1]?.content.startsWith(PROSE_HEADER) ? messages[1].content.slice(PROSE_HEADER.length).split(/\n\n(?=【原文\d+】context)/) : [];
  const texts = new Map(blocks.map(block => { const match = block.trim().match(/^【(原文\d+)】context\S*\n([\s\S]*)$/); return match ? [match[1]!, match[2]!] : ['', '']; }));
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') { const label = value.match(/^〔见下方【(原文\d+)】〕$/)?.[1]; return label && texts.has(label) ? texts.get(label) : value; }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  return walk(context) as Record<string, any>;
}
function userInput(definition: AgentDefinition, context: unknown, objective: string): ResponseInputItem[] {
  if (!definition.proseBlocks) return [{ role: 'user', content: JSON.stringify({ context, objective }) }];
  const lifted = liftProse(context);
  const input: ResponseInputItem[] = [{ role: 'user', content: JSON.stringify({ context: lifted.context, objective }) }];
  if (lifted.blocks.length) input.push({ role: 'user', content: `${PROSE_HEADER}\n\n${lifted.blocks.map(block => `【${block.label}】${block.path}\n${block.text}`).join('\n\n')}` });
  return input;
}

/** One bounded runtime serves planners, writers, independent characters, readers and demo mode. */
export async function runAgent(definition: AgentDefinition, options: RunAgentOptions): Promise<AgentStep> {
  const durable = !!(options.checkpoint || options.onCheckpoint);
  const newTurns: AgentTrace[] = [];
  const cp: AgentCheckpoint = options.checkpoint ?? {
    step: {
      id: randomUUID(), agentId: definition.id, label: definition.label, status: 'running',
      input: { instructions: definition.instructions, context: options.context, objective: options.objective, turns: newTurns },
      output: '', tools: [], usage: emptyUsage(), startedAt: new Date().toISOString(),
      contextSources: options.contextSources, responseIds: [], promptVersion: promptVersion(definition.instructions),
    },
    input: userInput(definition, options.context, options.objective),
    turn: 0, phase: 'ready', pendingCalls: [], cursor: 0,
  };
  const step = cp.step;
  if (cp.phase === 'completed') return step;
  const traceInput = step.input as { turns?: AgentTrace[] } | null;
  const turns = traceInput?.turns ?? newTurns;
  const tools = definition.tools ?? [];
  const maxTurns = options.maxTurns ?? MAX_AGENT_TURNS;
  const publish = () => options.onStep?.(step);
  let checkpointWriteFailed = false;
  const save = () => {
    try { options.onCheckpoint?.(cp); } catch (error) { checkpointWriteFailed = true; throw error; }
  };
  // A durable run waits for the author instead of failing; resuming sends the turn again.
  const unusable = (error: ModelServiceError | ModelOutputError) => durable
    ? new AgentSuspended(`${error.message}${error instanceof ModelServiceError ? '。这一轮没有产生结果' : ''}；恢复任务会重新发送这一轮`) : error;
  step.status = 'running';
  delete step.finishedAt;
  publish();
  try {
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 0) throw new Error('智能体轮次上限必须是非负整数');
    if (!options.checkpoint) save();
    while (true) {
      if (cp.phase === 'requesting' || cp.uncertain) {
        cp.uncertain = true;
        throw new AgentSuspended('模型请求结果不确定，请确认后恢复');
      }
      checkCancelled(options.signal);
      if (cp.phase === 'tools') {
        if (!cp.pendingCalls.length) {
          if (definition.outputSchema) {
            const value: unknown = JSON.parse(step.output);
            validateSchema(value, definition.outputSchema);
            step.structured = value;
          }
          step.status = 'completed';
          step.finishedAt = new Date().toISOString();
          cp.phase = 'completed';
          save();
          publish();
          return step;
        }
        while (cp.cursor < cp.pendingCalls.length) {
          checkCancelled(options.signal);
          const call = cp.pendingCalls[cp.cursor]!;
          if (call.type !== 'function_call') throw new Error('检查点包含无效的待处理工具调用');
          const tool = tools.find(candidate => candidate.name === call.name);
          if (!tool) throw new Error(`智能体无权调用工具：${call.name}`);
          const activity = toolActivity(cp, call);
          publish();
          save();
          let result: unknown;
          try {
            let argumentsValue: unknown;
            try { argumentsValue = JSON.parse(call.arguments); } catch { throw new ToolValidationError('工具参数必须是有效 JSON'); }
            activity.arguments = argumentsValue;
            validateSchema(argumentsValue, tool.parameters, '工具参数');
            const context: ToolCallContext = {
              key: `${step.id}:${cp.turn}:${call.call_id}`, callId: call.call_id, stepId: step.id, turn: cp.turn,
              argumentsHash: createHash('sha256').update(stableJson(argumentsValue)).digest('hex'),
            };
            result = await tool.execute(argumentsValue as Record<string, unknown>, options.signal, context);
            checkCancelled(options.signal);
          } catch (error) {
            // A suspension is a durable wait, not a tool failure or a fabricated model output.
            if (error instanceof AgentSuspended) throw error;
            result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
            activity.result = result;
            if (options.signal.aborted || !(error instanceof ToolValidationError || error instanceof DomainValidationError)) {
              publish();
              throw error;
            }
          }
          recordToolResult(cp, call, result);
          save();
          publish();
        }
        // A checkpoint at the last result still has phase=tools. Advance before any new request.
        cp.turn++;
        cp.phase = 'ready';
        cp.pendingCalls = [];
        cp.cursor = 0;
        save();
        continue;
      }
      if (options.next) {
        const work = options.next(cp);
        if (work === true) {
          step.status = 'completed';
          step.finishedAt = new Date().toISOString();
          cp.phase = 'completed';
          save();
          publish();
          return step;
        }
        if (work?.length) {
          const calls = runtimeCalls(work);
          cp.input.push(...calls);
          cp.pendingCalls = calls;
          cp.cursor = 0;
          cp.phase = 'tools';
          save();
          publish();
          continue;
        }
      }
      if (cp.turn >= maxTurns) {
        const reason = `智能体达到 ${maxTurns} 轮上限，请缩小本次任务`;
        if (durable) throw new AgentSuspended(reason);
        throw new Error(reason);
      }
      await options.beforeRequest?.();
      checkCancelled(options.signal);
      const requestInput = structuredClone(cp.input);
      // Durable history keeps each native response once, not an ever-growing copy of all replay input.
      const trace: AgentTrace = durable ? { turn: cp.turn } : { input: requestInput };
      turns.push(trace);
      step.output = cp.continued ?? '';
      cp.phase = 'requesting';
      cp.uncertain = true;
      publish();
      save();
      let response: ModelResponse;
      try {
        const stream = await options.transport.stream({
          agentId: definition.id, ...(options.model ? { model: options.model } : {}), instructions: definition.instructions, input: requestInput,
          tools: tools.map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters, strict: true })),
          ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
        }, options.signal);
        for await (const event of stream.events) {
          checkCancelled(options.signal);
          if (event.type === 'response.output_text.delta') {
            step.output += event.delta;
            options.onDelta?.(step.id, event.delta);
          } else if (event.type === 'error') {
            throw new ModelServiceError(`模型服务出错：${event.message}`);
          }
        }
        response = await stream.finalResponse();
      } catch (error) {
        if (!(error instanceof ModelServiceError) || options.signal.aborted) throw error;
        // The service turned the request down: nothing was generated, so sending this turn again needs no cost confirmation.
        cp.phase = 'ready';
        cp.uncertain = false;
        throw unusable(error);
      }
      trace.output = structuredClone(response);
      step.responseIds.push(response.id);
      addUsage(step.usage, usageOf(response));
      const text = responseText(response);
      step.output = cp.continued === undefined ? text : joinContinuation(cp.continued, text);
      const refusal = response.output.flatMap(item => item.type === 'message'
        ? item.content.flatMap(part => part.type === 'refusal' ? [part.refusal] : []) : []);
      if (response.status !== 'completed' || refusal.length) {
        // The answer is settled but unusable: keep its calls out of the executable checkpoint, even across a restart,
        // and send any further request as a new turn so each logged turn keeps a single response.
        cp.turn++;
        cp.phase = 'ready';
        cp.uncertain = false;
        cp.pendingCalls = [];
        cp.cursor = 0;
        const truncated = response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens';
        if (truncated && !definition.outputSchema && !response.output.some(item => item.type === 'function_call') && text.trim()
          && cp.input.filter(isContinuation).length < MAX_OUTPUT_CONTINUATIONS) {
          cp.continued = step.output;
          cp.input.push({ role: 'assistant', content: text }, { role: 'user', content: CONTINUE_NOTICE });
          save();
          publish();
          continue;
        }
        delete cp.continued;
        save();
        publish();
        checkCancelled(options.signal);
        if (truncated) throw new OutputLimitError(limitReason(response));
        if (refusal.length) throw unusable(new ModelOutputError(`模型拒绝：${refusal.join('\n')}`));
        throw unusable(response.status === 'incomplete'
          ? new ModelOutputError(`模型输出未完成：${response.incomplete_details?.reason ?? response.status}`)
          : new ModelServiceError(`模型服务出错：${response.error?.message ?? `响应状态 ${response.status}`}`));
      }
      delete cp.continued;
      cp.input.push(...toResponseInputItems(response.output));
      cp.pendingCalls = structuredClone(response.output.filter(item => item.type === 'function_call'));
      cp.cursor = 0;
      cp.phase = 'tools';
      cp.uncertain = false;
      save();
      publish();
    }
  } catch (error) {
    if (error instanceof AgentSuspended) {
      step.status = 'paused';
      delete step.finishedAt;
    } else {
      step.status = options.signal.aborted ? 'cancelled' : 'failed';
      step.finishedAt = new Date().toISOString();
    }
    // A failed persistence callback must abort before side effects, not trigger another failing write.
    if (!checkpointWriteFailed) save();
    publish();
    throw error;
  }
}
