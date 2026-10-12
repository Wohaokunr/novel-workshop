import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowRight, ArrowUp, Check, ChevronRight, CornerDownRight, GitBranch, GripHorizontal, Layers, Lightbulb, ListTree, LoaderCircle, MessageCircleQuestion, MessagesSquare, PanelRight, PenLine, RefreshCw, Sparkles, Square, StickyNote, Trash2, Undo2, UserPlus, Workflow, X, type LucideIcon } from 'lucide-react';
import type { Workspace } from '../shared/types';
import type { CompanionAnchor, CompanionIntensity, CompanionMode, CompanionNovelField, CompanionOp, CompanionProposal, CompanionThread, CompanionTurn } from '../shared/companion-types';
import { companionModeNames, focusNames, ideaKindNames, intensityNames, novelFieldNames } from '../shared/companion-types';
import { nextStage } from '../shared/story-flow';
import { companionCommands, selectCompanionItems } from '../shared/companion';
import { personNames, scaleNames } from '../shared/style-types';
import { fire, orderedScenes, relativeTime, uid } from './ui';
import { usePresence } from './interaction';
import Markdown from './Markdown';

export interface SummonRequest {
  mode: CompanionMode; anchor: CompanionAnchor;
  /** Screen position to open the floating dialog at; omitted → side panel. */
  screen?: { x: number; y: number };
  /** Sent immediately when present. */
  message?: string;
  label?: string;
}
interface PopoverState { threadId?: string; mode: CompanionMode; anchor: CompanionAnchor; x: number; y: number; label?: string; opener: HTMLElement | null }
interface CompanionApi {
  threads: CompanionThread[];
  intensity: CompanionIntensity; setIntensity: (value: CompanionIntensity) => void;
  summon: (request: SummonRequest) => void;
  send: (target: { thread?: CompanionThread; mode: CompanionMode; anchor: CompanionAnchor }, message: string, retry?: boolean) => Promise<CompanionThread | undefined>;
  adopt: (thread: CompanionThread, turn: CompanionTurn, itemIds: string[], options?: { group?: boolean; target?: 'canvas' | 'sceneOutline'; as?: 'character' }) => Promise<void>;
  undo: (thread: CompanionThread, batchId: string) => Promise<void>;
  cancel: (thread: CompanionThread) => Promise<void>;
  remove: (thread: CompanionThread) => Promise<void>;
  panelThread: string; openInPanel: (threadId: string) => void; setPanelThread: (threadId: string) => void;
}
const CompanionContext = createContext<CompanionApi | null>(null);
export function useCompanion(): CompanionApi {
  const value = useContext(CompanionContext);
  if (!value) throw new Error('创作伙伴尚未初始化');
  return value;
}
/** Optional variant for components that may render outside a project. */
export function useOptionalCompanion() { return useContext(CompanionContext); }

const surfaceNames = { canvas: '灵感画布', world: '世界因果', story: '叙述顺序', outline: '大纲', writer: '正文写作', panel: '对话', style: '文风' } as const;
const opNames: Record<CompanionOp['op'], string> = { addAct: '新增幕/卷', updateAct: '调整幕/卷', addChapter: '新增章节', updateChapter: '调整章节', addScene: '新增场景', updateScene: '调整场景', moveScene: '移动场景', addEvent: '新增事件', addCard: '画布便笺',
  updateNovel: '作品信息', addCharacter: '新增人物', updateCharacter: '丰富人物', link: '画布连线', addCause: '补充因果', updateStyle: '文风' };
const placeholders: Record<CompanionMode, string> = {
  diverge: '说说你在想什么，或者直接让我发散…', causality: '想推演哪一步因果？', structure: '你对现在的节奏哪里不满意？',
  outline: '想怎么展开这一层？', beat: '卡在哪里了？', develop: '补充你的想法，或直接点选上面的选项…', style: '说说你想要的笔触，或点选上面的选项…',
};

