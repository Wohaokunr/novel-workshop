import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, CircleAlert, MoreHorizontal, NotebookPen, X } from 'lucide-react';
import type { Workspace, Command, RunRequest, AgentRun, AssistTool, SourceReference } from '../shared/types';

export type Commit = (commands: Command[] | ((workspace: Workspace) => Command[]), label?: string) => Promise<Workspace>;
export interface TaskDraft {
  stage: RunRequest['stage']; tool: AssistTool; objective: string; references: SourceReference[];
  sceneId?: string; chapterScope: 'scene' | 'chapter'; selection?: { start: number; end: number; text: string };
}
export const SaveFeedbackContext = createContext<(id: string, status: 'editing' | 'saving' | 'error' | 'conflict' | null, pending?: Promise<unknown>) => void>(() => {});
export class ActionCancelled extends Error { constructor() { super('操作已取消'); } }
export const uid = () => crypto.randomUUID();
export const fire = (promise: Promise<unknown>) => { void promise.catch(() => {}); };
export const colors = ['#5b67d8','#d08442','#3a9a88','#b0649f','#7f9a3a','#4b8bd0'];
export const stageNames: Record<RunRequest['stage'],string> = { agent:'目标创作', idea:'新作构思', outline:'大纲编排', chapter:'正文书写', rewrite:'选段改写', assist:'专项辅助' };
export const assistTools: Record<AssistTool, { label: string; objective: string }> = {
  character: { label: '人物演进', objective: '依据实际事件和已写正文，演进人物视角、心理与动机，并检查其在叙述场景中的呈现。保留误解和渐进变化。' },
  world: { label: '世界因果', objective: '完善引用事件的动因、后果、参与人物和现场感知，关联世界事实与叙述场景，保留已写正文。' },
  narrative: { label: '叙述编排', objective: '依据真实世界事件完善场景大纲、叙述顺序与视角，安排信息揭露和人物情绪，保留已写正文。' },
  canvas: { label: '完善灵感', objective: '深化引用的灵感与分组，将想法落实为关联的人物、世界事件或叙述场景，同步构思画布，保留人工布局。' },
  theme: { label: '深化立意', objective: '从当前创意与正文提炼可通过人物选择和代价呈现的立意，保持作者题材、语言风格和娱乐性，避免说教。' },
  continuity: { label: '一致性跟进', objective: '跟进引用内容的修改，检查世界因果、人物心理和认知、叙述顺序与构思画布的关联，修正相关设定与大纲，保留作者正文。' },
};
export const taskLabel = (run: AgentRun) => run.stage === 'assist' && run.tool ? assistTools[run.tool].label : stageNames[run.stage];
export const statuses: Record<AgentRun['status'],string> = { queued:'等待中', running:'创作中', pausing:'正在暂停', paused:'已暂停', awaitingApproval:'等待作者审批', awaitingInput:'等待作者回答', completed:'已完成', failed:'失败', cancelled:'已停止' };
export const taskObjective = (stage: RunRequest['stage'], tool: AssistTool = 'canvas', scope: 'scene' | 'chapter' = 'scene') => ({
  agent: '', idea: '根据作品设定和引用资料发散构思，形成可发展的小说方向。',
  outline: '根据引用资料、人物和世界事实编排事件与叙述场景。',
  chapter: scope === 'scene' ? '根据当前场景大纲和人物视角生成正文，保留其他场景。' : '按顺序完成目标章节中尚未写作的场景正文，保留已有正文。',
  rewrite: '改写所选文字，保持人物与已发生事件一致，保留选段之外的正文。', assist: assistTools[tool].objective,
}[stage]);
export const characters = (w: Workspace) => w.objects.filter(o => o.typeId === 'character');
export const orderedChapters = (w: Workspace) => [...w.chapters].sort((a,b)=>a.order-b.order);
export const orderedScenes = (w: Workspace) => orderedChapters(w).flatMap(c => w.scenes.filter(s=>s.chapterId===c.id).sort((a,b)=>a.order-b.order));
export const sceneFor = (w: Workspace, id: string) => w.scenes.find(s=>s.id===id)||orderedScenes(w)[0];
export const events = (w: Workspace) => w.objects.filter(o=>o.event).sort((a,b)=>a.event!.worldOrder-b.event!.worldOrder);
export const showValue = (v: unknown) => typeof v === 'string' ? v : JSON.stringify(v, null, 2);

