import { useId, useState, type ReactNode } from 'react';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import type { NarrativeScene, NovelObject, Passage, SourceReference, StateChange, Workspace } from '../shared/types';
import { ASPECT_KEY_CHARS, ASPECT_VALUE_CHARS, aspectKey, aspectLabel, aspectsFor, changePlace, MAX_STATE_ASPECTS, sceneSubjects, STATE_ASPECTS, storyTimeline, type StatePoint } from '../shared/story-state';
import { continueSceneCommands, orderedChapters, orderedScenes, passageLabel, passageOrderAt, proseChars, scenePassages } from '../shared/structure';
import { Field, Select, fire, uid, type Commit } from './ui';
import type { AskDelete } from './types';

type OpenReference = (kind: SourceReference['kind'], id: string) => void;
const chapterTitle = (w: Workspace, id: string) => w.chapters.find(chapter => chapter.id === id)?.title ?? '';
/** Characters and settings whose state can change: everything but world events. */
const stateSubjects = (w: Workspace) => w.objects.filter(object => !object.event);

/** A subject's state at a point, one line per aspect; hovering shows where the value was set. */
function HeldState({ workspace: w, subjectId, point, empty }: { workspace: Workspace; subjectId: string; point: StatePoint; empty: string }) {
  const held = [...storyTimeline(w).stateAt(subjectId, point).values()];
  if (!held.length) return empty ? <p className="muted state-empty">{empty}</p> : null;
  return <dl className="state-aspects">{held.map(item => <div key={item.key} title={`记于 ${changePlace(w, item.change) || '…'}`}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}

/** One new aspect: a built-in one (心理、视角…) or the author's own label, and what it becomes. */
function AspectAdder({ subject, taken, onAdd, submitLabel }: { subject?: NovelObject; taken: string[]; onAdd: (key: string, value: string) => Promise<unknown>; submitLabel: string }) {
  const suggestions = (subject ? aspectsFor(subject) : STATE_ASPECTS).filter(aspect => !taken.includes(aspect.key));
  const [label, setLabel] = useState(suggestions[0]?.label ?? '');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const listId = useId();
  const key = aspectKey(label), hint = STATE_ASPECTS.find(aspect => aspect.key === key)?.hint;
  const full = taken.length >= MAX_STATE_ASPECTS;
  const invalid = !key || key.length > ASPECT_KEY_CHARS || taken.includes(key) || full;
  const submit = () => {
    if (invalid || !value.trim() || busy) return;
    setBusy(true);
    fire(onAdd(key, value.trim()).then(() => { setValue(''); setLabel(suggestions.find(aspect => aspect.key !== key)?.label ?? ''); }).finally(() => setBusy(false)));
  };
  return <div className="aspect-adder">
    <input list={listId} aria-label="状态方面" value={label} maxLength={ASPECT_KEY_CHARS} placeholder="方面：心理、境界…" onChange={event => setLabel(event.target.value)}/>
    <datalist id={listId}>{suggestions.map(aspect => <option key={aspect.key} value={aspect.label}>{aspect.hint}</option>)}</datalist>
    <textarea aria-label="变化后的状态" rows={2} value={value} maxLength={ASPECT_VALUE_CHARS} placeholder={full ? `一条变化最多 ${MAX_STATE_ASPECTS} 个方面` : taken.includes(key) ? '这个方面已经写了，直接在上面修改' : hint ? `从此以后的${label}：${hint}` : '从此以后的状态'}
      onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); } }}/>
    <button className="small" disabled={busy || invalid || !value.trim()} onClick={submit}><Plus aria-hidden="true"/>{submitLabel}</button>
  </div>;
}

