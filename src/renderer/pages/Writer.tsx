import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, BookMarked, CornerDownRight, FileText, Lightbulb, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, PanelRight, PenLine, Plus, Scissors, Sparkles, Trash2 } from 'lucide-react';
import { ActionMenu, Dialog, SaveFeedbackContext, Field, Empty, fire, uid, characters, orderedChapters, orderedPassages, isContinuation, isRunActive, type Commit } from '../ui';
import { styleProfile } from '../../shared/style-types';
import { styleBaseline, styleLint } from '../../shared/style-metrics';
import type { AgentRun, Chapter, NarrativeScene, Passage, RunRequest, SourceReference, Workspace } from '../../shared/types';
import { chapterPassages, chapterTarget, continueSceneCommands, movePassageCommands, passageLabel, passageOrderAt, proseChars, scenePassages, splitChapterCommands, volumeRuns } from '../../shared/structure';
import { useCompanion } from '../Companion';
import { canvasAction, type RegisterFlush, type AssistAction, type OpenCanvas, type AskDelete } from '../types';

/** Book length when each project was first opened in the writer during this app session. */
const sessionBase=new Map<string,number>();
const fontSizeKey='novel.writer.fontSize';
const storedFontSize=()=>{const value=Number(localStorage.getItem(fontSizeKey));return value>=14&&value<=28?value:18;};

