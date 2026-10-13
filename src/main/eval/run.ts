import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ProviderSecret, RunRequest, Workspace } from '../../shared/types.js';
import { OpenAIResponseTransport } from '../responses.js';
import { DemoAgentTransport } from '../agent/demo.js';
import { compareReports, formatReport, runBenchmark, type BenchReport } from './harness.js';
import { judgeReports } from './judge.js';

/** npm run eval -- [--repeat N] [--baseline report.json [--judge]] [--out dir] [--strict]
 * With NOVEL_EVAL_MODEL and an API key (NOVEL_EVAL_API_KEY or OPENAI_API_KEY; NOVEL_EVAL_BASE_URL, NOVEL_EVAL_REASONING_EFFORT and
 * NOVEL_EVAL_MAX_OUTPUT_TOKENS optional) it calls that model; otherwise it runs the local demo responses, which only exercises
 * the harness and the context checks. Exits 1 when a context check fails, when a check's pass rate dropped below the baseline,
 * or, with --strict, when any check failed. --judge also has a model (NOVEL_EVAL_JUDGE_MODEL, default the benchmark model) blindly
 * compare each scene the writer wrote with the baseline's version of it; the result is reported, it never fails the run. */
const { values } = parseArgs({ options: { repeat: { type: 'string', default: '1' }, baseline: { type: 'string' }, out: { type: 'string', default: 'artifacts/eval' }, strict: { type: 'boolean', default: false }, judge: { type: 'boolean', default: false } } });
const env = process.env, apiKey = env.NOVEL_EVAL_API_KEY ?? env.OPENAI_API_KEY ?? '', model = env.NOVEL_EVAL_MODEL ?? '';
const live = !!(apiKey && model);
const provider: ProviderSecret = { name: 'eval', mode: 'live', baseURL: env.NOVEL_EVAL_BASE_URL ?? 'https://api.openai.com/v1', model, apiKey,
  ...(env.NOVEL_EVAL_REASONING_EFFORT ? { reasoningEffort: env.NOVEL_EVAL_REASONING_EFFORT } : {}),
  ...(env.NOVEL_EVAL_MAX_OUTPUT_TOKENS ? { maxOutputTokens: Number(env.NOVEL_EVAL_MAX_OUTPUT_TOKENS) } : {}) };
if (!live) console.log('未设置 NOVEL_EVAL_MODEL 与 API Key：使用本地演示响应，只验证评测流程与上下文检查，输出检查的结果不代表模型质量。\n');

if (values.judge && !values.baseline) throw new Error('--judge 需要同时指定 --baseline：盲评比较的是基线报告与本次的正文。');
const transport = (project: Workspace, request: RunRequest) => live ? new OpenAIResponseTransport(provider) : new DemoAgentTransport(request, project);
const report = await runBenchmark(transport, {
  mode: live ? 'live' : 'demo', ...(live ? { model } : {}), repeat: Math.max(1, Number(values.repeat) || 1),
  onResult: result => console.log(`${result.error || result.checks.some(check => !check.ok) ? '✗' : '✓'} ${result.caseId}/${result.taskId} #${result.attempt}`),
});
const baseline = values.baseline ? JSON.parse(readFileSync(resolve(values.baseline), 'utf8')) as BenchReport : undefined;
if (baseline && values.judge) {
  console.log('\n盲评写作结果……');
  report.judge = await judgeReports(baseline, report, transport, { ...(env.NOVEL_EVAL_JUDGE_MODEL ? { model: env.NOVEL_EVAL_JUDGE_MODEL } : {}),
    onPair: pair => console.log(`${pair.error ? '✗' : { current: '↑', baseline: '↓', tie: '=' }[pair.overall]} ${pair.caseId}/${pair.taskId} #${pair.attempt}`) });
}
const out = resolve(values.out!);
mkdirSync(out, { recursive: true });
const file = join(out, `${report.at.replace(/[:.]/g, '-')}-${report.mode}.json`);
writeFileSync(file, JSON.stringify(report, null, 2)); writeFileSync(join(out, `latest-${report.mode}.json`), JSON.stringify(report, null, 2));
console.log(`\n${formatReport(report, baseline)}\n\n报告已保存：${file}`);

const contextFailed = report.results.some(result => result.checks.some(check => check.stage === 'context' && !check.ok));
const regressed = baseline ? compareReports(baseline, report).length > 0 : false;
const failed = report.results.some(result => result.error || result.checks.some(check => !check.ok));
if (contextFailed) console.log('上下文检查失败：受限角色拿到了不该看到的资料，或写作者没有拿到作者约束。这是代码问题，与模型无关。');
process.exitCode = contextFailed || regressed || (values.strict && failed) ? 1 : 0;
