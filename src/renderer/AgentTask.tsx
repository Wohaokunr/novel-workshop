import { useEffect, useRef, useState } from 'react';
import { Check, Circle, CircleAlert, FilePlus2, FileMinus2, FilePen, LoaderCircle, Pause, Play, Square } from 'lucide-react';
import type { AgentRun, Change, Workspace } from '../shared/types';
import { ROLE_LABELS, type AgentDecision, type AgentMemory, type AgentRole, type AgentRuntimeSummary, type AgentSession } from '../shared/agent-types';
import { diffStats, diffText } from '../shared/text-diff';
import { Callout, StatusPill, canResumeRun, fire, isAgentRun, isRunActive, runStatus, showValue } from './ui';
import Markdown from './Markdown';

export interface AgentTaskActions {
  onPause: (id: string) => Promise<unknown>;
  onResume: (id: string) => Promise<unknown>;
  onCancel: (id: string) => Promise<unknown>;
  onDecide: (decision: AgentDecision) => Promise<unknown>;
  onAnswer: (id: string, answer: string) => Promise<unknown>;
}

export const roleNames = ROLE_LABELS;
const reviewNames: Record<'reader' | 'continuity' | 'style', string> = { reader: '读者审查', continuity: '一致性审查', style: '文风审阅' };
const nodeStatuses = { pending: '尚未开始', running: '进行中', completed: '已完成', failed: '失败' };
const candidateStatuses = { draft: '草案', awaitingApproval: '等待作者审批', applied: '已批准并写入', rejected: '已拒绝', stale: '版本已过期' };
const collectionNames: Record<string, string> = {
  novel: '作品信息', metadata: '作品元数据', style: '文风档案', objects: '人物与设定', chapters: '章节', scenes: '场景', facts: '世界事实', knowledge: '人物认知',
  characterStates: '人物演进', cards: '画布卡片', canvasLinks: '素材关联', layouts: '画布位置', reading: '阅读偏好', objectTypes: '对象类型',
};
const fieldNames: Record<string, string> = {
  title: '标题', name: '名称', text: '正文', outline: '大纲', content: '内容', brief: '创作简述', genre: '题材',
  audience: '目标读者', theme: '立意', fields: '设定字段', event: '世界事件', perspective: '人物视角', psychology: '心理变化',
  motivation: '人物动机', evidence: '变化依据', value: '事实内容', key: '事实名称', order: '顺序', chapterId: '所属章节',
  povId: '视角人物', eventIds: '关联事件', sceneIds: '关联场景', participants: '参与人物', causes: '前置原因',
};
const proseFields = new Set(['text', 'outline', 'content', 'brief', 'theme', 'perspective', 'psychology', 'motivation', 'evidence', 'value']);

export function AgentRunControls({ run, actions, busy = false, otherActive = false, compact = false }: {
  run: AgentRun; actions: Pick<AgentTaskActions, 'onPause' | 'onResume' | 'onCancel'>; busy?: boolean; otherActive?: boolean; compact?: boolean;
}) {
  if (!isAgentRun(run)) return null;
  const pausable = ['queued', 'running', 'awaitingApproval', 'awaitingInput', 'pausing'].includes(run.status);
  return <div className={`button-row agent-run-controls ${compact ? 'compact' : ''}`}>
    {pausable && <button className="small" data-testid="pause-run" disabled={busy || run.status === 'pausing'} title="在下一个检查点暂停，可稍后恢复" onClick={() => fire(actions.onPause(run.id))}><Pause aria-hidden="true"/>{run.status === 'pausing' ? '正在暂停…' : '暂停'}</button>}
    {canResumeRun(run) && <button className="small primary" data-testid="resume-run" disabled={busy || otherActive} onClick={() => fire(actions.onResume(run.id))}><Play aria-hidden="true"/>恢复任务</button>}
    {isRunActive(run) && <button className="small ghost-danger" data-testid="cancel-agent-run" disabled={busy || run.status === 'cancelled'} onClick={() => fire(actions.onCancel(run.id))}><Square aria-hidden="true"/>{run.status === 'cancelled' ? '正在停止…' : '停止'}</button>}
  </div>;
}

function changeTitle(change: Change): string {
  const item = change.after ?? change.before;
  const record = item && typeof item === 'object' ? item as Record<string, unknown> : undefined;
  const title = record?.title ?? record?.name ?? record?.key;
  return `${collectionNames[change.collection] || change.collection}${typeof title === 'string' ? `「${title}」` : ''}`;
}