export function Writer({workspace:w,passage,selectPassage,addChapter,addScene,commit,askDelete,onSelection,hasSelection,cursor,onRewrite,onPinSample,registerFlush,onAssist,onOpenCanvas,onPrepare,onDetails,detailsOpen,beforeChange,focusMode,onFocusMode,onQuickWrite,onContinue,runs,notify}:{onQuickWrite:()=>void;onContinue:()=>void;runs:AgentRun[];beforeChange:()=>Promise<void>;registerFlush:RegisterFlush;onAssist:AssistAction;onOpenCanvas:OpenCanvas;workspace:Workspace;passage?:Passage;selectPassage:(id:string)=>void;addChapter:()=>Promise<string>;addScene:(chapterId?:string)=>Promise<string|undefined>;commit:Commit;askDelete:AskDelete;onSelection:(s:{start:number;end:number;text:string}|undefined)=>void;hasSelection:boolean;cursor?:number;onRewrite:()=>void;onPinSample:()=>void;onPrepare:(stage:RunRequest['stage'],refs:SourceReference[],scope?:'scene'|'chapter')=>void;onDetails:()=>void;detailsOpen:boolean;focusMode:boolean;onFocusMode:(value:boolean)=>void;notify:(text:string)=>void}) {
  const [chaptersOpen,setChaptersOpen]=useState(true);
  const [renaming,setRenaming]=useState('');
  const [focusPassage,setFocusPassage]=useState('');
  const [joining,setJoining]=useState('');
  const [fontSize,setFontSizeState]=useState(storedFontSize);
  const [checking,setChecking]=useState(false);
  const setFontSize=(value:number)=>{setFontSizeState(value);localStorage.setItem(fontSizeKey,String(value));};
  const companion=useCompanion();
  const moveChapter=(id:string,d:number)=>fire(commit(current=>{const list=orderedChapters(current),i=list.findIndex(v=>v.id===id),other=list[i+d];if(!other)return[];[list[i],list[i+d]]=[list[i+d],list[i]];return list.map((c,order)=>({type:'putChapter',value:{...c,order:order+1}}));},'调整章节顺序'));
  const movePassage=(id:string,d:-1|1)=>fire(commit(current=>movePassageCommands(current,id,d),'调整场景顺序'));
  const chapters=orderedChapters(w),target=chapterTarget(w),reading=orderedPassages(w);
  const scene=passage?w.scenes.find(s=>s.id===passage.sceneId):undefined;
  const parts=scene?scenePassages(w,scene.id):[];
  const chapter=passage?w.chapters.find(c=>c.id===passage.chapterId):undefined;
  const volume=chapter?.actId?(w.acts??[]).find(act=>act.id===chapter.actId):undefined;
  const label=passage?passageLabel(w,passage):'';
  const unplaced=w.scenes.filter(s=>!w.passages.some(p=>p.sceneId===s.id));
  const showChapters=chaptersOpen&&!focusMode;
  const pov=scene?.povId?characters(w).find(c=>c.id===scene.povId)?.name:undefined;
  const active=runs.find(run=>run.projectId===w.id&&isRunActive(run)),busy=!!active;
  const total=w.passages.reduce((sum,p)=>sum+proseChars(p.text),0);
  if(!sessionBase.has(w.id))sessionBase.set(w.id,total);
  const delta=total-sessionBase.get(w.id)!;
  useEffect(()=>{if(focusPassage&&passage?.id===focusPassage){document.querySelector<HTMLTextAreaElement>('[data-testid="prose-editor"]')?.focus();setFocusPassage('');}},[focusPassage,passage?.id]);
  const open=(id:string|undefined,focus=true)=>{if(!id)return;if(focus)setFocusPassage(id);selectPassage(id);};
  const createScene=(chapterId?:string)=>fire(addScene(chapterId).then(id=>open(id)));
  const createChapter=()=>fire(addChapter().then(id=>requestAnimationFrame(()=>{const input=document.querySelector<HTMLInputElement>(`[data-chapter-id="${id}"] .chapter-title input`);input?.focus();input?.select();})));
  const rename=(id:string,title:string|null,restoreFocus:boolean)=>{
    setRenaming('');
    if(restoreFocus)requestAnimationFrame(()=>document.querySelector<HTMLElement>(`[data-scene-row="${id}"] > button`)?.focus());
    if(title)fire(commit(current=>{const part=current.passages.find(p=>p.id===id),latest=part&&current.scenes.find(s=>s.id===part.sceneId);return latest&&latest.title!==title?[{type:'putScene',value:{...latest,title}}]:[];},'重命名场景'));
  };
  /** A chapter break at the cursor: the rest of this passage, and the passages after it, move to the next chapter. */
  const splitHere=()=>{if(!passage||cursor===undefined)return;const at=cursor;fire(beforeChange().then(async()=>{let moved='';await commit(current=>{const result=splitChapterCommands(current,passage.id,at,uid);moved=result.chapterId;return result.commands;},'在光标处分章');const next=workspaceTitle(moved);notify(next?`已分章：光标后的正文移到「${next}」。`:'已分章。');}));};
  const workspaceTitle=(id:string)=>chapters.find(c=>c.id===id)?.title??'';
  const continueNext=()=>{if(!passage)return;let created='';fire(beforeChange().then(()=>commit(current=>{const result=continueSceneCommands(current,passage.id,uid);created=result.passage.id;return result.commands;},'场景延续到下一章')).then(()=>open(created)));};
  const placeScene=(sceneId:string)=>{const chapterId=passage?.chapterId??chapters.at(-1)?.id;if(!chapterId)return;const id=uid();fire(commit(current=>[{type:'putPassage',value:{id,sceneId,chapterId,order:passageOrderAt(current,chapterId),text:''}}],'场景放进章节').then(()=>open(id)));};
  const passageRow=(p:Passage,index:number,count:number,chapterAt:number)=>{
    const s=w.scenes.find(item=>item.id===p.sceneId),n=proseChars(p.text),own=scenePassages(w,p.sceneId),continued=own[0]?.id!==p.id;
    const first=index===0&&chapterAt===0,last=index===count-1&&chapterAt===chapters.length-1;
    return <div className={`scene-row ${passage?.id===p.id?'selected':''} ${continued?'continued':''}`} key={p.id} data-scene-row={p.id}>{renaming===p.id?<SceneTitleInput value={s?.title??''} onDone={(title,restoreFocus)=>rename(p.id,title,restoreFocus)}/>:<><button aria-current={passage?.id===p.id?'true':undefined} title={`${continued?'接着上一章的这一场 · ':''}双击或按 F2 重命名场景 · Alt+↑/↓ 切换`} onClick={()=>selectPassage(p.id)} onDoubleClick={()=>setRenaming(p.id)} onKeyDown={event=>{if(event.key==='F2'){event.preventDefault();setRenaming(p.id);}}}>{continued?<CornerDownRight aria-hidden="true"/>:<FileText aria-hidden="true"/>}<strong>{passageLabel(w,p)}</strong><small className={n?'':'empty'}>{n?`${n.toLocaleString()} 字`:'空白'}</small></button><div className="row-actions"><button title={index===0&&!first?'移到上一章末尾':'上移'} aria-label="上移场景" disabled={first} onClick={()=>movePassage(p.id,-1)}><ArrowUp/></button><button title={index===count-1&&!last?'移到下一章开头':'下移'} aria-label="下移场景" disabled={last} onClick={()=>movePassage(p.id,1)}><ArrowDown/></button></div></>}</div>;
  };
  const chapterBlock=(c:Chapter)=>{
    const at=chapters.findIndex(item=>item.id===c.id),list=chapterPassages(w,c.id),count=list.reduce((sum,p)=>sum+proseChars(p.text),0),ratio=count/target;
    return <div className="chapter-block" key={c.id} data-chapter-id={c.id}>
      <div className="chapter-title"><Field value={c.title} onSave={title=>commit(current=>{const chapter=current.chapters.find(v=>v.id===c.id);return chapter?[{type:'putChapter',value:{...chapter,title}}]:[];})}/><small className={`chapter-count ${ratio>1.25?'over':''}`} title={`本章 ${count.toLocaleString()} 字 · 每章目标约 ${target.toLocaleString()} 字`}>{count.toLocaleString()}</small><div className="row-actions chapter-actions"><button title="上移章节" aria-label="上移章节" disabled={at===0} onClick={()=>moveChapter(c.id,-1)}><ArrowUp/></button><button title="下移章节" aria-label="下移章节" disabled={at===chapters.length-1} onClick={()=>moveChapter(c.id,1)}><ArrowDown/></button><button title="删除章节" aria-label="删除章节" className="text-danger" onClick={()=>fire(askDelete({type:'deleteChapter',id:c.id},`删除「${c.title}」`))}><Trash2/></button></div></div>
      <div className={`chapter-progress ${ratio>1.25?'over':ratio>=0.9?'full':''}`} aria-hidden="true"><i style={{width:`${Math.min(100,Math.round(ratio*100))}%`}}/></div>
      {list.map((p,index)=>passageRow(p,index,list.length,at))}
      <div className="chapter-adds"><button className="add-scene" onClick={()=>createScene(c.id)}><Plus aria-hidden="true"/>添加场景</button>{w.scenes.length>0&&<button className="add-scene join-scene" title="让一个已有场景在本章继续，例如上一章没写完的对峙" onClick={()=>setJoining(c.id)}><CornerDownRight aria-hidden="true"/>接续场景</button>}</div></div>;
  };
  const eyebrow=[volume?.title,chapter?.title].filter(Boolean).join(' · ');
  return <div className={`writer-page ${showChapters?'':'chapters-collapsed'}`}>
    {showChapters&&<aside className="chapter-sidebar" aria-label="章节目录">
      <div className="chapter-sidebar-head"><h3>目录</h3><span className="book-count" title={`本次：自打开叙境以来全书字数的变化 · 每章目标约 ${target.toLocaleString()} 字`}>全书 {total.toLocaleString()} 字{delta!==0&&<> · 本次 {delta>0?'+':'−'}{Math.abs(delta).toLocaleString()}</>}</span><button className="icon-button ghost small" title="新建章节" aria-label="新建章节" onClick={createChapter}><Plus/></button></div>
      {volumeRuns(w).map((run,index)=><div className="volume-block" key={run.act?.id??`chapters-${index}`}>{run.act&&<div className="volume-title" title={run.act.purpose||run.act.summary||undefined}><span className="volume-mark">卷</span><strong>{run.act.title}</strong><small>{run.chapters.length} 章</small></div>}{run.chapters.map(chapterBlock)}</div>)}
      {unplaced.length>0&&<div className="chapter-block unplaced-scenes"><p className="eyebrow">未排入章节的场景</p>{unplaced.map(s=><div className="scene-row" key={s.id}><button title={`放进${passage?'当前':'最后一'}章，接着写`} onClick={()=>placeScene(s.id)}><FileText aria-hidden="true"/><strong>{s.title}</strong><small>放进本章</small></button></div>)}</div>}
      {!w.chapters.length&&<p className="muted inset">新建章节，或在情节规划中让 AI 根据素材编排场景。</p>}
    </aside>}
    <div className="writing-area"><div className="writer-toolbar">
      <button className="icon-button ghost" data-testid="toggle-chapters" disabled={focusMode} aria-label={showChapters?'收起章节目录':'展开章节目录'} title={showChapters?'收起章节目录':'展开章节目录'} aria-expanded={showChapters} onClick={()=>fire(beforeChange().then(()=>setChaptersOpen(!chaptersOpen)))}>{showChapters?<PanelLeftClose/>:<PanelLeftOpen/>}</button>
      {passage&&scene&&<><div className="writer-title"><span className="eyebrow">{eyebrow}</span><h2>{label}</h2></div><div className="button-row">
        <button className={`ghost ${detailsOpen?'selected':''}`} aria-pressed={detailsOpen} title="场景大纲、视角、出场人物与本场的状态变化" onClick={onDetails}><PanelRight aria-hidden="true"/>场景大纲</button>
        {!passage.text.trim()&&<button className="primary" data-testid="prepare-chapter" disabled={busy} title={busy?'已有任务在进行，先在右侧处理它':'按场景大纲直接生成，写好后由你审批'} onClick={onQuickWrite}><Sparkles aria-hidden="true"/>{parts.length>1?'生成这一段':'生成当前场景'}</button>}
        {!!passage.text.trim()&&<button className="ghost" data-testid="continue-writing" disabled={busy} title={busy?'已有任务在进行，先在右侧处理它':'从光标处接着写；没有放光标时接在这一段结尾'} onClick={onContinue}><PenLine aria-hidden="true"/>续写</button>}
        <button className="ghost" data-testid="writer-beat" title="卡文时，让创作伙伴给出几个可以直接写下去的下一拍" onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();fire(beforeChange().then(()=>companion.summon({mode:'beat',anchor:{surface:'writer',references:[{kind:'scene',id:scene.id}],sceneId:scene.id,passageId:passage.id},screen:{x:rect.left,y:rect.bottom},label,message:passage.text.trim()?'我写到这里卡住了，接下来可以发生什么？':'这一段还没开始写，给我几个开场的切入点。'})));}}><Lightbulb aria-hidden="true"/>卡文了？</button>
        {hasSelection&&<button className="ghost" data-testid="pin-style-sample" title="把选中的文字加入范文库，AI 写作时会参照它的笔触" onClick={()=>fire(beforeChange().then(onPinSample))}><BookMarked aria-hidden="true"/>设为范文</button>}
        <button className={passage.text.trim()?'primary':''} data-testid="prepare-rewrite" disabled={!hasSelection} title={hasSelection?'准备改写所选文字':'先在正文中选择需要改写的文字'} onClick={onRewrite}><Sparkles aria-hidden="true"/>改写选段</button>
        <button className="icon-button ghost" data-testid="toggle-focus" aria-pressed={focusMode} title={focusMode?'退出专注模式（Esc）':'专注模式（Ctrl+Shift+F）'} aria-label={focusMode?'退出专注模式':'专注模式'} onClick={()=>onFocusMode(!focusMode)}>{focusMode?<Minimize2/>:<Maximize2/>}</button>
        <ActionMenu key={passage.id} label="更多场景操作"><button role="menuitem" onClick={()=>onAssist('character',[{kind:'scene',id:scene.id}])}>分析人物心理</button><button role="menuitem" onClick={()=>onAssist('continuity',[{kind:'scene',id:scene.id}])}>检查本场一致性</button><button role="menuitem" data-testid="style-check" disabled={!passage.text.trim()} onClick={()=>fire(beforeChange().then(()=>setChecking(true)))}>文风体检</button><button role="menuitem" onClick={()=>onOpenCanvas('scene',scene.id)}>{canvasAction(w,'scene',scene.id)}</button><button role="menuitem" data-testid="prepare-chapter-all" onClick={()=>onPrepare('chapter',[{kind:'scene',id:scene.id}],'chapter')}>完成本章空白场景</button><button role="menuitem" data-testid="split-chapter" disabled={cursor===undefined} title={cursor===undefined?'先在正文里点一下分章的位置':'光标后的正文和本章后面的场景移到下一章'} onClick={splitHere}><Scissors aria-hidden="true"/>在光标处分章</button><button role="menuitem" data-testid="continue-next-chapter" title="这一场没写完：在下一章开头接着写" onClick={continueNext}><CornerDownRight aria-hidden="true"/>这一场延续到下一章</button>{parts.length>1&&<button role="menuitem" className="text-danger" onClick={()=>fire(askDelete({type:'deletePassage',id:passage.id},`删除「${label}」这一段`))}><Trash2 aria-hidden="true"/>删除这一段</button>}<button role="menuitem" className="text-danger" onClick={()=>fire(askDelete({type:'deleteScene',id:scene.id},`删除「${scene.title}」${parts.length>1?`（共 ${parts.length} 段）`:''}`))}><Trash2 aria-hidden="true"/>删除场景</button></ActionMenu>
      </div></>}
    </div>{passage&&<LiveDraft run={active} passage={passage} label={label}/>}{checking&&passage&&<StyleCheck workspace={w} text={passage.text} title={label} onClose={()=>setChecking(false)}/>}{passage?<SceneComposer key={passage.id} passage={passage} pov={pov} commit={commit} registerFlush={registerFlush} onSelection={onSelection} fontSize={fontSize} onFontSize={setFontSize}/>:<Empty title="开始写下第一个场景" description="手动创建章节和场景，或在情节规划中让 AI 根据素材编排。" action={<button className="primary" onClick={()=>createScene()}><Plus aria-hidden="true"/>创建第一个场景</button>}/>}</div>
    {joining&&<JoinSceneDialog workspace={w} chapterId={joining} reading={reading} onClose={()=>setJoining('')} onJoin={sceneId=>{const chapterId=joining;setJoining('');const id=uid();fire(commit(current=>{const before=orderedChapters(current),at=before.findIndex(c=>c.id===chapterId),last=scenePassages(current,sceneId).at(-1);
      // Carried over from the chapter just before: it opens this chapter.
      const opens=!!last&&at>0&&before[at-1]!.id===last.chapterId;
      return[{type:'putPassage',value:{id,sceneId,chapterId,order:passageOrderAt(current,chapterId,opens?'start':'end'),text:''}}];},'接续场景').then(()=>open(id)));}}/>}
  </div>;
}