export function CompanionProvider({ workspace, children, beforeChange, onError, notify, showPanel }: {
  workspace: Workspace | null; children: ReactNode; beforeChange: () => Promise<void>;
  onError: (error: unknown) => void; notify: (text: string, error?: boolean) => void; showPanel: () => void;
}) {
  const [threads, setThreads] = useState<CompanionThread[]>([]);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [panelThread, setPanelThread] = useState('');
  const [intensity, setIntensityState] = useState<CompanionIntensity>(() => (localStorage.getItem('novel.companion.intensity') as CompanionIntensity | null) ?? 'bold');
  const projectId = workspace?.id;
  const projectRef = useRef(projectId); projectRef.current = projectId;
  const upsert = useCallback((thread: CompanionThread) => setThreads(old => [thread, ...old.filter(item => item.id !== thread.id)]), []);
  useEffect(() => {
    setThreads([]); setPopover(null); setPanelThread('');
    if (!projectId) return;
    let alive = true;
    window.novel.getCompanionThreads(projectId).then(values => { if (alive) setThreads(values); }, onError);
    return () => { alive = false; };
  }, [projectId, onError]);
  useEffect(() => window.novel.onAgentEvent(event => {
    if (event.type === 'companion' && event.thread && event.projectId === projectRef.current) upsert(event.thread);
  }), [upsert]);
  const guard = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    try { return await work(); } catch (error) { onError(error); return undefined; }
  }, [onError]);
  const send: CompanionApi['send'] = useCallback((target, message, retry = false) => guard(async () => {
    if (!projectRef.current) throw new Error('请先打开作品');
    const thread = await window.novel.askCompanion({ projectId: projectRef.current, threadId: target.thread?.id, mode: target.thread?.mode ?? target.mode,
      anchor: target.thread?.anchor ?? target.anchor, message, intensity, retry });
    upsert(thread); return thread;
  }), [guard, intensity, upsert]);
  const summon = useCallback((request: SummonRequest) => {
    const opener = document.activeElement as HTMLElement | null;
    const open = (threadId?: string) => {
      if (request.screen) setPopover({ threadId, mode: request.mode, anchor: request.anchor, x: request.screen.x, y: request.screen.y, label: request.label, opener });
      else { setPopover(null); if (threadId) setPanelThread(threadId); else setPanelThread(`new:${request.mode}:${JSON.stringify(request.anchor)}`); showPanel(); }
    };
    if (request.message) fire(send({ mode: request.mode, anchor: request.anchor }, request.message).then(thread => { if (thread) open(thread.id); }));
    else open();
  }, [send, showPanel]);
  const api: CompanionApi = {
    threads, intensity, setIntensity: value => { setIntensityState(value); localStorage.setItem('novel.companion.intensity', value); }, summon, send,
    adopt: (thread, turn, itemIds, options = {}) => guard(async () => {
      await beforeChange();
      const result = await window.novel.adoptCompanion({ projectId: thread.projectId, threadId: thread.id, turnId: turn.id, itemIds, ...options });
      upsert(result.thread);
      if (result.skipped.length) notify(`${result.batchId ? '已采纳，' : ''}跳过 ${result.skipped.length} 条：${result.skipped.slice(0, 3).join('；')}`, !result.batchId);
      else notify('已采纳到作品，可在对话里撤销。');
    }).then(() => undefined),
    undo: (thread, batchId) => guard(async () => { await beforeChange(); upsert(await window.novel.undoCompanion(thread.projectId, thread.id, batchId)); notify('已撤销这次采纳。'); }).then(() => undefined),
    cancel: thread => guard(() => window.novel.cancelCompanion(thread.projectId, thread.id)).then(() => undefined),
    remove: thread => guard(async () => {
      await window.novel.deleteCompanionThread(thread.projectId, thread.id);
      setThreads(old => old.filter(item => item.id !== thread.id));
      if (popover?.threadId === thread.id) setPopover(null);
    }).then(() => undefined),
    panelThread, setPanelThread,
    openInPanel: threadId => { setPopover(null); setPanelThread(threadId); showPanel(); },
  };
  // Keep the last dialog for a moment after closing so it can play its exit animation.
  const lastPopover = useRef(popover); if (popover) lastPopover.current = popover;
  const presence = usePresence(!!popover, 140);
  const shown = popover ?? (presence.mounted ? lastPopover.current : null);
  return <CompanionContext.Provider value={api}>
    {children}
    {shown && workspace && <CompanionPopover key={`${shown.x}:${shown.y}`} state={shown} workspace={workspace} closing={!popover}
      onThread={threadId => setPopover(old => old ? { ...old, threadId } : old)} onClose={() => { const opener = shown.opener; setPopover(null); opener?.focus?.(); }}/>}
  </CompanionContext.Provider>;
}

function CompanionPopover({ state, workspace, closing, onThread, onClose }: { state: PopoverState; workspace: Workspace; closing: boolean; onThread: (id: string) => void; onClose: () => void }) {
  const companion = useCompanion();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: state.x + 12, top: state.y + 8 });
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const thread = companion.threads.find(item => item.id === state.threadId);
  useLayoutEffect(() => {
    const element = ref.current; if (!element) return;
    const width = element.offsetWidth, height = element.offsetHeight;
    // Prefer the cursor's lower right; flip when the dialog would leave the window.
    const left = state.x + 12 + width > innerWidth - 8 ? Math.max(8, state.x - width - 12) : state.x + 12;
    const top = Math.min(Math.max(8, state.y + 8), Math.max(8, innerHeight - height - 8));
    setPosition({ left, top });
    element.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }, [state.x, state.y]);
  useEffect(() => {
    // Replies grow the dialog after it opens; keep it inside the window without undoing the author's drag.
    const element = ref.current; if (!element || typeof ResizeObserver === 'undefined') return;
    const clamp = () => setPosition(old => {
      const left = Math.min(Math.max(8, old.left), Math.max(8, innerWidth - element.offsetWidth - 8));
      const top = Math.min(Math.max(8, old.top), Math.max(8, innerHeight - element.offsetHeight - 8));
      return left === old.left && top === old.top ? old : { left, top };
    });
    const observer = new ResizeObserver(clamp);
    observer.observe(element); addEventListener('resize', clamp);
    return () => { observer.disconnect(); removeEventListener('resize', clamp); };
  }, []);
  useEffect(() => {
    if (closing) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); } };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  }, [onClose, closing]);
  return createPortal(<div ref={ref} className="companion-popover" data-state={closing ? 'closed' : 'open'} inert={closing} role="dialog" aria-label={`创作伙伴 · ${companionModeNames[thread?.mode ?? state.mode]}`} style={position} data-testid="companion-popover"
    onPointerMove={event => { if (drag.current) setPosition({ left: Math.max(0, event.clientX - drag.current.dx), top: Math.max(0, event.clientY - drag.current.dy) }); }}
    onPointerUp={() => { drag.current = null; }}>
    <header className="companion-head" onPointerDown={event => {
      if ((event.target as HTMLElement).closest('button')) return;
      drag.current = { dx: event.clientX - position.left, dy: event.clientY - position.top }; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    }}>
      <GripHorizontal className="companion-grip" aria-hidden="true"/>
      <span className="ai-mark" aria-hidden="true"><Sparkles/></span>
      <div><strong>{companionModeNames[thread?.mode ?? state.mode]}{state.anchor.focus ? ` · ${focusNames[state.anchor.focus]}` : ''}</strong><small>{state.label ?? surfaceNames[state.anchor.surface]}</small></div>
      {thread && <button className="icon-button small ghost" title="在侧栏继续" aria-label="在侧栏继续" onClick={() => companion.openInPanel(thread.id)}><PanelRight/></button>}
      <button className="icon-button small ghost" title="关闭（Esc）" aria-label="关闭创作伙伴" onClick={onClose}><X/></button>
    </header>
    <CompanionThreadView workspace={workspace} thread={thread} mode={state.mode} anchor={state.anchor} onThread={onThread} compact/>
  </div>, document.body);
}

