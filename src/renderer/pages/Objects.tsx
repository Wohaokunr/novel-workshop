import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ArrowRight, ArrowLeft, BookOpen, Check, ChevronRight, CircleAlert, Download, FileText, FolderPlus, History, LayoutDashboard, Lightbulb, ListTree, PanelLeftClose, PanelLeftOpen, Plus, Settings2, Sparkles, Trash2, Undo2, Upload, X, Moon, Sun } from 'lucide-react';
import { ActionCancelled, ActionMenu, Dialog, Toast, SaveFeedbackContext, Field, Select, Empty, MultiPicker, uid, fire, colors, stageNames, statuses, assistTools, taskLabel, taskObjective, canResumeRun, characters, orderedChapters, orderedScenes, sceneFor, events, showValue, isAgentRun, isRunActive, runStatus, type Commit, type TaskDraft } from '../ui';
import type { Workspace, Command, ProjectSummary, NovelObject, ObjectType, NarrativeScene, AgentRun, ProviderSettings, ProviderInput, OperationBatch, RunRequest, FieldValue, SourceReference, AssistTool } from '../../shared/types';
import { canvasAction, type View, type AskAction, type RegisterFlush, type AssistAction, type OpenCanvas, type AskDelete } from '../types';
import { ObjectForm } from '../forms';
import { useCompanion } from '../Companion';
import { elementOf, isSettingLike, objectHealth, type StoryElement } from '../../shared/story-elements';
import { storyFlow } from '../../shared/story-flow';

/** The three elements of a novel, each with its own column, gaps and AI entry. */
const elementColumns: Array<{ id: StoryElement; title: string; tagline: string; empty: string }> = [
  { id: 'people', title: '人物', tagline: '谁在推动故事，想要什么', empty: '还没有人物。先建主角，或让 AI 设计一组人物。' },
  { id: 'plot', title: '情节', tagline: '世界里真实发生的事件与因果', empty: '还没有世界事件。写下第一件改变局面的事。' },
  { id: 'place', title: '环境与设定', tagline: '人物在哪里行动，世界有什么规则', empty: '还没有环境。故事发生在哪里？那里有什么规矩？' },
];