/** Pick a scene to go on in this chapter: scenes last read before it come first, the most recent at the top. */
function JoinSceneDialog({workspace:w,chapterId,reading,onClose,onJoin}:{workspace:Workspace;chapterId:string;reading:Passage[];onClose:()=>void;onJoin:(sceneId:string)=>void}) {
  const chapters=orderedChapters(w),at=chapters.findIndex(c=>c.id===chapterId);
  const lastSeen=new Map<string,Passage>();for(const p of reading)lastSeen.set(p.sceneId,p);
  const rank=(sceneId:string)=>{const p=lastSeen.get(sceneId);return p?chapters.findIndex(c=>c.id===p.chapterId):-1;};
  const here=new Set(w.passages.filter(p=>p.chapterId===chapterId).map(p=>p.sceneId));
  const earlier=w.scenes.filter(s=>!here.has(s.id)&&rank(s.id)<at).sort((a,b)=>rank(b.id)-rank(a.id));
  const others=w.scenes.filter(s=>!here.has(s.id)&&!earlier.includes(s));
  const row=(s:NarrativeScene)=>{const p=lastSeen.get(s.id);return <button key={s.id} className="join-option" onClick={()=>onJoin(s.id)}><strong>{s.title}</strong><small>{p?`上次在${chapters.find(c=>c.id===p.chapterId)?.title??''}`:'未排入章节'}</small></button>;};
  return <Dialog title={`在「${chapters[at]?.title??''}」接续场景`} onClose={onClose}><div className="join-scene-dialog" data-testid="join-scene">
    <p className="muted">场景可以跨章：选中的场景会在本章多出一段，接着前面的情节写。紧接上一章的场景放在本章开头，其他的放在末尾，之后可以用上下箭头调整。</p>
    {earlier.length+others.length?<div className="join-list">{earlier.slice(0,30).map(row)}{others.slice(0,20).map(row)}</div>:<p className="muted">没有可以接续的场景。</p>}
    <div className="button-row"><button onClick={onClose}>取消</button></div>
  </div></Dialog>;
}