/** An editable change: each aspect it sets, the author's note, and where it happens. */
export function StateChangeCard({ workspace: w, change, commit, askDelete, heading }: { workspace: Workspace; change: StateChange; commit: Commit; askDelete: AskDelete; heading: ReactNode }) {
  const subject = w.objects.find(object => object.id === change.subjectId);
  const event = change.eventId ? w.objects.find(object => object.id === change.eventId) : undefined;
  const update = (build: (item: StateChange) => StateChange) => commit(current => {
    const item = current.stateChanges.find(value => value.id === change.id);
    return item ? [{ type: 'putStateChange', value: build(structuredClone(item)) }] : [];
  }, '调整状态变化');
  const setAspect = (key: string, value: string) => update(item => {
    if (value.trim()) item.aspects[key] = value;
    else if (Object.keys(item.aspects).length > 1) delete item.aspects[key];
    else throw new Error('一条变化至少写一个方面；不再需要时请删除这条变化。');
    return item;
  });
  const setNote = (value: string) => update(item => { delete item.note; return value.trim() ? { ...item, note: value } : item; });
  return <div className="nested-card state-change" data-testid="state-change">
    <div className="state-change-head">{heading}{event && <span className="pill" title="伴随的世界事件">{event.name}</span>}</div>
    {Object.entries(change.aspects).map(([key, value]) => <Field key={key} label={aspectLabel(key)} multiline value={value} onSave={next => setAspect(key, next)}/>)}
    <AspectAdder subject={subject} taken={Object.keys(change.aspects)} submitLabel="添加方面" onAdd={(key, value) => update(item => ({ ...item, aspects: { ...item.aspects, [key]: value } }))}/>
    <Field label="备注（为什么变、正文怎样体现）" multiline value={change.note ?? ''} placeholder="只给作者和 AI 参考，不会变成人物所知" onSave={setNote}/>
    <div className="button-row"><button className="text-danger small" onClick={() => fire(askDelete({ type: 'deleteStateChange', id: change.id }, `删除${subject?.name ?? ''}的状态变化`))}><Trash2 aria-hidden="true"/>删除这条变化</button></div>
  </div>;
}

/** Record a change: who, where (the scene, one passage of it, a world event) and its first aspect. A change at the same place for the
 * same subject takes the new aspect instead, since each subject has one change per place. */
