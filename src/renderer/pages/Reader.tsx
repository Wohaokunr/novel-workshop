import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ArrowRight, ArrowLeft, BookMarked, BookOpen, Check, ChevronRight, CircleAlert, Download, FileText, FolderPlus, History, LayoutDashboard, Lightbulb, ListTree, PanelLeftClose, PanelLeftOpen, Plus, Settings2, Sparkles, Trash2, Undo2, Upload, X, Moon, Sun } from 'lucide-react';
import { ActionCancelled, ActionMenu, Dialog, Toast, SaveFeedbackContext, Field, Select, Empty, MultiPicker, uid, fire, colors, stageNames, statuses, assistTools, taskLabel, taskObjective, canResumeRun, characters, orderedChapters, orderedScenes, sceneFor, events, showValue, isAgentRun, isRunActive, runStatus, type Commit, type TaskDraft } from '../ui';
import type { Workspace, Command, ProjectSummary, NovelObject, ObjectType, NarrativeScene, AgentRun, ProviderSettings, ProviderInput, OperationBatch, RunRequest, FieldValue, SourceReference, AssistTool } from '../../shared/types';
import { canvasAction, type View, type AskAction, type RegisterFlush, type AssistAction, type OpenCanvas, type AskDelete } from '../types';

export function Reader({workspace:w,commit,jump,registerFlush,onPinSample}:{workspace:Workspace;commit:Commit;jump:(id:string)=>void;registerFlush:RegisterFlush;onPinSample:(sceneId:string,text:string)=>void}) {
  const [picked,setPicked]=useState<{sceneId:string;text:string}>();
  /** A selection inside one scene can become a style sample. */
  const pick=()=>{const selection=window.getSelection(),text=selection?.toString().trim()??'';const start=selection?.anchorNode?.parentElement?.closest<HTMLElement>('[data-scene-id]'),end=selection?.focusNode?.parentElement?.closest<HTMLElement>('[data-scene-id]');setPicked(text&&start&&start===end?{sceneId:start.dataset.sceneId!,text}:undefined);};
  const [settings,setSettings]=useState(w.reading);
  const chapters=orderedChapters(w),chapter=chapters.find(c=>c.id===settings.chapterId)||chapters[0];
  const [progress,setProgress]=useState(0);
  const scroll=useRef<HTMLDivElement>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const pending=useRef<{chapterId:string;scroll:number}|null>(null);
  const flushProgress=useCallback(async()=>{
    if(timer.current)clearTimeout(timer.current);
    const position=pending.current;if(!position)return;pending.current=null;
    try{await commit(current=>{
      const currentChapter=current.reading.chapterId||orderedChapters(current)[0]?.id;
      return current.id===w.id&&currentChapter===position.chapterId?[{type:'setReading',value:{...current.reading,...position}}]:[];
    },'阅读进度');}catch(error){if(!pending.current)pending.current=position;throw error;}
  },[w.id,commit]);
  useEffect(()=>{setSettings(w.reading);},[w.reading]);
  useEffect(()=>{registerFlush(flushProgress);return()=>{registerFlush(null);fire(flushProgress());};},[flushProgress,registerFlush]);
  useLayoutEffect(()=>{
    const element=scroll.current;if(!element)return;
    element.scrollTo({top:w.reading.chapterId===chapter?.id||!w.reading.chapterId?w.reading.scroll:0,behavior:'instant'});
    const measure=()=>setProgress(!chapter?0:element.scrollHeight<=element.clientHeight?100:Math.round(element.scrollTop/(element.scrollHeight-element.clientHeight)*100));
    measure();const observer=new ResizeObserver(measure);observer.observe(element);
    if(element.firstElementChild)observer.observe(element.firstElementChild);
    return()=>observer.disconnect();
  },[chapter?.id]);
  const update=(patch:Partial<typeof settings>)=>fire((async()=>{
    await flushProgress();
    setSettings(old=>({...old,...patch,chapterId:patch.chapterId||chapter?.id}));
    await commit(current=>[{type:'setReading',value:{...current.reading,...patch,chapterId:patch.chapterId||current.reading.chapterId||chapter?.id}}],'阅读偏好');
  })());
  const onScroll=()=>{
    const element=scroll.current;if(!element||!chapter)return;
    setProgress(element.scrollHeight<=element.clientHeight?100:Math.round(element.scrollTop/(element.scrollHeight-element.clientHeight)*100));
    if(timer.current)clearTimeout(timer.current);
    pending.current={chapterId:chapter.id,scroll:element.scrollTop};
    timer.current=setTimeout(()=>fire(flushProgress()),800);
  };
  const idx=chapters.findIndex(c=>c.id===chapter?.id);
  useEffect(()=>{
    const keydown=(event:KeyboardEvent)=>{
      if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||document.querySelector('dialog[open]'))return;
      if((event.target as HTMLElement|null)?.closest?.('input,select,textarea,[contenteditable="true"]'))return;
      const next=event.key==='ArrowLeft'?chapters[idx-1]:event.key==='ArrowRight'?chapters[idx+1]:undefined;
      if(!next||idx<0)return;
      event.preventDefault();update({chapterId:next.id,scroll:0});
    };
    window.addEventListener('keydown',keydown);return()=>window.removeEventListener('keydown',keydown);
  });
  return <div className={`reader-page ${settings.theme}`}><div className="reader-controls"><Select ariaLabel="阅读章节" value={chapter?.id||''} onChange={chapterId=>update({chapterId,scroll:0})}>{chapters.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</Select><div className="button-row"><button disabled={settings.fontSize<=14} onClick={()=>update({fontSize:Math.max(14,settings.fontSize-1)})} aria-label="缩小字号">A−</button><span>{settings.fontSize}px</span><button disabled={settings.fontSize>=32} onClick={()=>update({fontSize:Math.min(32,settings.fontSize+1)})} aria-label="放大字号">A＋</button><select value={settings.lineHeight} aria-label="行距" onChange={e=>update({lineHeight:Number(e.target.value)})}><option value={1.6}>紧凑行距</option><option value={1.9}>舒适行距</option><option value={2.2}>宽松行距</option></select>{picked&&<button data-testid="reader-pin-sample" title="把选中的文字加入范文库" onClick={()=>{onPinSample(picked.sceneId,picked.text);setPicked(undefined);window.getSelection()?.removeAllRanges();}}><BookMarked size={16}/>设为范文（{picked.text.length.toLocaleString()} 字）</button>}<button aria-pressed={settings.theme==='dark'} onClick={()=>update({theme:settings.theme==='paper'?'dark':'paper'})}>{settings.theme==='paper'?<><Moon size={16}/>夜读</>:<><Sun size={16}/>浅色</>}</button></div></div><div className="reader-scroll" ref={scroll} onScroll={onScroll}>{chapter?<article style={{fontSize:settings.fontSize,lineHeight:settings.lineHeight}} onMouseUp={pick} onKeyUp={pick}><div className="reading-book-title">{w.title}</div><h2>{chapter.title}</h2>{w.scenes.filter(s=>s.chapterId===chapter.id).sort((a,b)=>a.order-b.order).map((s,i)=><section className="reading-scene" key={s.id} data-scene-id={s.id}>{i>0&&<div className="scene-separator">· · ·</div>}<button className="jump-scene" onClick={()=>jump(s.id)} title="跳回场景编辑"><FileText size={14}/>{s.title}</button>{s.text?s.text.split(/\n/).map((p,j)=>p.trim()?<p key={j}>{p}</p>:<div className="paragraph-gap" key={j}/>):<p className="muted">这一幕的故事，还在等待落笔。</p>}</section>)}<div className="reader-chapter-nav"><button disabled={idx<=0} title="上一章（←）" onClick={()=>update({chapterId:chapters[idx-1]?.id,scroll:0})}><ArrowLeft size={16}/>上一章</button><button disabled={idx>=chapters.length-1} title="下一章（→）" onClick={()=>update({chapterId:chapters[idx+1]?.id,scroll:0})}>下一章<ArrowRight size={16}/></button></div></article>:<Empty title="这里将成为你的作品" description="创建章节并写下正文，就能从读者的角度阅读它。"/>}</div><div className="reader-progress"><span>当前作品 · {chapter?.title||'暂无章节'}</span><div role="progressbar" aria-label="当前章阅读进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><i style={{width:`${progress}%`}}/></div><span>{progress}%</span></div></div>;
}