/** The prose the AI is writing for this passage, shown where the author is looking while it streams. Read-only: nothing reaches the
 * passage until the author approves the candidate. */
function LiveDraft({run,passage,label}:{run?:AgentRun;passage:Passage;label:string}) {
  const step=run&&[...run.steps].reverse().find(step=>step.status==='running'&&(step.agentId==='writer'||step.agentId==='rewrite')&&step.label.startsWith(`${label} · `));
  const box=useRef<HTMLDivElement>(null);
  useEffect(()=>{const element=box.current;if(element)element.scrollTop=element.scrollHeight;},[step?.output]);
  if(!run||!step)return null;
  const continuing=isContinuation(run)&&run.passageId===passage.id,at=run.selection?.end??0;
  // The end of the paragraph the continuation picks up from, faded, so the new prose reads on from it.
  const before=continuing?passage.text.slice(Math.max(0,at-60),at).split('\n').at(-1)!.trim():'';
  return <section className="live-draft" data-testid="live-draft" aria-live="polite" aria-busy="true">
    <header><i className="live-dot" aria-hidden="true"/>{continuing?'AI 正在续写':'AI 正在写这一场'}<span>还没写入作品，审阅后由你批准</span></header>
    <div ref={box} className="live-draft-text">{before&&<span className="live-draft-before">…{before}</span>}{step.output||<span className="live-draft-wait">正在读前文与设定…</span>}</div>
  </section>;
}

