import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ResponseInputItem, ResponseOutputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';
import {
  AgentSuspended, CONTINUE_NOTICE, joinContinuation, MAX_AGENT_TURNS, MAX_OUTPUT_CONTINUATIONS, ModelServiceError, objectSchema, OutputLimitError, runAgent, settleCheckpointTool,
  type AgentCheckpoint, type AgentDefinition, type ModelRequest, type ModelResponse,
  type ResponseTransport, type RunAgentOptions, type ToolCallContext,
} from './responses.js';
import { DomainValidationError } from './domain.js';

function message(text: string): ResponseOutputItem {
  return { type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
}
function call(callId = 'write-call', argumentsValue = '{"value":"ok"}'): ResponseOutputItem {
  return { type: 'function_call', id: `function-${callId}`, call_id: callId, name: 'write', arguments: argumentsValue };
}
function response(output: ResponseOutputItem[], id = 'response', status = 'completed'): ModelResponse {
  return { id, status, output, usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } };
}
class FixtureTransport implements ResponseTransport {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly replies: ModelResponse[], private readonly beforeRequest?: () => void) {}
  stream(request: ModelRequest) {
    this.beforeRequest?.();
    this.requests.push(structuredClone(request));
    const reply = this.replies[this.requests.length - 1] ?? this.replies[this.replies.length - 1]!;
    return {
      events: (async function* (): AsyncGenerator<ResponseStreamEvent> {
        yield { type: 'response.output_text.delta', delta: 'preview', item_id: 'message', output_index: 0, content_index: 0, sequence_number: 0 } as ResponseStreamEvent;
      })(),
      finalResponse: async () => reply,
    };
  }
}
function writer(execute: NonNullable<AgentDefinition['tools']>[number]['execute']): AgentDefinition {
  return { id: 'writer', label: 'writer', instructions: 'write', tools: [{
    name: 'write', description: 'write fixture', parameters: objectSchema({ value: { type: 'string' } }), execute,
  }] };
}
function options(transport: ResponseTransport, extra: Partial<RunAgentOptions> = {}): RunAgentOptions {
  return { transport, context: { limited: true }, objective: 'fixture', signal: new AbortController().signal, contextSources: ['fixture'], ...extra };
}
function journal() {
  const snapshots: AgentCheckpoint[] = [];
  return {
    snapshots,
    save(cp: AgentCheckpoint) { snapshots.push(structuredClone(cp)); },
    latest() { assert.ok(snapshots.length); return snapshots[snapshots.length - 1]!; },
  };
}
function outputs(input: ResponseInputItem[]) {
  return input.filter(item => item.type === 'function_call_output');
}
const suspended = (reason: string) => (error: unknown) => error instanceof AgentSuspended && error.reason === reason && error.message === reason;

