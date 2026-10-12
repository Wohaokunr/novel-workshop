import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { ResponseOutputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';
import { DomainValidationError } from './domain.js';
import type { ProviderSecret } from '../shared/types.js';
import {
  MODEL_RETRIES, ModelServiceError, OpenAIResponseTransport, RequestGate, runAgent, objectSchema,
  type AgentDefinition, type ModelRequest, type ModelResponse, type ResponseTransport,
} from './responses.js';

function message(text: string): ResponseOutputItem {
  return { type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
}
function call(): ResponseOutputItem {
  return { type: 'function_call', id: 'function', call_id: 'call-id', name: 'write', arguments: '{"value":"ok"}' };
}
function response(output: ResponseOutputItem[], status = 'completed'): ModelResponse {
  return {
    id: `response-${status}`, status, output,
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, output_tokens_details: { reasoning_tokens: 2 }, input_tokens_details: { cached_tokens: 3 } },
  };
}
class FixtureTransport implements ResponseTransport {
  requests: ModelRequest[] = [];
  constructor(private readonly responses: ModelResponse[], private readonly beforeEvent?: () => void) {}
  stream(request: ModelRequest) {
    this.requests.push(structuredClone(request));
    const reply = this.responses[this.requests.length - 1] ?? this.responses[this.responses.length - 1]!;
    const beforeEvent = this.beforeEvent;
    return {
      events: (async function* (): AsyncGenerator<ResponseStreamEvent> {
        beforeEvent?.();
        yield { type: 'response.output_text.delta', delta: 'preview', item_id: 'message', output_index: 0, content_index: 0, sequence_number: 0 } as ResponseStreamEvent;
      })(),
      finalResponse: async () => reply,
    };
  }
}
function writerTool(execute: () => unknown): AgentDefinition {
  return { id: 'agent', label: 'fixture', instructions: 'fixture', tools: [{
    name: 'write', description: 'fixture write', parameters: objectSchema({ value: { type: 'string' } }), execute,
  }] };
}

test('Responses 完整回放推理、phase 与工具结果，用量只按响应累加一次', async () => {
  const reasoning: ResponseOutputItem = { type: 'reasoning', id: 'reasoning', summary: [], encrypted_content: 'opaque-encrypted-state', status: 'completed' };
  const commentary = { ...message('准备执行'), phase: 'commentary' as const };
  const transport = new FixtureTransport([response([reasoning, commentary, call()]), response([message('done')])]);
  let writes = 0;
  const step = await runAgent(writerTool(() => { writes++; return { saved: true }; }), {
    transport, context: { limited: true }, objective: 'test', contextSources: ['fixture'], signal: new AbortController().signal,
  });
  assert.equal(writes, 1);
  assert.equal(step.output, 'done');
  assert.deepEqual(step.usage, { input: 20, output: 8, total: 28, reasoning: 4, cached: 6, provided: true });
  assert.equal(transport.requests[0]!.tools[0]!.strict, true);
  const replay = transport.requests[1]!.input;
  assert.ok(replay.some(item => item.type === 'reasoning' && item.encrypted_content === 'opaque-encrypted-state'));
  assert.ok(replay.some(item => item.type === 'message' && 'phase' in item && item.phase === 'commentary'));
  assert.ok(replay.some(item => item.type === 'function_call_output' && item.call_id === 'call-id' && item.output === '{"saved":true}'));
});

test('未完成、拒绝及取消响应都不能执行写工具', async () => {
  const refusal: ResponseOutputItem = { type: 'message', id: 'refusal', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: '拒绝' }] };
  for (const scenario of ['incomplete', 'refusal', 'cancel'] as const) {
    const controller = new AbortController();
    const reply = scenario === 'refusal' ? response([refusal, call()]) : response([call()], scenario === 'incomplete' ? 'incomplete' : 'completed');
    const transport = new FixtureTransport([reply], scenario === 'cancel' ? () => controller.abort() : undefined);
    let writes = 0;
    await assert.rejects(runAgent(writerTool(() => { writes++; }), {
      transport, context: {}, objective: 'test', contextSources: [], signal: controller.signal,
    }));
    assert.equal(writes, 0, scenario);
  }
});