/** Zero-token check of this scene against the author's style profile. */
function StyleCheck({workspace,text,title,onClose}:{workspace:Workspace;text:string;title:string;onClose:()=>void}) {
  const style=styleProfile(workspace),lint=styleLint(text,style,styleBaseline(style));
  return <Dialog title={`文风体检 · ${title}`} onClose={onClose}><div className="style-check" data-testid="style-check-result">
    <p><span className={`pill ${lint.score>=80?'good':lint.score>=60?'fair':'poor'}`}>贴合度 {lint.score}</span> <span className="muted">本地统计，不消耗 token。平均句长 {Math.round(lint.fingerprint.avgSentence)} 字 · 对白 {Math.round(lint.fingerprint.dialogueRatio*100)}% · 比喻 {lint.fingerprint.simile}/千字</span></p>
    {lint.issues.length?<ul className="style-issues">{lint.issues.map((issue,index)=><li key={index}>{issue.message}{issue.excerpt&&<q>{issue.excerpt}</q>}</li>)}</ul>:<p>没有发现禁用词、AI 腔或明显偏离你文风设定的地方。</p>}
    {!style.summary.trim()&&!style.samples.length&&<p className="muted">还没有设定文风，只检查了常见 AI 腔。到「文风」页添加范文后，体检会更准。</p>}
    <div className="button-row"><button className="primary" onClick={onClose}>知道了</button></div>
  </div></Dialog>;
}