test('完整响应后挂起保留 native 回放与原 step/call；恢复先用 receipt，不重发旧 response', async () => {
  const reasoning: ResponseOutputItem = { type: 'reasoning', id: 'reasoning', summary: [], encrypted_content: 'opaque-state', status: 'completed' };
  const commentary = { ...message('准备写入'), phase: 'commentary' as const };
  const transport = new FixtureTransport([response([reasoning, commentary, call()], 'tool-response'), response([message('done')], 'final-response')]);
  const saved = journal();
  const contexts: ToolCallContext[] = [];
  const deltas: Array<{ id: string; delta: string }> = [];
  const receipt = { saved: true };
  let waiting = true;
  let budgetAttempts = 0;
  const definition = writer((argumentsValue, _signal, context) => {
    assert.deepEqual(argumentsValue, { value: 'ok' });
    assert.ok(context);
    contexts.push(context);
    const latest = saved.latest();
    assert.equal(latest.phase, 'tools', 'response is persisted before execute');
    assert.equal(latest.cursor, 0);
    assert.equal(latest.pendingCalls.length, 1);
    assert.equal(transport.requests.length, 1, 'no second request before settling the stored call');
    if (waiting) throw new AgentSuspended('等待审批');
    return receipt;
  });
  const runOptions = options(transport, {
    onCheckpoint: saved.save,
    beforeRequest: () => { budgetAttempts++; },
    onDelta: (id, delta) => { deltas.push({ id, delta }); },
  });
  await assert.rejects(runAgent(definition, runOptions), suspended('等待审批'));
  const cp = saved.latest();
  assert.equal(cp.step.status, 'paused');
  assert.equal(cp.step.finishedAt, undefined);
  assert.equal(cp.phase, 'tools');
  assert.equal(cp.cursor, 0);
  assert.equal(cp.turn, 0);
  assert.equal(cp.uncertain, false);
  assert.equal(transport.requests.length, 1);
  assert.equal(outputs(cp.input).length, 0, 'suspension must not fabricate a function output');
  assert.deepEqual(cp.step.tools[0]!.result, { status: 'running' });
  const originalActivityAt = cp.step.tools[0]!.at;
  assert.equal(cp.step.tools[0]!.callId, 'write-call');
  assert.equal(cp.step.tools[0]!.turn, 0);
  waiting = false;
  const step = await runAgent(definition, { ...runOptions, checkpoint: cp });
  assert.equal(step.id, cp.step.id);
  assert.equal(step.status, 'completed');
  assert.equal(step.output, 'done');
  assert.equal(step.tools.length, 1, 'resume updates the original running activity');
  assert.equal(step.tools[0]!.at, originalActivityAt);
  assert.deepEqual(step.tools[0]!.result, receipt);
  assert.deepEqual(contexts[0], contexts[1], 'receipt key and parsed argument hash survive resume');
  assert.equal(contexts[0]!.key, `${step.id}:0:write-call`);
  assert.equal(contexts[0]!.argumentsHash, createHash('sha256').update('{"value":"ok"}').digest('hex'));
  assert.equal(budgetAttempts, 2);
  assert.deepEqual(step.responseIds, ['tool-response', 'final-response']);
  assert.deepEqual(step.usage, { input: 20, output: 8, total: 28, reasoning: 0, cached: 0, provided: true });
  const replay = transport.requests[1]!.input;
  assert.ok(replay.some(item => item.type === 'reasoning' && item.encrypted_content === 'opaque-state'));
  assert.ok(replay.some(item => item.type === 'message' && 'phase' in item && item.phase === 'commentary'));
  assert.equal(outputs(replay).length, 1);
  assert.equal(outputs(replay)[0]!.output, '{"saved":true}');
  assert.ok(deltas.every(delta => delta.id === step.id && delta.delta === 'preview'));
  const traces = (step.input as { turns: Array<{ input?: unknown; turn: number }> }).turns;
  assert.deepEqual(traces.map(trace => trace.turn), [0, 1]);
  assert.ok(traces.every(trace => trace.input === undefined), 'durable trace does not repeat the growing replay input');
  const completed = saved.latest();
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.step.status, 'completed');
  const replayStep = await runAgent(writer(() => { throw new Error('must not run'); }), options({ stream() { throw new Error('must not request'); } }, { checkpoint: completed }));
  assert.equal(replayStep.id, step.id);
});

