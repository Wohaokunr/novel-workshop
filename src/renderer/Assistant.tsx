import { ArrowUpRight, BookmarkPlus, ChevronRight, CircleAlert, CircleCheck, CircleSlash, CornerDownLeft, FileText, Film, Hourglass, LoaderCircle, Plus, RefreshCw, Sparkles, Square, StickyNote, Undo2, UserRound, X } from 'lucide-react';
import type { AgentRun, AssistTool, OperationBatch, ProviderSettings, RunRequest, SourceReference, Workspace } from '../shared/types';
import { Callout, Combobox, Kbd, Popover, StatusPill, assistTools, finalReview, fire, isAgentRun, isRunActive, orderedChapters, orderedScenes, runStatus, stageNames, taskLabel, taskObjective, type ComboItem, type TaskDraft } from './ui';
import { AgentInputForm, AgentMemoryPanel, AgentRunControls, CandidateReview, PlanStepper, ProgressBar, type AgentMemoryActions, type AgentTaskActions } from './AgentTask';
import Markdown from './Markdown';
import type { AgentMemory, AgentSession } from '../shared/agent-types';
import { CompanionPanel, useCompanion } from './Companion';
import { MessagesSquare } from 'lucide-react';

export function referenceLabel(workspace: Workspace, ref: SourceReference): string {
  if (ref.kind === 'object') {
    const object = workspace.objects.find(o => o.id === ref.id);
    return object ? `${object.event ? '事件' : workspace.objectTypes.find(t => t.id === object.typeId)?.name ?? '对象'} · ${object.name}` : '已删除的对象';
  }
  if (ref.kind === 'scene') return `场景 · ${workspace.scenes.find(s => s.id === ref.id)?.title ?? '已删除的场景'}`;
  const card = workspace.cards.find(c => c.id === ref.id);
  if (!card) return '已删除的卡片';
  if (card.kind === 'object' && card.refId) return `对象卡片 · ${workspace.objects.find(o => o.id === card.refId)?.name ?? card.title}`;
  if (card.kind === 'scene' && card.refId) return `场景卡片 · ${workspace.scenes.find(s => s.id === card.refId)?.title ?? card.title}`;
  return `${card.kind === 'group' ? '分组' : '便笺'} · ${card.title}`;
}

export function taskReferences(workspace: Workspace, history: OperationBatch[], runId: string): SourceReference[] {
  const refs = new Map<string, SourceReference>();
  for (const batch of history.filter(h => h.taskId === runId && !h.undone)) {
    for (const change of batch.changes) {
      let ref: SourceReference | undefined;
      if (change.collection === 'cards' && workspace.cards.some(c => c.id === change.key)) ref = { kind: 'card', id: change.key };
      else if (change.collection === 'objects' && workspace.objects.some(o => o.id === change.key)) ref = { kind: 'object', id: change.key };
      else if (change.collection === 'scenes' && workspace.scenes.some(s => s.id === change.key)) ref = { kind: 'scene', id: change.key };
      else if (change.collection === 'facts') { const fact = workspace.facts.find(f => f.id === change.key); if (fact) ref = { kind: 'object', id: fact.subjectId }; }
      else if (change.collection === 'knowledge') { const item = workspace.knowledge.find(k => k.id === change.key); if (item) ref = { kind: 'object', id: item.characterId }; }
      else if (change.collection === 'characterStates') { const item = workspace.characterStates?.find(k => k.id === change.key); if (item) ref = { kind: 'object', id: item.characterId }; }
      else if (change.collection === 'chapters') { const scene = orderedScenes(workspace).find(s => s.chapterId === change.key); if (scene) ref = { kind: 'scene', id: scene.id }; }
      if (ref) refs.set(`${ref.kind}:${ref.id}`, ref);
    }
  }
  return [...refs.values()];
}

