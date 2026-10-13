import { ArrowRight, Check, Clapperboard, FileText, Globe, Lightbulb, PenLine, PenTool, Sparkles, Users, Wand2 } from 'lucide-react';
import { styleProfile } from '../../shared/style-types';
import type { AgentRun, Passage, RunRequest, SourceReference, Workspace } from '../../shared/types';
import { chapterTarget, DEFAULT_CHAPTER_CHARS, passageLabel, proseChars } from '../../shared/structure';
import { Field, StatusPill, events, runStatus, taskLabel, type Commit } from '../ui';
import type { AssistAction, View } from '../types';
import { useCompanion } from '../Companion';
import { storyFlow, storyGaps, type FlowAssist } from '../../shared/story-flow';


function ago(iso: string) {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)} 天前`;
  return new Date(iso).toLocaleDateString();
}

const focusField = (name: string) => {
  const input = document.querySelector<HTMLElement>(`.home-field-${name} :is(input, textarea)`);
  input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  input?.focus({ preventScroll: true });
};

export function Home({ workspace: w, passage, commit, setView, onAssist, onPrepare, runs, onMonitor }: {
  workspace: Workspace; passage?: Passage; commit: Commit; setView: (v: View) => void; onAssist: AssistAction;
  onPrepare: (stage: RunRequest['stage'], refs: SourceReference[]) => void; runs: AgentRun[]; onMonitor: (id: string) => void;
}) {
  const companion = useCompanion();
  /** Summon the partner beside the clicked button for one stage of the flow. */
  const assist = (event: React.MouseEvent<HTMLElement>, value: FlowAssist, label = value.label) => {
    const rect = event.currentTarget.getBoundingClientRect();
    companion.summon({ mode: value.mode, label, message: value.message, screen: { x: rect.left, y: rect.bottom },
      anchor: { surface: 'panel', references: [], ...(value.focus ? { focus: value.focus } : {}), ...(value.mode === 'outline' ? { outlineNode: { kind: 'book' as const } } : {}) } });
  };
  const flow = storyFlow(w);
  const gaps = storyGaps(w);
  const flowAssist = (id: string) => flow.find(stage => stage.id === id)!.assist!;
  const words = w.passages.reduce((n, p) => n + proseChars(p.text), 0);
  const objects = w.objects.filter(o => !o.event).length;
  const worldEvents = events(w).length;
  const stats = [
    { label: '人物与设定', value: objects, view: 'objects' as View, icon: Users, empty: '添加人物' },
    { label: '世界事件', value: worldEvents, view: 'world' as View, icon: Globe, empty: '编排事件' },
    { label: '叙述场景', value: w.scenes.length, view: 'story' as View, icon: Clapperboard, empty: '规划场景' },
    { label: '正文字数', value: words, view: 'write' as View, icon: PenLine, empty: '开始写作' },
  ];
  const steps = flow.map(stage => ({ ...stage, go: () => stage.id === 'profile' ? focusField('brief') : stage.id === 'theme' ? focusField('theme') : setView(stage.view) }));
  const doneSteps = steps.filter(step => step.done).length;
  const next = steps.find(step => !step.done);
  const scene = passage ? w.scenes.find(item => item.id === passage.sceneId) : undefined;
  const chapter = w.chapters.find(chapter => chapter.id === passage?.chapterId);
  const chapterWords = chapter ? w.passages.reduce((n, p) => n + (p.chapterId === chapter.id ? proseChars(p.text) : 0), 0) : 0;
  const sceneWords = passage ? proseChars(passage.text) : 0;
  const tail = passage?.text.trim().slice(-90);
  return <div className="home">
    <section className="home-hero" aria-labelledby="current-work-title">
      <div className="hero-story">
        <div className="hero-meta">
          <span className="hero-tag">{w.genre || '尚未设定题材'}</span>
          {w.audience && <span className="eyebrow">写给 {w.audience}</span>}
        </div>
        <h2 id="current-work-title">{w.title}</h2>
        {w.brief.trim()
          ? <p className="hero-brief">{w.brief}</p>
          : <button className="hero-brief empty-brief" onClick={() => focusField('brief')}>还没有创作简述。写下核心冲突或一个还不确定的念头，AI 会以此为依据。<ArrowRight aria-hidden="true"/></button>}
        <dl className="stats" aria-label="作品内容统计">{stats.map(({ label, value, view, icon: Icon, empty }) => <div key={label}>
          <dt><Icon aria-hidden="true"/>{label}</dt>
          <dd><button className="stat-link" onClick={() => setView(view)} aria-label={`${label} ${value}，前往查看`}>
            <span className={value ? '' : 'zero'}>{value.toLocaleString()}</span>
            {!value && <small>{empty}<ArrowRight aria-hidden="true"/></small>}
          </button></dd>
        </div>)}</dl>
      </div>
      <div className="resume-card">
        <span className="eyebrow">{scene ? '上次写到' : '从这里开始'}</span>
        <strong title={scene?.title}>{scene && passage ? passageLabel(w, passage) : '灵感画布'}</strong>
        <small>{scene ? `${chapter?.title ?? '未分章'} · 本章 ${chapterWords.toLocaleString()} / ${chapterTarget(w).toLocaleString()} 字` : '记录灵感，再整理为人物、事件与场景'}</small>
        {scene && <blockquote className={tail ? 'resume-excerpt' : 'resume-excerpt is-empty'}>
          {tail ? `${passage!.text.trim().length > 90 ? '…' : ''}${tail}` : passage?.beat?.trim() ? `本段要点：${passage.beat.trim()}` : scene.outline.trim() ? `场景大纲：${scene.outline.trim()}` : '这一场还没有正文，从第一句开始。'}
        </blockquote>}
        <button className="primary" data-testid="continue-writing" onClick={() => setView(scene ? 'write' : 'canvas')}>{scene ? <FileText aria-hidden="true"/> : <Lightbulb aria-hidden="true"/>}{scene && !sceneWords ? '开始写这一场' : '继续创作'}<ArrowRight aria-hidden="true"/></button>
      </div>
    </section>
    <div className="home-grid">
      <div className="home-main">
        <section className="panel">
          <div className="section-heading"><div><h2>作品信息</h2><p className="muted">AI 以这些信息作为创作依据。</p></div></div>
          <Field label="作品名称" value={w.title} onSave={title => commit([{ type: 'updateNovel', patch: { title } }])}/>
          <div className="form-grid"><Field label="题材" value={w.genre} placeholder="悬疑、奇幻、现实主义…" onSave={genre => commit([{ type: 'updateNovel', patch: { genre } }])}/><Field label="目标读者" value={w.audience} placeholder="谁会喜欢这个故事？" onSave={audience => commit([{ type: 'updateNovel', patch: { audience } }])}/>
            <Field label="每章字数" type="number" value={w.chapterTarget ?? ''} placeholder={`${DEFAULT_CHAPTER_CHARS}（默认）`} onSave={value => commit([{ type: 'updateNovel', patch: { chapterTarget: value.trim() ? Number(value) : null } }], '调整每章字数')}/></div>
          <Field className="home-field-brief" label="创作简述" multiline value={w.brief} placeholder="核心冲突、故事方向，或一个还不确定的念头。" onSave={brief => commit([{ type: 'updateNovel', patch: { brief } }])}/>
          <div className="button-row panel-actions">
            {gaps.emptyFields.length > 0 && <button className="secondary" data-testid="home-develop-profile" title={`还空着：${gaps.emptyFields.join('、')}`} onClick={event => assist(event, flowAssist('profile'))}><Wand2 aria-hidden="true"/>AI 补全作品信息</button>}
            <button className={gaps.emptyFields.length ? 'ghost' : 'secondary'} data-testid="home-diverge" onClick={event => assist(event, { mode: 'diverge', label: '故事构思', message: w.brief.trim() ? '根据作品简述，帮我把故事往几个截然不同的方向发散。' : '我还只有一个模糊的念头，先问我几个问题，帮我找到故事的起点。' })}><Sparkles aria-hidden="true"/>发散故事构思</button>
            <button className="ghost" data-testid="home-develop-cast" onClick={event => assist(event, flowAssist('cast'))}><Users aria-hidden="true"/>{gaps.characters ? '补充人物' : 'AI 设计人物'}</button>
            <button className="ghost" onClick={() => setView('outline')}>打开大纲<ArrowRight aria-hidden="true"/></button>
          </div>
        </section>
        <section className="panel home-progress" aria-labelledby="home-progress-title">
          <div className="section-heading">
            <div><h2 id="home-progress-title">创作进度</h2><p className="muted">{next ? <>下一步：{next.label}</> : '基础已经齐备，专注写下去。'}</p></div>
            <span className="progress-count">{doneSteps}<small>/ {steps.length}</small></span>
          </div>
          <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneSteps} aria-label="创作进度"><i style={{ width: `${doneSteps / steps.length * 100}%` }}/></div>
          <ol className="progress-steps">{steps.map((step, index) => <li key={step.id}>
            <button className={step.done ? 'done' : step === next ? 'next' : ''} onClick={step.go}>
              <span className="step-mark" aria-hidden="true">{step.done ? <Check/> : index + 1}</span>
              <span><strong>{step.label}</strong><small>{step.done ? '已完成' : step.hint}</small></span>
            </button>
            {step.assist && <button className={`icon-button small ghost step-assist ${step === next ? 'next' : ''}`} data-testid={`flow-assist-${step.id}`} title={step.assist.label} aria-label={step.assist.label} onClick={event => assist(event, step.assist!, step.label)}><Sparkles/></button>}
          </li>)}</ol>
          {next?.assist && <button className="suggestion" data-testid="flow-next" onClick={event => assist(event, next.assist!, next.label)}><Sparkles aria-hidden="true"/><span><strong>下一步：{next.label}</strong>{next.assist.label}，信息不够时会先问你几个选择题</span><ArrowRight aria-hidden="true"/></button>}
        </section>
      </div>
      <div className="home-side">
        <section className="panel">
          <div className="section-heading"><div><h2>小说立意</h2><p className="muted">人物作出什么选择，又为此付出什么代价？</p></div></div>
          <Field className="home-field-theme" label="通过人物选择呈现的立意" multiline value={w.theme || ''} placeholder="例如：信任需要先承担被欺骗的风险。" onSave={theme => commit([{ type: 'updateNovel', patch: { theme } }], '调整小说立意')}/>
          <button className="ghost panel-link" data-testid="home-develop-theme" onClick={event => assist(event, flowAssist('theme'), '小说立意')}><Sparkles aria-hidden="true"/>{w.theme?.trim() ? '深化立意' : 'AI 推断立意'}</button>
        </section>
        <StyleCard workspace={w} open={() => setView('style')}/>
        <section className="panel recent-runs">
          <div className="section-heading"><h2>最近 AI 任务</h2>{runs.length > 0 && <button className="small ghost" onClick={() => setView('monitor')}>全部<ArrowRight aria-hidden="true"/></button>}</div>
          {runs.slice(0, 4).map(run => <button key={run.id} onClick={() => onMonitor(run.id)}>
            <div><strong>{taskLabel(run)}<time dateTime={run.startedAt}>{ago(run.startedAt)}</time></strong><span title={run.objective}>{run.objective}</span></div>
            <StatusPill status={run.status}>{runStatus(run)}</StatusPill>
          </button>)}
          {!runs.length && <p className="muted">还没有 AI 任务。按 <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">J</kbd> 打开 AI 助手。</p>}
        </section>
      </div>
    </div>
  </div>;
}

function StyleCard({ workspace, open }: { workspace: Workspace; open: () => void }) {
  const style = styleProfile(workspace);
  const dials = Object.values(style.dials).filter(Boolean).length, pending = style.suggestions.filter(item => item.status === 'pending').length;
  const empty = !style.summary.trim() && !style.samples.length && !dials && !style.rules.length;
  return <section className="panel home-style" data-testid="home-style">
    <div className="section-heading"><div><h2>文风</h2><p className="muted">AI 照着它写，也照着它审。</p></div>{pending > 0 && <span className="pill">{pending} 条新偏好</span>}</div>
    {empty ? <p className="muted">还没有文风画像。贴一段你写的文字，AI 才能写得像你。</p> : <>
      {style.summary.trim() && <p className="home-style-summary">{style.summary}</p>}
      <p className="muted">{style.samples.length} 段范文 · {dials} 个笔调 · {style.rules.length} 条规则{style.avoidWords.length ? ` · ${style.avoidWords.length} 个禁用词` : ''}</p>
    </>}
    <button className="ghost panel-link" data-testid="home-open-style" onClick={open}><PenTool aria-hidden="true"/>{empty ? '设定我的文风' : '调整文风'}</button>
  </section>;
}
