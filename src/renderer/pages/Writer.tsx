import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, BookMarked, FileText, Lightbulb, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, PanelRight, Plus, Sparkles, Trash2 } from 'lucide-react';
import { ActionMenu, Dialog, SaveFeedbackContext, Field, Empty, fire, characters, orderedChapters, type Commit } from '../ui';
import { styleProfile } from '../../shared/style-types';
import { styleBaseline, styleLint } from '../../shared/style-metrics';
import type { NarrativeScene, RunRequest, SourceReference, Workspace } from '../../shared/types';
import { useCompanion } from '../Companion';
import { canvasAction, type RegisterFlush, type AssistAction, type OpenCanvas, type AskDelete } from '../types';

const wordCount=(text:string)=>text.replace(/\s/g,'').length;
/** Book length when each project was first opened in the writer during this app session. */
const sessionBase=new Map<string,number>();
const fontSizeKey='novel.writer.fontSize';
const storedFontSize=()=>{const value=Number(localStorage.getItem(fontSizeKey));return value>=14&&value<=28?value:18;};

export function Writer({workspace:w,scene,selectScene,addChapter,addScene,commit,askDelete,onSelection,hasSelection,onRewrite,onPinSample,registerFlush,onAssist,onOpenCanvas,onPrepare,onDetails,detailsOpen,beforeChange,focusMode,onFocusMode}:{beforeChange:()=>Promise<void>;registerFlush:RegisterFlush;onAssist:AssistAction;onOpenCanvas:OpenCanvas;workspace:Workspace;scene?:NarrativeScene;selectScene:(id:string)=>void;addChapter:()=>Promise<string>;addScene:(chapterId?:string)=>Promise<string|undefined>;commit:Commit;askDelete:AskDelete;onSelection:(s:{start:number;end:number;text:string}|undefined)=>void;hasSelection:boolean;onRewrite:()=>void;onPinSample:()=>void;onPrepare:(stage:RunRequest['stage'],refs:SourceReference[],scope?:'scene'|'chapter')=>void;onDetails:()=>void;detailsOpen:boolean;focusMode:boolean;onFocusMode:(value:boolean)=>void}) {
  const [chaptersOpen,setChaptersOpen]=useState(true);
  const [renaming,setRenaming]=useState('');
  const [focusScene,setFocusScene]=useState('');
  const [fontSize,setFontSizeState]=useState(storedFontSize);
  const [checking,setChecking]=useState(false);
  const setFontSize=(value:number)=>{setFontSizeState(value);localStorage.setItem(fontSizeKey,String(value));};
  const companion=useCompanion();
  const moveChapter=(id:string,d:number)=>fire(commit(current=>{const list=orderedChapters(current),i=list.findIndex(v=>v.id===id),other=list[i+d];if(!other)return[];[list[i],list[i+d]]=[list[i+d],list[i]];return list.map((c,order)=>({type:'putChapter',value:{...c,order:order+1}}));},'调整章节顺序'));
  const moveScene=(id:string,d:number)=>fire(commit(current=>{const scene=current.scenes.find(s=>s.id===id);if(!scene)return[];const list=current.scenes.filter(s=>s.chapterId===scene.chapterId).sort((a,b)=>a.order-b.order),i=list.findIndex(s=>s.id===id);if(!list[i+d])return[];[list[i],list[i+d]]=[list[i+d],list[i]];return list.map((s,order)=>({type:'putScene',value:{...s,order:order+1}}));},'调整场景顺序'));
  const chapters=orderedChapters(w);
  const showChapters=chaptersOpen&&!focusMode;
  const pov=scene?.povId?characters(w).find(c=>c.id===scene.povId)?.name:undefined;
  const total=w.scenes.reduce((sum,s)=>sum+wordCount(s.text),0);
  if(!sessionBase.has(w.id))sessionBase.set(w.id,total);
  const delta=total-sessionBase.get(w.id)!;
  useEffect(()=>{if(focusScene&&scene?.id===focusScene){document.querySelector<HTMLTextAreaElement>('[data-testid="prose-editor"]')?.focus();setFocusScene('');}},[focusScene,scene?.id]);
  const createScene=(chapterId?:string)=>fire(addScene(chapterId).then(id=>{if(id)setFocusScene(id);}));
  const createChapter=()=>fire(addChapter().then(id=>requestAnimationFrame(()=>{const input=document.querySelector<HTMLInputElement>(`[data-chapter-id="${id}"] .chapter-title input`);input?.focus();input?.select();})));
  const rename=(id:string,title:string|null,restoreFocus:boolean)=>{
    setRenaming('');
    if(restoreFocus)requestAnimationFrame(()=>document.querySelector<HTMLElement>(`[data-scene-row="${id}"] > button`)?.focus());
    if(title)fire(commit(current=>{const latest=current.scenes.find(s=>s.id===id);return latest&&latest.title!==title?[{type:'putScene',value:{...latest,title}}]:[];},'重命名场景'));
  };
  return <div className={`writer-page ${showChapters?'':'chapters-collapsed'}`}>
    {showChapters&&<aside className="chapter-sidebar" aria-label="章节目录">
      <div className="chapter-sidebar-head"><h3>目录</h3><span className="book-count" title="本次：自打开叙境以来全书字数的变化">全书 {total.toLocaleString()} 字{delta!==0&&<> · 本次 {delta>0?'+':'−'}{Math.abs(delta).toLocaleString()}</>}</span><button className="icon-button ghost small" title="新建章节" aria-label="新建章节" onClick={createChapter}><Plus/></button></div>
      {chapters.map((c,index)=>{const scenes=w.scenes.filter(s=>s.chapterId===c.id).sort((a,b)=>a.order-b.order);const chapterCount=scenes.reduce((sum,s)=>sum+wordCount(s.text),0);return <div className="chapter-block" key={c.id} data-chapter-id={c.id}>
        <div className="chapter-title"><Field value={c.title} onSave={title=>commit(current=>{const chapter=current.chapters.find(v=>v.id===c.id);return chapter?[{type:'putChapter',value:{...chapter,title}}]:[];})}/><small className="chapter-count" title="本章字数">{chapterCount.toLocaleString()}</small><div className="row-actions chapter-actions"><button title="上移章节" aria-label="上移章节" disabled={index===0} onClick={()=>moveChapter(c.id,-1)}><ArrowUp/></button><button title="下移章节" aria-label="下移章节" disabled={index===chapters.length-1} onClick={()=>moveChapter(c.id,1)}><ArrowDown/></button><button title="删除章节" aria-label="删除章节" className="text-danger" onClick={()=>fire(askDelete({type:'deleteChapter',id:c.id},`删除「${c.title}」`))}><Trash2/></button></div></div>
        {scenes.map((s,sceneIndex)=>{const count=wordCount(s.text);return <div className={`scene-row ${scene?.id===s.id?'selected':''}`} key={s.id} data-scene-row={s.id}>{renaming===s.id?<SceneTitleInput value={s.title} onDone={(title,restoreFocus)=>rename(s.id,title,restoreFocus)}/>:<><button aria-current={scene?.id===s.id?'true':undefined} title="双击或按 F2 重命名 · Alt+↑/↓ 切换场景" onClick={()=>selectScene(s.id)} onDoubleClick={()=>setRenaming(s.id)} onKeyDown={event=>{if(event.key==='F2'){event.preventDefault();setRenaming(s.id);}}}><FileText aria-hidden="true"/><strong>{s.title}</strong><small className={count?'':'empty'}>{count?`${count.toLocaleString()} 字`:'空白'}</small></button><div className="row-actions"><button title="上移场景" aria-label="上移场景" disabled={sceneIndex===0} onClick={()=>moveScene(s.id,-1)}><ArrowUp/></button><button title="下移场景" aria-label="下移场景" disabled={sceneIndex===scenes.length-1} onClick={()=>moveScene(s.id,1)}><ArrowDown/></button></div></>}</div>;})}
        <button className="add-scene" onClick={()=>createScene(c.id)}><Plus aria-hidden="true"/>添加场景</button></div>;})}
      {!w.chapters.length&&<p className="muted inset">新建章节，或在情节规划中让 AI 根据素材编排场景。</p>}
    </aside>}
    <div className="writing-area"><div className="writer-toolbar">
      <button className="icon-button ghost" data-testid="toggle-chapters" disabled={focusMode} aria-label={showChapters?'收起章节目录':'展开章节目录'} title={showChapters?'收起章节目录':'展开章节目录'} aria-expanded={showChapters} onClick={()=>fire(beforeChange().then(()=>setChaptersOpen(!chaptersOpen)))}>{showChapters?<PanelLeftClose/>:<PanelLeftOpen/>}</button>
      {scene&&<><div className="writer-title"><span className="eyebrow">{w.chapters.find(c=>c.id===scene.chapterId)?.title}</span><h2>{scene.title}</h2></div><div className="button-row">
        <button className={`ghost ${detailsOpen?'selected':''}`} aria-pressed={detailsOpen} title="场景大纲、视角与关联事件" onClick={onDetails}><PanelRight aria-hidden="true"/>场景大纲</button>
        {!scene.text.trim()&&<button className="primary" data-testid="prepare-chapter" onClick={()=>onPrepare('chapter',[{kind:'scene',id:scene.id}])}><Sparkles aria-hidden="true"/>生成当前场景</button>}
        <button className="ghost" data-testid="writer-beat" title="卡文时，让创作伙伴给出几个可以直接写下去的下一拍" onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();fire(beforeChange().then(()=>companion.summon({mode:'beat',anchor:{surface:'writer',references:[{kind:'scene',id:scene.id}],sceneId:scene.id},screen:{x:rect.left,y:rect.bottom},label:scene.title,message:scene.text.trim()?'我写到这里卡住了，接下来可以发生什么？':'这一场还没开始写，给我几个开场的切入点。'})));}}><Lightbulb aria-hidden="true"/>卡文了？</button>
        {hasSelection&&<button className="ghost" data-testid="pin-style-sample" title="把选中的文字加入范文库，AI 写作时会参照它的笔触" onClick={()=>fire(beforeChange().then(onPinSample))}><BookMarked aria-hidden="true"/>设为范文</button>}
        <button className={scene.text.trim()?'primary':''} data-testid="prepare-rewrite" disabled={!hasSelection} title={hasSelection?'准备改写所选文字':'先在正文中选择需要改写的文字'} onClick={onRewrite}><Sparkles aria-hidden="true"/>改写选段</button>
        <button className="icon-button ghost" data-testid="toggle-focus" aria-pressed={focusMode} title={focusMode?'退出专注模式（Esc）':'专注模式（Ctrl+Shift+F）'} aria-label={focusMode?'退出专注模式':'专注模式'} onClick={()=>onFocusMode(!focusMode)}>{focusMode?<Minimize2/>:<Maximize2/>}</button>
        <ActionMenu key={scene.id} label="更多场景操作"><button role="menuitem" onClick={()=>onAssist('character',[{kind:'scene',id:scene.id}])}>分析人物心理</button><button role="menuitem" onClick={()=>onAssist('continuity',[{kind:'scene',id:scene.id}])}>检查本场一致性</button><button role="menuitem" data-testid="style-check" disabled={!scene.text.trim()} onClick={()=>fire(beforeChange().then(()=>setChecking(true)))}>文风体检</button><button role="menuitem" onClick={()=>onOpenCanvas('scene',scene.id)}>{canvasAction(w,'scene',scene.id)}</button><button role="menuitem" data-testid="prepare-chapter-all" onClick={()=>onPrepare('chapter',[{kind:'scene',id:scene.id}],'chapter')}>完成本章空白场景</button><button role="menuitem" className="text-danger" onClick={()=>fire(askDelete({type:'deleteScene',id:scene.id},`删除「${scene.title}」`))}><Trash2 aria-hidden="true"/>删除场景</button></ActionMenu>
      </div></>}
    </div>{checking&&scene&&<StyleCheck workspace={w} text={scene.text} title={scene.title} onClose={()=>setChecking(false)}/>}{scene?<SceneComposer key={scene.id} scene={scene} pov={pov} commit={commit} registerFlush={registerFlush} onSelection={onSelection} fontSize={fontSize} onFontSize={setFontSize}/>:<Empty title="开始写下第一个场景" description="手动创建章节和场景，或在情节规划中让 AI 根据素材编排。" action={<button className="primary" onClick={()=>createScene()}><Plus aria-hidden="true"/>创建第一个场景</button>}/>}</div>
  </div>;
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