test('工具循环在 12 轮停止，严格参数校验阻止未知字段', async () => {
  let writes = 0;
  await assert.rejects(runAgent(writerTool(() => { writes++; return {}; }), {
    transport: new FixtureTransport([response([call()])]), context: {}, objective: 'test', contextSources: [], signal: new AbortController().signal,
  }), /12 轮/);
  assert.equal(writes, 12);
  const invalidCall = { ...call(), arguments: '{"value":"ok","extra":true}' } as ResponseOutputItem;
  await assert.rejects(runAgent(writerTool(() => { writes++; }), {
    transport: new FixtureTransport([response([invalidCall])]), context: {}, objective: 'test', contextSources: [], signal: new AbortController().signal,
  }), /12 轮/);
  assert.equal(writes, 12);
});

test('工具 JSON、参数和领域错误返回模型后可纠正，基础设施与未知工具仍终止', async () => {
  for (const scenario of ['json', 'schema', 'domain'] as const) {
    let attempts = 0;
    const first = scenario === 'json' ? { ...call(), arguments: '{' } : scenario === 'schema' ? { ...call(), arguments: '{"value":"ok","extra":true}' } : call();
    const transport = new FixtureTransport([response([first as ResponseOutputItem]), response([call()]), response([message('done')])]);
    const step = await runAgent(writerTool(() => {
      if (scenario === 'domain' && attempts++ === 0) throw new DomainValidationError('事实引用无效');
      return { saved: true };
    }), { transport, context: {}, objective: 'test', contextSources: [], signal: new AbortController().signal });
    assert.equal(step.status, 'completed', scenario);
    assert.equal((step.tools[0]!.result as { ok: boolean }).ok, false);
    assert.equal(step.tools.length, 2);
    assert.ok(transport.requests[1]!.input.some(item => item.type === 'function_call_output' && JSON.parse(item.output as string).ok === false));
  }
  for (const unknownTool of [false, true]) {
    const transport = new FixtureTransport([response([{ ...call(), ...(unknownTool ? { name: 'unknown' } : {}) } as ResponseOutputItem])]);
    await assert.rejects(runAgent(writerTool(() => { throw new Error('数据库不可用'); }), {
      transport, context: {}, objective: 'test', contextSources: [], signal: new AbortController().signal,
    }), unknownTool ? /无权调用/ : /数据库不可用/);
    assert.equal(transport.requests.length, 1);
  }
});