export interface ReaderReview { verdict: 'pass' | 'revise'; issues: string[]; recommendation: string }
export function finalReview(run: AgentRun): ReaderReview | undefined {
  const step = [...run.steps].reverse().find(s => s.agentId === 'reader' && s.status === 'completed');
  return step?.structured as ReaderReview | undefined;
}
export const isRunActive = (run: AgentRun) => ['queued', 'running', 'pausing', 'paused', 'awaitingApproval', 'awaitingInput'].includes(run.status) || (run.status === 'cancelled' && !run.finishedAt);
export const isAgentRun = (run: AgentRun) => run.stage === 'agent' || !!run.runtime;
export const canResumeRun = (run: AgentRun) => isAgentRun(run) && !!run.runtime && run.status === 'paused';
export const runStatus = (run: AgentRun) => run.status === 'cancelled' && !run.finishedAt ? '正在停止…' : !isAgentRun(run) && run.status === 'completed' && finalReview(run)?.verdict === 'revise' ? '已生成 · 待修订' : statuses[run.status];

export function Field({ label, value, onSave, multiline=false, type='text', placeholder='', className='' }: { label?: string; value: string | number; onSave: (value:string)=>Promise<unknown>; multiline?:boolean; type?:string; placeholder?:string; className?:string }) {
  const [draft,setDraft] = useState(String(value));
  const [error,setError] = useState('');
  const id = useId();
  const report = useContext(SaveFeedbackContext);
  const dirty = useRef(false);
  const local = useRef(draft);
  const saved = useRef(String(value));
  const composing = useRef(false);
  const inFlight = useRef<Promise<unknown> | null>(null);
  const mounted = useRef(true);
  useEffect(()=>{ mounted.current=true; return()=>{ mounted.current=false; report(id,null); }; },[id,report]);
  useEffect(()=>{ saved.current=String(value);if (!dirty.current) { local.current=String(value); setDraft(String(value)); } },[value]);
  const save = () => {
    if (!dirty.current || inFlight.current) return;
    const submitted = local.current;
    if (submitted===saved.current) { dirty.current=false; setError(''); report(id,null); return; }
    let succeeded=false;
    setError('');
    const pending=onSave(submitted).then(()=>{
      succeeded=true;
      saved.current=submitted;
      if (!mounted.current) return;
      dirty.current=local.current!==submitted;
      report(id,dirty.current?'editing':null);
    }).catch(reason=>{
      if (!mounted.current) return;
      if (reason instanceof ActionCancelled) {
        local.current=saved.current; setDraft(saved.current); dirty.current=false; setError(''); report(id,null); return;
      }
      setError(reason instanceof Error?reason.message:String(reason));
      report(id,'error');
    }).finally(()=>{
      inFlight.current=null;
      if(succeeded&&mounted.current&&dirty.current)save();
    });
    inFlight.current=pending;report(id,'saving',pending);
  };
  const props = {
    id, value:draft, placeholder, 'aria-invalid':Boolean(error), 'aria-describedby':error?`${id}-error`:undefined,
    onChange:(e:React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>)=>{
      local.current=e.target.value; dirty.current=true; setDraft(e.target.value); setError(''); report(id,'editing');
    },
    onBlur:save, onCompositionStart:()=>{composing.current=true;}, onCompositionEnd:()=>{composing.current=false;},
  };
  return <label className={`field ${className}`} htmlFor={id}>{label&&<span>{label}</span>}{multiline?<textarea {...props} rows={4}/>:<input {...props} type={type} onKeyDown={e=>{if(e.key==='Enter'&&!composing.current&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.blur();}}}/>} {error&&<small id={`${id}-error`} className="field-error" role="alert">未保存，内容已保留。{error}</small>}</label>;
}
export function Select({label,ariaLabel,value,onChange,children}: {label?:string;ariaLabel?:string;value:string;onChange:(value:string)=>void;children:React.ReactNode}) { return <label className="field">{label&&<span>{label}</span>}<select aria-label={ariaLabel} value={value} onChange={e=>onChange(e.target.value)}>{children}</select></label>; }
export function Empty({title,description,action}: {title:string;description:string;action?:React.ReactNode}) { return <div className="empty"><div className="empty-mark"><NotebookPen size={28} aria-hidden="true"/></div><h3>{title}</h3><p>{description}</p>{action}</div>; }
export function MultiPicker({label,items,value,onChange}: {label:string;items:Array<{id:string;name:string}>;value:string[];onChange:(value:string[])=>void}) { return <div className="field"><span>{label}</span><div className="chip-picker">{items.length?items.map(i=><button className={`chip ${value.includes(i.id)?'selected':''}`} key={i.id} onClick={()=>onChange(value.includes(i.id)?value.filter(v=>v!==i.id):[...value,i.id])}>{i.name}</button>):<small>暂无可选内容</small>}</div></div>; }