function changeFields(change: Change): Array<{ key: string; before: unknown; after: unknown }> {
  const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (isRecord(change.before) || isRecord(change.after)) {
    const before = isRecord(change.before) ? change.before : {};
    const after = isRecord(change.after) ? change.after : {};
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(key => key !== 'id' && JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map(key => ({ key, before: before[key], after: after[key] }));
  }
  return [{ key: '内容', before: change.before, after: change.after }];
}

function nameResolver(workspace?: Workspace) {
  if (!workspace) return (value: unknown) => value;
  const names = new Map<string, string>();
  for (const item of workspace.objects) names.set(item.id, item.name);
  for (const item of workspace.scenes) names.set(item.id, item.title);
  for (const item of workspace.chapters) names.set(item.id, item.title);
  const resolve = (value: unknown): unknown => typeof value === 'string' ? names.get(value) ?? value : Array.isArray(value) ? value.map(resolve) : value;
  return resolve;
}

function plain(value: unknown, after: boolean): string {
  if (value === undefined) return after ? '（删除）' : '（原先不存在）';
  if (value === '' || value === null) return '（空白）';
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.length ? value.join('、') : '（无）';
  return showValue(value) ?? '（未提供内容）';
}

function FieldDiff({ name, before, after, resolve }: { name: string; before: unknown; after: unknown; resolve: (value: unknown) => unknown }) {
  const prose = proseFields.has(name) && (typeof before === 'string' || before === undefined) && typeof after === 'string';
  const label = fieldNames[name] || name;
  if (prose) {
    const parts = diffText(typeof before === 'string' ? before : '', after as string), stats = diffStats(parts);
    return <div className="agent-diff-field">
      <div className="diff-label"><strong>{label}</strong><span className="diff-stats"><ins>+{stats.added}</ins><del>−{stats.removed}</del></span></div>
      <div className={`inline-diff ${name === 'text' ? 'prose' : ''}`} data-testid="candidate-diff-inline">{parts.map((part, index) => part.kind === 'same' ? <span key={index}>{part.text}</span> : part.kind === 'add' ? <ins key={index}>{part.text}</ins> : <del key={index}>{part.text}</del>)}</div>
      <details className="diff-full"><summary>并排查看完整前后文本</summary>
        <div className="comparison"><div><span>修改前</span><pre className={name === 'text' ? 'agent-prose-diff' : ''} data-testid="candidate-before">{plain(before, false)}</pre></div><div><span>修改后</span><pre className={name === 'text' ? 'agent-prose-diff' : ''} data-testid="candidate-after">{plain(after, true)}</pre></div></div>
      </details>
    </div>;
  }
  return <div className="agent-diff-field">
    <div className="diff-label"><strong>{label}</strong></div>
    <div className="value-change"><pre data-testid="candidate-before">{plain(resolve(before), false)}</pre><span aria-hidden="true">→</span><pre data-testid="candidate-after">{plain(resolve(after), true)}</pre></div>
  </div>;
}

/** A readable count of what a candidate adds or changes, beyond the raw field diff. */
export function candidateSummary(changes: Change[]): { text: string; prose: boolean } {
  const count = (collection: string, test: (change: Change) => boolean = () => true) => changes.filter(change => change.collection === collection && test(change)).length;
  const added = (change: Change) => change.before === undefined && change.after !== undefined;
  const typeOf = (change: Change) => (change.after as { typeId?: string; event?: unknown } | undefined);
  const prose = changes.some(change => change.collection === 'scenes' && ((change.before as { text?: string } | undefined)?.text ?? '') !== ((change.after as { text?: string } | undefined)?.text ?? ''));
  const parts = [
    [count('metadata'), '项作品信息'], [count('style'), '项文风设定'], [count('objects', change => added(change) && typeOf(change)?.typeId === 'character'), '个新人物'],
    [count('objects', change => added(change) && !!typeOf(change)?.event), '个新事件'], [count('acts', added), '个幕/卷'], [count('chapters', added), '个新章节'],
    [count('scenes', added), '个新场景'], [count('cards', added), '张画布卡片'], [count('canvasLinks', added), '条画布连线'],
  ].filter(([value]) => value).map(([value, label]) => `${value} ${label}`);
  return { text: parts.join('、'), prose };
}

export function CandidateReview({ candidate, run, onDecide, busy, workspace, compact = false }: {
  candidate: AgentRuntimeSummary['candidates'][number]; run: AgentRun; onDecide: AgentTaskActions['onDecide']; busy: boolean; workspace?: Workspace; compact?: boolean;
}) {
  const [reason, setReason] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const waiting = run.runtime?.waiting;
  const actionable = run.status === 'awaitingApproval' && candidate.status === 'awaitingApproval'
    && waiting?.kind === 'approval' && waiting.candidateId === candidate.id && waiting.candidateHash === candidate.hash;
  const decide = (approve: boolean) => onDecide({ runId: run.id, candidateId: candidate.id, candidateHash: candidate.hash, approve, ...(!approve ? { reason: reason.trim() } : {}) });
  const current = candidate.reviews.filter(review => review.candidateHash === candidate.hash);
  const revise = current.filter(review => review.verdict === 'revise').length;
  const resolve = nameResolver(workspace);
  const summary = candidateSummary(candidate.changes);
  return <section className={`agent-candidate status-${candidate.status}`} data-testid="agent-candidate" data-candidate-id={candidate.id} data-candidate-hash={candidate.hash} data-candidate-status={candidate.status}>
    <header className="candidate-head">
      <div><h3>{candidate.label}</h3><p>v{candidate.version} · {candidate.changes.length} 项修改{current.length ? ` · ${revise ? `${revise} 条审查建议修订` : '审查通过'}` : ''}</p></div>
      <StatusPill status={candidate.status}>{candidateStatuses[candidate.status]}</StatusPill>
    </header>
    {summary.text && <p className="candidate-summary" data-testid="candidate-summary">包含：{summary.text}</p>}
    <div className="candidate-reviews" data-testid="candidate-reviews">
      {!candidate.reviews.length && <p className="muted">{summary.prose ? '尚无审查意见。' : '只修改设定、人物、画布或大纲，不涉及正文，无需审查；批准后可在修改历史中撤销。'}</p>}
      {candidate.reviews.map((review, index) => <div className={`review-result ${review.verdict}`} key={`${review.stepId}:${index}`} data-testid="candidate-review">
        <div className="review-head"><StatusPill status={review.verdict}>{review.verdict === 'pass' ? '通过' : '建议修订'}</StatusPill><strong>{reviewNames[review.role]}</strong>{review.candidateHash !== candidate.hash && <small>针对旧版本</small>}</div>
        {!!review.issues.length && <ul data-testid="candidate-review-issues">{review.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}
        {review.recommendation && <p>{review.recommendation}</p>}
      </div>)}
    </div>
    <details className="candidate-changes" data-testid="candidate-diff" open={!compact || actionable}>
      <summary>修改内容 · {candidate.changes.length} 项</summary>
      {!candidate.changes.length && <p className="muted">此候选没有内容修改。</p>}
      {candidate.changes.map((change, index) => {
        const Icon = change.before === undefined ? FilePlus2 : change.after === undefined ? FileMinus2 : FilePen;
        return <details className="agent-change" key={`${change.collection}:${change.key}:${index}`} open={index === 0 && candidate.changes.length <= 6}>
          <summary><Icon aria-hidden="true"/><span>{change.before === undefined ? '新增' : change.after === undefined ? '删除' : '修改'}</span>{changeTitle(change)}</summary>
          {changeFields(change).map(field => <FieldDiff key={field.key} name={field.key} before={field.before} after={field.after} resolve={resolve}/>)}
        </details>;
      })}
    </details>
    <details className="technical-details"><summary>版本标识与依据</summary><p className="agent-hash">候选 {candidate.id}<br/>hash {candidate.hash}<br/>基于作品版本 {candidate.baseRevision}</p>{!!candidate.sources.length && <ul>{candidate.sources.map((source, i) => <li key={i}>{source.kind} · {source.id}{source.start !== undefined && ` · ${source.start}–${source.end ?? source.start}`} · {source.hash}</li>)}</ul>}</details>
    {actionable && <div className="approval-bar" data-testid="candidate-approval">
      {!rejectOpen ? <>
        <p>{revise ? '审查仍有修订建议；批准即接受当前版本。' : '批准后写入作品并继续任务，可在修改历史撤销。'}</p>
        <div className="button-row"><button data-testid="reject-candidate" disabled={busy} aria-expanded={rejectOpen} onClick={() => setRejectOpen(true)}>拒绝…</button><button className="primary" data-testid="approve-candidate" disabled={busy} onClick={() => fire(decide(true))}><Check aria-hidden="true"/>批准并继续</button></div>
      </> : <form onSubmit={event => { event.preventDefault(); if (reason.trim() && !busy) fire(decide(false)); }}>
        <label className="field"><span>拒绝原因 <small>任务会按你的意见修订；关于文字的意见，叙境也会学进文风</small></span><textarea data-testid="candidate-reject-reason" autoFocus value={reason} onChange={event => setReason(event.target.value)} placeholder="例如：保留原有动机，不要提前揭露秘密。" required disabled={busy}/></label>
        <div className="button-row"><button type="button" data-testid="reject-candidate" disabled={busy} aria-expanded={rejectOpen} onClick={() => setRejectOpen(false)}>返回</button><button className="danger" data-testid="submit-reject-candidate" disabled={busy || !reason.trim()}>提交拒绝意见</button></div>
      </form>}
    </div>}
    {!actionable && candidate.status === 'awaitingApproval' && <p className="muted">任务切换到这份候选后才能审批。</p>}
  </section>;
}

/** Completed and total steps of a run, from its plan when it has one. */
export function runProgress(run: AgentRun): { done: number; total: number } {
  const nodes = run.runtime?.plan?.nodes;
  if (nodes?.length) return { done: nodes.filter(node => node.status === 'completed').length, total: nodes.length };
  return { done: run.steps.filter(step => step.status === 'completed').length, total: run.steps.length };
}

export function ProgressBar({ run }: { run: AgentRun }) {
  const { done, total } = runProgress(run);
  const percent = total ? Math.round(done / total * 100) : 0;
  return <div className={`run-progress-bar ${isRunActive(run) && done < total ? 'active' : ''}`} role="progressbar" aria-label="执行进度" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={done}>
    <span className="track"><i style={{ width: `${total ? Math.max(4, percent) : 4}%` }}/></span><small>{total ? `${done} / ${total} 步` : '准备中'}</small>
  </div>;
}

function LiveOutput({ label, text }: { label: string; text: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const element = box.current; if (element) element.scrollTop = element.scrollHeight; }, [text]);
  return <div className="live-output" aria-live="polite"><span><i className="live-dot" aria-hidden="true"/>实时输出 · {label}</span><div ref={box} className="live-output-text"><Markdown text={text.slice(-800)} streaming/></div></div>;
}

export function PlanStepper({ run, live = false }: { run: AgentRun; live?: boolean }) {
  const plan = run.runtime?.plan;
  if (plan) return <div className="plan" data-testid="agent-plan">
    {plan.summary && <Markdown text={plan.summary} className="plan-summary"/>}
    <ol className="plan-stepper">{plan.nodes.map((node, index) => <li key={node.id} className={`step ${node.status}`} style={{ '--i': Math.min(index, 8) } as React.CSSProperties} data-testid="agent-plan-node" data-node-id={node.id} data-node-status={node.status}>
      <StepIcon status={node.status}/>
      <div><strong>{roleNames[node.role]}</strong><span>{node.objective}</span>{node.status === 'running' && node.acceptance && <small>完成要求：{node.acceptance}</small>}{node.status === 'failed' && node.error && <small>未完成：{node.error}</small>}</div>
      <span className="sr-only">{nodeStatuses[node.status]}</span>
    </li>)}</ol>
  </div>;
  if (!run.steps.length) return <div className="plan-skeleton" aria-label="正在安排创作步骤"><p className="muted">正在安排创作步骤…</p><i/><i/><i/></div>;
  const current = [...run.steps].reverse().find(step => step.status === 'running') ?? run.steps.at(-1);
  return <div className="plan">
    <ol className="plan-stepper">{run.steps.map((step, index) => <li key={step.id} className={`step ${step.status}`} style={{ '--i': Math.min(index, 8) } as React.CSSProperties}><StepIcon status={step.status}/><div><strong>{step.label}</strong><span>{step.agentId}</span></div></li>)}</ol>
    {live && current?.output && <LiveOutput label={current.label} text={current.output}/>}
  </div>;
}

function StepIcon({ status }: { status: string }) {
  return <span className={`step-icon ${status}`} aria-hidden="true">{status === 'completed' ? <Check/> : status === 'running' ? <LoaderCircle/> : status === 'failed' ? <CircleAlert/> : <Circle/>}</span>;
}

export function AgentInputForm({ run, actions, busy }: { run: AgentRun; actions: AgentTaskActions; busy: boolean }) {
  const [answer, setAnswer] = useState('');
  const waiting = run.runtime?.waiting;
  if (waiting?.kind !== 'input' || run.status !== 'awaitingInput') return null;
  return <form className="input-request" data-testid="agent-input-request" onSubmit={event => {
    event.preventDefault(); if (answer.trim() && !busy) fire(actions.onAnswer(run.id, answer.trim()).then(() => setAnswer('')));
  }}>
    <strong>任务需要你补充信息</strong><p data-testid="agent-question">{waiting.question || '请补充你的要求，以便任务继续。'}</p>
    {!!waiting.options?.length && <div className="question-options" role="group" aria-label="可选回答">{waiting.options.map(option => <button key={option} type="button" className="chip" data-testid="agent-answer-option" disabled={busy} onClick={() => fire(actions.onAnswer(run.id, option))}>{option}</button>)}</div>}
    <label className="field"><span className="sr-only">你的回答</span><textarea data-testid="agent-answer" value={answer} onChange={event => setAnswer(event.target.value)} placeholder={waiting.options?.length ? '或者写下你自己的回答…' : '你的回答…'} required disabled={busy}/></label>
    <button className="primary" data-testid="answer-run" disabled={busy || !answer.trim()}>回答并继续</button>
  </form>;
}

export default function AgentTask({ run, actions, busy = false, otherActive = false, onReload, workspace }: {
  run: AgentRun; actions: AgentTaskActions; busy?: boolean; otherActive?: boolean; onReload: () => Promise<unknown>; workspace?: Workspace;
}) {
  const runtime = run.runtime;
  return <section className="agent-task" data-testid="agent-task">
    <div className="agent-task-bar"><p data-testid="agent-task-status" role="status">{isRunActive(run) ? '任务进行中，完成或停止前不能开始新任务。' : '任务已结束。'}</p><AgentRunControls run={run} actions={actions} busy={busy} otherActive={otherActive}/><button className="small ghost" data-testid="reload-agent-run" disabled={busy} onClick={() => fire(onReload())}>刷新</button></div>
    {((runtime?.pauseReason && ['paused', 'pausing'].includes(run.status)) || runtime?.uncertain) && <Callout tone="warning" data-testid="agent-pause-reason">
      {runtime.pauseReason && ['paused', 'pausing'].includes(run.status) && <p>{runtime.pauseReason}</p>}
      {runtime.uncertain && <p data-testid="agent-uncertain">上次请求的结果尚不确定。恢复可能重发已付费的模型请求；将先要求你明确确认。</p>}
    </Callout>}
    {!runtime && <p className="muted">尚未收到任务快照，请刷新记录。</p>}
    {runtime?.plan && <PlanStepper run={run}/>}
    <AgentInputForm run={run} actions={actions} busy={busy}/>
    {!!runtime?.candidates.length && <div className="agent-candidates">{runtime.candidates.map(candidate => <CandidateReview key={`${candidate.id}:${candidate.hash}`} candidate={candidate} run={run} onDecide={actions.onDecide} busy={busy} workspace={workspace}/>)}</div>}
    {runtime?.finalSummary && <section className="agent-final-summary" data-testid="agent-final-summary"><h3>任务总结</h3><Markdown text={runtime.finalSummary}/></section>}
    {!!runtime?.artifacts.length && <details className="technical-details" data-testid="agent-artifacts"><summary>过程产物 · {runtime.artifacts.length} 份（不等于已保存修改）</summary>{runtime.artifacts.map(artifact => <details className="agent-artifact" key={artifact.id} data-testid="agent-artifact"><summary>{roleNames[artifact.role]} · {artifact.label}</summary><pre>{artifact.text}</pre>{artifact.structured !== undefined && <details><summary>结构化内容</summary><pre>{showValue(artifact.structured)}</pre></details>}</details>)}</details>}
    {runtime?.budget && <RunBudget budget={runtime.budget}/>}
  </section>;
}

export function RunBudget({ budget }: { budget: NonNullable<AgentRuntimeSummary['budget']> }) {
  const rows: Array<[string, number, number, string?]> = [
    ['模型请求', budget.modelCalls, budget.maxModelCalls], ['工具调用', budget.toolCalls, budget.maxToolCalls],
    ['协作任务', budget.children, budget.maxChildren, `最多并行 ${budget.maxParallel} 个`], ['方案调整', budget.replans, budget.maxReplans],
    ['候选修订', budget.revisions, budget.maxRevisions], ['执行时间（秒）', Math.round(budget.activeMs / 1000), Math.round(budget.maxActiveMs / 1000), '不含暂停与等待'],
    ['Token', budget.tokens, budget.maxTokens, budget.usageUnknown ? '部分请求用量未知，不代表未计费' : undefined],
  ];
  return <details className="technical-details" data-testid="agent-budget"><summary>执行限额与实际用量</summary><dl className="agent-budget-list">
    {rows.map(([label, used, max, note]) => <div key={label}><dt>{label}</dt><dd><span className="meter"><i style={{ width: `${Math.min(100, max ? used / max * 100 : 0)}%` }}/></span>{used.toLocaleString()} / {max.toLocaleString()}{note && <small>{note}</small>}</dd></div>)}
  </dl></details>;
}

export interface AgentMemoryActions {
  onReload: () => Promise<unknown>;
  onSave: (content: string) => Promise<unknown>;
  onConfirm: (id: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
}
export function AgentMemoryPanel({ memories, session, actions, loading, busy, error }: {
  memories: AgentMemory[]; session: AgentSession | null; actions: AgentMemoryActions; loading: boolean; busy: boolean; error: string;
}) {
  const [preference, setPreference] = useState('');
  const kinds = { preference: '作者偏好', constraint: '创作约束', summary: '作品摘要', experience: '创作经验' };
  return <div className="agent-memory-panel" data-testid="agent-memories">
    <p className="muted">保存你希望 AI 长期遵守的写作偏好。只有你保存或确认的内容才会生效，不会修改正文。</p>
    <form className="memory-form" onSubmit={event => { event.preventDefault(); if (preference.trim() && !busy) fire(actions.onSave(preference.trim()).then(() => setPreference(''))); }}>
      <label className="field"><span className="sr-only">作者偏好</span><textarea data-testid="memory-preference" value={preference} onChange={event => setPreference(event.target.value)} placeholder="例如：对白保持克制，避免解释人物的每个动作。" disabled={busy} required/></label>
      <div className="button-row"><button className="small" data-testid="reload-memories" type="button" disabled={loading || busy} onClick={() => fire(actions.onReload())}>刷新</button><button className="small primary" data-testid="save-memory" disabled={busy || !preference.trim()}>保存偏好</button></div>
    </form>
    {loading && <p className="muted" role="status">正在读取作品记忆…</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <ul className="agent-memory-list">{memories.map(memory => {
      const pending = (memory.status === 'suggested' || !memory.confirmed) && memory.status !== 'stale';
      return <li key={memory.id} data-testid="agent-memory" data-memory-id={memory.id}>
        <div className="memory-head"><span>{kinds[memory.kind]}</span><StatusPill status={memory.status === 'stale' ? 'stale' : pending ? 'draft' : 'completed'}>{memory.status === 'stale' ? '已过期' : pending ? '待确认' : '已确认'}</StatusPill></div>
        <p>{memory.content}</p>
        <div className="button-row">{pending && <button className="small" data-testid="confirm-memory" disabled={busy} onClick={() => fire(actions.onConfirm(memory.id))}>确认</button>}<button className="small text-danger" data-testid="delete-memory" disabled={busy} onClick={() => fire(actions.onDelete(memory.id))}>删除</button></div>
      </li>;
    })}</ul>
    {!loading && !error && !memories.length && <p className="muted empty-line">尚无作品记忆。</p>}
    {session && <details className="agent-session" data-testid="agent-session"><summary>本作品对话记录 · {session.messages.length} 条</summary>{session.messages.map(message => <div key={message.id}><strong>{message.role === 'author' ? '作者' : '创作伙伴'}</strong><p>{message.text}</p></div>)}{!session.messages.length && <p className="muted">开始目标任务后，对话会记录在这里。</p>}</details>}
  </div>;
}
