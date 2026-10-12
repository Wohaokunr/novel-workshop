import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResponseOutputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';
import { DomainValidationError } from './domain.js';
import { runAgent, objectSchema, type AgentDefinition, type ModelRequest, type ModelResponse, type ResponseTransport } from './responses.js';

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
