import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ArrowRight, ArrowLeft, BookOpen, Check, ChevronRight, CircleAlert, Download, FileText, FolderPlus, History, LayoutDashboard, Lightbulb, ListTree, PanelLeftClose, PanelLeftOpen, Plus, Settings2, Sparkles, Trash2, Undo2, Upload, X, Moon, Sun } from 'lucide-react';
import { ActionCancelled, ActionMenu, Dialog, Toast, SaveFeedbackContext, Field, Select, Empty, MultiPicker, uid, fire, colors, stageNames, statuses, assistTools, taskLabel, taskObjective, canResumeRun, characters, orderedChapters, orderedScenes, sceneFor, events, showValue, isAgentRun, isRunActive, runStatus, type Commit, type TaskDraft } from '../ui';
import type { Workspace, Command, ProjectSummary, NovelObject, ObjectType, NarrativeScene, AgentRun, ProviderSettings, ProviderInput, OperationBatch, RunRequest, FieldValue, SourceReference, AssistTool } from '../../shared/types';
import { canvasAction, type View, type AskAction, type RegisterFlush, type AssistAction, type OpenCanvas, type AskDelete } from '../types';
import type { StoryMemoryStatus } from '../../shared/story-types';

export function Settings({provider,save,test,workspace,backup,restore,exportText}:{provider:ProviderSettings|null;save:(input:ProviderInput)=>Promise<ProviderSettings>;test:()=>Promise<string>;workspace:Workspace|null;backup:()=>Promise<unknown>;restore:()=>Promise<unknown>;exportText:()=>Promise<unknown>}) {
  const [draft,setDraft]=useState<ProviderInput>({name:'自定义模型',baseURL:'https://api.openai.com/v1',model:'',reasoningEffort:'medium',mode:'mock'});const [key,setKey]=useState('');const [result,setResult]=useState('');const [testing,setTesting]=useState(false);
  useEffect(()=>{if(provider)setDraft({...provider});},[provider]);
  const persist=async()=>{const p=await save({...draft,apiKey:key||undefined});setDraft({...p});setKey('');return p;};
  return <div className="settings-page"><section className="panel"><div className="section-heading"><div><h2>创作模型</h2></div><span className="pill">密钥保存在本机</span></div><p className="muted">采用 OpenAI Responses API。请使用支持工具调用、流式响应和结构化输出的模型 / 服务。</p><div className="segmented settings-mode"><button className={draft.mode==='mock'?'active':''} onClick={()=>setDraft({...draft,mode:'mock'})}>内置演示 · 无需 Key</button><button className={draft.mode==='live'?'active':''} onClick={()=>setDraft({...draft,mode:'live'})}>真实模型连接</button></div><label className="field"><span>配置名称</span><input value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label><label className="field"><span>Base URL</span><input value={draft.baseURL} onChange={e=>setDraft({...draft,baseURL:e.target.value})} placeholder="https://api.openai.com/v1"/></label><label className="field"><span>API Key {provider?.hasKey&&<small>· 已保存，留空保留当前密钥</small>}</span><input type="password" value={key} onChange={e=>setKey(e.target.value)} placeholder={provider?.hasKey?'已安全保存 · 输入新 Key 可替换':'输入你的 API Key'} autoComplete="off"/></label><div className="form-grid"><label className="field"><span>模型 ID</span><input value={draft.model} onChange={e=>setDraft({...draft,model:e.target.value})} placeholder="服务商提供的模型名称"/></label><Select label="推理强度" value={draft.reasoningEffort||''} onChange={reasoningEffort=>setDraft({...draft,reasoningEffort:reasoningEffort||undefined})}><option value="">不发送此参数</option><option value="none">none</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></Select></div><label className="field"><span>摘要模型（可选）</span><input value={draft.summaryModel||''} onChange={e=>setDraft({...draft,summaryModel:e.target.value})} placeholder="用于整理故事记忆的较便宜模型；留空则使用上面的模型"/></label><div className="button-row"><button className="primary" onClick={()=>fire(persist())}>保存配置</button><button disabled={testing} onClick={()=>{setTesting(true);setResult('');fire(persist().then(test).then(setResult).catch(e=>setResult(e instanceof Error?e.message:String(e))).finally(()=>setTesting(false)));}}>{testing?'正在验证…':'保存并测试连接'}</button></div>{result&&<div className="connection-result">{result}</div>}<p className="muted settings-note">测试验证流式连接；创作任务进一步验证工具调用与结构化输出。服务不支持的参数会显示明确错误。</p></section><StoryMemoryPanel workspace={workspace} provider={provider} setMode={mode=>{const next={...draft,storyMemory:mode};setDraft(next);return save({...next,apiKey:key||undefined});}}/><section className="panel"><div className="section-heading"><div><h2>作品备份与导出</h2></div></div><p className="muted">备份保存完整创作数据。TXT 导出按章节与场景阅读顺序生成正文。</p><div className="data-actions"><button disabled={!workspace} onClick={()=>fire(backup())}><Download size={22}/><strong>备份当前作品</strong><small>对象、双线、画布和正文</small></button><button onClick={()=>fire(restore())}><Upload size={22}/><strong>恢复作品备份</strong><small>从本地备份继续创作</small></button><button disabled={!workspace} onClick={()=>fire(exportText())}><FileText size={22}/><strong>导出 TXT 正文</strong><small>便于分享与其他工具阅读</small></button></div></section></div>;
}