export function Objects({workspace:w,commit,selected,select,patchObject,addObject,askDelete,askAction,onAssist,onOpenCanvas,onOpenReference,inspectorHost,beforeChange}:{beforeChange:()=>Promise<void>;onAssist:AssistAction;onOpenCanvas:OpenCanvas;onOpenReference:(kind:SourceReference['kind'],id:string)=>void;askAction:AskAction;workspace:Workspace;commit:Commit;selected:string;select:(id:string)=>void;patchObject:(id:string,p:Partial<NovelObject>)=>Promise<unknown>;addObject:(typeId?:string)=>Promise<unknown>;askDelete:AskDelete;inspectorHost:HTMLElement|null}) {
  const [manage,setManage]=useState(false);const [search,setSearch]=useState('');
  const placeTypes=w.objectTypes.filter(t=>t.id!=='character'&&t.id!=='event');const [placeType,setPlaceType]=useState('setting');
  const object=w.objects.find(o=>o.id===selected);const type=w.objectTypes.find(t=>t.id===object?.typeId);
  const companion=useCompanion();
  const below=(event:React.MouseEvent<HTMLElement>)=>{const rect=event.currentTarget.getBoundingClientRect();return {x:rect.left,y:rect.bottom};};
  /** Character design is ideation: the partner proposes, one click adopts, undo is in the dialog. */
  const designCast=(event:React.MouseEvent<HTMLElement>,target?:NovelObject)=>companion.summon({mode:'develop',label:target?target.name:'人物阵容',screen:below(event),
    anchor:{surface:'panel',references:target?[{kind:'object',id:target.id}]:[],focus:'cast'},
    message:target?`丰富「${target.name}」：补全身份、欲望、秘密与目标，并补充和他关系最紧密的人物。`:characters(w).length?'在现有人物之外补充几个能制造冲突的人物，并理清他们之间的关系。':'根据作品信息和立意，设计一组主要人物和他们之间的关系。'});
  const designWorld=(event:React.MouseEvent<HTMLElement>,target?:NovelObject)=>{const assist=storyFlow(w).find(stage=>stage.id==='setting')!.assist!;companion.summon({mode:'develop',label:target?target.name:'故事环境',screen:below(event),
    anchor:{surface:'panel',references:target?[{kind:'object',id:target.id}]:[],focus:'setting'},
    message:target?`丰富「${target.name}」：补全它的样貌、氛围、谁在这里活动，以及这里的世界规则与代价。`:assist.message});};
  const designPlot=(event:React.MouseEvent<HTMLElement>)=>companion.summon({mode:'causality',label:'世界事件',screen:below(event),anchor:{surface:'panel',references:[]},
    message:events(w).length?'看看现有的世界事件，还缺哪些关键的前因或后果？':'根据人物和灵感，推演故事里真实发生的几件关键事件及其因果。'});
  const query=search.trim().toLowerCase();const visible=w.objects.filter(o=>o.name.toLowerCase().includes(query));
  const subtitle=(o:NovelObject)=>o.event?`#${o.event.worldOrder} · ${o.event.thread||'主线'}`:o.typeId==='character'?(typeof o.fields.goal==='string'&&o.fields.goal.trim()?o.fields.goal:'人物'):w.objectTypes.find(t=>t.id===o.typeId)?.name||'设定';
  return <div className="objects-page">
    <div className="toolbar"><div className="search-wrap"><input className="search" aria-label="搜索人物与设定" value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索人物、事件、地点…"/></div><button onClick={()=>fire(beforeChange().then(()=>setManage(!manage)))}><Settings2 size={16}/>管理类型与字段</button></div>
    {manage&&<TypeManager workspace={w} commit={commit} askDelete={askDelete} askAction={askAction} beforeChange={beforeChange}/>}
    <div className="elements-board" data-testid="elements-board">{elementColumns.map(column=>{
      const items=visible.filter(o=>elementOf(o)===column.id).sort((a,b)=>column.id==='plot'?a.event!.worldOrder-b.event!.worldOrder:0);
      const all=w.objects.filter(o=>elementOf(o)===column.id);
      // Most common gaps first: a column-level nudge instead of a wall of warnings.
      const counts=new Map<string,number>();for(const o of all)for(const hint of objectHealth(w,o))counts.set(hint,(counts.get(hint)??0)+1);
      const gaps=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,2);
      return <section key={column.id} className="element-column panel" data-element={column.id} aria-label={column.title}>
        <div className="section-heading"><div><h2>{column.title} <small>{all.length}</small></h2><p className="muted">{column.tagline}</p></div></div>
        <div className="element-actions">
          {column.id==='people'?<button className="small secondary" data-testid="objects-design-cast" onClick={event=>designCast(event)}><Sparkles size={16}/>AI 设计人物</button>
            :column.id==='plot'?<button className="small secondary" data-testid="objects-design-plot" onClick={designPlot}><Sparkles size={16}/>AI 推演事件</button>
            :<button className="small secondary" data-testid="objects-design-setting" onClick={event=>designWorld(event)}><Sparkles size={16}/>AI 设计环境</button>}
          {column.id==='place'&&placeTypes.length>1&&<select className="small" aria-label="新建的设定类型" value={placeTypes.some(t=>t.id===placeType)?placeType:placeTypes[0]!.id} onChange={e=>setPlaceType(e.target.value)}>{placeTypes.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select>}
          <button className="small" data-testid={`objects-add-${column.id}`} onClick={()=>fire(addObject(column.id==='people'?'character':column.id==='plot'?'event':placeTypes.some(t=>t.id===placeType)?placeType:placeTypes[0]?.id))}><Plus size={16}/>新建</button>
        </div>
        {gaps.length>0&&<p className="element-gaps"><CircleAlert size={14} aria-hidden="true"/>{gaps.map(([hint,count])=>`${count} 个${hint}`).join(' · ')}</p>}
        <div className="element-list">{items.map((o,index)=>{const hints=objectHealth(w,o);return <button className={`object-row ${selected===o.id?'selected':''}`} key={o.id} onClick={()=>select(o.id)}><span className="object-avatar" style={{background:colors[index%colors.length]+'20',color:colors[index%colors.length]}}>{o.name.slice(0,1)}</span><span><strong>{o.name}</strong><small>{subtitle(o)}</small></span>{hints.length>0&&<span className="health-dot" title={hints.join('、')} aria-label={`待补：${hints.join('、')}`}/>}<ChevronRight size={16}/></button>;})}</div>
        {!items.length&&<p className="muted element-empty">{search?'没有匹配内容。':column.empty}</p>}
      </section>;})}</div>
    {inspectorHost&&createPortal(<div className="object-inspector">{object?<><div className="section-heading"><div><span className="eyebrow">{type?.name}</span><h2>{object.name}</h2></div><button className="icon-button text-danger" title="删除对象" onClick={()=>fire(askDelete({type:'deleteObject',id:object.id},`删除「${object.name}」`))}><Trash2 size={16}/></button></div><div className="reference-actions">{object.typeId==='character'&&<button data-testid="object-enrich-character" onClick={event=>designCast(event,object)}><Sparkles size={16}/>丰富这个人物</button>}{isSettingLike(object)&&<button data-testid="object-enrich-setting" onClick={event=>designWorld(event,object)}><Sparkles size={16}/>丰富这个环境</button>}<button onClick={()=>onAssist(object.typeId==='character'?'character':object.event?'world':'continuity',[{kind:'object',id:object.id}])}><Sparkles size={16}/>{object.typeId==='character'?'演进人物':object.event?'完善因果':'完善设定'}</button><button onClick={()=>onOpenCanvas('object',object.id)}>{canvasAction(w,'object',object.id)}</button></div><ObjectForm key={object.id} workspace={w} object={object} commit={commit} patch={patch=>patchObject(object.id,patch)} onOpenReference={onOpenReference} askDelete={askDelete}/></>:<Empty title="选择一个人物或设定" description="在这里编辑基础资料、世界事实与人物认知。"/>}</div>,inspectorHost)}
  </div>;
}