test('settleCheckpointTool 审批事务推进原调用且幂等，恢复不会再 execute 已批准工具', async () => {
  const transport = new FixtureTransport([response([call()], 'tool-response'), response([message('done')], 'final-response')]);
  const saved = journal();
  let executed = 0;
  const definition = writer(() => { executed++; throw new AgentSuspended('等待审批'); });
  await assert.rejects(runAgent(definition, options(transport, { onCheckpoint: saved.save })), AgentSuspended);
  const waiting = saved.latest();
  const result = { approved: true, revision: 7 };
  const settled = settleCheckpointTool(waiting, 'write-call', result);
  assert.equal(waiting.cursor, 0, 'transaction helper does not mutate its input');
  assert.equal(outputs(waiting.input).length, 0);
  assert.equal(settled.phase, 'tools');
  assert.equal(settled.cursor, 1);
  assert.equal(settled.turn, 0);
  assert.equal(settled.step.tools.length, 1);
  assert.deepEqual(settled.step.tools[0]!.result, result);
  assert.equal(outputs(settled.input).length, 1);
  const repeated = settleCheckpointTool(settled, 'write-call', { approved: false });
  assert.deepEqual(repeated, settled, 'the first committed receipt wins');
  assert.equal(outputs(repeated.input).length, 1);
  assert.throws(() => settleCheckpointTool(waiting, 'other-call', result), /当前没有对应/);
  assert.throws(() => settleCheckpointTool({ ...waiting, phase: 'ready' }, 'write-call', result), /当前没有对应/);
  const step = await runAgent(definition, options(transport, { checkpoint: repeated, onCheckpoint: saved.save }));
  assert.equal(executed, 1, 'only the initial suspension executes the tool');
  assert.equal(step.id, waiting.step.id);
  assert.deepEqual(step.tools[0]!.result, result);
  assert.equal(transport.requests.length, 2);
  assert.equal(outputs(transport.requests[1]!.input)[0]!.output, JSON.stringify(result));
});

test('响应 checkpoint 保存后崩溃，恢复无新模型请求先 execute 已存调用', async () => {
  const transport = new FixtureTransport([response([call()], 'tool-response'), response([message('done')], 'final-response')]);
  let stored: AgentCheckpoint | undefined;
  let executed = 0;
  const definition = writer(() => {
    assert.equal(transport.requests.length, 1);
    executed++;
    return { saved: true };
  });
  const crash = new Error('simulated crash after persistence');
  await assert.rejects(runAgent(definition, options(transport, { onCheckpoint(cp) {
    stored = structuredClone(cp);
    if (cp.phase === 'tools') throw crash;
  } })), error => error === crash);
  assert.equal(executed, 0);
  assert.ok(stored);
  const cp: AgentCheckpoint = stored;
  assert.equal(cp.phase, 'tools');
  assert.equal(cp.cursor, 0);
  assert.equal(cp.step.tools.length, 0);
  assert.deepEqual(cp.step.responseIds, ['tool-response']);
  const step = await runAgent(definition, options(transport, { checkpoint: cp }));
  assert.equal(step.status, 'completed');
  assert.equal(executed, 1);
  assert.equal(transport.requests.length, 2);
  assert.deepEqual(step.responseIds, ['tool-response', 'final-response']);
});

test('无工具最终响应保存后崩溃，恢复验证结果并完成，不发送第二个模型请求', async () => {
  let stored: AgentCheckpoint | undefined;
  const transport = new FixtureTransport([response([message('{"summary":"done"}')], 'final-response')]);
  const definition = writer(() => { throw new Error('must not execute'); });
  definition.outputSchema = objectSchema({ summary: { type: 'string' } });
  await assert.rejects(runAgent(definition, options(transport, { onCheckpoint(cp) {
    stored = structuredClone(cp);
    if (cp.phase === 'tools') throw new Error('final response persisted crash');
  } })), /final response persisted crash/);
  assert.ok(stored);
  assert.equal(stored.pendingCalls.length, 0);
  assert.equal(stored.phase, 'tools');
  const saved = journal();
  const step = await runAgent(definition, options({ stream() { throw new Error('must not request'); } }, { checkpoint: stored, onCheckpoint: saved.save }));
  assert.equal(step.id, stored.step.id);
  assert.equal(step.status, 'completed');
  assert.deepEqual(step.structured, { summary: 'done' });
  assert.deepEqual(step.responseIds, ['final-response']);
  assert.equal(step.usage.total, 14);
  assert.equal(saved.latest().phase, 'completed');
  assert.equal(transport.requests.length, 1);
});