function wan(chars:number){return chars>=10000?`${(chars/10000).toFixed(1)} 万字`:`${chars} 字`;}
function StoryMemoryPanel({workspace,provider,setMode}:{workspace:Workspace|null;provider:ProviderSettings|null;setMode:(mode:'auto'|'manual')=>Promise<unknown>}) {
  const [status,setStatus]=useState<StoryMemoryStatus|null>(null);const [error,setError]=useState('');
  const projectId=workspace?.id;
  useEffect(()=>{
    setStatus(null);setError('');if(!projectId)return;let alive=true;
    window.novel.getStoryMemory(projectId).then(s=>{if(alive)setStatus(s);}).catch(e=>{if(alive)setError(e instanceof Error?e.message:String(e));});
    const off=window.novel.onAgentEvent(event=>{if(event.type==='storyMemory'&&event.projectId===projectId&&event.story)setStatus(event.story);});
    return()=>{alive=false;off();};
  },[projectId,provider?.storyMemory,provider?.mode]);
  const act=(action:(id:string)=>Promise<StoryMemoryStatus>)=>{if(!projectId)return;setError('');fire(action(projectId).then(setStatus).catch(e=>setError(e instanceof Error?e.message:String(e))));};
  const auto=(provider?.storyMemory??'auto')==='auto';
  const done=status?status.scenesWithText-status.pending:0;
  return <section className="panel story-memory"><div className="section-heading"><div><h2>故事记忆</h2></div><span className="pill">{!status?'—':status.running?'整理中…':status.pending?`待整理 ${status.pending} 场`:'已是最新'}</span></div>
    <p className="muted">根据正文为每个场景、章节、分卷和全书整理摘要，并记录尚未回收的伏笔与人物出场位置。写作、读者审阅和创作伙伴用它理解前文，不必每次重读全书。摘要保存在本机，不进入作品备份，也不会改动作品。{provider?.mode==='mock'?'演示模式下摘要是从正文机械摘取的示例。':'整理会调用上面的摘要模型（留空则用主模型）。'}</p>
    {!workspace?<p className="muted">打开一部作品后查看整理进度。</p>:status&&<dl className="story-memory-stats">
      <div><dt>已整理</dt><dd>{done} / {status.scenesWithText} 场</dd></div>
      <div><dt>待整理</dt><dd>{status.pending?`${status.pending} 场 · 约 ${wan(status.pendingChars)}`:'无'}</dd></div>
      <div><dt>本次启动用量</dt><dd>{status.usage.provided?`${status.usage.total.toLocaleString()} tokens`:provider?.mode==='mock'?'演示不计费':'尚无'}</dd></div>
    </dl>}
    {status?.awaitingConfirmation&&!status.running&&<p className="story-memory-note" role="status">待整理内容较多（约 {wan(status.pendingChars)}），自动模式不会自行开始。点击「立即整理」后按批次进行，可随时停止，已完成的部分会保留。</p>}
    {!!status?.drifted&&<p className="muted">{status.drifted} 场正文有小幅修改，暂用旧摘要，稍后自动更新。</p>}
    <div className="button-row"><div className="segmented" role="group" aria-label="故事记忆整理方式"><button className={auto?'active':''} aria-pressed={auto} onClick={()=>fire(setMode('auto'))}>修改后自动整理</button><button className={!auto?'active':''} aria-pressed={!auto} onClick={()=>fire(setMode('manual'))}>仅手动整理</button></div>
      {status?.running?<button onClick={()=>act(id=>window.novel.stopStoryMemory(id))}>停止</button>:<button className="primary" disabled={!workspace||!status} onClick={()=>act(id=>window.novel.runStoryMemory(id))}>立即整理</button>}</div>
    {(error||status?.lastError)&&<p className="field-error" role="alert">{error||status?.lastError}</p>}
  </section>;
}