export function TypeManager({workspace:w,commit,askDelete,askAction,beforeChange}:{beforeChange:()=>Promise<void>;askAction:AskAction;workspace:Workspace;commit:Commit;askDelete:(c:Command,t:string)=>Promise<unknown>}) {
  const [selected,setSelected]=useState(w.objectTypes[0]?.id||'');const t=w.objectTypes.find(t=>t.id===selected);
  const patch=(fn:(t:ObjectType)=>ObjectType)=>commit(current=>{const type=current.objectTypes.find(v=>v.id===selected);return type?[{type:'putObjectType',value:fn(type)}]:[];});
  const changeField=(fieldId:string,change:Partial<ObjectType['fields'][number]>)=>{
    const previous=t?.fields.find(f=>f.id===fieldId);if(!t||!previous)return Promise.reject(new Error('字段不存在。'));
    const update=(field:ObjectType['fields'][number])=>{const value={...field,...change};if(value.kind==='choice'&&!value.options?.length)value.options=['选项一'];return value;};
    const updated=update(previous);
    const compatible=(value:FieldValue,field=updated,objects=w.objects)=>value===null||(field.kind==='text'?(typeof value==='string'||typeof value==='boolean'||Array.isArray(value)):field.kind==='number'?typeof value==='number'&&Number.isFinite(value):field.kind==='choice'?typeof value==='string'&&!!field.options?.includes(value):typeof value==='string'?objects.some(o=>o.id===value):Array.isArray(value)&&value.every(id=>objects.some(o=>o.id===id)));
    const affected=w.objects.filter(o=>o.typeId===t.id&&o.fields[fieldId]!==undefined&&!compatible(o.fields[fieldId]));
    const action=()=>commit(current=>{const type=current.objectTypes.find(v=>v.id===t.id);const field=type?.fields.find(f=>f.id===fieldId);if(!type||!field)return[];const latest=update(field);const commands:Command[]=[{type:'putObjectType',value:{...type,fields:type.fields.map(f=>f.id===fieldId?latest:f)}}];for(const o of current.objects.filter(o=>o.typeId===t.id)){if(o.fields[fieldId]!==undefined&&!compatible(o.fields[fieldId],latest,current.objects)){const fields={...o.fields};delete fields[fieldId];commands.push({type:'putObject',value:{...o,fields}});}}return commands;},'修改字段定义');
    return affected.length?askAction('调整字段并清理不匹配的值',`「${previous.label}」的定义改变后，${affected.length} 个对象的旧值将被清空：${affected.map(o=>o.name).join('、')}。本次修改可撤销。`,action):action();
  };
  return <div className="panel type-manager"><div className="section-heading"><h3>类型与动态字段</h3><button onClick={()=>{const id=uid();fire(commit([{type:'putObjectType',value:{id,name:'新类型',fields:[]}}]).then(()=>setSelected(id)));}}><Plus size={16}/>添加类型</button></div><div className="form-grid"><Select label="对象类型" value={selected} onChange={id=>fire(beforeChange().then(()=>setSelected(id)))}>{w.objectTypes.map(type=><option key={type.id} value={type.id}>{type.name}</option>)}</Select>{t&&<Field key={t.id} label="类型名称" value={t.name} onSave={name=>patch(old=>({...old,name}))}/>}</div>{t&&<><div className="type-fields">{t.fields.map(f=><div className="type-field-row" key={`${t.id}:${f.id}`}><Field value={f.label} onSave={label=>patch(old=>({...old,fields:old.fields.map(v=>v.id===f.id?{...v,label}:v)}))}/><select value={f.kind} onChange={e=>fire(changeField(f.id,{kind:e.target.value as typeof f.kind,options:e.target.value==='choice'?(f.options?.length?f.options:['选项一']):undefined}))}><option value="text">文字</option><option value="number">数值</option><option value="choice">选项</option><option value="reference">对象引用</option></select>{f.kind==='choice'&&<Field value={(f.options||[]).join('，')} placeholder="选项以逗号分隔" onSave={value=>changeField(f.id,{options:value.split(/[,，]/).map(s=>s.trim()).filter(Boolean)})}/>}<button title="删除字段" className="text-danger" onClick={()=>fire(patch(old=>({...old,fields:old.fields.filter(v=>v.id!==f.id)})))}><X size={16}/></button></div>)}</div><div className="button-row"><button onClick={()=>fire(patch(old=>({...old,fields:[...old.fields,{id:uid(),label:'新字段',kind:'text'}]})))}><Plus size={16}/>添加字段</button><button disabled={t.builtin} title={t.builtin?'基础类别保留，字段可自由删减':'删除类型'} className="text-danger" onClick={()=>fire(askDelete({type:'deleteObjectType',id:t.id},`删除「${t.name}」类型`))}>删除类型</button></div></>}</div>;
}
