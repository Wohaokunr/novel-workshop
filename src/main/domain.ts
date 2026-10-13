import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CanvasCard, Command, NarrativeScene, Workspace, NovelObject, ObjectType } from '../shared/types.js';
import { personNames, STYLE_KEYS, STYLE_LIMITS, STYLE_SCALES, styleProfile, type StyleProfile } from '../shared/style-types.js';
import { ASPECT_KEY_CHARS, ASPECT_VALUE_CHARS, MAX_STATE_ASPECTS } from '../shared/story-state.js';
import { chapterProse, orderedChapters, passageOrderAt } from '../shared/structure.js';
import { upgradeCommand } from './upgrade.js';

export const builtinTypes: ObjectType[] = [
  { id: 'character', name: '人物', builtin: true, fields: [
    { id: 'description', label: '作者设定', kind: 'text' },
    { id: 'selfKnowledge', label: '角色的自我认知（可进入角色视角）', kind: 'text' },
    { id: 'goal', label: '创作目标', kind: 'text' },
  ] },
  { id: 'event', name: '情节', builtin: true, fields: [
    { id: 'description', label: '世界中发生的事情', kind: 'text' },
    { id: 'purpose', label: '创作意图', kind: 'text' },
  ] },
  { id: 'setting', name: '环境', builtin: true, fields: [
    { id: 'description', label: '环境设定', kind: 'text' },
    { id: 'rules', label: '世界规则', kind: 'text' },
  ] },
];

export function createWorkspace(title: string, id: string = randomUUID()): Workspace {
  const workspace: Workspace = {
    schemaVersion: 2, id, title: title.trim() || '未命名小说', brief: '', genre: '', audience: '', theme: '', logline: '', structureTemplate: '', acts: [], revision: 0,
    objectTypes: structuredClone(builtinTypes), objects: [],
    chapters: [{ id: randomUUID(), title: '第一章', order: 0 }], scenes: [], passages: [],
    facts: [], knowledge: [], stateChanges: [], cards: [], canvasLinks: [], layouts: {},
    reading: { scroll: 0, fontSize: 20, lineHeight: 1.9, theme: 'paper' },
  };
  validateWorkspace(workspace);
  return workspace;
}

/** Project-level string fields that updateNovel may patch; it may also set chapterTarget (null returns to the default). */
export const NOVEL_FIELDS = ['title', 'brief', 'genre', 'audience', 'theme', 'logline', 'structureTemplate'] as const;
export const CHAPTER_TARGET_RANGE = [100, 100_000] as const;

