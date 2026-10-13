import type { PlanNode } from '../../shared/agent-types.js';
import type { RunRequest, TokenUsage, Workspace } from '../../shared/types.js';
import { styleProfile } from '../../shared/style-types.js';
import { addUsage, emptyUsage, runAgent, type ResponseTransport } from '../responses.js';
import { specialistDefinition } from '../agent/specialists.js';
import { StoryView } from '../agent/story-view.js';
import { PROMPTS, PROMPT_SET_VERSION } from '../prompts/index.js';
import { BENCHMARK, type BenchCase, type BenchTask } from './bench.js';
import { absent, filled, present, proseFormat, styleCheck, type CheckResult } from './checks.js';
import { formatJudge, type JudgeReport } from './judge.js';

export interface TaskResult {
  caseId: string; taskId: string; label: string; role: BenchTask['role']; attempt: number;
  promptVersion?: string; checks: CheckResult[]; usage: TokenUsage; output: string; error?: string;
}
export interface BenchReport {
  at: string; mode: string; model?: string; promptSet: string; prompts: Array<{ id: string; version: string }>;
  repeat: number; results: TaskResult[];
  /** Blind A/B comparison of the writer's prose against the baseline (`--judge`). */
  judge?: JudgeReport;
}
export interface Regression { caseId: string; taskId: string; checkId: string; label: string; before: number; after: number }

const OUTPUT_FIELDS: Record<'character' | 'reader', string[]> = { character: ['perspective', 'intention', 'action', 'uncertainty'], reader: ['verdict', 'recommendation'] };

/** Context checks need no model: what a restricted role is given must already respect its boundary, and the writer must be given
 * the author's rules and banned words. */
function contextChecks(benchCase: BenchCase, task: BenchTask, project: Workspace, context: string): CheckResult[] {
  const checks: CheckResult[] = [];
  if (task.role === 'writer') {
    checks.push(present('context:rules', 'constraint', 'context', '作者约束进入写作上下文', context, benchCase.rules.map(rule => rule.content)));
    checks.push(present('context:avoidWords', 'style', 'context', '禁用词进入写作上下文', context, styleProfile(project).avoidWords));
  } else {
    task.secrets.forEach((secret, index) => checks.push(absent(`context:secret:${index}`, 'knowledge', 'context', `上下文不含：${secret.label}`, context, secret.markers)));
    if (task.contextMustNot?.length) checks.push(absent('context:authorSide', 'knowledge', 'context', '上下文不含作者侧资料', context, task.contextMustNot));
  }
  return checks;
}
function outputChecks(benchCase: BenchCase, task: BenchTask, project: Workspace, text: string, structured: unknown): CheckResult[] {
  const checks: CheckResult[] = task.secrets.map((secret, index) => absent(`secret:${index}`, 'knowledge', 'output', secret.label, text, secret.markers));
  benchCase.rules.forEach((rule, index) => checks.push(absent(`rule:${index}`, 'constraint', 'output', `作者约束：${rule.content}`, text, rule.markers)));
  if (task.role === 'writer') checks.push(styleCheck(text, styleProfile(project)), proseFormat(text, task.length ?? [200, 8000]));
  else checks.push(filled(structured, OUTPUT_FIELDS[task.role]));
  return checks;
}

export async function runTask(benchCase: BenchCase, task: BenchTask, transport: (project: Workspace, request: RunRequest) => ResponseTransport, attempt = 1, signal = new AbortController().signal): Promise<TaskResult> {
  const project = benchCase.build();
  const node: PlanNode = { id: task.id, role: task.role, objective: task.objective, acceptance: '', dependsOn: [], status: 'pending',
    ...(task.sceneId ? { sceneId: task.sceneId } : {}), ...(task.chapterId ? { chapterId: task.chapterId } : {}),
    ...(task.characterId ? { characterId: task.characterId } : {}), ...(task.eventId ? { eventId: task.eventId } : {}) };
  const request: RunRequest = { projectId: project.id, stage: 'agent', objective: task.objective };
  const base = { caseId: benchCase.id, taskId: task.id, label: task.label, role: task.role, attempt };
  const spec = specialistDefinition({ role: task.role, node, project, request, story: new StoryView(project), authorRules: benchCase.rules.map(rule => ({ kind: 'constraint', content: rule.content })) });
  const checks = contextChecks(benchCase, task, project, JSON.stringify(spec.context));
  try {
    const step = await runAgent(spec.definition, { transport: transport(project, request), context: spec.context, objective: spec.objective, contextSources: [], signal });
    const text = task.role === 'writer' ? step.output : Object.values((step.structured ?? {}) as Record<string, unknown>).flat().map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n');
    return { ...base, promptVersion: step.promptVersion, checks: [...checks, ...outputChecks(benchCase, task, project, text, step.structured)], usage: step.usage, output: task.role === 'writer' ? text : JSON.stringify(step.structured) };
  } catch (error) {
    return { ...base, checks, usage: emptyUsage(), output: '', error: error instanceof Error ? error.message : String(error) };
  }
}

