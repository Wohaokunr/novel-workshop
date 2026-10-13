import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ModelRequest, ModelResponse, ResponseTransport } from './responses.js';
import { BENCHMARK } from './eval/bench.js';
import { compareReports, formatReport, runBenchmark, runTask, type BenchReport } from './eval/harness.js';
import { absent, proseFormat, styleCheck } from './eval/checks.js';
import { PROMPTS, PROMPT_SET_VERSION, prompt, promptVersion } from './prompts/index.js';
import { writerPrompt, writerScopePrompts } from './prompts/specialists.js';
import { styleProfile } from '../shared/style-types.js';

function answer(value: unknown): ModelResponse {
  return { id: randomUUID(), status: 'completed', output: [{ type: 'message', id: randomUUID(), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: typeof value === 'string' ? value : JSON.stringify(value), annotations: [] }] }], usage: null };
}
/** Answers every benchmark task the way a well-behaved model would: the author's own sample as prose, boundary-respecting JSON otherwise. */
function compliant(override?: (request: ModelRequest) => unknown): (project: { style?: { samples: Array<{ text: string }> } }) => ResponseTransport {
  return project => ({ stream: request => {
    const value = override?.(request) ?? (request.agentId === 'writer' ? `${project.style!.samples[0]!.text}\n${project.style!.samples[0]!.text}`
      : request.agentId === 'reader' ? { verdict: 'pass', issues: [], recommendation: '节奏清楚，悬念自然。' }
      : { perspective: '他问得太巧了。', intention: '弄清钥匙的下落', action: '先不说破，看对方怎么接', uncertainty: '不知道对方为什么关心这件事' });
    return { events: (async function* () {})(), finalResponse: async () => answer(value) };
  } });
}

test('基准集：受限角色的上下文不含秘密与作者侧资料，写作者拿到作者约束与禁用词；守规矩的输出通过全部检查', async () => {
  const report = await runBenchmark(compliant(), { mode: 'fixture' });
  assert.equal(report.results.length, BENCHMARK.flatMap(item => item.tasks).length);
  for (const result of report.results) {
    assert.equal(result.error, undefined);
    assert.deepEqual(result.checks.filter(check => !check.ok), [], `${result.caseId}/${result.taskId}`);
  }
  const kinds = new Set(report.results.flatMap(result => result.checks.map(check => `${check.kind}/${check.stage}`)));
  for (const kind of ['knowledge/context', 'knowledge/output', 'constraint/context', 'constraint/output', 'style/output', 'format/output']) assert.ok(kinds.has(kind), kind);
  assert.equal(report.promptSet, PROMPT_SET_VERSION);
});

test('基准检查抓出知识越界、违反作者约束、文风问题与格式问题，并引用出处', async () => {
  const mist = BENCHMARK.find(item => item.id === 'mist-harbor')!, task = mist.tasks.find(item => item.id === 'write-teahouse')!;
  const sample = mist.build().style!.samples[0]!.text, leaking = `${sample}\n${sample}\n许砚不禁想到：沈照就是巡捕房的线人。后来林舟死在了码头，鬼魂夜夜来敲门。`;
  const result = await runTask(mist, task, compliant(request => request.agentId === 'writer' ? leaking : undefined) as never);
  const failed = new Map(result.checks.filter(check => !check.ok).map(check => [check.id, check]));
  assert.match(failed.get('secret:0')!.detail!, /「线人」：.*沈照就是巡捕房的线人/);
  assert.ok(failed.has('rule:0'), '超自然元素'); assert.ok(failed.has('rule:1'), '林舟死亡');
  assert.match(failed.get('style')!.detail!, /不禁/);
  assert.ok(!failed.has('format'));
  assert.match(proseFormat('```\n{"text":"正文"}\n```', [1, 100]).detail!, /代码围栏/);
  assert.match(proseFormat('以下是本场正文：\n雾很大。', [1, 100]).detail!, /说明性/);
  assert.equal(styleCheck(mist.build().style!.samples[0]!.text, styleProfile(mist.build())).ok, true, '作者自己的范文贴合自己的文风');
  assert.equal(absent('x', 'knowledge', 'output', '', '他什么也不知道。', ['线人']).ok, true);
  const character = mist.tasks.find(item => item.role === 'character')!;
  const peeking = await runTask(mist, character, compliant(() => ({ perspective: '我早就知道沈照替巡捕房做线人。', intention: '揭穿', action: '摊牌', uncertainty: '无' })) as never);
  assert.ok(peeking.checks.some(check => check.id === 'secret:0' && check.stage === 'output' && !check.ok));
  assert.ok(peeking.checks.filter(check => check.stage === 'context').every(check => check.ok), '上下文本身没有泄漏');
});

test('与基线比较：报告通过率下降的检查与改动的提示词；请求失败算作未通过，已移出基准的任务不比较', async () => {
  const baseline = await runBenchmark(compliant(), { mode: 'fixture', repeat: 2 });
  assert.deepEqual(compareReports(baseline, baseline), []);
  let calls = 0;
  const worse = await runBenchmark(compliant(request => request.agentId === 'writer' && calls++ % 2 === 0 ? '许砚想起沈照是线人。'.repeat(40) : undefined), { mode: 'fixture', repeat: 2 });
  const regressions = compareReports(baseline, worse);
  assert.ok(regressions.some(item => item.taskId === 'write-teahouse' && item.checkId === 'secret:0' && item.before === 1 && item.after === 0.5));
  const broken: BenchReport = { ...worse, results: worse.results.map(result => result.taskId === 'character-su' ? { ...result, checks: result.checks.filter(check => check.stage === 'context'), error: '服务不可用' } : result) };
  assert.ok(compareReports(baseline, broken).some(item => item.taskId === 'character-su' && item.checkId === 'secret:0' && item.after === 0));
  const trimmed: BenchReport = { ...worse, results: worse.results.filter(result => result.caseId !== 'mist-harbor') };
  assert.ok(!compareReports(baseline, trimmed).some(item => item.caseId === 'mist-harbor'));
  const edited: BenchReport = { ...baseline, prompts: baseline.prompts.map(item => item.id === 'writer' ? { ...item, version: 'changed' } : item) };
  assert.match(formatReport(worse, edited), /改动的提示词 writer/);
  assert.match(formatReport(worse, baseline), /通过率下降 \d+ 项/);
});

test('提示词独立成文件：id 唯一、版本由文本计算，写作步骤记录所用提示词的版本', async () => {
  const ids = PROMPTS.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('coordinator') && ids.includes('writer') && ids.includes('companion.mode.outline') && ids.includes('story.digest') && ids.includes('style.learn'));
  for (const item of PROMPTS) { assert.ok(item.text.trim()); assert.equal(item.version, promptVersion(item.text)); }
  assert.notEqual(prompt('x', 'a').version, prompt('x', 'b').version);
  const mist = BENCHMARK[0]!, result = await runTask(mist, mist.tasks[0]!, compliant() as never);
  assert.equal(result.promptVersion, promptVersion(`${writerPrompt.text}\n${writerScopePrompts.scene.text}`));
});