export function SceneComposer({scene,pov,commit,onSelection,registerFlush,fontSize,onFontSize}:{scene:NarrativeScene;pov?:string;commit:Commit;onSelection:(s:{start:number;end:number;text:string}|undefined)=>void;registerFlush:RegisterFlush;fontSize:number;onFontSize:(value:number)=>void}) {
  const reportSave=useContext(SaveFeedbackContext);const saveId=useId();
  useEffect(()=>()=>reportSave(saveId,null),[reportSave,saveId]);
  const [text,setText]=useState(scene.text);const [status,setStatus]=useState('已保存');const [conflict,setConflict]=useState(false);const [composing,setComposing]=useState(false);const baseline=useRef(scene.text);const local=useRef(text);local.current=text;const conflictRef=useRef(conflict);conflictRef.current=conflict;const saving=useRef<Promise<void>|null>(null);const editor=useRef<HTMLTextAreaElement>(null);
  const flush=useCallback(async()=>{
    if(saving.current)await saving.current;
    const draft=local.current;if(draft===baseline.current)return;
    if(conflictRef.current)throw new Error('正文草稿存在版本冲突，请先在编辑器中选择如何继续。');
    setStatus('正在保存…');reportSave(saveId,'saving');
    const task=commit(current=>{const latest=current.scenes.find(s=>s.id===scene.id);if(!latest)throw new Error('该场景已被删除；当前草稿仍保留在编辑器中。');if(latest.text!==baseline.current&&latest.text!==draft)throw new Error('场景已有新的修改，你的草稿已保留，请选择如何合并。');return[{type:'putScene',value:{...latest,text:draft}}];},'保存正文').then(next=>{baseline.current=next.scenes.find(s=>s.id===scene.id)?.text||'';setStatus(local.current===baseline.current?'已保存':'待保存…');reportSave(saveId,local.current===baseline.current?null:'editing');}).catch(error=>{conflictRef.current=true;setConflict(true);setStatus('保存未完成 · 草稿已保留');reportSave(saveId,'conflict');throw error;}).finally(()=>{saving.current=null;});
    saving.current=task;await task;
  },[scene.id,commit,reportSave,saveId]);
  useEffect(()=>{registerFlush(flush);return()=>{registerFlush(null);fire(flush());};},[flush,registerFlush]);
  useEffect(()=>{if(scene.text===baseline.current)return;if(scene.text===local.current){baseline.current=scene.text;setConflict(false);setStatus('已保存');reportSave(saveId,null);}else if(local.current===baseline.current){baseline.current=scene.text;setText(scene.text);setStatus('已保存');reportSave(saveId,null);}else if(!saving.current){conflictRef.current=true;setConflict(true);setStatus('草稿已保留 · 有新版本');reportSave(saveId,'conflict');}},[scene.text]);
  useEffect(()=>{if(text===baseline.current||conflict||composing)return;setStatus('待保存…');const timer=setTimeout(()=>fire(flush()),600);return()=>clearTimeout(timer);},[text,conflict,composing,flush]);
  const pick=()=>{const element=editor.current;if(!element)return;onSelection(element.selectionEnd>element.selectionStart?{start:element.selectionStart,end:element.selectionEnd,text:element.value.slice(element.selectionStart,element.selectionEnd)}:undefined);};
  const count=wordCount(text);
  return <><div className="editor-meta"><span>{pov?`${pov} 视角`:'外部视角'}</span><span className="editor-meta-end"><span data-status={conflict?'conflict':status==='已保存'?'saved':'pending'}>{count.toLocaleString()} 字{status!=='已保存'&&<> · {status}</>}</span><span className="font-steps"><button className="ghost" disabled={fontSize<=14} aria-label="缩小正文字号" title="缩小正文字号" onClick={()=>onFontSize(fontSize-1)}>A−</button><span>{fontSize}px</span><button className="ghost" disabled={fontSize>=28} aria-label="放大正文字号" title="放大正文字号" onClick={()=>onFontSize(fontSize+1)}>A＋</button></span></span></div>{conflict&&<div className="conflict-banner" role="alert"><strong>正文有新的修改，你的草稿仍在这里。</strong><div><button className="small" onClick={()=>{baseline.current=scene.text;local.current=scene.text;setText(scene.text);conflictRef.current=false;setConflict(false);setStatus('已保存');reportSave(saveId,null);}}>使用当前保存内容</button><button className="small" onClick={()=>{baseline.current=scene.text;conflictRef.current=false;setConflict(false);setStatus('待保存…');reportSave(saveId,'editing');}}>以当前草稿继续</button></div></div>}<textarea ref={editor} data-testid="prose-editor" className="prose-editor" aria-label="场景正文" style={{'--prose-size':`${fontSize}px`} as React.CSSProperties} value={text} onChange={e=>{setText(e.target.value);onSelection(undefined);reportSave(saveId,e.target.value===baseline.current?null:'editing');setStatus(e.target.value===baseline.current?'已保存':'待保存…');}} onBlur={()=>fire(flush())} onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)} onSelect={pick} onMouseUp={pick} onKeyUp={pick} placeholder="在这里写下第一句。也可以点击「生成当前场景」，让 AI 走进人物的视角，与你一起完成这一幕。" spellCheck={false}/></>;
}