/** Runs every task `repeat` times (model output varies; pass rates over a few runs compare better than single runs). */
export async function runBenchmark(transport: (project: Workspace, request: RunRequest) => ResponseTransport, options: { mode: string; model?: string; repeat?: number; cases?: BenchCase[]; signal?: AbortSignal; onResult?: (result: TaskResult) => void } ): Promise<BenchReport> {
  const repeat = Math.max(1, options.repeat ?? 1), results: TaskResult[] = [];
  for (const benchCase of options.cases ?? BENCHMARK) for (const task of benchCase.tasks) for (let attempt = 1; attempt <= repeat; attempt++) {
    const result = await runTask(benchCase, task, transport, attempt, options.signal);
    results.push(result); options.onResult?.(result);
  }
  return { at: new Date().toISOString(), mode: options.mode, ...(options.model ? { model: options.model } : {}), promptSet: PROMPT_SET_VERSION,
    prompts: PROMPTS.map(({ id, version }) => ({ id, version })), repeat, results };
}

const taskKey = (result: Pick<TaskResult, 'caseId' | 'taskId'>) => `${result.caseId}\u0000${result.taskId}`;
/** Pass rate per check over the runs of its task; a run whose request failed counts as failing the output checks it never reached. */
function passRates(report: BenchReport): Map<string, { label: string; rate: number }> {
  const known = new Map<string, Map<string, string>>();
  for (const result of report.results) {
    const checks = known.get(taskKey(result)) ?? new Map<string, string>();
    for (const check of result.checks) checks.set(check.id, check.label);
    known.set(taskKey(result), checks);
  }
  const totals = new Map<string, { label: string; passed: number; runs: number }>();
  for (const result of report.results) for (const [id, label] of known.get(taskKey(result))!) {
    const key = `${taskKey(result)}\u0000${id}`, entry = totals.get(key) ?? { label, passed: 0, runs: 0 };
    entry.runs++; if (result.checks.find(check => check.id === id)?.ok) entry.passed++; totals.set(key, entry);
  }
  return new Map([...totals].map(([key, value]) => [key, { label: value.label, rate: value.passed / value.runs }]));
}
/** Checks whose pass rate dropped since the baseline, e.g. after a prompt edit. Tasks no longer in the benchmark are ignored. */
export function compareReports(baseline: BenchReport, current: BenchReport): Regression[] {
  const before = passRates(baseline), after = passRates(current), tasks = new Set(current.results.map(taskKey)), regressions: Regression[] = [];
  for (const [key, then] of before) {
    const [caseId, taskId, checkId] = key.split('\u0000') as [string, string, string];
    if (!tasks.has(`${caseId}\u0000${taskId}`)) continue;
    const rate = after.get(key)?.rate ?? 0;
    if (rate < then.rate) regressions.push({ caseId, taskId, checkId, label: then.label, before: then.rate, after: rate });
  }
  return regressions;
}

export function changedPrompts(baseline: BenchReport, current: BenchReport): string[] {
  const before = new Map(baseline.prompts.map(item => [item.id, item.version]));
  return current.prompts.filter(item => before.get(item.id) !== item.version).map(item => before.has(item.id) ? item.id : `${item.id}（新增）`);
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
export function formatReport(report: BenchReport, baseline?: BenchReport): string {
  const lines = [`叙境基准评测 · ${report.mode}${report.model ? ` · ${report.model}` : ''} · 提示词集 ${report.promptSet} · 每项 ${report.repeat} 次`];
  const usage = emptyUsage();
  for (const result of report.results) {
    addUsage(usage, result.usage);
    const failed = result.checks.filter(check => !check.ok);
    lines.push(`${result.error || failed.length ? '✗' : '✓'} ${result.caseId}/${result.taskId}${report.repeat > 1 ? ` #${result.attempt}` : ''} ${result.label}${result.promptVersion ? `（提示词 ${result.promptVersion}）` : ''}`);
    if (result.error) lines.push(`    请求失败：${result.error}`);
    for (const check of failed) lines.push(`    ✗ [${check.kind}/${check.stage}] ${check.label}${check.detail ? `：${check.detail}` : ''}`);
  }
  const checks = report.results.flatMap(result => result.checks);
  lines.push(`检查 ${checks.filter(check => check.ok).length}/${checks.length} 通过；请求失败 ${report.results.filter(result => result.error).length} 次；用量 ${usage.provided ? `${usage.total} tokens` : '未知'}。`);
  if (baseline) {
    const changed = changedPrompts(baseline, report), regressions = compareReports(baseline, report);
    lines.push(`与基线（${baseline.at}，提示词集 ${baseline.promptSet}）相比：${changed.length ? `改动的提示词 ${changed.join('、')}` : '提示词未变'}。`);
    lines.push(regressions.length ? `通过率下降 ${regressions.length} 项：` : '没有检查的通过率下降。');
    for (const item of regressions) lines.push(`    ↓ ${item.caseId}/${item.taskId} ${item.label}：${percent(item.before)} → ${percent(item.after)}`);
  }
  if (report.judge) lines.push(formatJudge(report.judge));
  return lines.join('\n');
}