test('每个结果 checkpoint 保存后崩溃，cursor 跳过已完成调用，最后结果不会重查旧 response', async () => {
  for (const crashAt of [1, 2]) {
    const transport = new FixtureTransport([response([call('first'), call('second')], 'tools'), response([message('done')], 'final')]);
    let stored: AgentCheckpoint | undefined;
    const executions: string[] = [];
    const definition = writer((_argumentsValue, _signal, context) => { executions.push(context!.callId); return { saved: context!.callId }; });
    await assert.rejects(runAgent(definition, options(transport, { onCheckpoint(cp) {
      stored = structuredClone(cp);
      if (cp.phase === 'tools' && cp.cursor === crashAt) throw new Error('result persisted crash');
    } })), /result persisted crash/);
    assert.ok(stored);
    assert.equal(stored.cursor, crashAt);
    assert.equal(transport.requests.length, 1);
    const step = await runAgent(definition, options(transport, { checkpoint: stored }));
    assert.equal(step.status, 'completed');
    assert.deepEqual(executions, ['first', 'second']);
    assert.equal(step.tools.length, 2);
    assert.equal(transport.requests.length, 2);
    assert.deepEqual(outputs(transport.requests[1]!.input).map(item => item.call_id), ['first', 'second']);
  }
});

test('requesting 检查点默认不重试；显式确认 ready 后保留 turn 并按新 attempt 做预算检查', async () => {
  const saved = journal();
  let attempts = 0;
  let requests = 0;
  const lost: ResponseTransport = { stream() { requests++; throw new Error('network connection lost'); } };
  const definition = writer(() => { throw new Error('must not execute'); });
  await assert.rejects(runAgent(definition, options(lost, { onCheckpoint: saved.save, beforeRequest: () => { attempts++; } })), /network connection lost/);
  const uncertain = saved.latest();
  assert.equal(uncertain.phase, 'requesting');
  assert.equal(uncertain.uncertain, true);
  assert.equal(requests, 1);
  await assert.rejects(runAgent(definition, options(lost, {
    checkpoint: uncertain, onCheckpoint: saved.save, beforeRequest: () => { attempts++; },
  })), suspended('模型请求结果不确定，请确认后恢复'));
  assert.equal(requests, 1);
  assert.equal(attempts, 1, 'blocked recovery is not a model attempt');
  assert.equal(saved.latest().step.status, 'paused');
  assert.equal(saved.latest().step.finishedAt, undefined);
  const confirmed = structuredClone(saved.latest());
  confirmed.phase = 'ready';
  confirmed.uncertain = false;
  const transport = new FixtureTransport([response([message('confirmed')], 'confirmed-response')]);
  const step = await runAgent(definition, options(transport, {
    checkpoint: confirmed, onCheckpoint: saved.save, beforeRequest: () => { attempts++; },
  }));
  assert.equal(step.id, uncertain.step.id);
  assert.equal(attempts, 2);
  assert.equal(saved.latest().turn, 0, 'confirmed retry retains the original response turn');
  assert.deepEqual(step.responseIds, ['confirmed-response']);
  assert.equal(step.usage.total, 14);
  assert.equal(step.status, 'completed');
});

test('request 前同步保存 requesting，保存失败时不能向模型发送请求', async () => {
  let requests = 0;
  let stored: AgentCheckpoint | undefined;
  await assert.rejects(runAgent(writer(() => null), options({ stream() { requests++; throw new Error('must not request'); } }, {
    onCheckpoint(cp) {
      stored = structuredClone(cp);
      if (cp.phase === 'requesting') throw new Error('request checkpoint crash');
    },
  })), /request checkpoint crash/);
  assert.equal(requests, 0);
  assert.ok(stored);
  assert.equal(stored.phase, 'requesting');
  assert.equal(stored.uncertain, true);
});