/** Shared by the floating dialog and the side panel. */
export function CompanionThreadView({ workspace, thread, mode, anchor, onThread, compact = false }: {
  workspace: Workspace; thread?: CompanionThread; mode: CompanionMode; anchor: CompanionAnchor; onThread?: (id: string) => void; compact?: boolean;
}) {
  const companion = useCompanion();
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  /** Follow new replies only while the author is reading the end of the conversation. */
  const pinned = useRef(true);
  const [behind, setBehind] = useState(false);
  const streaming = thread?.status === 'streaming';
  const turns = thread?.turns ?? [];
  const toEnd = (smooth = false) => { const element = scroller.current; if (element) element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); };
  useEffect(() => { if (pinned.current) toEnd(); else setBehind(true); }, [turns.length, thread?.streaming, streaming]);
  useLayoutEffect(() => {
    const element = input.current; if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, compact ? 120 : 160)}px`;
  }, [message, compact]);
  const submit = (text: string, retry = false) => {
    if ((!text.trim() && !retry) || sending || streaming) return;
    setSending(true); pinned.current = true; setBehind(false);
    fire(companion.send({ thread, mode, anchor }, text.trim(), retry).then(next => { if (next) { if (!retry) setMessage(''); onThread?.(next.id); } }).finally(() => setSending(false)));
  };
  const lastCompanion = [...turns].reverse().find(turn => turn.role === 'companion');
  const followUps = !streaming && lastCompanion === turns.at(-1) ? lastCompanion?.response?.followUps ?? [] : [];
  return <div className={`companion-thread ${compact ? 'compact' : ''}`} data-testid="companion-thread" data-thread-id={thread?.id ?? ''} data-status={thread?.status ?? 'new'}>
    <div className="companion-scroll" ref={scroller} onScroll={event => {
      const element = event.currentTarget, near = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      pinned.current = near; if (near) setBehind(false);
    }}>
      {!turns.length && <CompanionIntro mode={mode} disabled={sending || streaming} onPick={text => submit(text)}/>}
      {turns.map(turn => turn.role === 'author'
        ? <div key={turn.id} className="companion-msg author"><p className="companion-author">{turn.text}</p><time dateTime={turn.at}>{relativeTime(turn.at)}</time></div>
        : <PartnerMessage key={turn.id} at={turn.at}><CompanionReply workspace={workspace} thread={thread!} turn={turn} latest={turn === lastCompanion} onAnswer={text => submit(text)}/></PartnerMessage>)}
      {streaming && <PartnerMessage live><div className="companion-reply streaming" aria-live="polite">
        {thread?.streaming ? <Markdown text={thread.streaming} streaming/> : <div className="companion-thinking"><span><Sparkles aria-hidden="true"/>正在构思…</span><i/><i/><i/></div>}
      </div></PartnerMessage>}
      {thread?.status === 'failed' && <div className="companion-error" role="alert"><span>{thread.error || '回复失败'}</span>{turns.at(-1)?.role === 'author' && <button className="small" onClick={() => submit('', true)}><RefreshCw aria-hidden="true"/>重试</button>}</div>}
      {!streaming && Object.keys(lastCompanion?.adopted ?? {}).length > 0 && <NextStep workspace={workspace} thread={thread!}/>}
      {followUps.length > 0 && <div className="companion-followups" aria-label="接着问">{followUps.map((text, index) => <button key={text} className="chip" style={stagger(index)} onClick={() => submit(text)}><CornerDownRight aria-hidden="true"/>{text}</button>)}</div>}
    </div>
    {behind && <button type="button" className="small companion-jump" onClick={() => { pinned.current = true; setBehind(false); toEnd(true); }}><ArrowDown aria-hidden="true"/>最新回复</button>}
    <form className="companion-composer" onSubmit={event => { event.preventDefault(); submit(message); }}>
      <div className={`composer-box ${streaming ? 'busy' : ''}`}>
        <textarea ref={input} data-testid="companion-input" value={message} rows={1} placeholder={placeholders[thread?.mode ?? mode]} onChange={event => setMessage(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(message); } }}/>
        {streaming ? <button type="button" className="icon-button composer-send stop" title="停止回复" aria-label="停止回复" onClick={() => thread && fire(companion.cancel(thread))}><Square aria-hidden="true"/></button>
          : <button className="icon-button composer-send primary" data-testid="companion-send" title="发送（Enter）" aria-label="发送" disabled={!message.trim() || sending}>{sending ? <LoaderCircle className="spin" aria-hidden="true"/> : <ArrowUp aria-hidden="true"/>}</button>}
      </div>
      <div className="companion-composer-bar">
        <div className="segmented" role="radiogroup" aria-label="发散强度">{(Object.keys(intensityNames) as CompanionIntensity[]).map(value => <button type="button" key={value} role="radio" aria-checked={companion.intensity === value} className={companion.intensity === value ? 'active' : ''} onClick={() => companion.setIntensity(value)}>{intensityNames[value]}</button>)}</div>
        <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
      </div>
    </form>
  </div>;
}

/** Staggered entrance for lists; capped so long lists don't wait. */
const stagger = (index: number) => ({ '--i': Math.min(index, 6) } as React.CSSProperties);

function PartnerMessage({ at, live = false, children }: { at?: string; live?: boolean; children: ReactNode }) {
  return <div className={`companion-msg partner ${live ? 'live' : ''}`}>
    <span className="ai-mark companion-avatar" aria-hidden="true"><Sparkles/></span>
    <div className="companion-msg-body">
      <div className="companion-msg-meta"><strong>创作伙伴</strong>{live ? <span className="live-dot" aria-hidden="true"/> : at && <time dateTime={at}>{relativeTime(at)}</time>}</div>
      {children}
    </div>
  </div>;
}

/** After an adoption, point at the next unfinished stage of the creative flow. Computed locally; costs no tokens. */
function NextStep({ workspace, thread }: { workspace: Workspace; thread: CompanionThread }) {
  const companion = useCompanion();
  const next = nextStage(workspace);
  if (!next?.assist || (next.assist.mode === thread.mode && next.assist.focus === thread.anchor.focus)) return null;
  const assist = next.assist;
  return <button className="suggestion next-step" data-testid="companion-next-step" onClick={() => companion.summon({ mode: assist.mode, label: next.label, message: assist.message,
    anchor: { surface: 'panel', references: [], ...(assist.focus ? { focus: assist.focus } : {}), ...(assist.mode === 'outline' ? { outlineNode: { kind: 'book' as const } } : {}) } })}>
    <Sparkles aria-hidden="true"/><span><strong>下一步：{next.label}</strong>{assist.label}</span><ArrowRight aria-hidden="true"/></button>;
}

const modeIcons: Record<CompanionMode, LucideIcon> = { diverge: Lightbulb, causality: GitBranch, structure: Workflow, outline: ListTree, beat: PenLine, develop: Sparkles, style: PenLine };
/** Openers shown on an empty conversation; one click sends them. */
const starters: Record<CompanionMode, string[]> = {
  diverge: ['往几个截然不同的方向发散', '给我一个出人意料的反转', '先问我几个问题'],
  causality: ['往后推演两三步后果', '补一个关键前因', '如果这件事没发生呢？'],
  structure: ['诊断整体节奏', '换一个更抓人的开篇', '哪里的揭露太早了？'],
  outline: ['先定故事骨架', '给我 3 个版本比较', '展开下一层'],
  beat: ['给我几个下一拍', '让冲突升级一点', '这一场怎么收尾？'],
  develop: ['根据已有信息推断', '先问我几个选择题', '直接给我几个版本'],
  style: ['描述一下我的笔触', '给我几段盲测', '列出该避免的写法'],
};

function CompanionIntro({ mode, disabled, onPick }: { mode: CompanionMode; disabled: boolean; onPick: (text: string) => void }) {
  const text: Record<CompanionMode, string> = {
    diverge: '我会给你几个方向截然不同的点子，也会追问一些你可能还没想清楚的问题。喜欢的点子一键放到画布。',
    causality: '告诉我想往前追溯原因，还是往后推演后果。采纳的事件会接进世界因果图。',
    structure: '我会先诊断节奏与信息揭露，再给几个互斥的调整方案。采纳只会重排场景、修改大纲，不会动正文。',
    outline: '一层一层来：先定骨架，再展开章节和场景。说“给我 3 个版本”可以比较不同走向。',
    beat: '说说这一场想达到什么，我给你几个可以直接写下去的下一拍。',
    develop: '我会从你已经写下的一切推断你想写什么。信息太少时先问你几个选择题，够了就直接给几个版本，选中即可采纳，随时可撤销。',
    style: '我会读你的范文，把笔触说成写作者能照着写的画像、旋钮和规则；盲测时只给你几段不同写法，挑最像你的那一段。采纳随时可撤销。',
  };
  const Icon = modeIcons[mode];
  return <div className="companion-intro-card">
    <span className="companion-intro-icon" aria-hidden="true"><Icon/></span>
    <strong>{companionModeNames[mode]}</strong>
    <p className="companion-intro">{text[mode]}</p>
    <div className="companion-starters">{starters[mode].map((starter, index) => <button key={starter} type="button" className="chip" style={stagger(index)} disabled={disabled} onClick={() => onPick(starter)}>{starter}<ChevronRight aria-hidden="true"/></button>)}</div>
  </div>;
}

function SectionTitle({ icon: Icon, label, count }: { icon: LucideIcon; label: string; count?: number }) {
  return <div className="companion-section-title"><Icon aria-hidden="true"/>{label}{!!count && <span>{count}</span>}</div>;
}

function CompanionReply({ workspace, thread, turn, latest, onAnswer }: { workspace: Workspace; thread: CompanionThread; turn: CompanionTurn; latest: boolean; onAnswer: (text: string) => void }) {
  const companion = useCompanion();
  const response = turn.response;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const adopted = turn.adopted ?? {};
  const busy = useRef(false);
  const act = (work: () => Promise<void>) => { if (busy.current) return; busy.current = true; fire(work().finally(() => { busy.current = false; })); };
  if (!response) return <div className="companion-reply"><Markdown text={turn.text}/></div>;
  const freshIdeas = response.ideas.filter(idea => !adopted[idea.id]);
  const answered = response.questions.filter(question => answers[question.id]?.trim());
  const canvas = thread.mode !== 'beat';
  const answer = () => onAnswer(answered.map(item => `关于「${item.question}」：${answers[item.id]!.trim()}`).join('\n'));
  return <div className="companion-reply" data-testid="companion-reply">
    {response.reply && <Markdown text={response.reply}/>}
    {!!response.questions.length && <div className="companion-questions">
      <SectionTitle icon={MessageCircleQuestion} label="追问" count={response.questions.length}/>
      {response.questions.map((question, index) => <div key={question.id} className={`companion-question ${answers[question.id]?.trim() ? 'answered' : ''}`} data-testid="companion-question" style={stagger(index)}>
        <span><b className="q-index">{answers[question.id]?.trim() ? <Check aria-hidden="true"/> : index + 1}</b><strong>{question.question}</strong></span>
        {question.why && <small>{question.why}</small>}
        {latest && !!question.options?.length && <div className="question-options" role="radiogroup" aria-label={question.question}>{question.options.map(option =>
          <button key={option} type="button" role="radio" aria-checked={answers[question.id] === option} className={`chip ${answers[question.id] === option ? 'selected' : ''}`} data-testid="question-option"
            onClick={() => setAnswers(old => ({ ...old, [question.id]: old[question.id] === option ? '' : option }))}>{answers[question.id] === option && <Check aria-hidden="true"/>}{option}</button>)}</div>}
        {latest && <input aria-label={`回答：${question.question}`} value={answers[question.id] ?? ''} placeholder={question.options?.length ? '其他想法…（可跳过）' : '你的想法…（可跳过）'} onChange={event => setAnswers(old => ({ ...old, [question.id]: event.target.value }))}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && answered.length) { event.preventDefault(); answer(); } }}/>}
      </div>)}
      {latest && <button className="small primary" data-testid="answer-questions" disabled={!answered.length} onClick={answer}>回答并继续{answered.length ? `（${answered.length}/${response.questions.length}）` : ''}<ArrowRight aria-hidden="true"/></button>}
    </div>}
    {!!response.ideas.length && <div className="companion-ideas">
      <SectionTitle icon={Lightbulb} label="点子" count={response.ideas.length}/>
      {response.ideas.map((idea, index) => {
        const batch = adopted[idea.id];
        return <article key={idea.id} className={`companion-idea kind-${idea.kind} ${batch ? 'adopted' : ''}`} data-testid="companion-idea" style={stagger(index)}>
          <header><span className={`idea-kind kind-${idea.kind}`}>{ideaKindNames[idea.kind]}</span><strong>{idea.title}</strong>{batch && <span className="adopted-mark"><Check aria-hidden="true"/>已采纳</span>}</header>
          <Markdown text={idea.content}/>
          {idea.hook && <p className="idea-hook">{idea.hook}</p>}
          <div className="button-row">
            {batch ? <button className="small ghost" onClick={() => act(() => companion.undo(thread, batch))}><Undo2 aria-hidden="true"/>撤销</button>
              : <>{thread.mode === 'beat' && <button className="small" data-testid="adopt-idea-outline" onClick={() => act(() => companion.adopt(thread, turn, [idea.id], { target: 'sceneOutline' }))}>补进场景大纲</button>}
                {idea.kind === 'character' && <button className="small" data-testid="adopt-idea-character" onClick={() => act(() => companion.adopt(thread, turn, [idea.id], { as: 'character' }))}><UserPlus aria-hidden="true"/>设为人物</button>}
                {canvas || thread.anchor.surface === 'writer' ? <button className="small" data-testid="adopt-idea" onClick={() => act(() => companion.adopt(thread, turn, [idea.id], { target: 'canvas' }))}><StickyNote aria-hidden="true"/>放到画布</button> : null}</>}
          </div>
        </article>;
      })}
      {freshIdeas.length > 1 && canvas && <button className="small adopt-all" data-testid="adopt-ideas-group" onClick={() => act(() => companion.adopt(thread, turn, freshIdeas.map(idea => idea.id), { group: true, target: 'canvas' }))}><Layers aria-hidden="true"/>剩余 {freshIdeas.length} 条放进新分组</button>}
    </div>}
    {!!response.proposals.length && <div className="companion-proposals">
      <SectionTitle icon={ListTree} label={thread.mode === 'style' && thread.anchor.focus === 'blindtest' ? '盲测' : '方案'} count={response.proposals.length > 1 ? response.proposals.length : undefined}/>
      {response.proposals.map((proposal, index) => <ProposalCard key={proposal.id} index={index} workspace={workspace} thread={thread} turn={turn} proposal={proposal} onAct={act}/>)}
    </div>}
  </div>;
}

interface OpNode { op: CompanionOp; children: OpNode[] }
function opTree(proposal: CompanionProposal): OpNode[] {
  const nodes = new Map(proposal.ops.map(op => [op.id, { op, children: [] as OpNode[] }]));
  const roots: OpNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.op.parentRef ? proposal.ops.find(op => op.ref === node.op.parentRef && op.id !== node.op.id) : undefined;
    if (parent) nodes.get(parent.id)!.children.push(node); else roots.push(node);
  }
  return roots;
}
function descendants(node: OpNode): string[] { return [node.op.id, ...node.children.flatMap(descendants)]; }

function ProposalCard({ index, workspace, thread, turn, proposal, onAct }: { index: number; workspace: Workspace; thread: CompanionThread; turn: CompanionTurn; proposal: CompanionProposal; onAct: (work: () => Promise<void>) => void }) {
  const companion = useCompanion();
  const adopted = turn.adopted ?? {};
  const isAdopted = (op: CompanionOp) => !!adopted[`${proposal.id}#${op.id}`];
  const pending = proposal.ops.filter(op => !isAdopted(op));
  const [selected, setSelected] = useState<Set<string>>(() => new Set(pending.map(op => op.id)));
  const tree = useMemo(() => opTree(proposal), [proposal]);
  const nameOf = (id: string | null) => {
    if (!id) return '';
    const card = workspace.cards.find(item => item.id === id);
    return proposal.ops.find(op => op.ref === id)?.title ?? workspace.acts?.find(item => item.id === id)?.title ?? workspace.chapters.find(item => item.id === id)?.title
      ?? workspace.scenes.find(item => item.id === id)?.title ?? workspace.objects.find(item => item.id === id)?.name
      ?? (card && (card.kind === 'object' ? workspace.objects.find(item => item.id === card.refId)?.name : card.kind === 'scene' ? workspace.scenes.find(item => item.id === card.refId)?.title : card.title)) ?? '（已不存在）';
  };
  const fieldOf = (op: CompanionOp) => (op.field ?? op.purpose ?? '') as CompanionNovelField;
  const batches = [...new Set(proposal.ops.map(op => adopted[`${proposal.id}#${op.id}`]).filter((id): id is string => !!id))];
  const preview = useMemo(() => thread.mode === 'structure' ? structurePreview(workspace, proposal) : [], [workspace, proposal, thread.mode]);
  const toggle = (node: OpNode, on: boolean) => setSelected(old => { const next = new Set(old); for (const id of descendants(node)) if (on) next.add(id); else next.delete(id); return next; });
  const chosen = pending.filter(op => selected.has(op.id));
  const itemIds = chosen.length === pending.length && !batches.length ? [proposal.id] : chosen.map(op => `${proposal.id}#${op.id}`);
  const renderNode = (node: OpNode, depth: number): ReactNode => {
    const { op } = node, done = isAdopted(op);
    if (op.op === 'updateStyle') {
      const label = styleOpLabel(op, nameOf);
      return <li key={op.id} className={`op-node depth-${Math.min(depth, 3)} ${done ? 'adopted' : ''}`}>
        <label><input type="checkbox" disabled={done} checked={done || selected.has(op.id)} onChange={event => toggle(node, event.target.checked)}/>
          <span className="op-kind">{opNames[op.op]}</span><strong>{label.heading}</strong>{done && <Check className="op-done" aria-label="已采纳"/>}</label>
        {label.detail && <p className="op-value">{label.detail}</p>}
      </li>;
    }
    if (op.op === 'updateNovel' || op.op === 'link' || op.op === 'addCause') {
      const field = fieldOf(op), current = op.op === 'updateNovel' ? (workspace[field] ?? '').trim() : '';
      const heading = op.op === 'updateNovel' ? novelFieldNames[field] ?? field
        : op.op === 'link' ? `${nameOf(op.parentRef ?? op.parentId)} — ${nameOf(op.targetId)}` : `${op.causes.map(nameOf).join('、')} → ${nameOf(op.targetId)}`;
      const detail = op.op === 'updateNovel' ? op.content : op.title;
      return <li key={op.id} className={`op-node depth-${Math.min(depth, 3)} ${done ? 'adopted' : ''}`}>
        <label><input type="checkbox" disabled={done} checked={done || selected.has(op.id)} onChange={event => toggle(node, event.target.checked)}/>
          <span className="op-kind">{opNames[op.op]}</span><strong>{heading}</strong>{done && <Check className="op-done" aria-label="已采纳"/>}</label>
        {detail && <p className={op.op === 'updateNovel' ? 'op-value' : undefined}>{detail}</p>}
        {current && !done && <p className="op-current">现有：{current.length > 120 ? `${current.slice(0, 120)}…` : current}</p>}
        {!!node.children.length && <ul>{node.children.map(child => renderNode(child, depth + 1))}</ul>}
      </li>;
    }
    const detail = [op.content, op.purpose && `作用：${op.purpose}`, op.povName && `视角：${op.povName}`,
      op.op === 'moveScene' && `移到${op.parentId ? `「${nameOf(op.parentId)}」` : '本章'}${op.order === null || op.order > workspace.scenes.length ? '末尾' : `第 ${op.order} 位`}`,
      op.targetId && op.op !== 'moveScene' && (op.op === 'addEvent' ? `引发「${nameOf(op.targetId)}」` : `「${nameOf(op.targetId)}」`),
      op.parentId && !op.parentRef && op.op !== 'moveScene' && `归入「${nameOf(op.parentId)}」`,
      op.causes.length && `起因：${op.causes.map(id => proposal.ops.find(item => item.ref === id)?.title ?? nameOf(id)).join('、')}`].filter(Boolean).join(' · ');
    return <li key={op.id} className={`op-node depth-${Math.min(depth, 3)} ${done ? 'adopted' : ''}`}>
      <label><input type="checkbox" disabled={done} checked={done || selected.has(op.id)} onChange={event => toggle(node, event.target.checked)}/>
        <span className="op-kind">{opNames[op.op]}</span><strong>{op.title || nameOf(op.targetId)}</strong>{done && <Check className="op-done" aria-label="已采纳"/>}</label>
      {detail && <p>{detail}</p>}
      {!!node.children.length && <ul>{node.children.map(child => renderNode(child, depth + 1))}</ul>}
    </li>;
  };
  // Blind test: the passage alone, so the author chooses by ear; its dials show once chosen.
  const blind = thread.mode === 'style' && thread.anchor.focus === 'blindtest';
  const done = proposal.ops.length - pending.length;
  return <section className={`companion-proposal ${blind ? 'blind-test' : ''} ${!pending.length ? 'adopted' : ''}`} data-testid="companion-proposal" style={stagger(index)}>
    <header>
      <div className="proposal-title"><b className="proposal-index">{blind ? String.fromCharCode(65 + index) : index + 1}</b><strong>{proposal.title}</strong>
        {!(blind && !batches.length) && <span className="proposal-count">{done ? `${done}/${proposal.ops.length} 已采纳` : `${proposal.ops.length} 项`}</span>}</div>
      {proposal.summary && (blind ? <p className="style-passage">{proposal.summary}</p> : <Markdown text={proposal.summary} className="proposal-summary"/>)}
    </header>
    {!!preview.length && <div className="structure-preview">{preview.map(row => <div key={row.chapter}><span className="eyebrow">{row.chapter}</span>
      <ol className="before">{row.before.map(title => <li key={title}>{title}</li>)}</ol><span aria-hidden="true">→</span><ol className="after">{row.after.map(title => <li key={title}>{title}</li>)}</ol></div>)}</div>}
    {blind && !batches.length ? <p className="muted blind-note">选中后揭晓这一版对应的笔调。</p> : <ul className="op-tree">{tree.map(node => renderNode(node, 0))}</ul>}
    <div className="button-row proposal-actions">
      {!!pending.length && <button className="small primary" data-testid="adopt-proposal" disabled={!chosen.length} onClick={() => onAct(() => companion.adopt(thread, turn, itemIds))}>
        <Check aria-hidden="true"/>{blind && !batches.length ? '这段最像我' : chosen.length === pending.length ? (batches.length ? '采纳其余部分' : '采纳这个方案') : `采纳所选 ${chosen.length} 项`}</button>}
      {batches.map(batch => <button key={batch} className="small ghost" onClick={() => onAct(() => companion.undo(thread, batch))}><Undo2 aria-hidden="true"/>撤销{batches.length > 1 ? '一次' : ''}采纳</button>)}
    </div>
  </section>;
}

