import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CanvasCard, Command, Workspace, NovelObject, ObjectType } from '../shared/types.js';
import { personNames, STYLE_KEYS, STYLE_LIMITS, STYLE_SCALES, styleProfile, type StyleProfile } from '../shared/style-types.js';

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
    schemaVersion: 1, id, title: title.trim() || '未命名小说', brief: '', genre: '', audience: '', theme: '', logline: '', structureTemplate: '', acts: [], revision: 0,
    objectTypes: structuredClone(builtinTypes), objects: [],
    chapters: [{ id: randomUUID(), title: '第一章', order: 0 }], scenes: [],
    facts: [], knowledge: [], characterStates: [], cards: [], canvasLinks: [], layouts: {},
    reading: { scroll: 0, fontSize: 20, lineHeight: 1.9, theme: 'paper' },
  };
  validateWorkspace(workspace);
  return workspace;
}

/** Project-level string fields that updateNovel may patch. */
export const NOVEL_FIELDS = ['title', 'brief', 'genre', 'audience', 'theme', 'logline', 'structureTemplate'] as const;

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
  record(workspace, '项目'); check(workspace.schemaVersion === 1, '不支持的项目格式版本');
  text(workspace.id, '项目 ID', true); text(workspace.title, '书名', true);
  for (const key of ['brief', 'genre', 'audience'] as const) text(workspace[key], key);
  if (workspace.theme !== undefined) text(workspace.theme, '小说立意');
  if (workspace.logline !== undefined) text(workspace.logline, '一句话梗概');
  if (workspace.structureTemplate !== undefined) text(workspace.structureTemplate, '结构模板');
  check(Number.isSafeInteger(workspace.revision) && workspace.revision >= 0, '项目修订号无效');
  const types = ids(workspace.objectTypes, '对象类型');
  const objects = ids(workspace.objects, '对象');
  check(workspace.acts === undefined || Array.isArray(workspace.acts), '大纲幕/卷必须是列表');
  const acts = ids(workspace.acts ?? [], '大纲幕/卷');
  const actOrders = new Set<number>();
  for (const act of acts.values()) {
    text(act.title, '幕/卷标题', true); number(act.order, '幕/卷顺序'); text(act.purpose, '幕/卷作用'); text(act.summary, '幕/卷概要');
    check(!actOrders.has(act.order), '幕/卷顺序不能重复'); actOrders.add(act.order);
  }
  const chapters = ids(workspace.chapters, '章节');
  const scenes = ids(workspace.scenes, '场景');
  const facts = ids(workspace.facts, '事实');
  ids(workspace.knowledge, '角色知识');
  check(workspace.characterStates === undefined || Array.isArray(workspace.characterStates), '人物演进状态必须是列表');
  const characterStates = ids(workspace.characterStates ?? [], '人物演进状态');
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
    if (chapter.actId !== undefined) check(acts.has(chapter.actId), '章节所属幕/卷不存在');
  }
  const sceneOrders = new Set<string>();
  for (const scene of scenes.values()) {
    check(chapters.has(scene.chapterId), '场景所属章节不存在');
    number(scene.order, '场景顺序'); text(scene.title, '场景标题', true);
    check(scene.povId === null || isCharacter(scene.povId), '场景视角必须是人物或全知视角');
    strings(scene.eventIds, '场景事件'); for (const id of scene.eventIds) check(isEvent(id), '场景引用的事件不存在');
    if (scene.castIds !== undefined) { strings(scene.castIds, '出场人物'); for (const id of scene.castIds) check(isCharacter(id), '出场人物必须是人物'); }
    if (scene.settingIds !== undefined) { strings(scene.settingIds, '场景环境'); for (const id of scene.settingIds) check(objects.has(id) && !isCharacter(id) && !isEvent(id), '场景环境必须是环境或设定对象'); }
    text(scene.outline, '场景大纲'); text(scene.text, '场景正文');
    const key = `${scene.chapterId}:${scene.order}`; check(!sceneOrders.has(key), '同一章节的场景顺序不能重复'); sceneOrders.add(key);
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
  const stateAnchors = new Set<string>();
  for (const state of characterStates.values()) {
    check(isCharacter(state.characterId), '演进状态所属人物不存在');
    check(isEvent(state.eventId), '演进状态锚定事件不存在');
    for (const key of ['perspective', 'psychology', 'motivation', 'evidence'] as const) text(state[key], `人物状态 ${key}`);
    strings(state.sceneIds, '人物状态正文证据');
    for (const id of state.sceneIds) check(scenes.get(id)?.eventIds.includes(state.eventId), '人物状态的正文证据必须引用锚定事件');
    const key = JSON.stringify([state.characterId, state.eventId]);
    check(!stateAnchors.has(key), '同一人物在同一事件只能有一个演进状态'); stateAnchors.add(key);
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
    for (const key of ['sceneId', 'author', 'note'] as const) if (sample[key] !== undefined) text(sample[key], `范文 ${key}`);
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
function deleteScenes(workspace: Workspace, removed: Set<string>): void {
  workspace.scenes = workspace.scenes.filter(scene => !removed.has(scene.id));
  for (const state of workspace.characterStates ?? []) state.sceneIds = state.sceneIds.filter(id => !removed.has(id));
  cleanCards(workspace, new Set(workspace.cards.filter(card => card.kind === 'scene' && card.refId && removed.has(card.refId)).map(card => card.id)));
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
  workspace.characterStates = (workspace.characterStates ?? []).filter(state => state.characterId !== id && state.eventId !== id);
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
    logline: workspace.logline ?? '', structureTemplate: workspace.structureTemplate ?? '', acts: workspace.acts ?? [],
    objectTypes: workspace.objectTypes, objects: workspace.objects, chapters: workspace.chapters,
    scenes: workspace.scenes, facts: workspace.facts, knowledge: workspace.knowledge, characterStates: workspace.characterStates ?? [],
    cards: workspace.cards.map(cardContent), canvasLinks: workspace.canvasLinks, style: styleProfile(workspace) };
}

export function hasSemanticChanges(before: Workspace, after: Workspace): boolean {
  return !isDeepStrictEqual(semantic(before), semantic(after));
}

export function applyCommands(workspace: Workspace, commands: Command[]): Workspace {
  check(Array.isArray(commands), '操作必须是列表');
  const next = structuredClone(workspace);
  next.characterStates ??= [];
  next.theme ??= ''; next.logline ??= ''; next.structureTemplate ??= ''; next.acts ??= [];
  for (const command of commands) {
    record(command, '操作');
    text(command.type, '操作类型', true);
    if (command.type.startsWith('delete')) text((command as { id?: unknown }).id, '删除 ID', true);
    switch (command.type) {
      case 'updateNovel': {
        record(command.patch, '小说更新');
        for (const [key, value] of Object.entries(command.patch)) {
          check(NOVEL_FIELDS.includes(key as typeof NOVEL_FIELDS[number]), '不允许修改此项目字段'); text(value, key);
        }
        Object.assign(next, command.patch); break;
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
      case 'deleteChapter':
        deleteScenes(next, new Set(next.scenes.filter(scene => scene.chapterId === command.id).map(scene => scene.id)));
        next.chapters = next.chapters.filter(chapter => chapter.id !== command.id);
        if (next.reading.chapterId === command.id) { delete next.reading.chapterId; next.reading.scroll = 0; }
        break;
      case 'putScene':
        put(next.scenes, command.value);
        strings(command.value.eventIds, '场景事件');
        for (const state of next.characterStates) state.sceneIds = state.sceneIds.filter(id => id !== command.value.id || command.value.eventIds.includes(state.eventId));
        break;
      case 'deleteScene': deleteScenes(next, new Set([command.id])); break;
      case 'putFact': put(next.facts, command.value); break;
      case 'deleteFact': cleanFacts(next, new Set([command.id])); break;
      case 'putKnowledge': put(next.knowledge, command.value); break;
      case 'deleteKnowledge': next.knowledge = next.knowledge.filter(item => item.id !== command.id); break;
      case 'putCharacterState': put(next.characterStates, command.value); break;
      case 'deleteCharacterState': next.characterStates = next.characterStates.filter(item => item.id !== command.id); break;
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

export function chapterText(workspace: Workspace, chapterId?: string): string {
  return [...workspace.chapters].sort((a, b) => a.order - b.order).filter(chapter => !chapterId || chapter.id === chapterId)
    .map(chapter => [...(chapterId ? [] : [chapter.title]), ...workspace.scenes.filter(scene => scene.chapterId === chapter.id).sort((a, b) => a.order - b.order).map(scene => scene.text).filter(Boolean)].join('\n\n')).join('\n\n');
}