test('暂停/预算在 request 前可持久等待，暂停不等同取消或失败', async () => {
  const saved = journal();
  const transport = new FixtureTransport([response([message('done')])]);
  let paused = true;
  const beforeRequest = async () => { if (paused) throw new AgentSuspended('用户暂停'); };
  await assert.rejects(runAgent(writer(() => null), options(transport, { beforeRequest, onCheckpoint: saved.save })), suspended('用户暂停'));
  const cp = saved.latest();
  assert.equal(cp.step.status, 'paused');
  assert.equal(cp.step.finishedAt, undefined);
  assert.equal(cp.phase, 'ready');
  assert.equal(cp.turn, 0);
  assert.equal(transport.requests.length, 0);
  assert.equal(outputs(cp.input).length, 0);
  paused = false;
  const step = await runAgent(writer(() => null), options(transport, { checkpoint: cp, beforeRequest, onCheckpoint: saved.save }));
  assert.equal(step.status, 'completed');
  assert.equal(step.id, cp.step.id);
  const toolPause = journal();
  const controller = new AbortController();
  await assert.rejects(runAgent(writer(() => { controller.abort(); throw new AgentSuspended('等待输入'); }), options(new FixtureTransport([response([call()])]), {
    signal: controller.signal, onCheckpoint: toolPause.save,
  })), suspended('等待输入'));
  assert.equal(toolPause.latest().step.status, 'paused', 'AgentSuspended is not coerced to cancelled');
  assert.equal(outputs(toolPause.latest().input).length, 0);
  const cancelled = journal();
  await assert.rejects(runAgent(writer(() => null), options(transport, { signal: controller.signal, onCheckpoint: cancelled.save })), /任务已取消/);
  assert.equal(cancelled.latest().step.status, 'cancelled', 'real abort semantics remain unchanged');
});

test('durable maxTurns 在保存最后工具结果后挂起；提高预算恢复不会再次执行已保存工具', async () => {
  const saved = journal();
  const transport = new FixtureTransport([response([call()], 'tools'), response([message('done')], 'final')]);
  let writes = 0;
  const definition = writer(() => { writes++; return { saved: true }; });
  await assert.rejects(runAgent(definition, options(transport, { maxTurns: 1, onCheckpoint: saved.save })), suspended('智能体达到 1 轮上限，请缩小本次任务'));
  const cp = saved.latest();
  assert.equal(writes, 1);
  assert.equal(cp.phase, 'ready');
  assert.equal(cp.turn, 1);
  assert.equal(cp.step.status, 'paused');
  assert.equal(outputs(cp.input).length, 1);
  const step = await runAgent(definition, options(transport, { checkpoint: cp, maxTurns: 2, onCheckpoint: saved.save }));
  assert.equal(step.status, 'completed');
  assert.equal(writes, 1);
  assert.equal(transport.requests.length, 2);
});

test('参数 hash 使用解析对象的稳定 JSON，数组顺序保留，legacy 两参工具兼容', async () => {
  const hashes: string[] = [];
  const argumentsList = ['{"items":[{"z":2,"a":1}],"value":"ok"}', '{ "value": "ok", "items": [{"a":1,"z":2}] }'];
  for (const argumentsText of argumentsList) {
    const definition: AgentDefinition = { id: 'stable', label: 'stable', instructions: 'fixture', tools: [{
      name: 'write', description: 'write', parameters: objectSchema({ value: { type: 'string' }, items: { type: 'array', items: objectSchema({ a: { type: 'integer' }, z: { type: 'integer' } }) } }),
      execute(_argumentsValue, signal, context) { assert.equal(signal.aborted, false); hashes.push(context!.argumentsHash); return {}; },
    }] };
    await runAgent(definition, options(new FixtureTransport([response([call('stable', argumentsText)]), response([message('done')])]), { onCheckpoint() {} }));
  }
  assert.equal(hashes[0], hashes[1]);
  assert.equal(hashes[0], createHash('sha256').update('{"items":[{"a":1,"z":2}],"value":"ok"}').digest('hex'));
  let legacyArguments: unknown;
  let legacySignal: AbortSignal | undefined;
  const legacyOptions = options(new FixtureTransport([response([call()]), response([message('done')])]));
  const step = await runAgent(writer((argumentsValue, signal) => { legacyArguments = argumentsValue; legacySignal = signal; return { saved: true }; }), legacyOptions);
  assert.equal(step.status, 'completed');
  assert.deepEqual(legacyArguments, { value: 'ok' });
  assert.equal(legacySignal, legacyOptions.signal);
  const turns = (step.input as { turns: Array<{ input: ResponseInputItem[] }> }).turns;
  assert.equal(turns.length, 2);
  assert.ok(turns.every(turn => Array.isArray(turn.input)), 'legacy default keeps its original full-input trace');
});