function NewChangeForm({ workspace: w, commit, subjects, scene: fixedScene, passage: defaultPassage }: { workspace: Workspace; commit: Commit; subjects: NovelObject[]; scene?: NarrativeScene; passage?: Passage }) {
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? '');
  const [sceneId, setSceneId] = useState(fixedScene?.id ?? '');
  const [passageId, setPassageId] = useState(defaultPassage && defaultPassage.sceneId === fixedScene?.id ? defaultPassage.id : '');
  const [eventId, setEventId] = useState('');
  const scene = w.scenes.find(item => item.id === sceneId);
  const parts = scene ? scenePassages(w, scene.id) : [];
  const events = w.objects.filter(object => object.event && (!scene || scene.eventIds.includes(object.id))).sort((a, b) => a.event!.worldOrder - b.event!.worldOrder);
  const subject = w.objects.find(object => object.id === subjectId);
  const passage = parts.length > 1 ? parts.find(item => item.id === passageId) : undefined;
  const event = events.find(item => item.id === eventId);
  const existing = w.stateChanges.find(change => change.subjectId === subjectId && change.sceneId === (scene?.id) && change.passageId === passage?.id && change.eventId === event?.id);
  const add = (key: string, value: string) => commit(current => {
    const anchor = { subjectId, ...(scene ? { sceneId: scene.id } : {}), ...(passage ? { passageId: passage.id } : {}), ...(event ? { eventId: event.id } : {}) };
    const same = current.stateChanges.find(change => change.subjectId === subjectId && change.sceneId === anchor.sceneId && change.passageId === anchor.passageId && change.eventId === anchor.eventId);
    return [{ type: 'putStateChange', value: same ? { ...same, aspects: { ...same.aspects, [key]: value } } : { id: uid(), ...anchor, aspects: { [key]: value } } }];
  }, '记下状态变化');
  const others = stateSubjects(w).filter(object => !subjects.some(item => item.id === object.id));
  return <div className="new-change" data-testid="new-state-change">
    <div className="form-grid">
      {subjects.length === 1 && !fixedScene ? null : <Select label="谁在变" value={subjectId} onChange={setSubjectId}>
        {!subjectId && <option value="">选择人物或环境</option>}
        {subjects.length > 0 && <optgroup label="这一场的人物与环境">{subjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>}
        {others.length > 0 && <optgroup label="其他">{others.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>}
      </Select>}
      {!fixedScene && <Select label="在哪一场" value={sceneId} onChange={value => { setSceneId(value); setPassageId(''); setEventId(''); }}>
        <option value="">不在具体场景（只按世界事件）</option>
        {orderedScenes(w).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </Select>}
      {parts.length > 1 && <Select label="哪一段" value={passageId} onChange={setPassageId}>
        <option value="">整场结束时</option>
        {parts.map(item => <option key={item.id} value={item.id}>{chapterTitle(w, item.chapterId)} · {passageLabel(w, item)}</option>)}
      </Select>}
      {(events.length > 0 || !scene) && <Select label={scene ? '伴随的世界事件（可选）' : '世界事件'} value={eventId} onChange={setEventId}>
        <option value="">{scene ? '无' : '选择事件'}</option>
        {events.map(item => <option key={item.id} value={item.id}>#{item.event!.worldOrder} {item.name}</option>)}
      </Select>}
    </div>
    {subject && (scene || event) ? <AspectAdder key={`${subjectId}:${sceneId}:${passageId}:${eventId}`} subject={subject} taken={Object.keys(existing?.aspects ?? {})} submitLabel={existing ? '补进这条变化' : '记下变化'} onAdd={add}/>
      : <p className="muted">{subject ? '选一场或一个世界事件，变化从那里开始生效。' : '先选择人物或环境。'}</p>}
  </div>;
}

/** Where a scene is read: one passage per chapter it runs through, each with what it covers, and placing it in more chapters. */
export function ScenePassages({ workspace: w, scene, commit, askDelete, current, onOpenPassage }: { workspace: Workspace; scene: NarrativeScene; commit: Commit; askDelete: AskDelete; current?: Passage; onOpenPassage?: (id: string) => void }) {
  const parts = scenePassages(w, scene.id);
  const open = (id: string | undefined) => { if (id && onOpenPassage) onOpenPassage(id); };
  const continueScene = () => {
    let created: string | undefined;
    fire(commit(latest => { const last = scenePassages(latest, scene.id).at(-1); if (!last) return []; const result = continueSceneCommands(latest, last.id, uid); created = result.passage.id; return result.commands; }, '场景延续到下一章').then(() => open(created)));
  };
  const place = (chapterId: string) => {
    if (!chapterId) return;
    const id = uid();
    fire(commit(latest => [{ type: 'putPassage', value: { id, sceneId: scene.id, chapterId, order: passageOrderAt(latest, chapterId), text: '' } }], '场景放进章节').then(() => open(id)));
  };
  const setBeat = (part: Passage, beat: string) => commit(latest => {
    const item = latest.passages.find(value => value.id === part.id);
    if (!item) return [];
    const value = { ...item }; delete value.beat;
    return [{ type: 'putPassage', value: beat.trim() ? { ...value, beat } : value }];
  }, '调整场景段要点');
  return <section className="subsection scene-passages" data-testid="scene-passages">
    <h3>{parts.length > 1 ? `跨 ${new Set(parts.map(part => part.chapterId)).size} 章，共 ${parts.length} 段` : '所在章节'}</h3>
    {!parts.length && <p className="muted">这一场还没放进任何章节，写作台里看不到它。</p>}
    {parts.map((part, index) => <div className={`nested-card passage-card ${part.id === current?.id ? 'current' : ''}`} key={part.id}>
      <div className="passage-card-head">
        <strong>{chapterTitle(w, part.chapterId)}{parts.length > 1 && ` · 第 ${index + 1} 段`}</strong>
        <small className={proseChars(part.text) ? '' : 'blank'}>{proseChars(part.text) ? `${proseChars(part.text).toLocaleString()} 字` : '空白'}</small>
        {onOpenPassage && part.id !== current?.id && <button className="link-button" onClick={() => open(part.id)}>打开</button>}
        {parts.length > 1 && <button className="icon-button ghost small text-danger" title="删除这一段" aria-label="删除这一段" onClick={() => fire(askDelete({ type: 'deletePassage', id: part.id }, `删除「${scene.title}」在${chapterTitle(w, part.chapterId)}的一段`))}><Trash2/></button>}
      </div>
      {parts.length > 1 && <Field label="这一段写到哪里" multiline value={part.beat ?? ''} placeholder="例如：对峙开始，到他亮出底牌为止" onSave={beat => setBeat(part, beat)}/>}
    </div>)}
    <div className="button-row">
      {parts.length > 0 && <button className="small" data-testid="continue-scene" onClick={continueScene}><ArrowRight aria-hidden="true"/>延续到下一章</button>}
      <Select ariaLabel={parts.length ? '也放进其他章节' : '放进章节'} value="" onChange={place}>
        <option value="">{parts.length ? '也放进…' : '放进章节…'}</option>
        {orderedChapters(w).map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}
      </Select>
    </div>
  </section>;
}

/** The people and places of a scene as it begins, and how the scene changes them. */
export function SceneState({ workspace: w, scene, passage, commit, askDelete }: { workspace: Workspace; scene: NarrativeScene; passage?: Passage; commit: Commit; askDelete: AskDelete }) {
  const timeline = storyTimeline(w), subjects = sceneSubjects(w, scene), parts = scenePassages(w, scene.id);
  const here = passage && passage.sceneId === scene.id ? passage : undefined;
  const point: StatePoint = here && parts.length > 1 ? { passageId: here.id } : { sceneId: scene.id };
  const own = timeline.ordered.filter(change => change.sceneId === scene.id);
  const name = (id: string) => w.objects.find(object => object.id === id)?.name ?? '已删除';
  const where = (change: StateChange) => { const part = change.passageId ? w.passages.find(item => item.id === change.passageId) : undefined; return part ? ` · ${chapterTitle(w, part.chapterId)}那一段` : ''; };
  return <>
    <details className="subsection scene-state" open data-testid="scene-state-before">
      <summary>{'passageId' in point ? '本段开始时的状态' : '进入这一场时的状态'}</summary>
      <p className="muted">由此前的情节造成。按故事时间推算，倒叙的场景看到的是它那个时间的状态。</p>
      {subjects.length ? subjects.map(subject => <div className="state-subject" key={subject.id}><strong>{subject.name}</strong><HeldState workspace={w} subjectId={subject.id} point={point} empty="还没有记下的状态"/></div>)
        : <p className="muted">先选好视角、出场人物和发生地点。</p>}
    </details>
    <details className="subsection scene-changes" open data-testid="scene-changes">
      <summary>这一场的变化{own.length > 0 && <small> {own.length}</small>}</summary>
      <p className="muted">人物与环境在这一场里的变化就是情节。只写变了的方面，其余沿用此前的状态；AI 写这一场时会把它写出来。</p>
      {own.map(change => <StateChangeCard key={change.id} workspace={w} change={change} commit={commit} askDelete={askDelete} heading={<strong>{name(change.subjectId)}{where(change)}</strong>}/>)}
      <NewChangeForm key={scene.id} workspace={w} commit={commit} subjects={subjects} scene={scene} passage={here}/>
    </details>
  </>;
}

/** A character's or setting's changes in story order, its state by the end of the book, and adding a change anywhere in the story. */
export function StateTimeline({ workspace: w, object, commit, askDelete, onOpenReference }: { workspace: Workspace; object: NovelObject; commit: Commit; askDelete: AskDelete; onOpenReference: OpenReference }) {
  const history = storyTimeline(w).history(object.id), isCharacter = object.typeId === 'character';
  const openPlace = (change: StateChange) => { if (change.sceneId) onOpenReference('scene', change.sceneId); else if (change.eventId) onOpenReference('object', change.eventId); };
  return <details className="subsection state-timeline" data-testid="state-timeline" open={history.length > 0}>
    <summary>状态演进{history.length > 0 && <small> {history.length}</small>}</summary>
    <p className="muted">{isCharacter ? '心理、视角、认知与其它状态随情节变化，变化本身就是情节。按故事时间排列，倒叙的场景排在它的时间上。' : '环境的样貌、氛围与处境也随情节变化。按故事时间排列。'}</p>
    {history.length > 0 && <div className="state-now"><span className="eyebrow">到目前为止</span><HeldState workspace={w} subjectId={object.id} point={{ end: true }} empty=""/></div>}
    <ol className="state-history">{history.map(change => <li key={change.id}><StateChangeCard workspace={w} change={change} commit={commit} askDelete={askDelete}
      heading={<button className="link-button" title="打开这一场" onClick={() => openPlace(change)}>{changePlace(w, change) || '未定位'}</button>}/></li>)}</ol>
    <NewChangeForm workspace={w} commit={commit} subjects={[object]}/>
  </details>;
}
