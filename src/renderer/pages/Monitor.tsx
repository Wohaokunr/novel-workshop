import { useState } from 'react';
import { Bot, RefreshCw, Square, Undo2, UserRound } from 'lucide-react';
import type { AgentRun, OperationBatch, RunRequest, SourceReference, Workspace } from '../../shared/types';
import { Empty, StatusPill, fire, isAgentRun, isRunActive, runStatus, showValue, stageNames, statuses, taskLabel } from '../ui';
import AgentTask, { type AgentTaskActions } from '../AgentTask';
import { TaskOutcome } from '../Assistant';

type RunFilter = 'all' | 'active' | 'done' | 'failed';
const filters: Array<[RunFilter, string]> = [['all', '全部'], ['active', '进行中'], ['done', '已完成'], ['failed', '失败 / 停止']];
const matches = (run: AgentRun, filter: RunFilter) => filter === 'all' || (filter === 'active' ? isRunActive(run) : filter === 'done' ? run.status === 'completed' : !isRunActive(run) && ['failed', 'cancelled'].includes(run.status));
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function Monitor({ workspace, runs, history, selectedRun, onSelectedRun, onOpenReference, onNextStage, cancel, retry, undo, mock, agentActions, agentBusy, reload }: {
  workspace: Workspace; runs: AgentRun[]; history: OperationBatch[]; selectedRun: string; onSelectedRun: (id: string) => void;
  onOpenReference: (kind: SourceReference['kind'], id: string) => void; onNextStage: (stage: RunRequest['stage'], refs: SourceReference[]) => void;
  cancel: (id: string) => Promise<unknown>; retry: (id: string) => Promise<unknown>; undo: (id: string) => Promise<unknown>; mock: boolean;
  agentActions: AgentTaskActions; agentBusy: string; reload: () => Promise<unknown>;
}) {
  const [tab, setTab] = useState<'runs' | 'history'>('runs');
  const [filter, setFilter] = useState<RunFilter>('all');
  const [detail, setDetail] = useState<'overview' | 'steps' | 'usage'>('overview');
  const run = runs.find(r => r.id === selectedRun) || runs[0];
  const active = runs.some(isRunActive);
  const visible = runs.filter(item => matches(item, filter));
  const labels: Record<string, string> = { novel: '作品信息', acts: '卷', objects: '人物与设定', chapters: '章节', scenes: '场景', passages: '场景段', facts: '世界事实', knowledge: '人物认知', stateChanges: '状态变化', characterStates: '人物演进', cards: '画布卡片', canvasLinks: '素材关联', layouts: '图布局', reading: '阅读偏好', objectTypes: '对象类型' };
  const changeTitle = (change: OperationBatch['changes'][number]) => {
    const item = (change.after ?? change.before) as { name?: string; title?: string; content?: string; key?: string } | undefined;
    const name = item?.name || item?.title || item?.content || item?.key;
    return { verb: change.before === undefined ? '新增' : change.after === undefined ? '删除' : '更新', label: labels[change.collection] || '内容', name: name ? name.slice(0, 60) : '' };
  };
  const openSource = (source: string) => {
    const [kind, id] = source.split(':');
    if (kind === 'card' || kind === 'scene' || kind === 'object') onOpenReference(kind, id);
    else if (kind === 'event') onOpenReference('object', id);
    else if (kind === 'fact') { const fact = workspace.facts.find(f => f.id === id); if (fact) onOpenReference('object', fact.subjectId); }
    else if (kind === 'knowledge') { const knowledge = workspace.knowledge.find(k => k.id === id); if (knowledge) onOpenReference('object', knowledge.characterId); }
    else if (kind === 'passage') { const passage = workspace.passages.find(p => p.id === id); if (passage) onOpenReference('scene', passage.sceneId); }
    else if (kind === 'stateChange') { const change = workspace.stateChanges.find(k => k.id === id); if (change) onOpenReference('object', change.subjectId); }
  };
  return <div className="monitor-page">
    <div className="monitor-toolbar"><div className="segmented" role="tablist" aria-label="创作记录"><button role="tab" aria-selected={tab === 'runs'} className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>AI 任务 · {runs.length}</button><button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>修改历史 · {history.length}</button></div>{mock && <span className="provider-tag mock"><i aria-hidden="true"/>演示输出 · 未调用真实模型</span>}</div>
    {tab === 'history' ? <ol className="history-list">{history.map(batch => <li key={batch.id}><details className={`history-item ${batch.undone ? 'undone' : ''}`}>
      <summary><span className={`actor-badge ${batch.actor}`} title={batch.actor === 'ai' ? 'AI 修改' : '人工修改'}>{batch.actor === 'ai' ? <Bot aria-hidden="true"/> : <UserRound aria-hidden="true"/>}</span><div><strong>{batch.label}</strong><small>{new Date(batch.at).toLocaleString('zh-CN')} · {batch.changes.length} 项变更{batch.undone ? ' · 已撤销' : ''}</small></div><button className="small" disabled={batch.undone || active} onClick={e => { e.preventDefault(); fire(undo(batch.id)); }}>{batch.undone ? '已撤销' : '撤销这一批'}</button></summary>
      <ul className="change-list">{batch.changes.map((change, i) => { const title = changeTitle(change); return <li className="change-card" key={i}><span className={`change-verb ${title.verb}`}>{title.verb}</span><span>{title.label}{title.name && <strong> · {title.name}</strong>}</span><details><summary>技术详情</summary><div className="comparison"><div><span>修改前</span><pre>{showValue(change.before)}</pre></div><div><span>修改后</span><pre>{showValue(change.after)}</pre></div></div></details></li>; })}</ul>
    </details></li>)}{!history.length && <Empty title="每一笔修改，都能回看" description="人和 AI 的操作进入同一份修改历史，可以随时撤销。"/>}</ol>
    : <div className="monitor-split">
      <aside className="run-list" aria-label="任务列表">
        <div className="run-filters">{filters.map(([id, label]) => <button key={id} className={`chip ${filter === id ? 'selected' : ''}`} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
        {visible.map(item => <button key={item.id} className={run?.id === item.id ? 'selected' : ''} aria-current={run?.id === item.id ? 'true' : undefined} onClick={() => { onSelectedRun(item.id); setDetail('overview'); }}>
          <div className="run-list-head"><strong>{taskLabel(item)}</strong><StatusPill status={item.status}>{runStatus(item)}</StatusPill></div>
          <p>{item.objective}</p><small>{time(item.startedAt)}{item.usage.provided ? ` · ${item.usage.total.toLocaleString()} tokens` : ''}</small>
        </button>)}
        {!visible.length && <p className="muted inset">{runs.length ? '没有符合筛选的任务。' : '还没有 AI 任务。'}</p>}
      </aside>
      <div className="run-detail">{run ? <>
        <header className="run-detail-head"><div><span className="eyebrow">{taskLabel(run)} · {time(run.startedAt)}</span><div className="run-title"><h2>{stageNames[run.stage]}</h2><StatusPill status={run.status}>{runStatus(run)}</StatusPill></div><p className="run-objective">{run.objective}</p></div>
          <div className="button-row">
            {!isAgentRun(run) && isRunActive(run) && <button className="small danger" disabled={run.status === 'cancelled'} onClick={() => fire(cancel(run.id))}><Square aria-hidden="true"/>{run.status === 'cancelled' ? '正在停止…' : '停止'}</button>}
            {(isAgentRun(run) ? run.status === 'failed' : run.status === 'failed' || run.status === 'cancelled') && <button className="small" data-testid="retry-run" disabled={active || !run.finishedAt} onClick={() => fire(retry(run.id))}
              title={isAgentRun(run) ? '沿用已完成的步骤与产出，只重做中断的部分' : undefined}><RefreshCw aria-hidden="true"/>{isAgentRun(run) ? '从检查点重试' : '重试'}</button>}
            <button className="small" data-testid="undo-task" disabled={active || !history.some(h => h.taskId === run.id && !h.undone)} onClick={() => fire(undo(run.id))}><Undo2 aria-hidden="true"/>撤销本次修改</button>
          </div>
        </header>
        <div className="detail-tabs" role="tablist" aria-label="任务详情">{([['overview', '概览'], ['steps', `步骤日志 · ${run.steps.length}`], ['usage', '用量']] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={detail === id} className={detail === id ? 'active' : ''} onClick={() => setDetail(id)}>{label}</button>)}</div>
        {detail === 'overview' && <>
          {run.error && <div className="error-box">{run.error}</div>}
          <TaskOutcome workspace={workspace} run={run} history={history} onOpenReference={onOpenReference} onNextStage={onNextStage} bare/>
          {isAgentRun(run) && <AgentTask run={run} actions={agentActions} busy={agentBusy === run.id} otherActive={runs.some(item => item.id !== run.id && isRunActive(item))} onReload={reload} workspace={workspace}/>}
          {!isAgentRun(run) && run.steps.length > 0 && <ol className="step-summary">{run.steps.map(step => <li key={step.id}><StatusPill status={step.status}>{statuses[step.status as keyof typeof statuses] ?? step.status}</StatusPill><strong>{step.label}</strong><span>{step.output.slice(0, 120) || '…'}</span></li>)}</ol>}
        </>}
        {detail === 'steps' && <>{run.steps.map((step, i) => <section className="agent-step" key={step.id}>
          <header><div className="step-title"><span>{String(i + 1).padStart(2, '0')}</span><div><h3>{step.label}</h3><small>{step.agentId}</small></div></div><StatusPill status={step.status}>{statuses[step.status as keyof typeof statuses] ?? step.status}</StatusPill></header>
          <div className="public-output"><span className="eyebrow">公开输出</span><p>{step.output || '智能体正在准备输出…'}</p></div>
          <details><summary>输入与上下文来源</summary><pre>{showValue(step.input)}</pre><div className="source-tags">{step.contextSources.map((source, j) => /^(card|scene|passage|object|event|fact|knowledge|stateChange):/.test(source) ? <button key={j} className="chip" onClick={() => openSource(source)}>{source}</button> : <span key={j} className="chip">{source}</span>)}</div></details>
          {step.structured !== undefined && <details><summary>结构化结果</summary><pre>{showValue(step.structured)}</pre></details>}
          {step.tools.map((tool, j) => <details className="tool-detail" key={j}><summary>工具 · {tool.name}<small>{new Date(tool.at).toLocaleTimeString('zh-CN')}</small></summary><div className="comparison"><div><span>操作参数</span><pre>{showValue(tool.arguments)}</pre></div><div><span>操作结果</span><pre>{showValue(tool.result)}</pre></div></div></details>)}
          <div className="step-footer">{step.usage.provided ? `${step.usage.total} tokens · 输入 ${step.usage.input} / 输出 ${step.usage.output}` : '模型未提供该步用量'}{step.promptVersion && <span className="muted" title="这一步所用提示词的版本（由文本计算）"> · 提示词 {step.promptVersion}</span>}{step.responseIds.length > 0 && <details><summary>响应标识</summary><code>{step.responseIds.join('\n')}</code></details>}</div>
        </section>)}{!run.steps.length && <p className="muted inset">正在安排创作步骤…</p>}</>}
        {detail === 'usage' && <div className="usage-strip">{run.usage.provided ? <><div><span>总计</span><strong>{run.usage.total.toLocaleString()}<small> tokens</small></strong></div><div><span>输入</span><strong>{run.usage.input.toLocaleString()}</strong></div><div><span>输出</span><strong>{run.usage.output.toLocaleString()}</strong></div><div><span>推理</span><strong>{run.usage.reasoning.toLocaleString()}</strong></div><div><span>缓存</span><strong>{run.usage.cached.toLocaleString()}</strong></div></> : <p className="muted">当前任务未提供 token 用量{mock ? '（演示模式不调用真实模型）' : ''}。</p>}</div>}
      </> : <Empty title="看看故事是如何被写出来的" description="这里显示人物视角、读者评审、工具动作与实际用量。"/>}</div>
    </div>}
  </div>;
}