test('拒绝和未完成响应即使 checkpoint 恢复也绝不执行工具；legacy 12 轮保持失败', async () => {
  const refusal: ResponseOutputItem = { type: 'message', id: 'refusal', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: '不允许' }] };
  for (const reply of [response([call()], 'incomplete', 'incomplete'), response([refusal, call()], 'refusal')]) {
    const saved = journal();
    let writes = 0;
    const definition = writer(() => { writes++; return {}; });
    const transport = new FixtureTransport([reply]);
    // The answer arrived, so the outcome is known: the run waits for the author, and resuming sends a new turn without a cost confirmation.
    await assert.rejects(runAgent(definition, options(transport, { onCheckpoint: saved.save })), (error: unknown) => error instanceof AgentSuspended && /未完成|模型拒绝/.test(error.message));
    assert.equal(saved.latest().step.status, 'paused');
    assert.equal(saved.latest().pendingCalls.length, 0);
    assert.deepEqual([saved.latest().phase, saved.latest().uncertain, saved.latest().turn], ['ready', false, 1]);
    assert.equal(writes, 0);
    await assert.rejects(runAgent(definition, options(transport, { checkpoint: saved.latest(), onCheckpoint: saved.save })), AgentSuspended);
    assert.equal(writes, 0);
    assert.equal(transport.requests.length, 2);
  }
  let writes = 0;
  let lastStatus: string | undefined;
  const transport = new FixtureTransport([response([call()])]);
  await assert.rejects(runAgent(writer(() => { writes++; return {}; }), options(transport, { onStep: step => { lastStatus = step.status; } })), /12 轮/);
  assert.equal(MAX_AGENT_TURNS, 12);
  assert.equal(transport.requests.length, MAX_AGENT_TURNS);
  assert.equal(writes, MAX_AGENT_TURNS);
  assert.equal(lastStatus, 'failed');
});

test('durable 保留严格 schema/领域校验反馈及未知工具/基础设施终止语义', async () => {
  for (const scenario of ['json', 'schema', 'domain'] as const) {
    const saved = journal();
    const first = scenario === 'json' ? call('first', '{') : scenario === 'schema' ? call('first', '{"value":"ok","extra":true}') : call('first');
    const transport = new FixtureTransport([response([first]), response([call('corrected')]), response([message('{"summary":"done"}')])]);
    let writes = 0;
    const definition = writer(() => {
      if (scenario === 'domain' && writes++ === 0) throw new DomainValidationError('领域校验失败');
      return { saved: true };
    });
    definition.outputSchema = objectSchema({ summary: { type: 'string' } });
    const step = await runAgent(definition, options(transport, { onCheckpoint: saved.save }));
    assert.equal(step.status, 'completed');
    assert.deepEqual(step.structured, { summary: 'done' });
    assert.equal((step.tools[0]!.result as { ok: boolean }).ok, false);
    assert.equal(transport.requests[0]!.tools[0]!.strict, true);
    assert.ok(outputs(transport.requests[1]!.input).some(item => JSON.parse(item.output as string).ok === false));
  }
  for (const unknown of [false, true]) {
    const saved = journal();
    const transport = new FixtureTransport([response([{ ...call(), ...(unknown ? { name: 'unknown' } : {}) } as ResponseOutputItem])]);
    await assert.rejects(runAgent(writer(() => { throw new Error('infra failed'); }), options(transport, { onCheckpoint: saved.save })), unknown ? /无权调用/ : /infra failed/);
    assert.equal(saved.latest().step.status, 'failed');
    assert.equal(outputs(saved.latest().input).length, 0);
    assert.equal(transport.requests.length, 1);
  }
});

function cut(text: string, extra: ResponseOutputItem[] = []): ModelResponse {
  const output: ResponseOutputItem[] = text ? [{ ...message(text), status: 'incomplete' } as ResponseOutputItem] : [];
  return { id: `cut-${text.length}`, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [...output, ...extra],
    usage: { input_tokens: 10, output_tokens: 16000, total_tokens: 16010, output_tokens_details: { reasoning_tokens: 9000 } } };
}
const prose: AgentDefinition = { id: 'writer', label: 'writer', instructions: 'write' };