/** Heading and value of a style op, in the words of the 文风 page. */
function styleOpLabel(op: CompanionOp, nameOf: (id: string | null) => string): { heading: string; detail: string } {
  const field = op.field ?? '', content = op.content ?? '';
  if (field === 'summary') return { heading: '文风画像', detail: content };
  if (field === 'dial:person') return { heading: '叙述人称', detail: personNames[content as keyof typeof personNames] ?? content };
  if (field.startsWith('dial:')) {
    const names = scaleNames[field.slice(5) as keyof typeof scaleNames];
    return names ? { heading: `笔调 · ${names[0]}`, detail: `${content} / 5（1=${names[1]}，5=${names[2]}）` } : { heading: field, detail: content };
  }
  if (field === 'rule:do') return { heading: '要这样写', detail: content };
  if (field === 'rule:avoid') return { heading: '避免这样写', detail: content };
  if (field === 'preferWords') return { heading: '偏好词', detail: content };
  if (field === 'avoidWords') return { heading: '禁用词', detail: content };
  if (field === 'voice') return { heading: `人物声音 · ${nameOf(op.targetId) || op.povName || ''}`, detail: content };
  return { heading: field, detail: content };
}

/** Before/after reading order for chapters a structure proposal touches. */
function structurePreview(workspace: Workspace, proposal: CompanionProposal) {
  try {
    const { commands } = companionCommands(workspace, selectCompanionItems({ reply: '', questions: [], ideas: [], proposals: [proposal], followUps: [] }, [proposal.id]),
      { mode: 'structure', anchor: { surface: 'story', references: [] }, newId: uid });
    const changed = new Map(commands.flatMap(command => command.type === 'putScene' ? [[command.value.id, command.value]] : []));
    if (!changed.size) return [];
    const after = [...workspace.scenes.filter(scene => !changed.has(scene.id)), ...changed.values()];
    const chapters = new Set([...changed.values()].map(scene => scene.chapterId));
    for (const scene of changed.values()) { const old = workspace.scenes.find(item => item.id === scene.id); if (old) chapters.add(old.chapterId); }
    const titles = (scenes: Workspace['scenes'], chapterId: string) => scenes.filter(scene => scene.chapterId === chapterId).sort((a, b) => a.order - b.order).map(scene => scene.title);
    return orderedScenes(workspace).map(scene => scene.chapterId).filter((id, index, all) => all.indexOf(id) === index && chapters.has(id))
      .map(id => ({ chapter: workspace.chapters.find(chapter => chapter.id === id)?.title ?? '', before: titles(workspace.scenes, id), after: titles(after, id) }));
  } catch { return []; }
}

