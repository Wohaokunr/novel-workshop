import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Check, ChevronRight, ChevronsUpDown, CircleAlert, Feather, FileText, PenTool, History, LayoutDashboard, Moon, Sun, Lightbulb, ListTree, PanelLeftClose, PanelLeftOpen, PanelRight, Plus, Search, Settings2, Sparkles, Undo2, Upload, X } from 'lucide-react';
import Board from './Board';
import Assistant, { TaskOutcome } from './Assistant';
import AgentTask, { type AgentMemoryActions, type AgentTaskActions } from './AgentTask';
import { ActionCancelled, Dialog, Toast, SaveFeedbackContext, Empty, Kbd, uid, fire, assistTools, taskObjective, CONTINUE_OBJECTIVE, canResumeRun, orderedChapters, orderedPassages, orderedScenes, passageFor, sceneChapters, events, isAgentRun, isRunActive, type Commit, type TaskDraft } from './ui';
import { useMediaQuery, useModalFocus } from './interaction';
import type { Workspace, Command, ProjectSummary, NovelObject, ObjectType, NarrativeScene, Passage, AgentRun, ProviderSettings, ProviderInput, OperationBatch, RunRequest, FieldValue, SourceReference, AssistTool } from '../shared/types';
import type { AgentDecision, AgentMemory, AgentSession } from '../shared/agent-types';