test('服务明确报错的请求不算结果不确定：durable 挂起后可直接重发同一轮，非 durable 原样报错', async () => {
  let failing = true, requests = 0;
  const flaky: ResponseTransport = { stream(request, signal) {
    requests++;
    if (failing) throw new ModelServiceError('模型服务出错（已自动重试 4 次）：429 Rate limit reached', 429);
    return new FixtureTransport([response([message('ok')], 'after-retry')]).stream(request);
  } };
  await assert.rejects(runAgent(prose, options(flaky)), (error: unknown) => error instanceof ModelServiceError && error.status === 429);
  const saved = journal();
  await assert.rejects(runAgent(prose, options(flaky, { onCheckpoint: saved.save })),
    (error: unknown) => error instanceof AgentSuspended && /429 Rate limit reached。这一轮没有产生结果；恢复任务会重新发送这一轮/.test(error.message));
  assert.deepEqual([saved.latest().phase, saved.latest().uncertain, saved.latest().turn, saved.latest().step.status], ['ready', false, 0, 'paused']);
  failing = false;
  const step = await runAgent(prose, options(flaky, { checkpoint: saved.latest(), onCheckpoint: saved.save }));
  assert.equal(step.output, 'ok');
  assert.equal(saved.latest().turn, 0, 'a turn the service rejected had no response, so it is sent again as the same turn');
  assert.equal(requests, 3);
});

test('纯文本回答达到输出上限时续写并去掉重叠；续写次数用尽或结构化输出被截断时报告上限', async () => {
  const transport = new FixtureTransport([cut('第一段。直到雨停下来的时候'), cut('直到雨停下来的时候，她推开门。'), response([message('门外没有人。')])]);
  const saved = journal();
  const step = await runAgent(prose, options(transport, { onCheckpoint: saved.save }));
  assert.equal(step.output, '第一段。直到雨停下来的时候，她推开门。门外没有人。');
  assert.deepEqual(transport.requests[1]!.input.slice(-2), [{ role: 'assistant', content: '第一段。直到雨停下来的时候' }, { role: 'user', content: CONTINUE_NOTICE }]);
  assert.equal(transport.requests[2]!.input.length, 5);
  assert.equal(saved.latest().turn, 2);
  assert.equal(saved.latest().continued, undefined);

  const endless = new FixtureTransport([cut('又一段。')]);
  await assert.rejects(runAgent(prose, options(endless)), (error: unknown) => error instanceof OutputLimitError
    && error.message === '模型输出达到单次上限被截断（本次输出 16000 tokens，其中推理 9000）');
  assert.equal(endless.requests.length, MAX_OUTPUT_CONTINUATIONS + 1);

  const schema = objectSchema({ summary: { type: 'string' } });
  for (const definition of [{ ...prose, outputSchema: schema }, writer(() => { throw new Error('must not execute'); })]) {
    const structured = new FixtureTransport([cut('{"summary":"半', definition.tools ? [call('cut-call', '{"value":"')] : [])]);
    const journalled = journal();
    await assert.rejects(runAgent(definition, options(structured, { onCheckpoint: journalled.save })), OutputLimitError);
    assert.equal(structured.requests.length, 1, 'a cut JSON answer or tool call cannot be continued');
    assert.deepEqual([journalled.latest().phase, journalled.latest().uncertain, journalled.latest().turn, journalled.latest().pendingCalls.length], ['ready', false, 1, 0]);
  }
});

test('续写拼接只去掉足够长的重叠', () => {
  assert.equal(joinContinuation('她说：“走吧。”他站在门口没有回答。', '他站在门口没有回答。风更大了。'), '她说：“走吧。”他站在门口没有回答。风更大了。');
  assert.equal(joinContinuation('一二三四五六七', '七八九'), '一二三四五六七七八九', 'a short coincidence is not an overlap');
});
