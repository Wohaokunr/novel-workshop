import type { RunRequest, TokenUsage, Workspace } from '../../shared/types.js';
import { addUsage, emptyUsage, objectSchema, runAgent, validateSchema, type AgentDefinition, type ResponseTransport } from '../responses.js';
import { JUDGE_DIMENSIONS, judgePrompt } from '../prompts/eval.js';
import { BENCHMARK, type BenchCase } from './bench.js';
import type { BenchReport, TaskResult } from './harness.js';

/** Blind A/B judging of the writer's prose against a baseline report: the model the benchmark runs on (or NOVEL_EVAL_JUDGE_MODEL)
 * compares the two versions of each scene without knowing which build wrote which. Every pair is judged twice with the order
 * swapped, and a dimension only has a winner when both orders agree, so a judge that prefers whatever comes first scores a tie. */

export type JudgeDimension = typeof JUDGE_DIMENSIONS[number];
export type JudgeSide = 'baseline' | 'current' | 'tie';
export interface JudgedPair {
  caseId: string; taskId: string; label: string; attempt: number;
  dimensions: Record<JudgeDimension, JudgeSide>; overall: JudgeSide; reasons: string[]; error?: string;
}
export interface JudgeReport { baseline: { at: string; promptSet: string }; promptVersion: string; pairs: JudgedPair[]; usage: TokenUsage }

export const DIMENSION_LABELS: Record<JudgeDimension, string> = { drama: '戏剧性', imagery: '画面感', dialogue: '对白', voice: '去 AI 腔', fidelity: '贴合度' };
const choice = { type: 'string', enum: ['A', 'B', 'tie'] };
export const judgeSchema = objectSchema({
  dimensions: { type: 'array', items: objectSchema({ name: { type: 'string', enum: [...JUDGE_DIMENSIONS] }, winner: choice, reason: { type: 'string' } }) },
  winner: choice, reason: { type: 'string' },
});
const judgeDefinition: AgentDefinition = { id: 'judge', label: '评审 · 盲评', instructions: judgePrompt.text, tools: [], outputSchema: judgeSchema, proseBlocks: true };
interface Verdict { dimensions: Array<{ name: JudgeDimension; winner: 'A' | 'B' | 'tie'; reason: string }>; winner: 'A' | 'B' | 'tie'; reason: string }

const key = (result: Pick<TaskResult, 'caseId' | 'taskId' | 'attempt'>) => `${result.caseId}\u0000${result.taskId}\u0000${result.attempt}`;
/** Writer runs both reports finished, matched by case, task and attempt. */
export function judgePairs(baseline: BenchReport, current: BenchReport): Array<{ before: TaskResult; after: TaskResult }> {
  const earlier = new Map(baseline.results.filter(result => result.role === 'writer' && !result.error && result.output.trim()).map(result => [key(result), result]));
  return current.results.flatMap(after => {
    const before = after.role === 'writer' && !after.error && after.output.trim() ? earlier.get(key(after)) : undefined;
    return before ? [{ before, after }] : [];
  });
}

/** Turns one verdict's A/B into baseline/current; `baselineFirst` says which version was shown as A. */
function sides(verdict: Verdict, baselineFirst: boolean) {
  const side = (winner: 'A' | 'B' | 'tie'): JudgeSide => winner === 'tie' ? 'tie' : (winner === 'A') === baselineFirst ? 'baseline' : 'current';
  const dimensions = Object.fromEntries(JUDGE_DIMENSIONS.map(name => [name, side(verdict.dimensions.find(item => item.name === name)?.winner ?? 'tie')])) as Record<JudgeDimension, JudgeSide>;
  return { dimensions, overall: side(verdict.winner) };
}
const agree = (first: JudgeSide, second: JudgeSide): JudgeSide => first === second ? first : 'tie';

function judgeContext(benchCase: BenchCase, project: Workspace, before: TaskResult, a: string, b: string) {
  const task = benchCase.tasks.find(item => item.id === before.taskId), scene = project.scenes.find(item => item.id === task?.sceneId);
  return { task: task?.objective ?? '', outline: scene?.outline ?? '', style: { summary: project.style?.summary ?? '', rules: project.style?.rules.map(rule => rule.content) ?? [],
    avoidWords: project.style?.avoidWords ?? [] }, authorRules: benchCase.rules.map(rule => rule.content), A: a, B: b };
}

