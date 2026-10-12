import OpenAI from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type { ResponseInputItem, ResponseOutputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { ReasoningEffort } from 'openai/resources/shared';
import type { AgentStep, ProviderSecret, TokenUsage } from '../shared/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { DomainValidationError } from './domain.js';

export class ToolValidationError extends Error {}

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

export class OpenAIResponseTransport implements ResponseTransport {
  private readonly client: OpenAI;
  constructor(private readonly provider: ProviderSecret) {
    this.client = new OpenAI({ baseURL: provider.baseURL, apiKey: provider.apiKey, maxRetries: 0 });
  }
  stream(request: ModelRequest, signal: AbortSignal): ModelStream {
    checkCancelled(signal);
    const stream = this.client.responses.stream({
      model: this.provider.model,
      instructions: request.instructions,
      input: request.input,
      tools: request.tools,
      store: false,
      parallel_tool_calls: false,
      max_output_tokens: 12000,
      ...(this.provider.reasoningEffort ? { reasoning: { effort: this.provider.reasoningEffort as ReasoningEffort } } : {}),
      ...(request.outputSchema ? {
        text: { format: { type: 'json_schema' as const, name: 'agent_result', schema: request.outputSchema, strict: true } },
      } : {}),
    }, { signal });
    return { events: stream, finalResponse: () => stream.finalResponse() };
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

/** One bounded runtime serves planners, writers, independent characters, readers and demo mode. */
export async function runAgent(definition: AgentDefinition, options: RunAgentOptions): Promise<AgentStep> {
  const durable = !!(options.checkpoint || options.onCheckpoint);
  const newTurns: AgentTrace[] = [];
  const cp: AgentCheckpoint = options.checkpoint ?? {
    step: {
      id: randomUUID(), agentId: definition.id, label: definition.label, status: 'running',
      input: { instructions: definition.instructions, context: options.context, objective: options.objective, turns: newTurns },
      output: '', tools: [], usage: emptyUsage(), startedAt: new Date().toISOString(),
      contextSources: options.contextSources, responseIds: [],
    },
    input: [{ role: 'user', content: JSON.stringify({ context: options.context, objective: options.objective }) }],
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
      step.output = '';
      cp.phase = 'requesting';
      cp.uncertain = true;
      publish();
      save();
      const stream = await options.transport.stream({
        agentId: definition.id, instructions: definition.instructions, input: requestInput,
        tools: tools.map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters, strict: true })),
        ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
      }, options.signal);
      for await (const event of stream.events) {
        checkCancelled(options.signal);
        if (event.type === 'response.output_text.delta') {
          step.output += event.delta;
          options.onDelta?.(step.id, event.delta);
        } else if (event.type === 'error') {
          throw new Error(event.message);
        }
      }
      const response = await stream.finalResponse();
      trace.output = structuredClone(response);
      step.responseIds.push(response.id);
      addUsage(step.usage, usageOf(response));
      step.output = responseText(response);
      const refusal = response.output.flatMap(item => item.type === 'message'
        ? item.content.flatMap(part => part.type === 'refusal' ? [part.refusal] : []) : []);
      if (response.status !== 'completed' || refusal.length) {
        // Keep untrusted/incomplete calls out of the executable checkpoint, even across a restart.
        save();
        publish();
        checkCancelled(options.signal);
        throw new Error(response.status !== 'completed'
          ? response.error?.message ?? `模型输出未完成：${response.incomplete_details?.reason ?? response.status}`
          : `模型拒绝：${refusal.join('\n')}`);
      }
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