import type { View, AskAction, RegisterFlush, AssistAction, OpenCanvas, AskDelete, SaveState } from './types';
import { Home } from './pages/Home';
import { Objects } from './pages/Objects';
import { Writer } from './pages/Writer';
import { Reader } from './pages/Reader';
import { Monitor } from './pages/Monitor';
import { Settings } from './pages/Settings';
import { ObjectForm, SceneForm } from './forms';
import CommandPalette from './CommandPalette';
import { CompanionProvider, useCompanion } from './Companion';
import { Outline } from './pages/Outline';
import { Style } from './pages/Style';
import { accents, setAppearance, toggleTheme, useAppearance } from './appearance';
import { STYLE_LIMITS, styleProfile } from '../shared/style-types';
import { newChapter, passageLabel, passageOrderAt, scenePassages } from '../shared/structure';
const nav = [
  { view: 'home', label: '作品概览', icon: LayoutDashboard },
  { view: 'canvas', label: '构思', icon: Lightbulb },
  { view: 'world', label: '情节规划', icon: ListTree },
  { view: 'write', label: '正文写作', icon: FileText },
  { view: 'reader', label: '阅读', icon: BookOpen },
  { view: 'style', label: '文风', icon: PenTool },
] as const;
const viewTitles: Record<View, string> = { home: '作品概览', objects: '人物与设定', canvas: '灵感画布', outline: '大纲', world: '世界因果', story: '叙述顺序', write: '正文写作', reader: '阅读', monitor: '创作记录', settings: '设置', style: '文风' };
/** Lets App, which renders the provider, reach the partner API from outside the tree. */
function CompanionBridge({ apiRef }: { apiRef: React.MutableRefObject<ReturnType<typeof useCompanion> | null> }) { apiRef.current = useCompanion(); return null; }
const freshTask = (): TaskDraft => ({ stage: 'agent', tool: 'canvas', objective: '', references: [], chapterScope: 'scene' });
export default function App() {
  const [projects,setProjects] = useState<ProjectSummary[]>([]);
  const [workspace,setWorkspace] = useState<Workspace|null>(null);
  const workspaceRef = useRef<Workspace|null>(null);
  const [view,setView] = useState<View>('home');
  const [runs,setRuns] = useState<AgentRun[]>([]);
  const runsRef = useRef<AgentRun[]>([]);
  const receiveRuns = useCallback((values: AgentRun[])=>{runsRef.current=values;setRuns(values);},[]);
  const reloadingRuns = useRef(new Map<string,Promise<void>>());
  const [agentBusy,setAgentBusy] = useState('');
  const agentActionRef = useRef('');
  const [memories,setMemories] = useState<AgentMemory[]>([]);
  const [session,setSession] = useState<AgentSession|null>(null);
  const [memoryLoading,setMemoryLoading] = useState(false);
  const [memoryBusy,setMemoryBusy] = useState(false);
  const [memoryError,setMemoryError] = useState('');
  const memoryRequest = useRef(0);
  const memoryActionRef = useRef(false);
  const [history,setHistory] = useState<OperationBatch[]>([]);
  const [provider,setProvider] = useState<ProviderSettings|null>(null);
  const [notice,setNotice] = useState<{id:string;text:string;error:boolean;undoId?:string;action?:{label:string;run:()=>void}}|null>(null);
  const companionApi = useRef<ReturnType<typeof useCompanion>|null>(null);
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [projectTitle,setProjectTitle] = useState('');
  const [projectGenre,setProjectGenre] = useState('');
  const [projectIdea,setProjectIdea] = useState('');
  const [projectSample,setProjectSample] = useState('');
  const [creating,setCreating] = useState(false);
  const [selectedObject,setSelectedObject] = useState('');
  const [selectedScene,setSelectedScene] = useState('');
  /** The passage open in the writer; selectedScene is the scene the boards and details show. */
  const [selectedPassage,setSelectedPassage] = useState('');
  const [selectedCard,setSelectedCard] = useState('');
  const [confirm,setConfirm] = useState<{title:string;message:string;act:()=>Promise<void>;cancel?:()=>void;confirmLabel:string;danger?:boolean}|null>(null);
  const [task,setTask] = useState<TaskDraft>(freshTask);
  const [selection,setSelection] = useState<{passageId:string;start:number;end:number;text:string}|undefined>();
  const [selectedRun,setSelectedRun] = useState('');
  const [navCollapsed,setNavCollapsed] = useState(false);
  const [inspectorOpen,setInspectorOpen] = useState(false);
  const [aiOpen,setAiOpen] = useState(false);
  const [aiTab,setAiTab] = useState<'chat'|'task'|'memory'>('task');
  // Like the former panel-local state: a closed assistant reopens on the task tab unless a caller picks another.
  useEffect(()=>{if(!aiOpen)setAiTab('task');},[aiOpen]);
  const [paletteOpen,setPaletteOpen] = useState(false);
  const appearance = useAppearance();
  const [focusMode,setFocusMode] = useState(false);
  const [dismissedRun,setDismissedRun] = useState('');
  const [inspectorHost,setInspectorHost] = useState<HTMLDivElement|null>(null);
  const aiOpener = useRef<HTMLElement|null>(null);
  const inspectorOpener = useRef<HTMLElement|null>(null);
  const aiRef = useRef<HTMLElement|null>(null);
  const inspectorRef = useRef<HTMLElement|null>(null);
  const aiDrawer = useMediaQuery('(max-width: 1439px)');
  const inspectorDrawer = useMediaQuery('(max-width: 1099px)');
  useModalFocus(aiRef, aiOpen&&aiDrawer, aiOpener);
  useModalFocus(inspectorRef, inspectorOpen&&inspectorDrawer&&!(aiOpen&&aiDrawer), inspectorOpener);
  const [saveReports,setSaveReports] = useState<Record<string,SaveState>>({});
  const saveReportsRef = useRef<Record<string,SaveState>>({});
  const fieldSaves = useRef(new Map<string,Promise<unknown>>());
  const [pendingSaves,setPendingSaves] = useState(0);
  const [saveError,setSaveError] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const closing = useRef(false);
  const draftFlusher = useRef<(() => Promise<void>) | null>(null);
  const registerFlush = useCallback<RegisterFlush>(flush=>{draftFlusher.current=flush;},[]);
  const reportSave = useCallback((id:string,status:SaveState|null,pending?:Promise<unknown>)=>{
    if(pending){fieldSaves.current.set(id,pending);void pending.finally(()=>{if(fieldSaves.current.get(id)===pending)fieldSaves.current.delete(id);}).catch(()=>{});}
    if(saveReportsRef.current[id]===status||(!status&&!(id in saveReportsRef.current)))return;
    if(!status&&['error','conflict'].includes(saveReportsRef.current[id]))setSaveError(false);
    const next={...saveReportsRef.current};if(status)next[id]=status;else delete next[id];
    saveReportsRef.current=next;setSaveReports(next);
  },[]);
  const receive = useCallback((value: Workspace)=>{ workspaceRef.current=value;setWorkspace(value); },[]);
  const notify = useCallback((text:string,error=false,undoId?:string)=>setNotice({id:uid(),text,error,undoId}),[]);
  const dismissNotice = useCallback(()=>setNotice(null),[]);
  const failure = useCallback((error:unknown)=>{if(!(error instanceof ActionCancelled))notify(error instanceof Error?error.message:String(error),true);},[notify]);
  const protect = useCallback(async <T,>(work:()=>Promise<T>):Promise<T>=>{try{return await work();}catch(e){failure(e);throw e;}},[failure]);
  const enqueue = useCallback(<T,>(action:()=>Promise<T>)=>{
    const work=queue.current.catch(()=>{}).then(action);queue.current=work;
    void work.catch(()=>{if(queue.current===work)queue.current=Promise.resolve();});
    return protect(()=>work);
  },[protect]);
  const flushEdits = useCallback(async()=>{
    (document.activeElement as HTMLElement|null)?.blur();
    while(fieldSaves.current.size)await Promise.all([...fieldSaves.current.values()]);
    await draftFlusher.current?.();await queue.current;
    if(Object.values(saveReportsRef.current).some(status=>status==='error'||status==='conflict'))throw new Error('有修改尚未保存，请先修正提示的问题；当前草稿已保留。');
  },[]);
  /** Details and AI are independent: both dock side by side on wide windows; drawers never stack. */
  const showPanel = (panel:'details'|'ai',opener=document.activeElement as HTMLElement|null)=>{
    const ref=panel==='ai'?aiOpener:inspectorOpener;
    if(opener&&opener!==document.body&&!opener.closest('.context-panel,.inspector-panel'))ref.current=opener;
    if(panel==='ai'){setAiOpen(true);if(inspectorDrawer)setInspectorOpen(false);}
    else{setInspectorOpen(true);if(aiDrawer)setAiOpen(false);}
  };
  const closePanel = (panel:'details'|'ai')=>fire(protect(async()=>{
    await flushEdits();
    if(panel==='ai')setAiOpen(false);else setInspectorOpen(false);
    const opener=panel==='ai'?aiOpener:inspectorOpener;
    requestAnimationFrame(()=>{if(opener.current?.isConnected&&!opener.current.closest('[inert]'))opener.current.focus({preventScroll:true});});
  }));
  const switchPanel=(panel:'details'|'ai')=>{
    const opener=document.activeElement as HTMLElement|null;
    fire(protect(async()=>{await flushEdits();showPanel(panel,opener);}));
  };
  const togglePanel=(panel:'details'|'ai')=>(panel==='ai'?aiOpen:inspectorOpen)?closePanel(panel):switchPanel(panel);
  const selectEntity=(select:(id:string)=>void,id:string)=>fire(protect(async()=>{await flushEdits();select(id);if(id)showPanel('details');}));
  useEffect(()=>{
    const keydown=(event:KeyboardEvent)=>{
      if(event.defaultPrevented||document.querySelector('dialog[open]'))return;
      const within=(ref:React.RefObject<HTMLElement|null>)=>!!ref.current?.contains(document.activeElement);
      if(event.key==='Escape'){
        if(aiOpen&&(aiDrawer||within(aiRef))){event.preventDefault();closePanel('ai');}
        else if(inspectorOpen&&(inspectorDrawer||within(inspectorRef))){event.preventDefault();closePanel('details');}
        else if(focusMode){event.preventDefault();setFocusMode(false);}
        return;
      }
      if(view==='write'&&event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&(event.key==='ArrowUp'||event.key==='ArrowDown')){
        const current=workspaceRef.current;if(!current)return;
        event.preventDefault();
        const list=orderedPassages(current),index=list.findIndex(passage=>passage.id===passageFor(current,selectedPassage)?.id),next=list[index+(event.key==='ArrowDown'?1:-1)];
        if(next)selectPassage(next.id);
        return;
      }
      if(!(event.ctrlKey||event.metaKey)||event.altKey)return;
      const key=event.key.toLowerCase();
      if(key==='s'&&!event.shiftKey){
        event.preventDefault();
        // flushEdits blurs to commit Field drafts; return the caret so saving does not interrupt typing.
        const active=document.activeElement as HTMLElement|null;
        fire(protect(async()=>{await flushEdits();if(active?.isConnected&&active!==document.body&&!active.closest('[inert]'))active.focus({preventScroll:true});notify('已保存到本机。');}));
      }
      else if(key==='k'){event.preventDefault();setPaletteOpen(true);}
      else if(key==='j'){event.preventDefault();togglePanel('ai');}
      else if(key==='i'&&!event.shiftKey){event.preventDefault();togglePanel('details');}
      else if(key==='\\'){event.preventDefault();setNavCollapsed(value=>!value);}
      else if(key==='f'&&event.shiftKey&&view==='write'){event.preventDefault();setFocusMode(value=>!value);}
      else if(/^[1-6]$/.test(event.key)&&!event.shiftKey&&workspaceRef.current){event.preventDefault();navigate(nav[Number(event.key)-1].view);}
    };
    window.addEventListener('keydown',keydown);return()=>window.removeEventListener('keydown',keydown);
  });
  useEffect(()=>window.novel.onCloseRequested(()=>{
    if(closing.current)return;
    closing.current=true;
    fire(protect(async()=>{
      await flushEdits();
      await window.novel.confirmClose();
    }).finally(()=>{closing.current=false;}));
  }),[protect,flushEdits]);
  const navigate = (next:View,focusTarget?:string)=>{
    const opener=document.activeElement as HTMLElement|null;
    fire(protect(async()=>{
      await flushEdits();setView(next);setInspectorOpen(false);if(next==='reader'||aiDrawer)setAiOpen(false);if(next!=='write')setFocusMode(false);
      requestAnimationFrame(()=>{
        const target=focusTarget?document.getElementById(focusTarget):opener?.isConnected&&opener!==document.body?opener:document.querySelector<HTMLElement>('.page-heading h1');
        if(target&&!target.closest('[inert]'))target.focus({preventScroll:true});
      });
    }));
  };
  const choosePassage = async(id:string)=>{
    setBusy(true);
    try{
      await flushEdits();
      const passage=workspaceRef.current?.passages.find(item=>item.id===id);
      if(!passage)throw new Error('这一段已被删除。');
      setSelectedPassage(id);setSelectedScene(passage.sceneId);setSelection(undefined);
    }finally{setBusy(false);}
  };
  const selectPassage = (id:string)=>fire(protect(()=>choosePassage(id)));
  /** A scene opens in the writer at the passage already open, when it is one of the scene's, else at its first passage. */
  const passageOfScene = (current:Workspace,sceneId:string)=>{const parts=scenePassages(current,sceneId);return parts.find(item=>item.id===selectedPassage)??parts[0];};
  const refreshDetails = useCallback(async(id:string)=>{const [h,p]=await Promise.all([window.novel.history(id),window.novel.listProjects()]);if(workspaceRef.current?.id===id)setHistory(h);setProjects(p);},[]);
  const reloadRuns = useCallback((id:string):Promise<void>=>{
    const pending=reloadingRuns.current.get(id);if(pending)return pending;
    const work=protect(async()=>{
      const snapshots=await window.novel.getRuns(id);if(workspaceRef.current?.id!==id)return;
      const current=runsRef.current;
      const merged=snapshots.map(snapshot=>{
        const newer=current.find(run=>run.id===snapshot.id);
        return newer?.eventVersion!==undefined&&(snapshot.eventVersion===undefined||newer.eventVersion>snapshot.eventVersion)?newer:snapshot;
      });
      receiveRuns([...current.filter(run=>!snapshots.some(snapshot=>snapshot.id===run.id)),...merged]);
    }).finally(()=>{if(reloadingRuns.current.get(id)===work)reloadingRuns.current.delete(id);});
    reloadingRuns.current.set(id,work);return work;
  },[protect,receiveRuns]);
  const loadAgentContext = useCallback((id:string)=>protect(async()=>{
    const request=++memoryRequest.current;setMemoryLoading(true);setMemoryError('');
    try{
      const [nextSession,nextMemories]=await Promise.all([window.novel.getSession(id),window.novel.getMemories(id)]);
      if(workspaceRef.current?.id===id&&request===memoryRequest.current){setSession(nextSession);setMemories(nextMemories);}
    }catch(error){
      if(workspaceRef.current?.id===id&&request===memoryRequest.current)setMemoryError(error instanceof Error?error.message:String(error));
      throw error;
    }finally{if(request===memoryRequest.current)setMemoryLoading(false);}
  }),[protect]);
  useEffect(()=>{if(workspace?.id&&aiOpen)fire(loadAgentContext(workspace.id));},[workspace?.id,aiOpen,loadAgentContext]);
  const resetProjectUI=useCallback(()=>{
    setSelectedObject('');setSelectedScene('');setSelectedPassage('');setSelectedCard('');setSelection(undefined);setSelectedRun('');
    setTask(freshTask());setInspectorOpen(false);setAiOpen(false);setFocusMode(false);setDismissedRun('');setView('home');setSaveError(false);setNotice(null);
    ++memoryRequest.current;setMemories([]);setSession(null);setMemoryLoading(false);setMemoryError('');
    saveReportsRef.current={};setSaveReports({});
  },[]);
  const openProject = useCallback(async(id:string)=>{await flushEdits();const [w,r]=await protect(()=>Promise.all([window.novel.loadProject(id),window.novel.getRuns(id)]));receive(w);receiveRuns(r);resetProjectUI();await protect(()=>refreshDetails(id));},[flushEdits,protect,receive,receiveRuns,resetProjectUI,refreshDetails]);
  const commit:Commit = useCallback((commands,label='人工编辑')=>{
    const projectId=workspaceRef.current?.id;
    setPendingSaves(count=>count+1);
    return enqueue(async()=>{
      const current=workspaceRef.current;if(!current||current.id!==projectId)throw new Error('作品已切换，请在当前作品中重新操作。');
      const values=typeof commands==='function'?commands(current):commands;
      if(!values.length)return current;
      const next=await window.novel.execute({projectId:current.id,expectedRevision:current.revision,commands:values,actor:'human',label});
      if(workspaceRef.current?.id===next.id)receive(next);
      setSaveError(false);
      await refreshDetails(next.id);return next;
    }).catch(error=>{setSaveError(true);throw error;}).finally(()=>setPendingSaves(count=>count-1));
  },[enqueue,receive,refreshDetails]);
  useEffect(()=>{let alive=true;void (async()=>{try{const [p,s]=await Promise.all([window.novel.listProjects(),window.novel.getProvider()]);if(!alive)return;setProjects(p);setProvider(s);if(p.length)await openProject(p[0].id);}catch(e){if(alive)failure(e);}finally{if(alive)setLoading(false);}})();return()=>{alive=false;};},[openProject,failure]);
  useEffect(()=>window.novel.onAgentEvent(event=>{
    if(event.projectId!==workspaceRef.current?.id)return;
    const old=runsRef.current;
    const previous=old.find(run=>run.id===event.runId);
    if(event.type==='run'&&event.run){
      const version=event.version??event.run.eventVersion;
      if(version!==undefined&&previous?.eventVersion!==undefined&&version<=previous.eventVersion)return;
      const snapshot={...event.run,...(version!==undefined?{eventVersion:version}:{})};
      receiveRuns([snapshot,...old.filter(run=>run.id!==snapshot.id)]);
    }else if(event.type==='delta'){
      if(event.version!==undefined&&previous?.eventVersion!==undefined&&event.version<=previous.eventVersion)return;
      const step=previous?.steps.find(step=>step.id===event.stepId);
      const resync=()=>fire(reloadRuns(event.projectId));
      if(!previous||!step||typeof event.delta!=='string'){resync();return;}
      if(event.version!==undefined&&previous.eventVersion!==undefined&&event.version>previous.eventVersion+1){resync();return;}
      const offset=event.offset;
      if(offset!==undefined){
        if(!Number.isSafeInteger(offset)||offset<0||offset>step.output.length){resync();return;}
        if(offset<step.output.length){
          if(offset+event.delta.length>step.output.length||step.output.slice(offset,offset+event.delta.length)!==event.delta){resync();return;}
          // A newer envelope can describe text already present in a full snapshot.
          if(event.version!==undefined)receiveRuns(old.map(run=>run.id===previous.id?{...run,eventVersion:event.version}:run));
          return;
        }
      }else if(previous.runtime){resync();return;}
      receiveRuns(old.map(run=>run.id===previous.id?{...run,...(event.version!==undefined?{eventVersion:event.version}:{}),steps:run.steps.map(item=>item.id===step.id?{...item,output:item.output+event.delta}:item)}:run));
    }else if(event.type==='projectChanged'){
      fire(enqueue(async()=>{
        if(workspaceRef.current?.id!==event.projectId)return;
        const next=await window.novel.loadProject(event.projectId);
        if(workspaceRef.current?.id===next.id){receive(next);await refreshDetails(next.id);}
      }));
    }
  }),[receive,receiveRuns,refreshDetails,enqueue,reloadRuns]);
  const askDelete:AskDelete = async(command,title)=>{
    const current=workspaceRef.current;if(!current)return;
    const commands=Array.isArray(command)?command:[command];
    const impact=[...new Set((await protect(()=>Promise.all(commands.map(item=>window.novel.deleteImpact(current.id,item))))).flat())];
    setConfirm({title,message:`${impact.length?`将影响：${impact.join('；')}。`:''}删除会保存到修改历史，可以撤销。`,confirmLabel:'确认删除',danger:true,act:async()=>{
      if(workspaceRef.current?.id!==current.id)throw new Error('作品已切换，请重新选择要删除的内容。');
      const before=new Set((await window.novel.history(current.id)).map(batch=>batch.id));
      await commit(commands,title);
      const batch=(await window.novel.history(current.id)).find(batch=>!before.has(batch.id)&&batch.label===title);
      notify('内容已删除。',false,batch?.id);
    }});
  };
  const askAction:AskAction = (title,message,action)=>new Promise((resolve,reject)=>setConfirm({title,message,confirmLabel:'确认修改',act:async()=>{try{resolve(await action());}catch(error){reject(error);throw error;}},cancel:()=>reject(new ActionCancelled())}));
  const create = async()=>{
    const title=projectTitle.trim();if(!title)return;setBusy(true);
    try{
      await flushEdits();let w=await protect(()=>window.novel.createProject(title));
      const patch={...(projectGenre.trim()?{genre:projectGenre.trim()}:{}),...(projectIdea.trim()?{brief:projectIdea.trim()}:{})};
      if(Object.keys(patch).length)w=await protect(()=>window.novel.execute({projectId:w.id,expectedRevision:w.revision,actor:'human',label:'填写作品信息',commands:[{type:'updateNovel',patch}]}));
      const sample=projectSample.trim().slice(0,STYLE_LIMITS.sampleChars);
      if(sample){const created=w;w=await protect(()=>window.novel.execute({projectId:created.id,expectedRevision:created.revision,actor:'human',label:'添加范文',commands:[{type:'updateStyle',patch:{samples:[{id:uid(),label:'我的文字',text:sample,source:'own'}]}}]}));}
      receive(w);receiveRuns([]);resetProjectUI();setCreating(false);setProjectTitle('');setProjectGenre('');setProjectIdea('');setProjectSample('');await refreshDetails(w.id);
      setNotice({id:uid(),error:false,text:Object.keys(patch).length?'新作品已创建。要不要让 AI 根据这些信息推断立意，再补全其他作品信息？':'新作品已创建，先写下你的故事想法。',
        ...(Object.keys(patch).length?{action:{label:'AI 帮我补全',run:()=>{setNotice(null);companionApi.current?.summon({mode:'develop',label:'作品信息',anchor:{surface:'panel',references:[],focus:'profile'},message:'根据我已经填写的信息，推断并补全作品信息里还空着的部分；信息不够就先问我几个选择题。'});}}}:{})});
    }finally{setBusy(false);}
  };
  const restore=()=>protect(async()=>{await flushEdits();const w=await window.novel.importProject();if(w){await openProject(w.id);notify('备份已恢复为独立作品。');}});
  const patchObject = (id:string,patch:Partial<NovelObject>)=>commit(w=>{const value=w.objects.find(o=>o.id===id);return value?[{type:'putObject',value:{...value,...patch}}]:[];});
  const patchScene = (id:string,patch:Partial<NarrativeScene>)=>commit(w=>{const value=w.scenes.find(s=>s.id===id);return value?[{type:'putScene',value:{...value,...patch}}]:[];});
  const addObject = async(typeId?:string,isEvent=false,position?:{x:number;y:number})=>{await protect(flushEdits);if(!workspace)return;const id=uid();const tid=typeId||workspace.objectTypes.find(t=>t.id==='event')?.id||workspace.objectTypes[0]?.id;if(!tid){notify('请先创建一个对象类型。',true);return;}await commit(w=>[
    {type:'putObject',value:{id,typeId:tid,name:isEvent?'新的世界事件':'未命名对象',fields:{},...(isEvent||tid==='event'?{event:{worldOrder:Math.max(0,...events(w).map(o=>o.event!.worldOrder))+1,timeLabel:'',thread:'主线',participants:[],causes:[],critical:false,observations:{}}}:{})}},
    ...(position?[{type:'setLayout' as const,key:`world:${id}`,value:position}]:[]),
  ]);setSelectedObject(id);showPanel('details');return id;};
  /** A new chapter at the end of the book, in the last chapter's volume. */
  const addChapter = async()=>{const id=uid();await commit(w=>[{type:'putChapter',value:newChapter(w,id)}]);return id;};
  /** A new scene, opened in a chapter as its first (empty) passage: the given chapter, else the last one. */
  const createScene = async(chapterId?:string,position?:{x:number;y:number})=>{
    await flushEdits();
    const current=workspaceRef.current;if(!current)return;
    const cid=chapterId||orderedChapters(current).at(-1)?.id||await addChapter();const id=uid(),passageId=uid();
    await commit(w=>[
      {type:'putScene',value:{id,title:'新的场景',povId:null,eventIds:[],outline:''}},
      {type:'putPassage',value:{id:passageId,sceneId:id,chapterId:cid,order:passageOrderAt(w,cid),text:''}},
      ...(position?[{type:'setLayout' as const,key:`story:${id}`,value:position}]:[]),
    ]);
    setSelectedScene(id);setSelectedPassage(passageId);setSelection(undefined);return {sceneId:id,passageId};
  };
  const addScene = (chapterId?:string,position?:{x:number;y:number})=>protect(async()=>(await createScene(chapterId,position))?.sceneId);
  const addPassageScene = (chapterId?:string)=>protect(async()=>(await createScene(chapterId))?.passageId);
  const activeRun = runs.find(isRunActive);
  const isBoard = view==='canvas'||view==='world'||view==='story';
  const changeInspector = (open:boolean)=>{if(open)switchPanel('details');else closePanel('details');};
  const openReference = (kind:SourceReference['kind'],id:string)=>fire(protect(async()=>{
    await flushEdits();const w=workspaceRef.current;if(!w)return;
    if(kind==='card'){if(!w.cards.some(c=>c.id===id))throw new Error('这张卡片已被删除。');setSelectedCard(id);setView('canvas');showPanel('details');}
    else if(kind==='object'){const object=w.objects.find(o=>o.id===id);if(!object)throw new Error('这个对象已被删除。');setSelectedObject(id);setView(object.event?'world':'objects');showPanel('details');}
    else{
      if(!w.scenes.some(s=>s.id===id))throw new Error('这个场景已被删除。');
      const passage=passageOfScene(w,id);
      setSelectedScene(id);setSelection(undefined);
      // A scene not placed in any chapter has nothing to write yet: its details show where to place it.
      if(passage){setSelectedPassage(passage.id);setView('write');setInspectorOpen(false);if(aiDrawer)setAiOpen(false);}
      else{setView('story');showPanel('details');}
    }
  }));
  /** Open one passage in the writer, e.g. where the reader or the scene details point. */
  const openPassage = (id:string)=>fire(protect(async()=>{
    await flushEdits();const passage=workspaceRef.current?.passages.find(item=>item.id===id);
    if(!passage)throw new Error('这一段已被删除。');
    setSelectedPassage(id);setSelectedScene(passage.sceneId);setSelection(undefined);setView('write');setInspectorOpen(false);if(aiDrawer)setAiOpen(false);
  }));
  const prepareTask = (stage:RunRequest['stage'],references:SourceReference[]=[],tool:AssistTool='canvas',chapterScope:'scene'|'chapter'='scene')=>{
    const opener=document.activeElement as HTMLElement|null;
    fire(protect(async()=>{
      setBusy(true);
      try{
        await flushEdits();const current=workspaceRef.current;if(!current)return;
        const ref=references.find(ref=>ref.kind==='scene'||(ref.kind==='card'&&current.cards.find(card=>card.id===ref.id)?.kind==='scene'));
        const sceneId=ref?.kind==='scene'?ref.id:ref?current.cards.find(card=>card.id===ref.id)?.refId:undefined;
        // Drafting a scene writes its passage still without prose (the selected one first), e.g. the part that goes on in the next chapter.
        const blank=stage==='chapter'&&sceneId?scenePassages(current,sceneId).filter(item=>!item.text.trim()):[];
        const passage=sceneId?blank.find(item=>item.id===selectedPassage)??blank[0]??passageOfScene(current,sceneId):passageFor(current,selectedPassage);
        setTask({stage,tool,objective:taskObjective(stage,tool,chapterScope),references,chapterScope,
          ...((stage==='chapter'||stage==='rewrite')?{passageId:passage?.id}:{}),
          ...(stage==='rewrite'&&selection&&passage&&selection.passageId===passage.id&&selection.end>selection.start?{selection:{start:selection.start,end:selection.end,text:selection.text}}:{}),
        });setDismissedRun(runsRef.current.find(isRunActive)?.id??runsRef.current[0]?.id??'');setAiTab('task');showPanel('ai',opener);
      }finally{setBusy(false);}
    }));
  };
  const prepareStage = (next:RunRequest['stage'],sources:SourceReference[])=>prepareTask(next,sources);
  /** One click from the writer: write the empty scene, or continue the prose at the cursor (the end of the scene when there is none),
   * without stopping at the task form. The task still ends with the author approving the candidate. */
  const quickWrite = (mode:'scene'|'continue')=>fire(protect(async()=>{
    await flushEdits();const current=workspaceRef.current,passage=current&&passageFor(current,selectedPassage);if(!current||!passage)return;
    const at=selection&&selection.passageId===passage.id&&selection.end<=passage.text.length?selection.end:passage.text.length;
    const references:SourceReference[]=[{kind:'scene',id:passage.sceneId}];
    const draft:TaskDraft=mode==='scene'?{stage:'chapter',tool:'canvas',objective:taskObjective('chapter'),references,chapterScope:'scene',passageId:passage.id}
      :{stage:'rewrite',tool:'canvas',objective:CONTINUE_OBJECTIVE,references,chapterScope:'scene',passageId:passage.id,selection:{start:at,end:at,text:''}};
    setTask(draft);setAiTab('task');
    await start(draft);
  }));
  const prepareAssist:AssistAction = (tool,sources)=>prepareTask('assist',sources,tool);
  const openMonitor = (id:string)=>{setSelectedRun(id);navigate('monitor');};
  const openCanvas:OpenCanvas = (kind,id)=>fire(protect(async()=>{
    await flushEdits();const current=workspaceRef.current;if(!current)return;
    const entity=(kind==='object'?current.objects:current.scenes).find(item=>item.id===id);
    if(!entity)throw new Error('引用内容已删除。');
    let card=current.cards.find(item=>item.kind===kind&&item.refId===id);
    if(!card){
      card={id:uid(),kind,refId:id,title:'name' in entity?entity.name:entity.title,content:'',x:Math.max(0,...current.cards.map(item=>item.x+(item.width||218)))+60,y:80};
      await commit([{type:'putCard',value:card}],'添加到构思画布');
    }
    openReference('card',card.id);
  }));
  const start = (override?:TaskDraft)=>{const draft=override??task;return protect(async()=>{
    setBusy(true);
    try{
      await flushEdits();const current=workspaceRef.current;if(!current)return;
      if(runsRef.current.some(isRunActive))throw new Error('当前任务尚未结束，请先恢复、审批、回答或停止任务。');
      if(!draft.objective.trim())throw new Error('请填写本次创作目标。');
      const passage=current.passages.find(item=>item.id===draft.passageId);
      for(const ref of draft.references){const collection=ref.kind==='card'?current.cards:ref.kind==='object'?current.objects:current.scenes;if(!collection.some(item=>item.id===ref.id))throw new Error('引用资料已被删除，请移除失效引用后再开始。');}
      if((draft.stage==='chapter'||draft.stage==='rewrite')&&!passage)throw new Error('请先选择有效的目标场景。');
      if(draft.stage==='chapter'&&(draft.chapterScope==='scene'?!!passage!.text.trim():!current.passages.some(item=>item.chapterId===passage!.chapterId&&!item.text.trim())))throw new Error('目标已有正文，请选择空白场景，或选中文字进行改写。');
      if(draft.stage==='rewrite'&&(!draft.selection||passage!.text.slice(draft.selection.start,draft.selection.end)!==draft.selection.text))throw new Error('选段已变化，请在正文中重新选取文字并准备改写。');
      const run=await window.novel.startRun({
        projectId:current.id,stage:draft.stage,
        objective:draft.objective.trim(),
        ...((draft.stage==='chapter'||draft.stage==='rewrite')?{chapterId:passage!.chapterId}:{}),
        ...(draft.stage==='assist'?{tool:draft.tool}:{}),references:draft.references,
        ...(draft.stage==='chapter'&&draft.chapterScope==='scene'?{passageId:passage!.id}:{}),
        ...(draft.stage==='rewrite'?{passageId:passage!.id,selection:{start:draft.selection!.start,end:draft.selection!.end}}:{}),
      });
      if(workspaceRef.current?.id!==run.projectId)return;
      const existing=runsRef.current.find(item=>item.id===run.id);
      if(!existing||((run.eventVersion??-1)>(existing.eventVersion??-1)))receiveRuns([run,...runsRef.current.filter(item=>item.id!==run.id)]);
      setSelectedRun(run.id);setAiTab('task');showPanel('ai');
      notify(provider?.mode==='mock'?'演示任务已启动，不会连接真实模型；正式写入前仍需审批。':'任务已启动；候选生成后由你审批，批准前不会写入作品。');
    }finally{setBusy(false);}
  });};
  const undo = (id:string)=>protect(async()=>{await flushEdits();const current=workspaceRef.current;if(!current)return;const next=await window.novel.undo(current.id,id);receive(next);await refreshDetails(next.id);notify('修改已撤销。');});
  const retry = (id:string)=>protect(async()=>{
    await flushEdits();
    const previous=runsRef.current.find(r=>r.id===id);if(!previous)throw new Error('找不到任务');
    if(isAgentRun(previous)){
      // Continues from the checkpoint; changes the author already approved stay in the work.
      if(previous.status!=='failed'||!previous.finishedAt)throw new Error('只有失败的任务可以从检查点重试；暂停的任务请使用恢复。');
      const current=await window.novel.loadProject(previous.projectId);
      if(workspaceRef.current?.id!==current.id)throw new Error('作品已切换，请在原作品中重试。');
      const run=await window.novel.retryRun(id,current.revision);
      receiveRuns([run,...runsRef.current.filter(r=>r.id!==run.id)]);setSelectedRun(run.id);
      notify(run.id===id?'已从检查点继续：已完成的步骤、产出和候选直接沿用，只重做中断的部分。':'原检查点无法沿用（已清理，或工具版本、模型服务已变化），已按原目标新建任务。');
      return;
    }
    if(!['failed','cancelled'].includes(previous.status)||!previous.finishedAt)throw new Error('此任务不能重试。');
    const [current,batches]=await Promise.all([window.novel.loadProject(previous.projectId),window.novel.history(previous.projectId)]);
    const runAgain=()=>protect(async()=>{
      if(workspaceRef.current?.id!==current.id)throw new Error('作品已切换，请在原作品中重试。');
      const run=await window.novel.retryRun(id,current.revision);
      receive(await window.novel.loadProject(current.id));await refreshDetails(current.id);
      receiveRuns([run,...runsRef.current.filter(r=>r.id!==run.id)]);
    });
    if(batches.some(batch=>batch.taskId===id&&!batch.undone)){
      setConfirm({title:'撤销本次修改并重试',message:'重试会先撤销该任务已保存的修改，再重新创作。如有后续人工编辑冲突，将保留内容并停止重试。',confirmLabel:'撤销并重试',act:runAgain});
    }else await runAgain();
  });
  const runAgentAction = (id:string,action:(run:AgentRun)=>Promise<unknown>,message:string)=>protect(async()=>{
    if(agentActionRef.current)throw new Error('正在处理任务操作，请稍候。');
    agentActionRef.current=id;setAgentBusy(id);
    try{
      await flushEdits();
      const run=runsRef.current.find(item=>item.id===id);
      if(!run||run.projectId!==workspaceRef.current?.id||!isAgentRun(run))throw new Error('任务已变化，请在当前作品的任务记录中重新操作。');
      await action(run);
      await reloadRuns(run.projectId);
      if(workspaceRef.current?.id===run.projectId)notify(message);
    }finally{agentActionRef.current='';setAgentBusy('');}
  });
  const pauseAgent = (id:string)=>runAgentAction(id,async run=>{
    if(!['queued','running','awaitingApproval','awaitingInput'].includes(run.status))throw new Error('任务当前不在可暂停状态。');
    await window.novel.pauseRun(id);
  },'已请求暂停；正在进行的操作会在检查点收尾。');
  const doResumeAgent = (id:string,confirmUncertain=false)=>runAgentAction(id,async run=>{
    if(!canResumeRun(run))throw new Error('任务当前不能恢复，请刷新任务记录。');
    if(runsRef.current.some(item=>item.id!==id&&isRunActive(item)))throw new Error('已有其他任务占用当前作品，请先处理该任务。');
    if(run.runtime?.uncertain&&!confirmUncertain)throw new Error('上次请求结果不确定，恢复前必须明确确认可能重发付费请求。');
    await window.novel.resumeRun(id,confirmUncertain);
  },'任务已恢复；后续候选仍需你审批。');
  const resumeAgent = (id:string)=>protect(async()=>{
    await flushEdits();
    const run=runsRef.current.find(item=>item.id===id);
    if(!run||run.projectId!==workspaceRef.current?.id||!canResumeRun(run))throw new Error('此任务无法恢复，请刷新记录。');
    if(run.runtime?.uncertain){
      setConfirm({title:'确认恢复不确定的请求',message:'上次模型请求的结果尚不确定，可能已经产生费用。恢复任务可能重新发送同一请求，再次产生付费模型费用。已批准写入的修改不会因此被视为新的审批。是否接受可能重发付费请求并恢复？',confirmLabel:'确认可能重发付费请求并恢复',act:()=>doResumeAgent(id,true)});
    }else await doResumeAgent(id);
  });
  const decideCandidate = (decision:AgentDecision)=>runAgentAction(decision.runId,async run=>{
    const waiting=run.runtime?.waiting;
    const candidate=run.runtime?.candidates.find(item=>item.id===decision.candidateId);
    if(run.status!=='awaitingApproval'||waiting?.kind!=='approval'||waiting.candidateId!==decision.candidateId||waiting.candidateHash!==decision.candidateHash||candidate?.status!=='awaitingApproval'||candidate.hash!==decision.candidateHash)throw new Error('候选版本或审批状态已变化，请刷新并重新核对差异。');
    if(!decision.approve&&!decision.reason?.trim())throw new Error('请说明拒绝原因，候选内容尚未写入。');
    // runAgentAction has flushed Writer and Field drafts before this revision-sensitive decision.
    await window.novel.decideCandidate(decision);
    if(decision.approve)await enqueue(async()=>{
      if(workspaceRef.current?.id!==run.projectId)return;
      const next=await window.novel.loadProject(run.projectId);
      if(workspaceRef.current?.id===next.id){receive(next);await refreshDetails(next.id);}
    });
  },decision.approve?'已批准候选；写入结果可在修改历史中查看。':'已提交拒绝意见；此候选未写入作品。');
  const answerAgent = (id:string,answer:string)=>runAgentAction(id,async run=>{
    if(run.status!=='awaitingInput'||run.runtime?.waiting?.kind!=='input')throw new Error('任务已不再等待回答，请刷新记录。');
    if(!answer.trim())throw new Error('请填写回答。');
    await window.novel.answerRun(id,answer.trim());
  },'回答已提交，任务将继续。');
  const agentActions:AgentTaskActions={onPause:pauseAgent,onResume:resumeAgent,onDecide:decideCandidate,onAnswer:answerAgent,onCancel:id=>runAgentAction(id,()=>window.novel.cancelRun(id),'已请求停止任务。')};
  const changeMemory = (action:(id:string)=>Promise<unknown>,message:string)=>protect(async()=>{
    const id=workspaceRef.current?.id;if(!id)return;
    if(memoryActionRef.current)throw new Error('正在保存记忆，请稍候。');
    memoryActionRef.current=true;setMemoryBusy(true);
    try{await action(id);if(workspaceRef.current?.id===id){await loadAgentContext(id);notify(message);}}
    finally{memoryActionRef.current=false;setMemoryBusy(false);}
  });
  const memoryActions:AgentMemoryActions={
    onReload:()=>workspaceRef.current?loadAgentContext(workspaceRef.current.id):Promise.resolve(),
    onSave:content=>changeMemory(id=>{if(!content.trim())throw new Error('请填写作者偏好。');return window.novel.saveMemory(id,content.trim(),'preference');},'作者偏好已显式保存。'),
    onConfirm:memoryId=>changeMemory(id=>window.novel.confirmMemory(id,memoryId),'记忆建议已确认。'),
    onDelete:memoryId=>changeMemory(id=>window.novel.deleteMemory(id,memoryId),'记忆已删除。'),
  };
  const currentPassage = workspace?passageFor(workspace,selectedPassage):undefined;
  const currentScene = workspace&&currentPassage?workspace.scenes.find(scene=>scene.id===currentPassage.sceneId):undefined;
  const canInspect=isBoard||view==='objects'||(view==='write'&&!!currentScene);
  const groupView=view==='objects'?'canvas':view==='story'||view==='outline'?'world':view;
  const pageTabs:View[]=groupView==='canvas'?['canvas','objects']:groupView==='world'?['outline','world','story']:[];
  const reported=Object.values(saveReports);
  const status=reported.includes('conflict')?'conflict':reported.includes('error')||saveError?'error':pendingSaves||reported.includes('saving')?'saving':reported.includes('editing')?'editing':'saved';
  /** The selected prose becomes an own sample: the strongest signal of the author's voice. */
  const pinSample=(passageId=selection?.passageId,raw=selection?.text)=>{
    const passage=workspace?.passages.find(item=>item.id===passageId);
    if(!workspace||!passage||!raw?.trim())return;
    const title=passageLabel(workspace,passage);
    const text=raw.trim().slice(0,STYLE_LIMITS.sampleChars);
    fire(protect(async()=>{
      await commit(current=>{const style=styleProfile(current),total=style.samples.reduce((sum,item)=>sum+item.text.length,0);
        if(style.samples.some(item=>item.text===text))return[];
        if(style.samples.length>=STYLE_LIMITS.samples||total+text.length>STYLE_LIMITS.samplesTotal)throw new Error(`范文库已满（最多 ${STYLE_LIMITS.samples} 段、${STYLE_LIMITS.samplesTotal.toLocaleString()} 字），请先在文风页删掉一些。`);
        return[{type:'updateStyle',patch:{samples:[...style.samples,{id:uid(),label:`${title} · ${text.slice(0,12)}`,text,source:'own',passageId:passage.id}]}}];},'设为范文');
      notify(`已设为范文（${text.length.toLocaleString()} 字），写作时会参照这段的笔触。`);
    }));
  };
  const statusText={conflict:'草稿冲突',error:'保存失败',saving:'保存中',editing:'编辑中',saved:'已保存'}[status];
  const inspectorVisible=inspectorOpen&&canInspect;
  const drawerOpen=(aiOpen&&aiDrawer)||(inspectorVisible&&inspectorDrawer);
  const groupTitle=groupView==='canvas'?'构思':groupView==='world'?'情节规划':viewTitles[view];
  const content = workspace&&<>
    {view==='home'&&<Home workspace={workspace} passage={currentPassage} commit={commit} setView={navigate} onAssist={prepareAssist} onPrepare={prepareStage} runs={runs} onMonitor={openMonitor}/>}
    {view==='objects'&&<Objects workspace={workspace} commit={commit} selected={selectedObject} select={id=>selectEntity(setSelectedObject,id)} patchObject={patchObject} addObject={addObject} askDelete={askDelete} askAction={askAction} onAssist={prepareAssist} onOpenCanvas={openCanvas} onOpenReference={openReference} beforeChange={()=>protect(flushEdits)} inspectorHost={inspectorVisible?inspectorHost:null}/>}
    {isBoard&&<Board key={`${workspace.id}:${view}`} mode={view as 'canvas'|'world'|'story'} workspace={workspace} commit={commit}
      selectedObject={selectedObject} selectObject={id=>selectEntity(setSelectedObject,id)} selectedScene={selectedScene} selectScene={id=>selectEntity(setSelectedScene,id)} selectedCard={selectedCard} selectCard={id=>selectEntity(setSelectedCard,id)}
      addEvent={position=>addObject(undefined,true,position)} addScene={addScene} askDelete={askDelete}
      renderObjectForm={object=><ObjectForm key={object.id} workspace={workspace} object={object} commit={commit} patch={patch=>patchObject(object.id,patch)} onOpenReference={openReference} askDelete={askDelete}/>}
      renderSceneForm={scene=><SceneForm key={scene.id} workspace={workspace} scene={scene} patch={patch=>patchScene(scene.id,patch)} commit={commit} askDelete={askDelete} onOpenPassage={openPassage}/>}
      onOpenReference={openReference} onPrepare={prepareStage} onAssist={prepareAssist} onOpenCanvas={openCanvas} showInspector={inspectorVisible} onInspectorChange={changeInspector} inspectorHost={inspectorHost}/>}
    {view==='outline'&&<Outline workspace={workspace} commit={commit} askDelete={askDelete} onOpenPassage={openPassage}/>}
    {view==='write'&&<Writer workspace={workspace} passage={currentPassage} selectPassage={selectPassage} registerFlush={registerFlush} addChapter={addChapter} addScene={addPassageScene} commit={commit} askDelete={askDelete} onAssist={prepareAssist} onOpenCanvas={openCanvas} beforeChange={()=>protect(flushEdits)}
      onSelection={picked=>setSelection(picked&&currentPassage?{...picked,passageId:currentPassage.id}:undefined)} hasSelection={!!selection&&selection.passageId===currentPassage?.id&&selection.end>selection.start}
      cursor={selection&&selection.passageId===currentPassage?.id?selection.start:undefined} notify={text=>notify(text)}
      onQuickWrite={()=>quickWrite('scene')} onContinue={()=>quickWrite('continue')} runs={runs}
      onRewrite={()=>prepareTask('rewrite',currentScene?[{kind:'scene',id:currentScene.id}]:[])} onPinSample={()=>pinSample()} onPrepare={(stage,refs,scope)=>prepareTask(stage,refs,'canvas',scope)} onDetails={()=>changeInspector(!inspectorOpen)} detailsOpen={inspectorVisible}
      focusMode={focusMode} onFocusMode={setFocusMode}/>}
    {view==='style'&&<Style workspace={workspace} commit={commit} history={history} passageId={currentPassage?.id} onOpenPassage={openPassage}/>}
    {view==='reader'&&<Reader workspace={workspace} commit={commit} registerFlush={registerFlush} jump={openPassage} onPinSample={pinSample}/>}
    {view==='monitor'&&<Monitor workspace={workspace} selectedRun={selectedRun} onSelectedRun={setSelectedRun} onOpenReference={openReference} onNextStage={prepareStage} runs={runs} history={history} cancel={id=>protect(()=>window.novel.cancelRun(id))} retry={retry} undo={undo} mock={provider?.mode==='mock'} agentActions={agentActions} agentBusy={agentBusy} reload={()=>reloadRuns(workspace.id)}/>}
  </>;
  const dismissConfirm=()=>{confirm?.cancel?.();setConfirm(null);};
  const saveTitle=status==='saved'?`所有修改已保存在本机${workspace?` · 版本 ${workspace.revision}`:''}`:status==='error'?'有修改未能保存，草稿已保留':status==='conflict'?'正文草稿与新版本冲突，请在编辑器中选择':'正在保存到本机';
  const showCompanionPanel=useCallback(()=>{setAiTab('chat');showPanel('ai');},[showPanel]);
  const flushForCompanion=useCallback(()=>flushEdits(),[flushEdits]);
  return <SaveFeedbackContext.Provider value={reportSave}><CompanionProvider workspace={workspace} beforeChange={flushForCompanion} onError={failure} notify={notify} showPanel={showCompanionPanel}><CompanionBridge apiRef={companionApi}/><div className={`app view-${view} ${navCollapsed?'nav-collapsed':''} ${focusMode&&view==='write'?'focus-mode':''} ${inspectorVisible&&!inspectorDrawer?'inspector-docked':''} ${aiOpen&&!aiDrawer?'ai-docked':''}`}>
    <aside className="sidebar" aria-label="作品导航">
      <div className="brand"><div className="brand-symbol"><Feather aria-hidden="true"/></div><strong>叙境</strong><button className="icon-button ghost nav-toggle" data-testid="toggle-navigation" title={`${navCollapsed?'展开':'收起'}导航（Ctrl+\\）`} aria-label={navCollapsed?'展开导航':'收起导航'} aria-expanded={!navCollapsed} onClick={()=>setNavCollapsed(!navCollapsed)}>{navCollapsed?<PanelLeftOpen/>:<PanelLeftClose/>}</button></div>
      <div className="project-row"><label className="project-picker"><span className="project-initial" aria-hidden="true">{workspace?.title.slice(0,1)||'·'}</span><select className="project-switch" aria-label="选择作品" title={workspace?.title} value={workspace?.id||''} onChange={e=>fire(protect(()=>openProject(e.target.value)))}><option value="" disabled>选择作品</option>{projects.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select><ChevronsUpDown className="project-caret" aria-hidden="true"/></label>
        <button className="icon-button ghost new-project-button" data-testid="open-create-project" title="新建作品" aria-label="新建作品" onClick={()=>{setProjectTitle('');setCreating(true);}}><Plus/></button></div>
      <button className="search-trigger" onClick={()=>setPaletteOpen(true)} title="搜索与命令（Ctrl+K）"><Search aria-hidden="true"/><span className="nav-label">搜索与跳转</span><Kbd>Ctrl K</Kbd></button>
      <nav>{nav.map(({view:id,label,icon:Icon},index)=><button title={`${label}（Ctrl+${index+1}）`} data-testid={`nav-${id==='canvas'?'idea':id==='reader'?'read':id}`} key={id} className={groupView===id?'active':''} aria-current={groupView===id?'page':undefined} onClick={()=>navigate(id)} disabled={!workspace}><Icon aria-hidden="true"/><span className="nav-label">{label}</span><span className="nav-kbd" aria-hidden="true">{index+1}</span></button>)}</nav>
      <div className="sidebar-bottom"><button title="创作记录" data-testid="nav-monitor" className={view==='monitor'?'active':''} disabled={!workspace} onClick={()=>navigate('monitor')}><History aria-hidden="true"/><span className="nav-label">创作记录</span>{activeRun&&<i className="live-dot" title="有任务正在进行"/>}</button><button title={appearance.theme!=='light'?'切换到浅色模式':'切换到深色模式'} data-testid="theme-toggle" className="theme-toggle" aria-pressed={appearance.theme!=='light'} onClick={toggleTheme}>{appearance.theme!=='light'?<Sun aria-hidden="true"/>:<Moon aria-hidden="true"/>}<span className="nav-label">{appearance.theme!=='light'?'浅色模式':'深色模式'}</span></button><button title="设置" data-testid="nav-settings" className={view==='settings'?'active':''} onClick={()=>navigate('settings')}><Settings2 aria-hidden="true"/><span className="nav-label">设置</span></button></div>
    </aside>
    <main className="main"><header className="topbar">
      <div className="page-heading">{workspace&&view!=='settings'&&<><span className="workspace-title" title={workspace.title}>{workspace.title}</span><ChevronRight className="crumb-sep" aria-hidden="true"/></>}<h1 tabIndex={-1}>{groupTitle}</h1></div>
      {pageTabs.length>0&&<div className="page-tabs" role="tablist" aria-label="工作区视图" onKeyDown={event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();const index=pageTabs.indexOf(view),next=event.key==='Home'?pageTabs[0]:event.key==='End'?pageTabs.at(-1)!:pageTabs[(index+(event.key==='ArrowRight'?1:-1)+pageTabs.length)%pageTabs.length];
        navigate(next,`workspace-tab-${next}`);
      }}>{pageTabs.map(id=><button key={id} id={`workspace-tab-${id}`} role="tab" tabIndex={view===id?0:-1} aria-selected={view===id} aria-controls="workspace-content" className={view===id?'active':''} data-testid={`nav-${id==='canvas'?'canvas-tab':id==='world'?'world-tab':id}`} onClick={()=>navigate(id)}>{viewTitles[id]}</button>)}</div>}
      <div className="top-actions">{workspace&&<span className="save-indicator" data-state={status} data-revision={workspace.revision} role="status" title={saveTitle}>{status==='saved'?<Check aria-hidden="true"/>:status==='error'||status==='conflict'?<CircleAlert aria-hidden="true"/>:<span className={`save-mark ${status}`} aria-hidden="true"/>}{statusText}</span>}
        <button className={`provider-tag ${provider?.mode==='mock'?'mock':''}`} title="打开模型设置" onClick={()=>navigate('settings')}><i aria-hidden="true"/>{provider?.mode==='mock'?'演示模式':provider?.model||'模型未连接'}</button>
        <span className="top-divider" aria-hidden="true"/>
        {canInspect&&<button className={`toolbar-toggle ${inspectorVisible?'selected':''}`} data-testid="show-details-panel" title="详情（Ctrl+I）" aria-pressed={inspectorVisible} aria-controls="inspector-panel" onClick={()=>changeInspector(!inspectorOpen)}><PanelRight aria-hidden="true"/><span>详情</span></button>}
        <button className={`toolbar-toggle ai-toggle ${aiOpen?'selected':''}`} data-testid="toggle-assistant" title="AI 助手（Ctrl+J）" aria-pressed={aiOpen} aria-controls="ai-panel" onClick={()=>togglePanel('ai')}><Sparkles aria-hidden="true"/><span>AI 助手</span>{activeRun&&<i className="live-dot"/>}</button></div>
    </header>
    <div key={`${workspace?.id}:${view}`} id="workspace-content" className="main-content" role={pageTabs.length?'tabpanel':undefined} aria-labelledby={pageTabs.length?`workspace-tab-${view}`:undefined}>{view==='settings'?<Settings provider={provider}
      save={input=>protect(async()=>{const p=await window.novel.saveProvider(input);setProvider(p);notify('模型配置已保存。');return p;})}
      test={()=>protect(()=>window.novel.testProvider())} workspace={workspace}
      backup={()=>protect(async()=>{await flushEdits();if(!workspace)return;const path=await window.novel.exportProject(workspace.id);if(path)notify(`备份已保存：${path}`);})}
      restore={restore} exportText={()=>protect(async()=>{await flushEdits();if(!workspace)return;const path=await window.novel.exportText(workspace.id);if(path)notify(`正文已导出：${path}`);})}
    />:loading?<Empty title="正在打开作品" description="读取本地创作数据…"/>:workspace?content:<Empty title="开始你的第一部作品" description="创建作品后，从构思、规划到写作与阅读，都可以在这里完成。" action={<div className="button-row"><button className="primary" onClick={()=>setCreating(true)}><Plus/>新建作品</button><button onClick={()=>fire(restore())}><Upload/>恢复备份</button></div>}/>}
    </div></main>
    {drawerOpen&&<div className="context-backdrop" aria-hidden="true" onClick={()=>{if(aiOpen&&aiDrawer)closePanel('ai');else closePanel('details');}}/>}
    {inspectorVisible&&<aside ref={inspectorRef} id="inspector-panel" className={`inspector-panel ${inspectorDrawer?'drawer':''}`} role={inspectorDrawer?'dialog':'complementary'} aria-modal={inspectorDrawer||undefined} aria-label="详情" tabIndex={-1}>
      <header className="panel-header"><PanelRight className="panel-icon" aria-hidden="true"/><strong>详情</strong><button className="icon-button ghost inspector-close" aria-label="关闭详情" title="关闭（Esc）" onClick={()=>closePanel('details')}><X/></button></header>
      <div className="inspector-body" ref={setInspectorHost}>
        {view==='write'&&workspace&&currentScene&&<div className="writer-details"><div className="inspector-title"><span className="eyebrow">场景</span><h2>{currentScene.title}</h2></div><SceneForm key={currentScene.id} workspace={workspace} scene={currentScene} passage={currentPassage} patch={patch=>patchScene(currentScene.id,patch)} commit={commit} askDelete={askDelete} onOpenPassage={selectPassage}/></div>}
      </div>
    </aside>}
    {aiOpen&&<aside ref={aiRef} id="ai-panel" className={`context-panel ${aiDrawer?'drawer':''}`} role={aiDrawer?'dialog':'complementary'} aria-modal={aiDrawer||undefined} aria-label="AI 助手" tabIndex={-1}>
      <header className="panel-header"><span className="ai-mark" aria-hidden="true"><Sparkles/></span><div className="panel-title"><strong>AI 助手</strong><small>{provider?.mode==='mock'?'演示模式 · 本地示例':provider?.model||'模型未连接'}</small></div><button className="icon-button ghost panel-close" aria-label="关闭 AI 助手" title="关闭（Esc）" onClick={()=>closePanel('ai')}><X/></button></header>
      <div className="context-body">
        <Assistant workspace={workspace} provider={provider} runs={runs} history={history} draft={task} onDraftChange={patch=>setTask(old=>({...old,...patch}))} onPrepare={prepareTask} busy={busy} dismissedRun={dismissedRun} onDismissRun={setDismissedRun} onStart={start} onCancel={id=>protect(()=>window.novel.cancelRun(id))} onMonitor={openMonitor} onOpenReference={openReference} onNextStage={prepareStage} onUndo={undo} onRetry={retry} agentActions={agentActions} agentBusy={agentBusy} memories={memories} session={session} memoryActions={memoryActions} memoryLoading={memoryLoading} memoryBusy={memoryBusy} memoryError={memoryError} tab={aiTab} onTab={setAiTab}/>
      </div>
    </aside>}
    {notice&&<Toast key={notice.id} text={notice.text} error={notice.error} persistent={notice.error||!!notice.undoId||!!notice.action} onClose={dismissNotice}>{notice.undoId&&<button className="small" disabled={!!activeRun} onClick={()=>fire(undo(notice.undoId!))}><Undo2/>撤销</button>}{notice.action&&<button className="small primary" data-testid="notice-action" onClick={notice.action.run}><Sparkles/>{notice.action.label}</button>}</Toast>}
    {paletteOpen&&<CommandPalette onClose={()=>setPaletteOpen(false)} commands={[
      ...nav.map(({view:id,label},index)=>({id:`view:${id}`,label,group:'页面',hint:`Ctrl ${index+1}`,disabled:!workspace,run:()=>navigate(id)})),
      {id:'theme:toggle',label:appearance.theme!=='light'?'切换到浅色模式':'切换到深色模式',group:'外观',run:toggleTheme},
      {id:'theme:onedark',label:'外观：One Dark',group:'外观',disabled:appearance.mode==='onedark',run:()=>setAppearance({mode:'onedark'})},
      ...accents.map(accent=>({id:`accent:${accent.id}`,label:`配色：${accent.label}`,group:'外观',disabled:appearance.accent===accent.id,run:()=>setAppearance({accent:accent.id})})),
      {id:'view:objects',label:'人物与设定',group:'页面',disabled:!workspace,run:()=>navigate('objects')},
      {id:'view:story',label:'叙述顺序',group:'页面',disabled:!workspace,run:()=>navigate('story')},
      {id:'view:outline',label:'大纲',group:'页面',disabled:!workspace,run:()=>navigate('outline')},
      {id:'action:companion',label:'和创作伙伴聊聊',group:'操作',disabled:!workspace,run:showCompanionPanel},
      {id:'view:monitor',label:'创作记录',group:'页面',disabled:!workspace,run:()=>navigate('monitor')},
      {id:'view:settings',label:'设置',group:'页面',run:()=>navigate('settings')},
      {id:'action:ai',label:aiOpen?'关闭 AI 助手':'打开 AI 助手',group:'操作',hint:'Ctrl J',run:()=>togglePanel('ai')},
      {id:'action:new',label:'新建作品',group:'操作',run:()=>{setProjectTitle('');setCreating(true);}},
      ...(Object.entries(assistTools) as Array<[AssistTool,typeof assistTools[AssistTool]]>).map(([tool,info])=>({id:`assist:${tool}`,label:`AI · ${info.label}`,group:'AI 专项工具',disabled:!workspace,run:()=>prepareAssist(tool,[])})),
      ...(workspace?orderedScenes(workspace).map(scene=>({id:`scene:${scene.id}`,label:scene.title,group:'场景',hint:sceneChapters(workspace,scene.id),run:()=>openReference('scene',scene.id)})):[]),
      ...(workspace?workspace.objects.map(object=>({id:`object:${object.id}`,label:object.name,group:object.event?'世界事件':'人物与设定',hint:object.event?`#${object.event.worldOrder}`:workspace.objectTypes.find(t=>t.id===object.typeId)?.name,run:()=>openReference('object',object.id)})):[]),
    ]}/>}
    {creating&&<Dialog title="新建作品" onClose={()=>{if(!busy)setCreating(false);}}><form onSubmit={e=>{e.preventDefault();fire(protect(create));}}><label className="field"><span>作品名称</span><input data-testid="project-title-input" value={projectTitle} placeholder="为你的故事起一个名字" onChange={e=>setProjectTitle(e.target.value)} maxLength={200}/></label><label className="field"><span>题材（可选）</span><input data-testid="project-genre-input" value={projectGenre} placeholder="悬疑、奇幻、轻小说…" onChange={e=>setProjectGenre(e.target.value)} maxLength={200}/></label><label className="field"><span>一个念头（可选）</span><textarea data-testid="project-idea-input" rows={3} value={projectIdea} placeholder="一个画面、一个人物或一个还不确定的冲突。AI 会据此推断立意与人物。" onChange={e=>setProjectIdea(e.target.value)} maxLength={4000}/></label><label className="field"><span>贴一段你写的文字（可选）<small>叙境会以它为范文学习你的笔触</small></span><textarea data-testid="project-sample-input" rows={3} value={projectSample} placeholder="任何你满意的段落都可以，不必和这部作品有关。" onChange={e=>setProjectSample(e.target.value)} maxLength={STYLE_LIMITS.sampleChars}/></label><div className="button-row"><button type="button" onClick={()=>setCreating(false)} disabled={busy}>取消</button><button className="primary" data-testid="create-project" disabled={!projectTitle.trim()||busy}>{busy?'正在创建…':'创建作品'}</button></div></form></Dialog>}
    {confirm&&<Dialog title={confirm.title} onClose={dismissConfirm}><p>{confirm.message}</p><div className="button-row"><button onClick={dismissConfirm}>取消</button><button className={confirm.danger?'danger':'primary'} onClick={()=>{const pending=confirm;setConfirm(null);fire(protect(pending.act));}}>{confirm.confirmLabel}</button></div></Dialog>}
  </div></CompanionProvider></SaveFeedbackContext.Provider>;
}
