import type { MouseEvent } from 'react';
import { BookOpenText, FilePlus2, Layers, ListTree, MessageCircleQuestion, Plus, Sparkles, Split, Trash2 } from 'lucide-react';
import type { Chapter, SourceReference, Workspace } from '../../shared/types';
import type { CompanionAskOptions, CompanionOp, OutlineNodeKind } from '../../shared/companion-types';
import { companionCommands } from '../../shared/companion';
import { outlineTemplate, outlineTemplates } from '../../shared/outline-templates';
import { useCompanion } from '../Companion';
import { Field, fire, uid, type Commit } from '../ui';
import { chapterPassages, chapterTarget, passageLabel, proseChars } from '../../shared/structure';
import type { AskDelete } from '../types';

function manualOp(patch: Partial<CompanionOp> & Pick<CompanionOp, 'op'>): CompanionOp {
  return { id: 'o1', ref: null, targetId: null, parentRef: null, parentId: null, title: null, content: null, purpose: null, order: null, povName: null, causes: [], people: [], ...patch };
}

export function Outline({ workspace: w, commit, askDelete, onOpenPassage }: {
  workspace: Workspace; commit: Commit; askDelete: AskDelete; onOpenPassage: (id: string) => void;
}) {
  const target = chapterTarget(w);
  const companion = useCompanion();
  const acts = [...(w.acts ?? [])].sort((a, b) => a.order - b.order);
  const chapters = [...w.chapters].sort((a, b) => a.order - b.order);
  const loose = chapters.filter(chapter => !chapter.actId);
  const template = outlineTemplate(w.structureTemplate);
  const summon = (event: MouseEvent<HTMLElement>, kind: OutlineNodeKind, id: string | undefined, message: string, label: string, options?: CompanionAskOptions) => {
    const rect = event.currentTarget.getBoundingClientRect();
    companion.summon({ mode: 'outline', anchor: { surface: 'outline', references: kind === 'chapter' && id ? [...new Set(chapterPassages(w, id).map(passage => passage.sceneId))].slice(0, 6).map(sceneId => ({ kind: 'scene' as const, id: sceneId })) : [], outlineNode: { kind, ...(id ? { id } : {}) } },
      screen: { x: rect.left, y: rect.bottom }, message, label, ...(options ? { options } : {}) });
  };
  /** Manual additions share the companion's ordering rules, so a chapter added to an act lands after that act's chapters. */
  const add = (op: CompanionOp, label: string) => fire(commit(current => companionCommands(current, { ideas: [], ops: [{ proposal: { id: 'manual', title: '', summary: '', ops: [op] }, op }] },
    { mode: 'outline', anchor: { surface: 'outline', references: [] }, newId: uid }).commands, label));
  const aiActions = (kind: OutlineNodeKind, id: string | undefined, title: string, next: string) => <div className="outline-ai" role="group" aria-label={`${title}的 AI 操作`}>
    <button className="small ghost ai-action" data-testid={`outline-expand-${kind}`} onClick={event => summon(event, kind, id, `为「${title}」展开${next}。`, `展开 · ${title}`)}><Split aria-hidden="true"/>展开{next}</button>
    <button className="small ghost ai-action" onClick={event => summon(event, kind, id, `给我 3 个不同版本的「${title}」${next}展开，风格和走向要明显不同。`, `3 个版本 · ${title}`)}><Layers aria-hidden="true"/>3 个版本</button>
    <button className="small ghost ai-action" onClick={event => summon(event, kind, id, `先别急着展开「${title}」，问我几个关键问题，帮我想清楚它在整个故事里要完成什么。`, `追问 · ${title}`)}><MessageCircleQuestion aria-hidden="true"/>追问我</button>
  </div>;
  const chapterView = (chapter: Chapter) => {
    const passages = chapterPassages(w, chapter.id), chars = passages.reduce((sum, passage) => sum + proseChars(passage.text), 0);
    return <li key={chapter.id} className="outline-chapter" data-testid="outline-chapter" data-chapter-id={chapter.id}>
      <div className="outline-node-head">
        <Field key={`${chapter.id}-title`} className="outline-title" value={chapter.title} onSave={title => commit(current => { const value = current.chapters.find(item => item.id === chapter.id); return value && title.trim() ? [{ type: 'putChapter', value: { ...value, title: title.trim() } }] : []; }, '修改章节标题')}/>
        <small className="outline-chapter-size" title={`每章目标约 ${target.toLocaleString()} 字`}>{chars.toLocaleString()} / {target.toLocaleString()} 字</small>
        <select aria-label={`「${chapter.title}」所属卷`} value={chapter.actId ?? ''} onChange={event => fire(commit(current => { const value = current.chapters.find(item => item.id === chapter.id); if (!value) return []; const { actId: _old, ...rest } = value; return [{ type: 'putChapter', value: event.target.value ? { ...rest, actId: event.target.value } : rest }]; }, '调整章节所属卷'))}>
          <option value="">未归入卷</option>{acts.map(act => <option key={act.id} value={act.id}>{act.title}</option>)}
        </select>
      </div>
      <Field key={`${chapter.id}-summary`} multiline value={chapter.summary ?? ''} placeholder="这一章要完成什么？结尾留下什么钩子？" onSave={summary => commit(current => { const value = current.chapters.find(item => item.id === chapter.id); return value ? [{ type: 'putChapter', value: { ...value, summary } }] : []; }, '修改章节概要')}/>
      <ol className="outline-scenes">{passages.map(passage => { const scene = w.scenes.find(item => item.id === passage.sceneId); return <li key={passage.id}>
        <button className="outline-scene" onClick={() => onOpenPassage(passage.id)} title="进入正文写作">
          <strong>{passageLabel(w, passage)}</strong>{passage.text.trim() ? <span className="badge written">已有正文 · {proseChars(passage.text).toLocaleString()} 字</span> : <span className="badge">未写</span>}
          <span className="outline-scene-text">{passage.beat?.trim() || scene?.outline || '尚无场景大纲'}</span>
        </button>
      </li>; })}</ol>
      <div className="outline-node-actions">
        <button className="small ghost" onClick={() => add(manualOp({ op: 'addScene', parentId: chapter.id, title: '新的场景' }), '添加场景')}><FilePlus2 aria-hidden="true"/>场景</button>
        {aiActions('chapter', chapter.id, chapter.title, '场景节拍')}
      </div>
    </li>;
  };
  return <div className="outline-page" data-testid="outline-page">
    <aside className="outline-meta panel">
      <div className="section-heading"><div><h2>故事骨架</h2><p className="muted">一句话说清：谁，想要什么，被什么阻挡，代价是什么。</p></div></div>
      <Field label="一句话梗概" multiline value={w.logline ?? ''} placeholder="例如：一个修钟学徒必须在第十三声钟响前，决定是否相信来历不明的信使。" onSave={logline => commit([{ type: 'updateNovel', patch: { logline } }], '修改一句话梗概')}/>
      <label className="field"><span>结构模板</span>
        <select data-testid="structure-template" value={w.structureTemplate ?? ''} onChange={event => fire(commit([{ type: 'updateNovel', patch: { structureTemplate: event.target.value } }], '选择结构模板'))}>
          <option value="">不使用模板</option>{outlineTemplates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      {template && <div className="template-stages"><p className="muted">{template.fit}</p><ol>{template.stages.map(stage => <li key={stage.name}><span className="stage-bar" style={{ width: `${Math.max(6, stage.share)}%` }}/><strong>{stage.name}</strong><small>{stage.purpose}</small></li>)}</ol></div>}
      <div className="outline-meta-actions">
        <button className="primary" data-testid="outline-full-draft" onClick={event => summon(event, 'book', undefined, '生成全书草案：卷 → 章节 → 场景节拍。', '全书草案', { fullDraft: true })}><Sparkles aria-hidden="true"/>一键生成全书草案</button>
        <button onClick={event => summon(event, 'book', undefined, '把故事骨架展开成几卷，每卷是一个情节阶段。', '展开卷')}><Split aria-hidden="true"/>展开卷</button>
        <button className="ghost" onClick={event => summon(event, 'book', undefined, '先别展开，问我几个关键问题，帮我把故事骨架想清楚。', '追问 · 故事骨架')}><MessageCircleQuestion aria-hidden="true"/>追问我</button>
      </div>
    </aside>
    <section className="outline-tree" aria-label="分层大纲">
      <div className="outline-tree-head"><h2><ListTree aria-hidden="true"/>卷 · 章节 · 场景</h2>
        <button className="small" data-testid="outline-add-act" onClick={() => add(manualOp({ op: 'addAct', title: `第 ${acts.length + 1} 卷` }), '添加卷')}><Plus aria-hidden="true"/>卷</button></div>
      {!acts.length && !w.scenes.length && <div className="outline-empty"><BookOpenText aria-hidden="true"/><p>先写下一句话梗概、选一个结构模板，再让创作伙伴展开第一层；也可以直接生成全书草案，逐层精修。</p></div>}
      <ol className="outline-acts">{acts.map(act => {
        const members = chapters.filter(chapter => chapter.actId === act.id);
        return <li key={act.id} className="outline-act" data-testid="outline-act">
          <div className="outline-node-head">
            <Field key={`${act.id}-title`} className="outline-title" value={act.title} onSave={title => commit(current => { const value = current.acts?.find(item => item.id === act.id); return value && title.trim() ? [{ type: 'putAct', value: { ...value, title: title.trim() } }] : []; }, '修改卷标题')}/>
            <small className="outline-chapter-size">{members.length} 章</small>
            <button className="icon-button small ghost text-danger" aria-label={`删除「${act.title}」`} title="删除卷（保留章节）" onClick={() => fire(askDelete({ type: 'deleteAct', id: act.id }, `删除卷「${act.title}」`))}><Trash2 aria-hidden="true"/></button>
          </div>
          <div className="form-grid">
            <Field key={`${act.id}-purpose`} label="在整体结构中的作用" value={act.purpose} onSave={purpose => commit(current => { const value = current.acts?.find(item => item.id === act.id); return value ? [{ type: 'putAct', value: { ...value, purpose } }] : []; }, '修改卷的作用')}/>
            <Field key={`${act.id}-summary`} label="概要" multiline value={act.summary} onSave={summary => commit(current => { const value = current.acts?.find(item => item.id === act.id); return value ? [{ type: 'putAct', value: { ...value, summary } }] : []; }, '修改卷概要')}/>
          </div>
          <ol className="outline-chapters">{members.map(chapterView)}</ol>
          <div className="outline-node-actions">
            <button className="small ghost" onClick={() => add(manualOp({ op: 'addChapter', parentId: act.id, title: `第 ${chapters.length + 1} 章` }), '添加章节')}><FilePlus2 aria-hidden="true"/>章节</button>
            {aiActions('act', act.id, act.title, '章节')}
          </div>
        </li>;
      })}</ol>
      {loose.length > 0 && <div className="outline-loose"><h3>{acts.length ? '未归入卷的章节' : '章节'}</h3><ol className="outline-chapters">{loose.map(chapterView)}</ol></div>}
    </section>
  </div>;
}