function SceneTitleInput({value,onDone}:{value:string;onDone:(title:string|null,restoreFocus:boolean)=>void}) {
  const input=useRef<HTMLInputElement>(null);const done=useRef(false);
  useEffect(()=>{input.current?.focus();input.current?.select();},[]);
  const finish=(save:boolean,restoreFocus:boolean)=>{if(done.current)return;done.current=true;const title=input.current?.value.trim()||'';onDone(save&&title&&title!==value?title:null,restoreFocus);};
  return <input ref={input} className="scene-rename" aria-label="场景标题" defaultValue={value} maxLength={200} onBlur={()=>finish(true,false)}
    onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();finish(true,true);}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();finish(false,true);}}}/>;
}

export function SceneComposer({passage,pov,commit,onSelection,registerFlush,fontSize,onFontSize}:{passage:Passage;pov?:string;commit:Commit;onSelection:(s:{start:number;end:number;text:string}|undefined)=>void;registerFlush:RegisterFlush;fontSize:number;onFontSize:(value:number)=>void}) {
  const reportSave=useContext(SaveFeedbackContext);const saveId=useId();
  useEffect(()=>()=>reportSave(saveId,null),[reportSave,saveId]);
  const [text,setText]=useState(passage.text);const [status,setStatus]=useState('已保存');const [conflict,setConflict]=useState(false);const [composing,setComposing]=useState(false);const baseline=useRef(passage.text);const local=useRef(text);local.current=text;const conflictRef=useRef(conflict);conflictRef.current=conflict;const saving=useRef<Promise<void>|null>(null);const editor=useRef<HTMLTextAreaElement>(null);
  const flush=useCallback(async()=>{
    if(saving.current)await saving.current;
    const draft=local.current;if(draft===baseline.current)return;
    if(conflictRef.current)throw new Error('正文草稿存在版本冲突，请先在编辑器中选择如何继续。');
    setStatus('正在保存…');reportSave(saveId,'saving');
    const task=commit(current=>{const latest=current.passages.find(p=>p.id===passage.id);if(!latest)throw new Error('这一段已被删除；当前草稿仍保留在编辑器中。');if(latest.text!==baseline.current&&latest.text!==draft)throw new Error('这一段已有新的修改，你的草稿已保留，请选择如何合并。');return[{type:'putPassage',value:{...latest,text:draft}}];},'保存正文').then(next=>{baseline.current=next.passages.find(p=>p.id===passage.id)?.text||'';setStatus(local.current===baseline.current?'已保存':'待保存…');reportSave(saveId,local.current===baseline.current?null:'editing');}).catch(error=>{conflictRef.current=true;setConflict(true);setStatus('保存未完成 · 草稿已保留');reportSave(saveId,'conflict');throw error;}).finally(()=>{saving.current=null;});
    saving.current=task;await task;
  },[passage.id,commit,reportSave,saveId]);
  useEffect(()=>{registerFlush(flush);return()=>{registerFlush(null);fire(flush());};},[flush,registerFlush]);
  useEffect(()=>{if(passage.text===baseline.current)return;if(passage.text===local.current){baseline.current=passage.text;setConflict(false);setStatus('已保存');reportSave(saveId,null);}else if(local.current===baseline.current){baseline.current=passage.text;setText(passage.text);setStatus('已保存');reportSave(saveId,null);}else if(!saving.current){conflictRef.current=true;setConflict(true);setStatus('草稿已保留 · 有新版本');reportSave(saveId,'conflict');}},[passage.text]);
  useEffect(()=>{if(text===baseline.current||conflict||composing)return;setStatus('待保存…');const timer=setTimeout(()=>fire(flush()),600);return()=>clearTimeout(timer);},[text,conflict,composing,flush]);
  // A collapsed selection is reported too: it is where 续写 continues.
  const pick=()=>{const element=editor.current;if(!element)return;onSelection({start:element.selectionStart,end:element.selectionEnd,text:element.value.slice(element.selectionStart,element.selectionEnd)});};
  const count=proseChars(text);
  return <><div className="editor-meta"><span>{pov?`${pov} 视角`:'外部视角'}</span><span className="editor-meta-end"><span data-status={conflict?'conflict':status==='已保存'?'saved':'pending'}>{count.toLocaleString()} 字{status!=='已保存'&&<> · {status}</>}</span><span className="font-steps"><button className="ghost" disabled={fontSize<=14} aria-label="缩小正文字号" title="缩小正文字号" onClick={()=>onFontSize(fontSize-1)}>A−</button><span>{fontSize}px</span><button className="ghost" disabled={fontSize>=28} aria-label="放大正文字号" title="放大正文字号" onClick={()=>onFontSize(fontSize+1)}>A＋</button></span></span></div>{conflict&&<div className="conflict-banner" role="alert"><strong>正文有新的修改，你的草稿仍在这里。</strong><div><button className="small" onClick={()=>{baseline.current=passage.text;local.current=passage.text;setText(passage.text);conflictRef.current=false;setConflict(false);setStatus('已保存');reportSave(saveId,null);}}>使用当前保存内容</button><button className="small" onClick={()=>{baseline.current=passage.text;conflictRef.current=false;setConflict(false);setStatus('待保存…');reportSave(saveId,'editing');}}>以当前草稿继续</button></div></div>}<textarea ref={editor} data-testid="prose-editor" className="prose-editor" aria-label="正文" style={{'--prose-size':`${fontSize}px`} as React.CSSProperties} value={text} onChange={e=>{setText(e.target.value);onSelection(undefined);reportSave(saveId,e.target.value===baseline.current?null:'editing');setStatus(e.target.value===baseline.current?'已保存':'待保存…');}} onBlur={()=>fire(flush())} onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)} onSelect={pick} onMouseUp={pick} onKeyUp={pick} placeholder="在这里写下第一句。也可以点击「生成当前场景」，让 AI 走进人物的视角，与你一起完成这一幕。" spellCheck={false}/></>;
}