export function ActionMenu({ label, children }: { label: string; children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  const close = (restoreFocus = false) => {
    if (menu.current) menu.current.open = false;
    if (restoreFocus) menu.current?.querySelector<HTMLElement>('summary')?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <details ref={menu} className="more-actions" onToggle={event => setOpen(event.currentTarget.open)}
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) close(); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && menu.current?.open) { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (menu.current) menu.current.open = true;
      const key = event.key;
      requestAnimationFrame(() => {
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
        const index = items.findIndex(item => item === document.activeElement);
        const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : key === 'ArrowDown' ? (index + 1) % items.length : (index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length);
        items[next]?.focus();
      });
    }}>
    <summary aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id}><MoreHorizontal size={18} aria-hidden="true"/></summary>
    <div id={id} role="menu" aria-label={label} onClickCapture={event => {
      const button = (event.target as HTMLElement).closest('button');
      if (button && !button.disabled) close(true);
    }}>{children}</div>
  </details>;
}

export function Toast({ text, error, persistent, onClose, children }: { text: string; error: boolean; persistent: boolean; onClose: () => void; children?: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  useEffect(() => {
    if (persistent || paused) return;
    const timer = setTimeout(onClose, 4500);
    return () => clearTimeout(timer);
  }, [persistent, paused, onClose]);
  return <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'} aria-atomic="true"
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    <span className="toast-mark" aria-hidden="true">{error ? <CircleAlert size={18}/> : <Check size={18}/>}</span><span>{text}</span>{children}
    <button className="icon-button" aria-label="关闭提示" onClick={onClose}><X size={16} aria-hidden="true"/></button>
  </div>;
}

export function Dialog({title,onClose,children}: {title:string;onClose:()=>void;children:React.ReactNode}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(()=>{
    const element=dialog.current;
    const previous=document.activeElement as HTMLElement|null;
    element?.showModal();
    element?.querySelector<HTMLElement>('[data-dialog-focus], input:not([type="hidden"]), textarea, select')?.focus();
    return()=>{if(element?.open)element.close();if(previous?.isConnected)previous.focus();};
  },[]);
  return <dialog ref={dialog} className="app-dialog" aria-labelledby={titleId} onCancel={e=>{e.preventDefault();onClose();}}><div className="modal"><div className="modal-heading"><h3 id={titleId}>{title}</h3><button type="button" className="icon-button" aria-label="关闭对话框" onClick={onClose}><X size={18} aria-hidden="true"/></button></div>{children}</div></dialog>;
}


export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
const statusTones: Record<string, Tone> = {
  queued: 'accent', running: 'accent', pausing: 'accent',
  awaitingApproval: 'warning', awaitingInput: 'warning', draft: 'warning', revise: 'warning',
  completed: 'success', applied: 'success', pass: 'success',
  failed: 'danger', stale: 'danger',
  paused: 'neutral', cancelled: 'neutral', rejected: 'neutral', pending: 'neutral',
};
export const toneOf = (status: string): Tone => statusTones[status] ?? 'neutral';
export function StatusPill({ status, children, tone }: { status: string; children: ReactNode; tone?: Tone }) {
  const value = tone ?? toneOf(status);
  return <span className={`status-pill tone-${value}`} data-status={status}>{value === 'accent' && <i className="pulse" aria-hidden="true"/>}{children}</span>;
}
export function Callout({ tone = 'neutral', title, children, className = '', ...rest }: { tone?: Tone; title?: ReactNode; children?: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`callout tone-${tone} ${className}`} {...rest}>{title && <strong>{title}</strong>}{children}</div>;
}
export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;

export function Popover({ label, trigger, children, align = 'start', side = 'bottom', className = '', triggerClassName = '', testId, disabled }: {
  label: string; trigger: ReactNode; children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end' | 'center'; side?: 'top' | 'bottom'; className?: string; triggerClassName?: string; testId?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = (restore = false) => { setOpen(false); if (restore) button.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-autofocus], .popover-panel input, .popover-panel button:not(:disabled)')?.focus({ preventScroll: true }));
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div ref={root} className={`popover ${className}`} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); }
  }}>
    <button ref={button} type="button" className={triggerClassName} data-testid={testId} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => setOpen(!open)}>{trigger}</button>
    {open && <div id={id} className={`popover-panel align-${align} side-${side}`} role="dialog" aria-label={label}>{typeof children === 'function' ? children(() => close(true)) : children}</div>}
  </div>;
}