export async function judgeReports(baseline: BenchReport, current: BenchReport, transport: (project: Workspace, request: RunRequest) => ResponseTransport,
  options: { model?: string; cases?: BenchCase[]; signal?: AbortSignal; onPair?: (pair: JudgedPair) => void } = {}): Promise<JudgeReport> {
  const usage = emptyUsage(), pairs: JudgedPair[] = [], signal = options.signal ?? new AbortController().signal;
  for (const { before, after } of judgePairs(baseline, current)) {
    const benchCase = (options.cases ?? BENCHMARK).find(item => item.id === after.caseId);
    if (!benchCase) continue;
    const base = { caseId: after.caseId, taskId: after.taskId, label: after.label, attempt: after.attempt };
    try {
      const rounds = [];
      for (const baselineFirst of [true, false]) {
        const project = benchCase.build(), request: RunRequest = { projectId: project.id, stage: 'agent', objective: '盲评两版正文' };
        const [a, b] = baselineFirst ? [before.output, after.output] : [after.output, before.output];
        const step = await runAgent(judgeDefinition, { transport: transport(project, request), context: judgeContext(benchCase, project, before, a, b),
          objective: '比较 A 与 B 两版正文。', contextSources: [], signal, ...(options.model ? { model: options.model } : {}) });
        addUsage(usage, step.usage); validateSchema(step.structured, judgeSchema);
        const verdict = step.structured as Verdict;
        rounds.push({ ...sides(verdict, baselineFirst), reason: `${baselineFirst ? '基线为 A' : '基线为 B'}：${verdict.reason}` });
      }
      const [first, second] = rounds as [typeof rounds[0], typeof rounds[0]];
      const pair: JudgedPair = { ...base, overall: agree(first.overall, second.overall), reasons: rounds.map(round => round.reason),
        dimensions: Object.fromEntries(JUDGE_DIMENSIONS.map(name => [name, agree(first.dimensions[name], second.dimensions[name])])) as Record<JudgeDimension, JudgeSide> };
      pairs.push(pair); options.onPair?.(pair);
    } catch (error) {
      const pair: JudgedPair = { ...base, overall: 'tie', reasons: [], error: error instanceof Error ? error.message : String(error),
        dimensions: Object.fromEntries(JUDGE_DIMENSIONS.map(name => [name, 'tie'])) as Record<JudgeDimension, JudgeSide> };
      pairs.push(pair); options.onPair?.(pair);
    }
  }
  return { baseline: { at: baseline.at, promptSet: baseline.promptSet }, promptVersion: judgePrompt.version, pairs, usage };
}

const tally = (values: JudgeSide[]) => {
  const count = (side: JudgeSide) => values.filter(value => value === side).length;
  return `当前胜 ${count('current')} · 基线胜 ${count('baseline')} · 持平 ${count('tie')}`;
};
export function formatJudge(judge: JudgeReport): string {
  const judged = judge.pairs.filter(pair => !pair.error), failed = judge.pairs.length - judged.length;
  const lines = [`盲评（对照基线 ${judge.baseline.at}，提示词集 ${judge.baseline.promptSet}；评审提示词 ${judge.promptVersion}；每对正反各评一次，两次一致才算胜出）：`];
  if (!judge.pairs.length) return [...lines, '    没有可配对的写作结果：基线与本次需要同一任务、同一轮次都成功写出正文。'].join('\n');
  lines.push(`    整体：${tally(judged.map(pair => pair.overall))}（共 ${judged.length} 对${failed ? `，评审失败 ${failed} 对` : ''}）`);
  for (const name of JUDGE_DIMENSIONS) lines.push(`    ${DIMENSION_LABELS[name]}：${tally(judged.map(pair => pair.dimensions[name]))}`);
  for (const pair of judge.pairs) {
    const head = `    ${pair.caseId}/${pair.taskId} #${pair.attempt} ${pair.label}`;
    if (pair.error) { lines.push(`${head}：评审失败：${pair.error}`); continue; }
    lines.push(`${head}：${{ current: '当前更好', baseline: '基线更好', tie: '持平' }[pair.overall]}`);
    for (const reason of pair.reasons) lines.push(`        ${reason}`);
  }
  return lines.join('\n');
}