export function TaskOutcome({ workspace, run, history, onOpenReference, onNextStage, onMonitor, onUndo, onRetry, onDismiss, bare = false, disabled = false }: {
  workspace: Workspace; run: AgentRun; history: OperationBatch[];
  onOpenReference: (kind: SourceReference['kind'], id: string) => void;
  onNextStage?: (stage: RunRequest['stage'], refs: SourceReference[]) => void;
  onMonitor?: (id: string) => void;
  onUndo?: (id: string) => Promise<unknown>;
  onRetry?: (id: string) => Promise<unknown>;
  onDismiss?: () => void;
  bare?: boolean;
  disabled?: boolean;
}) {
  const batches = history.filter(h => h.taskId === run.id);
  const changes = new Set(batches.filter(h => !h.undone).flatMap(h => h.changes.map(c => `${c.collection}:${c.key}`)));
  const refs = taskReferences(workspace, history, run.id);
  const review = isAgentRun(run) ? undefined : finalReview(run);
  const pendingCandidates = run.runtime?.candidates.filter(candidate => candidate.status === 'awaitingApproval' || candidate.status === 'draft').length || 0;
  const outcome = changes.size ? `已保存 ${changes.size} 项修改${pendingCandidates ? `，另有 ${pendingCandidates} 份候选未写入` : ''}。`
    : batches.length ? '本次修改已撤销。'
    : pendingCandidates ? `${pendingCandidates} 份候选尚未写入作品。`
    : isRunActive(run) ? '任务仍在进行，尚无写入的修改。'
    : run.status === 'failed' ? '任务未完成，作品没有被修改。' : '没有写入作品的修改。';
  const next = run.stage === 'idea' ? 'outline' : run.stage === 'outline' && workspace.scenes.length ? 'chapter' : undefined;
  const RefIcon = (ref: SourceReference) => ref.kind === 'scene' ? Film : ref.kind === 'object' ? UserRound : StickyNote;
  const resultLink = (ref: SourceReference) => { const Icon = RefIcon(ref); return <button key={`${ref.kind}:${ref.id}`} data-testid={`open-result-${ref.id}`} onClick={() => onOpenReference(ref.kind, ref.id)}><Icon className="ref-icon" aria-hidden="true"/><span>{referenceLabel(workspace, ref)}</span><ArrowUpRight aria-hidden="true"/></button>; };
  const StatusIcon = run.status === 'completed' ? (review?.verdict === 'revise' ? CircleAlert : CircleCheck) : run.status === 'failed' ? CircleAlert : run.status === 'cancelled' ? CircleSlash : Hourglass;
  const retryable = !!onRetry && (isAgentRun(run) ? run.status === 'failed' : ['failed', 'cancelled'].includes(run.status));
  return <section className={`task-outcome status-${run.status} ${bare ? 'bare' : ''}`} data-testid="task-outcome">
    {!bare && <header><span className="outcome-icon" aria-hidden="true"><StatusIcon/></span><div><span className="eyebrow">{taskLabel(run)}</span><StatusPill status={review?.verdict === 'revise' && run.status === 'completed' ? 'revise' : run.status}>{runStatus(run)}</StatusPill></div>
      <div className="button-row">{onMonitor && <button className="small ghost" onClick={() => onMonitor(run.id)}>查看记录</button>}{onDismiss && <button className="icon-button small ghost" aria-label="收起上次任务结果" title="收起" onClick={onDismiss}><X aria-hidden="true"/></button>}</div></header>}
    <p>{outcome}</p>
    {isAgentRun(run) && run.runtime?.waiting?.kind === 'input' && <p>{run.runtime.waiting.question || '需要你补充信息。'}</p>}
    {isAgentRun(run) && run.runtime?.pauseReason && run.status === 'paused' && <p className="muted">{run.runtime.pauseReason}</p>}
    {run.error && <p className="field-error" role="status">{run.error}</p>}
    {review && <div className={`review-result ${review.verdict}`} data-testid="final-review">
      <div className="review-head"><StatusPill status={review.verdict}>{review.verdict === 'revise' ? '仍有修改建议' : '读者评审通过'}</StatusPill></div>
      {!!review.issues.length && <ul>{review.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}
      {review.recommendation && <Markdown text={review.recommendation}/>}
    </div>}
    {!!refs.length && <div className="outcome-links">{refs.slice(0, 4).map(resultLink)}</div>}
    {refs.length > 4 && <details className="more-references"><summary>其他 {refs.length - 4} 项产出</summary><div className="outcome-links">{refs.slice(4).map(resultLink)}</div></details>}
    {(next || batches.length > 0 || retryable) && <div className="button-row task-actions">
      {run.status === 'completed' && next && onNextStage && <button className="small primary" data-testid="prepare-next-stage" disabled={disabled} onClick={() => onNextStage(next, refs)}>继续{stageNames[next]}<ChevronRight aria-hidden="true"/></button>}
      {retryable && <button className="small" data-testid="retry-latest-run" disabled={disabled || !run.finishedAt} onClick={() => fire(onRetry!(run.id))} title={isAgentRun(run) ? '沿用已完成的步骤与产出，只重做中断的部分' : undefined}><RefreshCw aria-hidden="true"/>{isAgentRun(run) ? '从检查点重试' : '重试'}</button>}
      {batches.length > 0 && onUndo && <button className="small" data-testid="undo-result" disabled={disabled || isRunActive(run) || !changes.size} onClick={() => fire(onUndo(run.id))}><Undo2 aria-hidden="true"/>{changes.size ? '撤销本次修改' : '已撤销'}</button>}
    </div>}
  </section>;
}

interface AssistantProps {
  workspace: Workspace | null; provider: ProviderSettings | null; runs: AgentRun[]; history: OperationBatch[];
  draft: TaskDraft; onDraftChange: (patch: Partial<TaskDraft>) => void;
  onPrepare: (stage: RunRequest['stage'], refs: SourceReference[], tool?: AssistTool, scope?: 'scene' | 'chapter') => void;
  busy: boolean; dismissedRun: string; onDismissRun: (id: string) => void;
  onStart: () => Promise<unknown>; onCancel: (id: string) => Promise<unknown>;
  onMonitor: (id: string) => void; onOpenReference: (kind: SourceReference['kind'], id: string) => void;
  onNextStage: (stage: RunRequest['stage'], refs: SourceReference[]) => void;
  onUndo: (id: string) => Promise<unknown>; onRetry: (id: string) => Promise<unknown>;
  agentActions: AgentTaskActions; agentBusy: string;
  memories: AgentMemory[]; session: AgentSession | null; memoryActions: AgentMemoryActions;
  memoryLoading: boolean; memoryBusy: boolean; memoryError: string;
  tab: 'chat' | 'task' | 'memory'; onTab: (tab: 'chat' | 'task' | 'memory') => void;
}

const descriptions: Record<Exclude<RunRequest['stage'], 'assist' | 'chapter'>, string> = {
  agent: '用一句话描述目标。AI 拟定方案并生成候选，写入作品前由你审批。',
  idea: '围绕作品设定发散构思方向，整理为可发展的灵感。',
  outline: '编排真实世界事件与读者看到的场景顺序。',
  rewrite: '只替换选中的文字，选段之外的正文保持不变。',
};

/** One-click rewrite directions; each only fills the objective, so the author can still edit it. */
const rewriteIntents = [
  { label: '按我的文风重写', objective: '按 style 中作者的文风重写选段：贴近范文的句子长短、节奏与描写方式，保留事件经过与人物认知。' },
  { label: '更简练', objective: '把选段改得更简练：删去重复与多余的修饰，短句为主，保留关键动作与信息。' },
  { label: '更有画面感', objective: '让选段更有画面感：用具体的动作、物件和感官细节代替概括与形容，不增加新的情节。' },
  { label: '对白更像人物', objective: '让选段的对白更像各自的人物：依照 style.voices 的说话方式改写，保留对白传达的信息。' },
  { label: '去 AI 腔', objective: '去掉选段里的 AI 腔：删除套话与空泛的情绪词（如“嘴角勾起一抹弧度”“眼中闪过一丝”），改成作者文风里朴素准确的写法。' },
];

export default function Assistant(props: AssistantProps) {
  const { workspace, provider, runs, history, draft } = props;
  const { tab, onTab: setTab } = props;
  const companion = useCompanion();
  const streamingThreads = companion.threads.filter(thread => thread.status === 'streaming').length;
  const { stage, tool, references, selection, chapterScope } = draft;
  const scene = workspace?.scenes.find(s => s.id === draft.sceneId);
  const chapter = workspace?.chapters.find(c => c.id === scene?.chapterId);
  const active = runs.find(isRunActive);
  const latest = active ?? runs[0];
  const lastHuman = history.find(batch => batch.actor === 'human' && !batch.undone && batch.changes.some(change => !['layouts', 'reading'].includes(change.collection) && (change.collection !== 'cards' || ['title', 'content', 'kind', 'refId'].some(key => (change.before as Record<string, unknown> | undefined)?.[key] !== (change.after as Record<string, unknown> | undefined)?.[key]))));
  const needsFollowUp = lastHuman && (!latest?.finishedAt || lastHuman.at > latest.finishedAt) && !active;
  const followUpRefs = workspace && lastHuman ? taskReferences(workspace, [{ ...lastHuman, taskId: lastHuman.id }], lastHuman.id) : [];
  const validSelection = !!scene && !!selection && Number.isSafeInteger(selection.start) && Number.isSafeInteger(selection.end)
    && selection.start >= 0 && selection.end >= selection.start && selection.end <= scene.text.length
    && scene.text.slice(selection.start, selection.end) === selection.text;
  const continuing = stage === 'rewrite' && !!selection && selection.start === selection.end;
  const hasMissingReference = !!workspace && references.some(ref => !(ref.kind === 'card' ? workspace.cards : ref.kind === 'object' ? workspace.objects : workspace.scenes).some(item => item.id === ref.id));
  let blocker = !workspace ? '先创建或打开一部作品。' : hasMissingReference ? '引用资料已删除，请移除后继续。' : !draft.objective.trim() ? '填写本次创作目标后即可开始。' : '';
  if (!blocker && (stage === 'chapter' || stage === 'rewrite')) {
    if (!scene || !chapter) blocker = '请选择目标章节或场景。';
    else if (stage === 'chapter' && chapterScope === 'scene' && scene.text.trim()) blocker = '这个场景已有正文，请在正文中选中文字进行改写。';
    else if (stage === 'chapter' && chapterScope === 'chapter' && !workspace?.scenes.some(s => s.chapterId === chapter.id && !s.text.trim())) blocker = '这章没有空白场景，可添加场景或改写已有正文。';
    else if (stage === 'rewrite' && !validSelection) blocker = selection ? '选段对应的正文已变化，请重新选择。' : '在正文中选中文字，再点击「改写选段」。';
  }
  const taskType = stage === 'assist' ? `assist:${tool}` : stage;
  /** Ideation belongs to the creative partner: lighter, conversational, one-click adopt with undo. */
  const ideation: { mode: 'diverge' | 'outline' | 'develop'; focus?: 'theme'; title: string; hint: string; message: string } | undefined =
    stage === 'idea' ? { mode: 'diverge', title: '和创作伙伴一起发散', hint: '多轮对话、追问与反转，喜欢的点子一键放上画布', message: '根据作品信息，往几个截然不同的方向发散。' }
    : stage === 'outline' ? { mode: 'outline', title: '和创作伙伴逐层展开大纲', hint: '先定骨架再展开章节，可只采纳其中一部分', message: '把故事骨架展开成幕/卷。' }
    : stage === 'assist' && tool === 'theme' ? { mode: 'develop', focus: 'theme', title: '和创作伙伴推断立意', hint: '信息不够时先问你几个选择题，再给几个版本，选中即写入立意', message: '根据我已有的信息推断几个立意方向；信息不够就先问我几个选择题。' }
    : stage === 'assist' && tool === 'canvas' ? { mode: 'diverge', title: '和创作伙伴发展灵感', hint: '围绕引用的卡片发散、补人物、连线，一键采纳到画布', message: '把这些灵感发展成可以写的人物、事件或场景，并理清它们的关系。' }
    : undefined;
  const changeTask = (value: string) => {
    if (value.startsWith('assist:')) props.onPrepare('assist', references, value.slice(7) as AssistTool, chapterScope);
    else props.onPrepare(value as RunRequest['stage'], references, undefined, chapterScope);
  };
  const changeScene = (id: string) => props.onDraftChange({ sceneId: id, selection: undefined });
  const description = continuing ? '从光标处接着写，写好的内容经审阅后由你批准插入。' : stage === 'assist' ? assistTools[tool].objective : stage === 'chapter' ? (chapterScope === 'chapter' ? '依次完成本章所有空白场景，保留已有正文。' : '根据场景大纲与人物视角，为目标空白场景生成正文。') : descriptions[stage];
  const startLabel = stage === 'assist' ? `开始${assistTools[tool].label}` : continuing ? '开始续写' : { agent: '开始目标任务', idea: '开始构思', outline: '开始编排', chapter: '开始生成', rewrite: '开始改写' }[stage];
  const canStart = !blocker && !active && !props.busy;
  const start = () => { if (canStart) fire(props.onStart()); };
  const referenceChip = (ref: SourceReference) => workspace ? <span className="reference-chip" key={`${ref.kind}:${ref.id}`}><button onClick={() => props.onOpenReference(ref.kind, ref.id)} title="打开这项资料">{referenceLabel(workspace, ref)}</button><button aria-label={`移除${referenceLabel(workspace, ref)}`} onClick={() => props.onDraftChange({ references: references.filter(r => r.kind !== ref.kind || r.id !== ref.id) })}><X aria-hidden="true"/></button></span> : null;
  const referenceItems: ComboItem[] = workspace ? [
    ...workspace.objects.map(o => ({ id: `object:${o.id}`, label: o.name, group: o.event ? '世界事件' : workspace.objectTypes.find(t => t.id === o.typeId)?.name ?? '设定' })),
    ...orderedScenes(workspace).map(s => ({ id: `scene:${s.id}`, label: s.title, hint: workspace.chapters.find(c => c.id === s.chapterId)?.title, group: '叙述场景' })),
    ...workspace.cards.filter(c => c.kind === 'note' || c.kind === 'group').map(c => ({ id: `card:${c.id}`, label: c.title, group: c.kind === 'group' ? '画布分组' : '灵感便笺' })),
  ].sort((a, b) => a.group.localeCompare(b.group, 'zh-CN')).map(item => ({ ...item, disabled: references.some(ref => `${ref.kind}:${ref.id}` === item.id) })) : [];
  const addReference = (item: ComboItem) => {
    const [kind, ...id] = item.id.split(':');
    props.onDraftChange({ references: [...references, { kind: kind as SourceReference['kind'], id: id.join(':') }] });
  };
  const showResult = !active && latest && latest.id !== props.dismissedRun;
  const awaiting = active?.runtime?.waiting?.kind === 'approval' ? active.runtime.candidates.find(candidate => candidate.id === active.runtime!.waiting!.candidateId) : undefined;

  return <aside className="ai-sidebar" aria-label="创作伙伴">
    <div className="ai-tabs" role="tablist" aria-label="AI 助手内容">
      <button role="tab" data-testid="ai-tab-chat" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}><MessagesSquare aria-hidden="true"/>对话{streamingThreads > 0 && <i className="live-dot"/>}</button>
      <button role="tab" data-testid="ai-tab-task" aria-selected={tab === 'task'} className={tab === 'task' ? 'active' : ''} onClick={() => setTab('task')}>{active ? <StatusPill status={active.status}>{runStatus(active)}</StatusPill> : '任务'}</button>
      <button role="tab" data-testid="ai-tab-memory" aria-selected={tab === 'memory'} className={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}><BookmarkPlus aria-hidden="true"/>偏好记忆{!!props.memories.length && <small>{props.memories.length}</small>}</button>
    </div>
    {tab === 'chat' ? <div key="chat" className="ai-scroll">{workspace ? <CompanionPanel workspace={workspace} defaultAnchor={{ surface: 'panel', references }}/> : <p className="muted">先创建或打开一部作品。</p>}</div>
    : tab === 'memory' ? <div key="memory" className="ai-scroll">{workspace && <AgentMemoryPanel key={workspace.id} memories={props.memories} session={props.session} actions={props.memoryActions} loading={props.memoryLoading} busy={props.memoryBusy} error={props.memoryError}/>}</div>
    : active ? <div key="run" className="ai-scroll run-view" data-testid="active-run">
      <header className="run-head">
        <div className="run-head-top"><span className="eyebrow"><span className="ai-mark run-mark" aria-hidden="true"><Sparkles/></span>{taskLabel(active)}</span><StatusPill status={active.status}>{runStatus(active)}</StatusPill></div>
        <p className="run-goal" title={active.objective}>{active.objective}</p>
        <ProgressBar run={active}/>
        {isAgentRun(active) ? <AgentRunControls run={active} actions={props.agentActions} busy={props.busy || !!props.agentBusy} compact/>
          : <button className="small ghost-danger" disabled={active.status === 'cancelled'} onClick={() => fire(props.onCancel(active.id))}><Square aria-hidden="true"/>{active.status === 'cancelled' ? '正在停止…' : '停止'}</button>}
      </header>
      {active.runtime?.pauseReason && ['paused', 'pausing'].includes(active.status) && <Callout tone="warning">{active.runtime.pauseReason}</Callout>}
      {active.error && <p className="field-error" role="status">{active.error}</p>}
      <AgentInputForm run={active} actions={props.agentActions} busy={!!props.agentBusy}/>
      {awaiting && <CandidateReview candidate={awaiting} run={active} onDecide={props.agentActions.onDecide} busy={!!props.agentBusy} workspace={workspace ?? undefined} compact/>}
      <section className="run-progress"><h3>执行进度</h3><PlanStepper run={active} live/></section>
      <button className="link-button" data-testid={active.status === 'awaitingApproval' ? 'review-current-candidate' : 'open-active-run'} onClick={() => props.onMonitor(active.id)}>{active.status === 'awaitingApproval' ? '在创作记录中全屏审阅' : '查看完整记录'}<ArrowUpRight aria-hidden="true"/></button>
    </div>
    : <>
      <div key="compose" className="ai-scroll compose-view">
        {needsFollowUp && <button className="suggestion" data-testid="follow-up-change" onClick={() => props.onPrepare('assist', followUpRefs, 'continuity')}><Sparkles aria-hidden="true"/><span><strong>有新的人工修改</strong>让 AI 跟进相关设定的一致性</span><ChevronRight aria-hidden="true"/></button>}
        {workspace && showResult && <TaskOutcome workspace={workspace} run={latest} history={history} onOpenReference={props.onOpenReference} onNextStage={props.onNextStage} onMonitor={props.onMonitor} onUndo={props.onUndo} onRetry={props.onRetry} onDismiss={() => props.onDismissRun(latest.id)} disabled={props.busy}/>}
        <div className="compose-card">
          <label className="task-type"><span className="sr-only">任务类型</span><Sparkles aria-hidden="true"/><select data-testid="task-type" value={taskType} disabled={props.busy} onChange={e => changeTask(e.target.value)}>
            <option value="agent">目标创作 · 交给智能体完成</option>
            <optgroup label="① 构思（推荐和创作伙伴对话）"><option value="idea">构思发散</option><option value="assist:theme">{assistTools.theme.label}</option><option value="assist:canvas">{assistTools.canvas.label}</option><option value="outline">编排大纲</option></optgroup>
            <optgroup label="② 写作"><option value="chapter">生成正文</option><option value="rewrite">改写选段</option></optgroup>
            <optgroup label="③ 检查与跟进">{(['character', 'world', 'narrative', 'continuity'] as AssistTool[]).map(id => <option key={id} value={`assist:${id}`}>{assistTools[id].label}</option>)}</optgroup>
          </select></label>
          <p className="task-description">{description}</p>
          {ideation && workspace && <button className="suggestion" data-testid="use-companion" onClick={() => companion.summon({ mode: ideation.mode,
            anchor: { surface: 'panel', references, ...(ideation.mode === 'outline' ? { outlineNode: { kind: 'book' as const } } : {}), ...(ideation.focus ? { focus: ideation.focus } : {}) },
            message: draft.objective.trim() && draft.objective !== taskObjective(stage, tool, chapterScope) ? draft.objective.trim() : ideation.message })}>
            <Sparkles aria-hidden="true"/><span><strong>{ideation.title}</strong>{ideation.hint}</span><ChevronRight aria-hidden="true"/></button>}
          {(stage === 'chapter' || stage === 'rewrite') && <div className="target-scene">
            {stage === 'chapter' && <label className="inline-field"><span>范围</span><select data-testid="chapter-scope" value={chapterScope} onChange={e => { const scope = e.target.value as 'scene' | 'chapter'; props.onDraftChange({ chapterScope: scope, ...(draft.objective === taskObjective(stage, tool, chapterScope) ? { objective: taskObjective(stage, tool, scope) } : {}) }); }}><option value="chapter">整章空白场景</option><option value="scene">单个空白场景</option></select></label>}
            <span>{stage === 'chapter' && chapterScope === 'chapter' ? '目标章节' : '目标场景'}</span>
            {stage === 'chapter' && chapterScope === 'chapter' ? <select data-testid="target-chapter" aria-label="目标章节" value={scene?.chapterId || ''} onChange={e => { const target = workspace && orderedScenes(workspace).find(s => s.chapterId === e.target.value); if (target) changeScene(target.id); }}><option value="" disabled>选择章节</option>{workspace && orderedChapters(workspace).map(c => <option key={c.id} value={c.id} disabled={!workspace.scenes.some(s => s.chapterId === c.id)}>{c.title}</option>)}</select> : <select data-testid="target-scene" aria-label="目标场景" value={scene?.id || ''} onChange={e => changeScene(e.target.value)}><option value="" disabled>选择场景</option>{workspace && orderedScenes(workspace).map(s => <option key={s.id} value={s.id}>{workspace.chapters.find(c => c.id === s.chapterId)?.title} · {s.title}</option>)}</select>}
            {stage === 'chapter' && chapterScope === 'chapter' && chapter && <small>将生成 {workspace?.scenes.filter(s => s.chapterId === chapter.id && !s.text.trim()).length} 个空白场景</small>}
            {continuing && scene && <div className="selection-preview"><span><FileText aria-hidden="true"/>{selection!.end >= scene.text.length ? '接在本场结尾续写' : `从第 ${selection!.end.toLocaleString()} 字处续写`}</span>{!!scene.text.slice(0, selection!.end).trim() && <blockquote>…{scene.text.slice(Math.max(0, selection!.end - 120), selection!.end)}</blockquote>}</div>}
            {stage === 'rewrite' && selection && !continuing && <div className="selection-preview"><span><FileText aria-hidden="true"/>选中 {selection.end - selection.start} 字</span><blockquote>{selection.text.slice(0, 180)}{selection.text.length > 180 ? '…' : ''}</blockquote></div>}
          </div>}
          <div className="reference-sources" data-testid="reference-sources">
            <span className="context-label">参考资料</span>
            <div className="chips">
              {workspace && references.length ? <>{references.slice(0, 6).map(referenceChip)}{references.length > 6 && <details className="more-references"><summary>其余 {references.length - 6} 项</summary>{references.slice(6).map(referenceChip)}</details>}</> : <span className="context-default">作品全局设定</span>}
              {workspace && <Popover label="添加参考资料" className="add-reference" triggerClassName="chip-add" trigger={<><Plus aria-hidden="true"/>添加</>}>{close => <Combobox label="搜索人物、事件、场景或灵感" placeholder="搜索人物、事件、场景、灵感…" items={referenceItems} onPick={item => { addReference(item); close(); }}/>}</Popover>}
              {references.length > 1 && <button className="chip-clear" onClick={() => props.onDraftChange({ references: [] })}>清空</button>}
            </div>
          </div>
          {stage === 'rewrite' && <div className="chips rewrite-intents" role="group" aria-label="改写方向">{rewriteIntents.map(intent => <button key={intent.label} type="button"
            className={`chip ${draft.objective === intent.objective ? 'selected' : ''}`} aria-pressed={draft.objective === intent.objective} onClick={() => props.onDraftChange({ objective: intent.objective })}>{intent.label}</button>)}</div>}
          <label className="ai-prompt" data-testid="agent-goal"><span>本次创作目标</span><textarea data-testid="ai-objective" value={draft.objective} onChange={e => props.onDraftChange({ objective: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); start(); } }}
            placeholder={stage === 'rewrite' ? '例如：保留事件经过，让对白更克制。' : '例如：为第一章安排一次误会，从人物动机到场景大纲，先给我审阅。'} required /></label>
        </div>
      </div>
      <footer className="ai-footer">
        <p className="task-blocker" role="status">{blocker || <>{provider?.mode === 'mock' ? '演示模式 · 不请求真实模型' : '写入作品前由你审批'} · <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> 开始</>}</p>
        <button data-testid={`run-${stage}`} className="primary start-button" disabled={!canStart} onClick={start}>{props.busy ? <LoaderCircle className="spin" aria-hidden="true"/> : <CornerDownLeft aria-hidden="true"/>}{props.busy ? '正在启动…' : startLabel}</button>
      </footer>
    </>}
  </aside>;
}