export class DomainValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'DomainValidationError'; }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainValidationError(message);
}
function text(value: unknown, label: string, nonempty = false): asserts value is string {
  check(typeof value === 'string' && (!nonempty || value.trim().length > 0), `${label}必须是${nonempty ? '非空' : ''}字符串`);
}
function number(value: unknown, label: string): asserts value is number {
  check(typeof value === 'number' && Number.isFinite(value), `${label}必须是有限数字`);
}
function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}必须是对象`);
}
function ids<T extends { id: string }>(items: T[], label: string): Map<string, T> {
  check(Array.isArray(items), `${label}必须是列表`);
  const result = new Map<string, T>();
  for (const item of items) {
    record(item, label); text(item.id, `${label} ID`, true);
    check(!result.has(item.id), `${label} ID 重复：${item.id}`); result.set(item.id, item);
  }
  return result;
}
function strings(value: unknown, label: string): asserts value is string[] {
  check(Array.isArray(value) && value.every(v => typeof v === 'string'), `${label}必须是字符串列表`);
  check(new Set(value).size === value.length, `${label}不能包含重复项`);
}

/** Validate the complete resulting workspace, allowing commands to fix dependencies together. */
export function validateWorkspace(workspace: Workspace): void {
  record(workspace, '项目'); check(workspace.schemaVersion === 2, '不支持的项目格式版本');
  text(workspace.id, '项目 ID', true); text(workspace.title, '书名', true);
  for (const key of ['brief', 'genre', 'audience'] as const) text(workspace[key], key);
  if (workspace.theme !== undefined) text(workspace.theme, '小说立意');
  if (workspace.logline !== undefined) text(workspace.logline, '一句话梗概');
  if (workspace.structureTemplate !== undefined) text(workspace.structureTemplate, '结构模板');
  check(Number.isSafeInteger(workspace.revision) && workspace.revision >= 0, '项目修订号无效');
  if (workspace.chapterTarget !== undefined) check(Number.isSafeInteger(workspace.chapterTarget) && workspace.chapterTarget >= CHAPTER_TARGET_RANGE[0]
    && workspace.chapterTarget <= CHAPTER_TARGET_RANGE[1], `每章目标字数须是 ${CHAPTER_TARGET_RANGE[0]}–${CHAPTER_TARGET_RANGE[1]} 的整数`);
  const types = ids(workspace.objectTypes, '对象类型');
  const objects = ids(workspace.objects, '对象');
  check(workspace.acts === undefined || Array.isArray(workspace.acts), '卷必须是列表');
  const acts = ids(workspace.acts ?? [], '卷');
  const actOrders = new Set<number>();
  for (const act of acts.values()) {
    text(act.title, '卷标题', true); number(act.order, '卷顺序'); text(act.purpose, '卷的作用'); text(act.summary, '卷概要');
    check(!actOrders.has(act.order), '卷的顺序不能重复'); actOrders.add(act.order);
  }
  const chapters = ids(workspace.chapters, '章节');
  const scenes = ids(workspace.scenes, '场景');
  const passages = ids(workspace.passages, '场景段');
  const facts = ids(workspace.facts, '事实');
  ids(workspace.knowledge, '角色知识');
  const stateChanges = ids(workspace.stateChanges, '状态变化');
  const cards = ids(workspace.cards, '画布卡片');
  ids(workspace.canvasLinks, '画布关联');
  for (const builtin of builtinTypes) check(types.get(builtin.id)?.builtin === true, `内置类型 ${builtin.name} 不可删除或改为自定义类型`);
  for (const type of types.values()) {
    text(type.name, '类型名称', true);
    check(type.builtin === undefined || typeof type.builtin === 'boolean', '内置类型标记无效');
    check(!type.builtin || builtinTypes.some(b => b.id === type.id), '自定义类型不能标为内置类型');
    const fields = ids(type.fields, '类型字段');
    for (const field of fields.values()) {
      text(field.label, '字段名称', true);
      check(['text', 'number', 'choice', 'reference'].includes(field.kind), '字段类型无效');
      if (field.options !== undefined) strings(field.options, '字段选项');
      if (field.kind === 'choice') check(field.options && field.options.length > 0, '选择字段需要选项');
    }
  }
  const isCharacter = (id: string) => objects.get(id)?.typeId === 'character';
  const isEvent = (id: string) => objects.get(id)?.typeId === 'event';
  for (const object of objects.values()) {
    text(object.name, '对象名称', true); text(object.typeId, '对象类型 ID', true);
    if (object.aliases !== undefined) {
      strings(object.aliases, '对象别名');
      check(object.aliases.length <= 20 && object.aliases.every(alias => alias.trim() && alias.length <= 40), `对象 ${object.name} 的别名无效：最多 20 个，每个 1–40 字`);
    }
    const type = types.get(object.typeId); check(type, `对象 ${object.name} 的类型不存在`);
    record(object.fields, '对象字段');
    for (const [key, value] of Object.entries(object.fields)) {
      const field = type.fields.find(f => f.id === key); check(field, `对象 ${object.name} 包含未定义字段 ${key}`);
      if (value === null) continue;
      if (field.kind === 'text') check(typeof value === 'string' || typeof value === 'boolean' || (Array.isArray(value) && value.every(v => typeof v === 'string')), `字段 ${field.label} 需要文本`);
      if (field.kind === 'number') number(value, field.label);
      if (field.kind === 'choice') check(typeof value === 'string' && field.options?.includes(value), `字段 ${field.label} 的选项无效`);
      if (field.kind === 'reference') {
        const references = typeof value === 'string' ? [value] : value;
        strings(references, field.label);
        for (const ref of references) check(objects.has(ref), `字段 ${field.label} 引用了不存在的对象`);
      }
    }
    check(object.typeId === 'event' ? !!object.event : object.event === undefined, `对象 ${object.name} 的情节数据与类型不一致`);
    if (!object.event) continue;
    const event = object.event;
    number(event.worldOrder, '世界时间'); text(event.timeLabel, '时间描述'); text(event.thread, '情节线');
    check(typeof event.critical === 'boolean', '关键情节标记无效');
    strings(event.participants, '事件参与者'); strings(event.causes, '因果前序'); record(event.observations, '角色现场感知');
    for (const id of event.participants) check(objects.has(id), `事件 ${object.name} 的参与对象不存在`);
    for (const id of event.causes) check(isEvent(id) && id !== object.id, `事件 ${object.name} 的因果前序无效`);
    for (const [id, perception] of Object.entries(event.observations)) {
      check(isCharacter(id), '现场感知必须属于人物'); text(perception, '现场感知');
    }
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(object: NovelObject): void {
    if (visited.has(object.id)) return;
    check(!visiting.has(object.id), '事件因果图不能成环'); visiting.add(object.id);
    for (const id of object.event!.causes) visit(objects.get(id)!);
    visiting.delete(object.id); visited.add(object.id);
  }
  for (const object of objects.values()) if (object.event) visit(object);
  for (const object of objects.values()) if (object.event) for (const id of object.event.causes) {
    check(objects.get(id)!.event!.worldOrder < object.event.worldOrder, `因果前序必须早于事件 ${object.name}`);
  }
  const chapterOrders = new Set<number>();
  for (const chapter of chapters.values()) {
    text(chapter.title, '章节标题', true); number(chapter.order, '章节顺序');
    check(!chapterOrders.has(chapter.order), '章节阅读顺序不能重复'); chapterOrders.add(chapter.order);
    if (chapter.summary !== undefined) text(chapter.summary, '章节概要');
    if (chapter.actId !== undefined) check(acts.has(chapter.actId), '章节所属的卷不存在');
  }
  for (const scene of scenes.values()) {
    text(scene.title, '场景标题', true);
    for (const key of ['chapterId', 'order', 'text']) check(!Object.hasOwn(scene, key), `场景「${scene.title}」不再直接属于章节或包含正文（${key}），正文属于场景段`);
    check(scene.povId === null || isCharacter(scene.povId), '场景视角必须是人物或全知视角');
    strings(scene.eventIds, '场景事件'); for (const id of scene.eventIds) check(isEvent(id), '场景引用的事件不存在');
    if (scene.castIds !== undefined) { strings(scene.castIds, '出场人物'); for (const id of scene.castIds) check(isCharacter(id), '出场人物必须是人物'); }
    if (scene.settingIds !== undefined) { strings(scene.settingIds, '场景环境'); for (const id of scene.settingIds) check(objects.has(id) && !isCharacter(id) && !isEvent(id), '场景环境必须是环境或设定对象'); }
    text(scene.outline, '场景大纲');
  }
  const passageOrders = new Set<string>();
  for (const passage of passages.values()) {
    check(scenes.has(passage.sceneId), '场景段所属的场景不存在');
    check(chapters.has(passage.chapterId), '场景段所属的章节不存在');
    number(passage.order, '场景段顺序'); text(passage.text, '正文');
    if (passage.beat !== undefined) text(passage.beat, '场景段要点');
    const key = `${passage.chapterId}:${passage.order}`; check(!passageOrders.has(key), '同一章节中场景段的顺序不能重复'); passageOrders.add(key);
  }
  for (const fact of facts.values()) {
    check(objects.has(fact.subjectId), '事实所属对象不存在'); text(fact.key, '事实属性', true); text(fact.value, '事实内容');
    check(fact.fromEventId === null || isEvent(fact.fromEventId), '事实来源事件不存在');
    if (fact.replacesId !== undefined) {
      const prior = facts.get(fact.replacesId); check(prior && prior.id !== fact.id, '被替代的事实不存在');
      check(prior.subjectId === fact.subjectId && prior.key === fact.key, '只能替代同一对象的同一事实属性');
      check(fact.fromEventId !== null, '事实变化需要明确的事件来源');
      const previousTime = prior.fromEventId ? objects.get(prior.fromEventId)!.event!.worldOrder : -Infinity;
      check(previousTime < objects.get(fact.fromEventId)!.event!.worldOrder, '事实变化必须发生在旧事实之后');
    }
  }
  for (const knowledge of workspace.knowledge) {
    check(isCharacter(knowledge.characterId), '知识所属人物不存在'); text(knowledge.content, '知识内容', true);
    check(['initial', 'witness', 'told', 'belief'].includes(knowledge.source), '知识来源类型无效');
    check(knowledge.learnedAt === null || isEvent(knowledge.learnedAt), '知识获知事件不存在');
    check(knowledge.source !== 'initial' || knowledge.learnedAt === null, '初始知识不能挂在后续事件');
    check(!['witness', 'told'].includes(knowledge.source) || knowledge.learnedAt !== null, '亲历或告知的知识需要获知事件');
    if (knowledge.fromCharacterId !== undefined) check(knowledge.source === 'told' && isCharacter(knowledge.fromCharacterId), '传播来源必须是告知知识的人物');
    if (knowledge.factId !== undefined) {
      const fact = facts.get(knowledge.factId); check(fact, '知识引用的事实不存在');
      if (fact.fromEventId !== null) {
        check(knowledge.learnedAt !== null && objects.get(fact.fromEventId)!.event!.worldOrder <= objects.get(knowledge.learnedAt)!.event!.worldOrder, '不能在事实发生前将其标为已知');
      }
    }
  }
  const changeAnchors = new Set<string>();
  for (const change of stateChanges.values()) {
    const subject = objects.get(change.subjectId);
    check(subject && !subject.event, '状态变化必须属于人物、环境或其它设定对象');
    check(change.sceneId !== undefined || change.eventId !== undefined, '状态变化需要所在场景或世界事件');
    if (change.sceneId !== undefined) check(scenes.has(change.sceneId), '状态变化所在的场景不存在');
    if (change.passageId !== undefined) check(change.sceneId !== undefined && passages.get(change.passageId)?.sceneId === change.sceneId, '状态变化所在的场景段不属于该场景');
    if (change.eventId !== undefined) {
      check(isEvent(change.eventId), '状态变化对应的世界事件不存在');
      if (change.sceneId !== undefined) check(scenes.get(change.sceneId)!.eventIds.includes(change.eventId), '状态变化对应的事件不在该场景中');
    }
    record(change.aspects, '状态内容');
    const aspects = Object.entries(change.aspects);
    check(aspects.length >= 1 && aspects.length <= MAX_STATE_ASPECTS, `一条状态变化写 1–${MAX_STATE_ASPECTS} 个方面`);
    for (const [key, value] of aspects) {
      check(key.trim() === key && key.length >= 1 && key.length <= ASPECT_KEY_CHARS, `状态方面的名称须为 1–${ASPECT_KEY_CHARS} 字`);
      text(value, `状态「${key}」`, true); check(value.length <= ASPECT_VALUE_CHARS, `状态「${key}」过长`);
    }
    if (change.note !== undefined) text(change.note, '状态变化备注');
    const anchor = JSON.stringify([change.subjectId, change.sceneId ?? null, change.passageId ?? null, change.eventId ?? null]);
    check(!changeAnchors.has(anchor), `${subject.name}在同一位置只能有一条状态变化`); changeAnchors.add(anchor);
  }
  for (const card of cards.values()) {
    check(['note', 'object', 'scene', 'group'].includes(card.kind), '画布卡片类型无效');
    text(card.title, '卡片标题'); text(card.content, '卡片内容'); number(card.x, '卡片 X'); number(card.y, '卡片 Y');
    for (const key of ['width', 'height'] as const) if (card[key] !== undefined) {
      number(card[key], `卡片 ${key}`); check(card[key]! > 0, '卡片尺寸必须大于零');
    }
    check(card.collapsed === undefined || typeof card.collapsed === 'boolean', '卡片折叠状态无效');
    if (card.kind === 'object') check(card.refId && objects.has(card.refId), '画布对象引用不存在');
    if (card.kind === 'scene') check(card.refId && scenes.has(card.refId), '画布场景引用不存在');
    if (card.groupId !== undefined) check(cards.get(card.groupId)?.kind === 'group' && card.groupId !== card.id, '画布分组不存在或包含自己');
    const ancestors = new Set<string>([card.id]); let parent = card.groupId;
    while (parent) { check(!ancestors.has(parent), '画布分组不能成环'); ancestors.add(parent); parent = cards.get(parent)?.groupId; }
  }
  for (const link of workspace.canvasLinks) check(cards.has(link.source) && cards.has(link.target) && link.source !== link.target, '画布关联端点不存在或相同');
  if (workspace.style !== undefined) validateStyle(workspace.style, id => isCharacter(id));
  record(workspace.layouts, '图布局');
  for (const position of Object.values(workspace.layouts)) { record(position, '图位置'); number(position.x, '图 X'); number(position.y, '图 Y'); }
  record(workspace.reading, '阅读设置'); number(workspace.reading.scroll, '阅读进度'); number(workspace.reading.fontSize, '阅读字号'); number(workspace.reading.lineHeight, '阅读行距');
  check(workspace.reading.scroll >= 0 && workspace.reading.fontSize > 0 && workspace.reading.lineHeight > 0, '阅读参数无效');
  check(['paper', 'dark'].includes(workspace.reading.theme), '阅读主题无效');
  if (workspace.reading.chapterId !== undefined) check(chapters.has(workspace.reading.chapterId), '阅读章节不存在');
}

function validateStyle(style: StyleProfile, isCharacter: (id: string) => boolean): void {
  record(style, '文风档案');
  for (const key of Object.keys(style)) check((STYLE_KEYS as readonly string[]).includes(key), `文风档案包含未知字段 ${key}`);
  text(style.summary, '文风画像'); check(style.summary.length <= STYLE_LIMITS.summary, '文风画像过长');
  record(style.dials, '笔调旋钮');
  for (const [key, value] of Object.entries(style.dials)) {
    if (key === 'person') { check(value === null || Object.hasOwn(personNames, value as string), '叙述人称无效'); continue; }
    check((STYLE_SCALES as readonly string[]).includes(key), `未知笔调旋钮 ${key}`);
    check(value === null || (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5), '笔调旋钮必须是 1–5 档或未设定');
  }
  const rules = ids(style.rules, '文风规则');
  check(rules.size <= STYLE_LIMITS.rules, `文风规则最多 ${STYLE_LIMITS.rules} 条`);
  const suggestions = ids(style.suggestions, '文风建议');
  const origins = ['author', 'samples', 'edits', 'rejection', 'blindtest', 'choice'];
  for (const rule of [...rules.values(), ...suggestions.values()]) {
    check(rule.kind === 'do' || rule.kind === 'avoid', '文风规则类型无效'); text(rule.content, '文风规则内容', true);
    check(origins.includes(rule.origin), '文风规则来源无效'); if (rule.evidence !== undefined) text(rule.evidence, '文风规则依据');
  }
  for (const key of ['preferWords', 'avoidWords'] as const) {
    strings(style[key], key === 'preferWords' ? '偏好词' : '禁用词');
    check(style[key].length <= STYLE_LIMITS.words && style[key].every(word => word.trim() && word.length <= 40), '词表条目无效或过多');
  }
  check(typeof style.blockAiCliches === 'boolean', 'AI 腔开关无效');
  const samples = ids(style.samples, '范文');
  check(samples.size <= STYLE_LIMITS.samples, `范文最多 ${STYLE_LIMITS.samples} 段`);
  let total = 0;
  for (const sample of samples.values()) {
    text(sample.label, '范文标题'); text(sample.text, '范文内容', true);
    check(sample.text.length <= STYLE_LIMITS.sampleChars, `单段范文最多 ${STYLE_LIMITS.sampleChars} 字`);
    check(sample.source === 'own' || sample.source === 'reference', '范文来源无效');
    for (const key of ['passageId', 'author', 'note'] as const) if (sample[key] !== undefined) text(sample[key], `范文 ${key}`);
    check(sample.pinned === undefined || typeof sample.pinned === 'boolean', '范文置顶标记无效');
    total += sample.text.length;
  }
  check(total <= STYLE_LIMITS.samplesTotal, `范文合计最多 ${STYLE_LIMITS.samplesTotal} 字`);
  check(Array.isArray(style.voices), '人物声音必须是列表');
  const voiced = new Set<string>();
  for (const voice of style.voices) {
    record(voice, '人物声音'); check(isCharacter(voice.characterId), '人物声音所属人物不存在');
    check(!voiced.has(voice.characterId), '同一人物只能有一条声音设定'); voiced.add(voice.characterId);
    text(voice.voice, '人物声音'); check(voice.voice.length <= STYLE_LIMITS.voice, '人物声音设定过长');
  }
  check(suggestions.size <= STYLE_LIMITS.suggestions, '文风建议过多');
  for (const suggestion of suggestions.values()) {
    check(suggestion.status === 'pending' || suggestion.status === 'dismissed', '文风建议状态无效'); text(suggestion.createdAt, '文风建议时间', true);
    if (suggestion.word !== undefined) { record(suggestion.word, '文风建议词条'); check(suggestion.word.list === 'preferWords' || suggestion.word.list === 'avoidWords', '文风建议词表无效'); text(suggestion.word.value, '文风建议词条', true); }
  }
}

function put<T extends { id: string }>(items: T[], value: T): void {
  record(value, '操作实体'); text(value.id, '操作实体 ID', true);
  const index = items.findIndex(item => item.id === value.id);
  if (index < 0) items.push(structuredClone(value)); else items[index] = structuredClone(value);
}
function cleanCards(workspace: Workspace, removed: Set<string>): void {
  const original = new Map(workspace.cards.map(card => [card.id, card]));
  workspace.cards = workspace.cards.filter(card => !removed.has(card.id));
  for (const card of workspace.cards) if (card.groupId && removed.has(card.groupId)) {
    let parent = original.get(card.groupId)?.groupId;
    while (parent && removed.has(parent)) parent = original.get(parent)?.groupId;
    if (parent) card.groupId = parent; else delete card.groupId;
  }
  workspace.canvasLinks = workspace.canvasLinks.filter(link => !removed.has(link.source) && !removed.has(link.target));
  for (const id of removed) cleanLayout(workspace, id);
}
function cleanLayout(workspace: Workspace, id: string): void {
  for (const key of Object.keys(workspace.layouts)) if (key === id || key.endsWith(`:${id}`)) delete workspace.layouts[key];
}
function cleanFacts(workspace: Workspace, removed: Set<string>): void {
  workspace.facts = workspace.facts.filter(fact => !removed.has(fact.id));
  for (const fact of workspace.facts) if (fact.replacesId && removed.has(fact.replacesId)) delete fact.replacesId;
  for (const knowledge of workspace.knowledge) if (knowledge.factId && removed.has(knowledge.factId)) delete knowledge.factId;
}
/** A scene goes with its passages and the state changes that happen in it. */
function deleteScenes(workspace: Workspace, removed: Set<string>): void {
  workspace.scenes = workspace.scenes.filter(scene => !removed.has(scene.id));
  const passages = new Set(workspace.passages.filter(passage => removed.has(passage.sceneId)).map(passage => passage.id));
  workspace.passages = workspace.passages.filter(passage => !passages.has(passage.id));
  workspace.stateChanges = workspace.stateChanges.filter(change => !change.sceneId || !removed.has(change.sceneId));
  cleanCards(workspace, new Set(workspace.cards.filter(card => card.kind === 'scene' && card.refId && removed.has(card.refId)).map(card => card.id)));
  for (const id of [...removed, ...passages]) cleanLayout(workspace, id);
}
/** Changes on a removed passage stay with its scene as changes of the whole scene, unless the scene already has one for that subject. */
function deletePassages(workspace: Workspace, removed: Set<string>): void {
  workspace.passages = workspace.passages.filter(passage => !removed.has(passage.id));
  const kept = workspace.stateChanges.filter(change => !change.passageId || !removed.has(change.passageId));
  for (const change of workspace.stateChanges) if (change.passageId && removed.has(change.passageId)) {
    const lifted = { ...change }; delete lifted.passageId;
    if (!kept.some(other => other.subjectId === lifted.subjectId && other.sceneId === lifted.sceneId && !other.passageId && other.eventId === lifted.eventId)) kept.push(lifted);
  }
  workspace.stateChanges = kept;
  for (const id of removed) cleanLayout(workspace, id);
}
function deleteObject(workspace: Workspace, id: string): void {
  workspace.objects = workspace.objects.filter(object => object.id !== id);
  for (const object of workspace.objects) {
    const type = workspace.objectTypes.find(type => type.id === object.typeId);
    for (const field of type?.fields ?? []) if (field.kind === 'reference') {
      const value = object.fields[field.id];
      if (value === id) object.fields[field.id] = null;
      else if (Array.isArray(value)) object.fields[field.id] = value.filter(ref => ref !== id);
    }
    if (object.event) {
      object.event.participants = object.event.participants.filter(ref => ref !== id);
      object.event.causes = object.event.causes.filter(ref => ref !== id);
      delete object.event.observations[id];
    }
  }
  for (const scene of workspace.scenes) {
    scene.eventIds = scene.eventIds.filter(ref => ref !== id); if (scene.povId === id) scene.povId = null;
    if (scene.castIds) scene.castIds = scene.castIds.filter(ref => ref !== id);
    if (scene.settingIds) scene.settingIds = scene.settingIds.filter(ref => ref !== id);
  }
  cleanFacts(workspace, new Set(workspace.facts.filter(fact => fact.subjectId === id || fact.fromEventId === id).map(fact => fact.id)));
  workspace.knowledge = workspace.knowledge.filter(item => item.characterId !== id && item.learnedAt !== id);
  // A change placed in a scene outlives its event; one placed only at the event goes with it.
  workspace.stateChanges = workspace.stateChanges.filter(change => change.subjectId !== id && (change.eventId !== id || change.sceneId !== undefined));
  for (const change of workspace.stateChanges) if (change.eventId === id) delete change.eventId;
  for (const item of workspace.knowledge) if (item.fromCharacterId === id) delete item.fromCharacterId;
  cleanCards(workspace, new Set(workspace.cards.filter(card => card.kind === 'object' && card.refId === id).map(card => card.id)));
  if (workspace.style) workspace.style.voices = workspace.style.voices.filter(voice => voice.characterId !== id);
  cleanLayout(workspace, id);
}

export function cardContent({ x: _x, y: _y, width: _width, height: _height, collapsed: _collapsed, ...content }: CanvasCard) {
  if (content.refId === undefined) delete content.refId;
  if (content.groupId === undefined) delete content.groupId;
  return content;
}

function semantic(workspace: Workspace): unknown {
  return { title: workspace.title, brief: workspace.brief, genre: workspace.genre, audience: workspace.audience, theme: workspace.theme ?? '',
    logline: workspace.logline ?? '', structureTemplate: workspace.structureTemplate ?? '', acts: workspace.acts ?? [], chapterTarget: workspace.chapterTarget ?? null,
    objectTypes: workspace.objectTypes, objects: workspace.objects, chapters: workspace.chapters, scenes: workspace.scenes, passages: workspace.passages,
    facts: workspace.facts, knowledge: workspace.knowledge, stateChanges: workspace.stateChanges,
    cards: workspace.cards.map(cardContent), canvasLinks: workspace.canvasLinks, style: styleProfile(workspace) };
}

export function hasSemanticChanges(before: Workspace, after: Workspace): boolean {
  return !isDeepStrictEqual(semantic(before), semantic(after));
}

export function applyCommands(workspace: Workspace, commands: Command[]): Workspace {
  check(Array.isArray(commands), '操作必须是列表');
  const next = structuredClone(workspace);
  next.passages ??= []; next.stateChanges ??= [];
  next.theme ??= ''; next.logline ??= ''; next.structureTemplate ??= ''; next.acts ??= [];
  for (const raw of commands) {
    record(raw, '操作');
    text(raw.type, '操作类型', true);
    const command = upgradeCommand(raw);
    if (command.type.startsWith('delete')) text((command as { id?: unknown }).id, '删除 ID', true);
    switch (command.type) {
      case 'updateNovel': {
        record(command.patch, '小说更新');
        for (const [key, value] of Object.entries(command.patch)) {
          if (key === 'chapterTarget') {
            if (value === null) delete next.chapterTarget; else { number(value, '每章目标字数'); next.chapterTarget = value; }
            continue;
          }
          check(NOVEL_FIELDS.includes(key as typeof NOVEL_FIELDS[number]), '不允许修改此项目字段'); text(value, key);
          next[key as typeof NOVEL_FIELDS[number]] = value;
        }
        break;
      }
      case 'updateStyle': {
        record(command.patch, '文风更新');
        for (const key of Object.keys(command.patch)) check((STYLE_KEYS as readonly string[]).includes(key), `不允许修改文风字段 ${key}`);
        const current = styleProfile(next), patch = structuredClone(command.patch);
        next.style = { ...current, ...patch, dials: patch.dials ? { ...current.dials, ...patch.dials } : current.dials };
        break;
      }
      case 'putObjectType': {
        put(next.objectTypes, command.value);
        const allowed = new Set(ids(command.value.fields, '类型字段').keys());
        for (const object of next.objects.filter(object => object.typeId === command.value.id)) for (const key of Object.keys(object.fields)) if (!allowed.has(key)) delete object.fields[key];
        break;
      }
      case 'deleteObjectType': {
        check(!builtinTypes.some(type => type.id === command.id), '内置类型不可删除');
        for (const object of next.objects.filter(object => object.typeId === command.id)) deleteObject(next, object.id);
        next.objectTypes = next.objectTypes.filter(type => type.id !== command.id); break;
      }
      case 'putObject': put(next.objects, command.value); break;
      case 'deleteObject': deleteObject(next, command.id); break;
      case 'putChapter': put(next.chapters, command.value); break;
      case 'putAct': put(next.acts, command.value); break;
      case 'deleteAct':
        next.acts = next.acts.filter(act => act.id !== command.id);
        for (const chapter of next.chapters) if (chapter.actId === command.id) delete chapter.actId;
        break;
      case 'deleteChapter': {
        // Its passages go with it, and so do the scenes that had prose only in this chapter; scenes running on elsewhere stay.
        const removed = next.passages.filter(passage => passage.chapterId === command.id);
        const orphans = new Set(removed.map(passage => passage.sceneId).filter(sceneId => next.passages.every(passage => passage.sceneId !== sceneId || passage.chapterId === command.id)));
        deletePassages(next, new Set(removed.map(passage => passage.id)));
        deleteScenes(next, orphans);
        next.chapters = next.chapters.filter(chapter => chapter.id !== command.id);
        if (next.reading.chapterId === command.id) { delete next.reading.chapterId; next.reading.scroll = 0; }
        break;
      }
      case 'putScene': {
        record(command.value, '场景');
        // Format 1 kept a scene's prose on it, in one chapter: that part becomes the passage sharing the scene's id.
        const { chapterId, order, text: prose, ...scene } = command.value as NarrativeScene & { chapterId?: unknown; order?: unknown; text?: unknown };
        put(next.scenes, scene);
        strings(scene.eventIds, '场景事件');
        for (const change of next.stateChanges) if (change.sceneId === scene.id && change.eventId !== undefined && !scene.eventIds.includes(change.eventId)) delete change.eventId;
        if (chapterId !== undefined || order !== undefined || prose !== undefined) {
          const existing = next.passages.find(passage => passage.id === scene.id), target = chapterId ?? existing?.chapterId;
          text(target, '场景正文所属章节', true);
          put(next.passages, { id: scene.id, sceneId: scene.id, chapterId: target, text: prose === undefined ? existing?.text ?? '' : prose as string,
            order: order === undefined ? existing?.chapterId === target ? existing.order : passageOrderAt(next, target) : order as number,
            ...(existing?.beat !== undefined ? { beat: existing.beat } : {}) });
        }
        break;
      }
      case 'deleteScene': deleteScenes(next, new Set([command.id])); break;
      case 'putPassage': {
        put(next.passages, command.value);
        // A passage handed to another scene takes none of the old scene's changes along.
        for (const change of next.stateChanges) if (change.passageId === command.value.id && change.sceneId !== command.value.sceneId) delete change.passageId;
        break;
      }
      case 'deletePassage': deletePassages(next, new Set([command.id])); break;
      case 'putFact': put(next.facts, command.value); break;
      case 'deleteFact': cleanFacts(next, new Set([command.id])); break;
      case 'putKnowledge': put(next.knowledge, command.value); break;
      case 'deleteKnowledge': next.knowledge = next.knowledge.filter(item => item.id !== command.id); break;
      case 'putStateChange': put(next.stateChanges, command.value); break;
      case 'deleteStateChange': next.stateChanges = next.stateChanges.filter(item => item.id !== command.id); break;
      case 'putCard': put(next.cards, command.value); break;
      case 'deleteCard': cleanCards(next, new Set([command.id])); break;
      case 'putCanvasLink': put(next.canvasLinks, command.value); break;
      case 'deleteCanvasLink': next.canvasLinks = next.canvasLinks.filter(link => link.id !== command.id); break;
      case 'setLayout': text(command.key, '布局键', true); next.layouts[command.key] = structuredClone(command.value); break;
      case 'setReading': next.reading = structuredClone(command.value); break;
      default: throw new DomainValidationError(`未知操作类型：${String((command as { type: unknown }).type)}`);
    }
  }
  if (hasSemanticChanges(workspace, next)) next.revision++;
  validateWorkspace(next);
  return next;
}

/** The book's prose for export: every chapter with its title, or one chapter's prose alone. */
export function chapterText(workspace: Workspace, chapterId?: string): string {
  return orderedChapters(workspace).filter(chapter => !chapterId || chapter.id === chapterId)
    .map(chapter => [...(chapterId ? [] : [chapter.title]), chapterProse(workspace, chapter.id)].filter(Boolean).join('\n\n')).join('\n\n');
}