type Reply = { status: number; headers?: Record<string, string>; body: unknown } | { events: unknown[] };
/** A local stand-in for the Responses endpoint: records each request body and answers with JSON errors or an SSE stream. */
async function fakeService(answer: (index: number) => Reply) {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      const reply = answer(bodies.length - 1);
      if ('events' in reply) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of reply.events) response.write(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
      } else {
        response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
        response.end(JSON.stringify(reply.body));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}/v1`, bodies, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
function completed(text: string): Reply {
  const message = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const base = { id: 'resp_1', object: 'response', created_at: 0, model: 'fixture', parallel_tool_calls: false, tool_choice: 'auto', tools: [] };
  return { events: [
    { type: 'response.created', sequence_number: 0, response: { ...base, status: 'in_progress', output: [] } },
    { type: 'response.completed', sequence_number: 1, response: { ...base, status: 'completed', output: [message],
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ] };
}
const live = (baseURL: string, extra: Partial<ProviderSecret> = {}): ProviderSecret => ({ name: 'fixture', mode: 'live', baseURL, model: 'fixture', apiKey: 'sk-fixture', ...extra });
const ask: AgentDefinition = { id: 'ask', label: 'ask', instructions: 'Reply OK.' };
const run = (transport: ResponseTransport) => runAgent(ask, { transport, context: {}, objective: 'x', signal: new AbortController().signal, contextSources: [] });

test('限流先按 Retry-After 自动重试；服务明确拒绝的请求报告状态码且不重试，后台请求的排队位随之释放', async () => {
  const service = await fakeService(index => index === 0 || index === 4
    ? { status: 429, headers: { 'retry-after-ms': '1' }, body: { error: { message: 'Rate limit reached', type: 'requests' } } }
    : index === 2 ? { status: 400, body: { error: { message: 'Unsupported parameter', type: 'invalid_request_error' } } } : completed('OK'));
  try {
    const background = new OpenAIResponseTransport(live(service.baseURL), { background: true });
    assert.equal((await run(background)).output, 'OK');
    assert.equal(service.bodies.length, 2);
    await assert.rejects(run(background), (error: unknown) => error instanceof ModelServiceError && error.status === 400
      && error.message === '模型服务出错：400 Unsupported parameter');
    assert.equal(service.bodies.length, 3, 'a request the service rejects as invalid is not retried');
    assert.equal((await run(background)).output, 'OK', 'the failed background request gave its place back');
    assert.ok(MODEL_RETRIES >= 2);
    const before = service.bodies.length;
    await assert.rejects(run(new OpenAIResponseTransport(live(service.baseURL), { retries: 0 })), (error: unknown) => error instanceof ModelServiceError
      && error.message === '模型服务出错：429 Rate limit reached');
    assert.equal(service.bodies.length, before + 1, 'the connection test reports at once');
  } finally { await service.close(); }
});

test('推理配置请求加密推理内容并给出更高的输出上限；无加密内容的推理项不回传给不保存状态的服务', async () => {
  const service = await fakeService(() => completed('OK'));
  try {
    const signal = new AbortController().signal;
    const input = [
      { role: 'user' as const, content: '你好' },
      { type: 'reasoning' as const, id: 'rs_plain', summary: [] },
      { type: 'reasoning' as const, id: 'rs_sealed', summary: [], encrypted_content: 'sealed' },
      { type: 'function_call' as const, id: 'fc_1', call_id: 'call_1', name: 'save_report', arguments: '{}' },
      { type: 'function_call_output' as const, call_id: 'call_1', output: '{}' },
    ];
    const send = async (provider: ProviderSecret) => {
      const stream = await new OpenAIResponseTransport(provider).stream({ agentId: 'ask', instructions: 'x', input, tools: [] }, signal);
      for await (const _event of stream.events) { /* drain */ }
      await stream.finalResponse();
      return service.bodies.at(-1)!;
    };
    const reasoning = await send(live(service.baseURL, { reasoningEffort: 'high' }));
    assert.deepEqual(reasoning.include, ['reasoning.encrypted_content']);
    assert.deepEqual(reasoning.reasoning, { effort: 'high' });
    assert.equal(reasoning.max_output_tokens, 32000);
    assert.equal(reasoning.store, false);
    assert.deepEqual((reasoning.input as Array<{ id?: string }>).map(item => item.id), [undefined, 'rs_sealed', 'fc_1', undefined]);
    const plain = await send(live(service.baseURL));
    assert.equal(plain.include, undefined);
    assert.equal(plain.reasoning, undefined);
    assert.equal(plain.max_output_tokens, 16000);
    assert.equal((await send(live(service.baseURL, { maxOutputTokens: 8000, reasoningEffort: 'low' }))).max_output_tokens, 8000);
  } finally { await service.close(); }
});

test('后台请求只在作者的请求都结束后逐个发出；取消排队不占位，作者的请求从不等待', async () => {
  const gate = new RequestGate(), signal = new AbortController().signal, order: string[] = [];
  const author = await gate.enter(false, signal);
  const first = gate.enter(true, signal).then(release => { order.push('first'); return release; });
  const aborted = new AbortController(), cancelled = gate.enter(true, aborted.signal);
  const second = gate.enter(true, signal).then(release => { order.push('second'); return release; });
  const another = await gate.enter(false, signal);
  aborted.abort();
  await assert.rejects(cancelled, /取消/);
  author();
  await delay(5);
  assert.deepEqual(order, [], 'still one author request in flight');
  another();
  const releaseFirst = await first;
  await delay(5);
  assert.deepEqual(order, ['first'], 'one background request at a time');
  const third = await gate.enter(false, signal);
  releaseFirst(); releaseFirst();
  await delay(5);
  assert.deepEqual(order, ['first'], 'a new author request holds back the queue again');
  third();
  (await second)();
  assert.deepEqual(order, ['first', 'second']);
});