/** Side panel: list of conversations and the selected one. */
export function CompanionPanel({ workspace, defaultAnchor }: { workspace: Workspace; defaultAnchor: CompanionAnchor }) {
  const companion = useCompanion();
  const [mode, setMode] = useState<CompanionMode>('diverge');
  const selected = companion.panelThread;
  const draft = selected.startsWith('new:') ? (() => { const [, value, ...rest] = selected.split(':'); try { return { mode: value as CompanionMode, anchor: JSON.parse(rest.join(':')) as CompanionAnchor }; } catch { return undefined; } })() : undefined;
  const thread = companion.threads.find(item => item.id === selected);
  if (thread || draft) {
    const current = thread?.mode ?? draft!.mode, Icon = modeIcons[current];
    return <div className="companion-panel in-thread" data-testid="companion-panel">
      <div className="companion-panel-head">
        <button className="icon-button small ghost" title="全部对话" aria-label="返回全部对话" onClick={() => companion.setPanelThread('')}><ArrowRight className="flip" aria-hidden="true"/></button>
        <span className="companion-panel-icon" aria-hidden="true"><Icon/></span>
        <div><strong>{thread?.title || companionModeNames[current]}</strong><span className="eyebrow">{companionModeNames[current]} · {surfaceNames[(thread?.anchor ?? draft!.anchor).surface]}</span></div>
        {thread && <button className="icon-button small ghost text-danger" title="删除对话" aria-label="删除对话" onClick={() => fire(companion.remove(thread).then(() => companion.setPanelThread('')))}><Trash2/></button>}
      </div>
      <CompanionThreadView workspace={workspace} thread={thread} mode={current} anchor={thread?.anchor ?? draft!.anchor} onThread={id => companion.setPanelThread(id)}/>
    </div>;
  }
  return <div className="companion-panel" data-testid="companion-panel">
    <div className="companion-start">
      <div className="companion-start-head"><span className="ai-mark" aria-hidden="true"><MessagesSquare/></span><div><strong>和创作伙伴聊聊</strong><p className="muted">还没成形的想法也可以。也能在画布、因果图、叙述顺序或大纲上右键，就地唤出它。</p></div></div>
      <div className="mode-picker" role="radiogroup" aria-label="对话类型">{(['develop', 'diverge', 'outline', 'structure', 'causality'] as CompanionMode[]).map(value => { const Icon = modeIcons[value]; return <button key={value} role="radio" aria-checked={mode === value} className={mode === value ? 'active' : ''} onClick={() => setMode(value)}><Icon aria-hidden="true"/>{companionModeNames[value]}</button>; })}</div>
      <button className="primary" data-testid="companion-new" onClick={() => companion.setPanelThread(`new:${mode}:${JSON.stringify({ ...defaultAnchor, surface: 'panel', ...(mode === 'outline' ? { outlineNode: { kind: 'book' } } : {}), ...(mode === 'develop' ? { focus: 'profile' } : {}) })}`)}><Sparkles aria-hidden="true"/>开始新对话</button>
    </div>
    {!!companion.threads.length && <span className="companion-list-title">最近的对话 · {companion.threads.length}</span>}
    <ul className="companion-list">{companion.threads.map((item, index) => { const Icon = modeIcons[item.mode]; return <li key={item.id} style={stagger(index)}><button onClick={() => companion.setPanelThread(item.id)} data-testid="companion-thread-item">
      <span className="companion-list-icon" aria-hidden="true"><Icon/></span>
      <span className="companion-list-text"><strong>{item.title}</strong><small>{companionModeNames[item.mode]} · {surfaceNames[item.anchor.surface]} · {item.turns.filter(turn => turn.role === 'author').length} 轮</small></span>
      <span className="companion-list-meta">{item.status === 'streaming' ? <span className="live-dot" title="回复中"/> : item.status === 'failed' ? <small className="text-danger">失败</small> : <small>{relativeTime(item.updatedAt)}</small>}<ChevronRight aria-hidden="true"/></span>
    </button></li>; })}</ul>
    {!companion.threads.length && <p className="muted empty-line">还没有对话。</p>}
  </div>;
}