export interface ComboItem { id: string; label: string; hint?: string; group?: string; disabled?: boolean }
export function Combobox({ items, onPick, placeholder = '搜索…', empty = '没有匹配内容', label }: { items: ComboItem[]; onPick: (item: ComboItem) => void; placeholder?: string; empty?: string; label: string }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const visible = items.filter(item => !query.trim() || `${item.label} ${item.hint ?? ''} ${item.group ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const enabled = visible.filter(item => !item.disabled);
  const current = enabled[Math.min(active, enabled.length - 1)];
  useEffect(() => setActive(0), [query]);
  let lastGroup: string | undefined;
  return <div className="combobox">
    <input data-autofocus role="combobox" aria-label={label} aria-expanded="true" aria-controls={listId} aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
      value={query} placeholder={placeholder} onChange={event => setQuery(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (enabled.length) setActive(index => (Math.min(index, enabled.length - 1) + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length); }
        else if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (current) onPick(current); }
      }}/>
    <div className="combo-list" role="listbox" id={listId} aria-label={label}>
      {visible.map(item => {
        const heading = item.group && item.group !== lastGroup ? item.group : undefined; lastGroup = item.group;
        return <div key={item.id} role="presentation">{heading && <div className="combo-group" role="presentation">{heading}</div>}
          <button type="button" role="option" id={`${listId}-${item.id}`} aria-selected={item === current} className={item === current ? 'active' : ''} disabled={item.disabled}
            onPointerMove={() => { const index = enabled.indexOf(item); if (index >= 0 && index !== active) setActive(index); }} onClick={() => onPick(item)}>
            <span>{item.label}</span>{item.hint && <small>{item.hint}</small>}
          </button></div>;
      })}
      {!visible.length && <p className="combo-empty">{empty}</p>}
    </div>
  </div>;
}
