import test from 'node:test';
import assert from 'node:assert/strict';
import type { CharacterState, NovelObject } from '../shared/types.js';
import { applyCommands, createWorkspace } from './domain.js';
import { buildCharacterContext, buildWriterContext, resolveReferences } from './context.js';

const character: NovelObject = { id: 'character', typeId: 'character', name: '侦探', fields: { selfKnowledge: '我是一名侦探' } };
const event = (id: string, worldOrder: number): NovelObject => ({
  id, typeId: 'event', name: id, fields: {},
  event: { worldOrder, timeLabel: '', thread: '主线', participants: ['character'], causes: [], critical: false, observations: { character: `看到${id}` } },
});

test('人物状态按世界时间演进：倒叙排除未来与同刻状态，作者单独取得当前转变与正文证据', () => {
  const original = createWorkspace('倒叙'), chapterId = original.chapters[0]!.id;
  const state = (id: string, eventId: string): CharacterState => ({ id, characterId: character.id, eventId,
    perspective: `${id}的理解`, psychology: `${id}的情绪`, motivation: `${id}的目标`, evidence: '作者知道隐藏凶手', sceneIds: [] });
  const workspace = applyCommands(original, [
    { type: 'putObject', value: character },
    ...['first', 'earlier', 'anchor', 'parallel', 'future'].map((id, index) => ({ type: 'putObject' as const, value: event(id, id === 'parallel' ? 3 : index + 1) })),
    { type: 'updateNovel', patch: { theme: '从独断走向信任' } },
    { type: 'putScene', value: { id: 'future-scene', chapterId, order: 0, title: '先叙终局', povId: character.id, eventIds: ['future'], outline: '', text: '终局正文' } },
    { type: 'putScene', value: { id: 'flashback', chapterId, order: 1, title: '回到过去', povId: character.id, eventIds: ['anchor'], outline: '', text: '回忆中的犹豫。' } },
    { type: 'putCharacterState', value: state('first-state', 'first') },
    { type: 'putCharacterState', value: state('future-state', 'future') },
    { type: 'putCharacterState', value: state('earlier-state', 'earlier') },
    { type: 'putCharacterState', value: state('parallel-state', 'parallel') },
    { type: 'putCharacterState', value: { ...state('current-state', 'anchor'), sceneIds: ['flashback'] } },
  ]);
  const role = buildCharacterContext(workspace, character.id, 'anchor');
  assert.equal(role.state!.id, 'earlier-state');
  assert.equal(role.state!.psychology, 'earlier-state的情绪');
  assert.equal(role.state!.evidence, ''); assert.deepEqual(role.state!.sceneIds, []);
  assert.doesNotMatch(JSON.stringify(role), /隐藏凶手|future-state|parallel-state|current-state|终局正文/);
  const writer = buildWriterContext(workspace, 'flashback');
  assert.equal(writer.novel.theme, '从独断走向信任');
  assert.deepEqual(writer.eventContexts[0]!.characterTransitions.map(item => item.id), ['current-state']);
  assert.equal(writer.eventContexts[0]!.characterTransitions[0]!.evidence, '作者知道隐藏凶手');
  assert.ok(writer.sources.includes('scene:flashback:text'));
  assert.ok(!writer.sources.includes('characterState:future-state'));
  assert.equal(buildCharacterContext(workspace, character.id, 'first').state, undefined);
  const unanchored = buildWriterContext(applyCommands(workspace, [
    { type: 'putScene', value: { id: 'unanchored', chapterId, order: 2, title: '未定时间', povId: character.id, eventIds: [], outline: '', text: '' } },
  ]), 'unanchored');
  assert.equal(unanchored.eventContexts.length, 0);
  assert.ok(!unanchored.sources.some(source => source.startsWith('characterState:')));
});

test('分组参考递归展开、去重并读取真实实体，失效引用明确拒绝', () => {
  const original = createWorkspace('参考资料');
  const workspace = applyCommands(original, [
    { type: 'putObject', value: character },
    { type: 'putScene', value: { id: 'scene', chapterId: original.chapters[0]!.id, order: 1, title: '真实场景', povId: null, eventIds: [], outline: '真实大纲', text: '' } },
    { type: 'putCard', value: { id: 'group', kind: 'group', title: '外层', content: '', x: 0, y: 0 } },
    { type: 'putCard', value: { id: 'inner', kind: 'group', title: '内层', content: '', x: 10, y: 10, groupId: 'group' } },
    { type: 'putCard', value: { id: 'note', kind: 'note', title: '灵感', content: '线索', x: 20, y: 20, groupId: 'inner' } },
    { type: 'putCard', value: { id: 'object-card', kind: 'object', refId: character.id, title: '旧标题', content: '备注', x: 30, y: 30, groupId: 'inner' } },
    { type: 'putCard', value: { id: 'scene-card', kind: 'scene', refId: 'scene', title: '旧场景', content: '', x: 40, y: 40, groupId: 'group' } },
  ]);
  const result = resolveReferences(workspace, [{ kind: 'card', id: 'group' }, { kind: 'card', id: 'note' }, { kind: 'object', id: character.id }]);
  assert.equal(result.cards.length, 5);
  assert.deepEqual(result.objects.map(object => object.name), ['侦探']);
  assert.deepEqual(result.scenes.map(scene => scene.outline), ['真实大纲']);
  assert.equal(result.sources.length, 7);
  assert.throws(() => resolveReferences(workspace, [{ kind: 'card', id: 'deleted' }]), /已删除/);
});

test('普通事件写作获得时间边界内角色知识、有效事实及相关对象', () => {
  const original = createWorkspace('普通事件');
  const workspace = applyCommands(original, [
    { type: 'putObject', value: character },
    { type: 'putObject', value: { id: 'unrelated', typeId: 'character', name: '无关人物', fields: {} } },
    ...['earlier', 'anchor', 'future'].map((id, index) => ({ type: 'putObject' as const, value: event(id, index + 1) })),
    { type: 'putFact', value: { id: 'initial-fact', subjectId: character.id, key: '地点', value: '门外', fromEventId: null } },
    { type: 'putFact', value: { id: 'current-fact', subjectId: character.id, key: '地点', value: '门内', fromEventId: 'anchor', replacesId: 'initial-fact' } },
    { type: 'putFact', value: { id: 'future-fact', subjectId: character.id, key: '地点', value: '地下室', fromEventId: 'future', replacesId: 'current-fact' } },
    { type: 'putKnowledge', value: { id: 'initial', characterId: character.id, content: '初始认知', learnedAt: null, source: 'initial' } },
    { type: 'putKnowledge', value: { id: 'known', characterId: character.id, content: '先前发现', learnedAt: 'earlier', source: 'witness' } },
    { type: 'putKnowledge', value: { id: 'same-time', characterId: character.id, content: '同刻不能预知', learnedAt: 'anchor', source: 'witness' } },
    { type: 'putKnowledge', value: { id: 'future-knowledge', characterId: character.id, content: '未来不能预知', learnedAt: 'future', source: 'witness' } },
    { type: 'putScene', value: { id: 'scene', chapterId: original.chapters[0]!.id, order: 1, title: '普通场景', povId: character.id, eventIds: ['anchor'], outline: '', text: '' } },
  ]);
  const context = buildWriterContext(workspace, 'scene');
  assert.equal(context.eventContexts.length, 1);
  assert.deepEqual(context.eventContexts[0]!.characters[0]!.memories.map(item => item.id), ['initial', 'known']);
  assert.equal(context.eventContexts[0]!.characters[0]!.perception, '看到anchor');
  assert.deepEqual(context.eventContexts[0]!.facts.map(fact => fact.id), ['current-fact']);
  assert.deepEqual(context.relatedObjects.map(object => object.id), ['character', 'anchor']);
  assert.ok(context.sources.includes('knowledge:known'));
  assert.ok(!context.sources.includes('knowledge:same-time'));
  const noEvent = buildWriterContext(applyCommands(workspace, [{ type: 'putScene', value: { ...workspace.scenes[0]!, eventIds: [] } }]), 'scene');
  assert.equal(noEvent.initialCharacters[0]!.selfKnowledge, '我是一名侦探');
  assert.deepEqual(noEvent.initialCharacters[0]!.memories.map(item => item.id), ['initial']);
  assert.ok(!noEvent.sources.includes('knowledge:known'), '无事件时间锚不能注入后续获知信息');
});

test('跨章前文按阅读顺序取最近 6000 字符原文，较早内容进入分层摘要且不含后文', () => {
  const original = createWorkspace('跨章连续性');
  const workspace = applyCommands(original, [
    { type: 'putChapter', value: { id: 'later-chapter', title: '第二章', order: 2 } },
    { type: 'putScene', value: { id: 'old', chapterId: original.chapters[0]!.id, order: 1, title: '旧场景', povId: null, eventIds: [], outline: '较早大纲', text: 'A'.repeat(14000) } },
    { type: 'putScene', value: { id: 'recent', chapterId: 'later-chapter', order: 1, title: '最近场景', povId: null, eventIds: [], outline: '最近大纲', text: 'B'.repeat(8000) } },
    { type: 'putScene', value: { id: 'target', chapterId: 'later-chapter', order: 2, title: '目标', povId: null, eventIds: [], outline: '', text: '' } },
    { type: 'putScene', value: { id: 'future', chapterId: 'later-chapter', order: 3, title: '未来', povId: null, eventIds: [], outline: '未来大纲', text: '后文' } },
  ]);
  const context = buildWriterContext(workspace, 'target');
  assert.deepEqual(context.recentText.map(item => item.sceneId), ['recent']);
  assert.equal(context.recentText[0]!.text, 'B'.repeat(6000));
  assert.match(context.storySoFar.recentChapters[0]!.summary, /较早大纲/);
  assert.deepEqual(context.storySoFar.thisChapterEarlierScenes, [], '已作为原文提供的场景不重复摘要');
  assert.ok(!context.sources.includes('scene:future:text'));
  assert.doesNotMatch(JSON.stringify(context), /后文|未来大纲/);
});

test('写作上下文只带入本场的环境：绑定的、大纲或前文提到的；环境很少时才全部带入', () => {
  const original = createWorkspace('环境范围');
  const chapterId = original.chapters[0]!.id;
  const settings = ['钟楼', '码头', '集市', '档案馆', '灯塔', '渡口', '旧宅'].map((name, index) => ({ type: 'putObject' as const, value: { id: `place-${index}`, typeId: 'setting', name, fields: { description: `${name}的样子` } } }));
  const workspace = applyCommands(original, [
    ...settings,
    { type: 'putObject', value: { id: 'lin', typeId: 'character', name: '林舟', fields: {} } },
    { type: 'putScene', value: { id: 'before', chapterId, order: 1, title: '前一场', povId: null, eventIds: [], outline: '', text: '他从码头一路跑回来。' } },
    { type: 'putScene', value: { id: 'target', chapterId, order: 2, title: '目标', povId: null, castIds: ['lin'], settingIds: ['place-0'], eventIds: [], outline: '在档案馆找到旧卷宗', text: '' } },
    { type: 'putScene', value: { id: 'bare', chapterId, order: 3, title: '无名', povId: null, eventIds: [], outline: '', text: '' } },
  ]);
  const context = buildWriterContext(workspace, 'target');
  const places = context.relatedObjects.filter(object => object.typeId === 'setting').map(object => object.name).sort();
  assert.deepEqual(places, ['档案馆', '码头', '钟楼'].sort(), '绑定 + 大纲提到 + 前文提到');
  assert.ok(context.relatedObjects.some(object => object.id === 'lin'), '出场人物进入上下文');
  assert.deepEqual(context.sceneElements.places, ['钟楼']);
  assert.deepEqual(context.sceneElements.cast, ['林舟']);
  // Seven settings and none named near the scene: none are sent, instead of the whole list.
  const bare = buildWriterContext(applyCommands(workspace, [{ type: 'putScene', value: { ...workspace.scenes.find(scene => scene.id === 'before')!, text: '' } }]), 'bare');
  assert.equal(bare.relatedObjects.filter(object => object.typeId === 'setting').length, 0);
  // A small book keeps the old behaviour.
  const small = applyCommands(workspace, ['place-4', 'place-5', 'place-6'].map(id => ({ type: 'deleteObject' as const, id })));
  const smallBare = buildWriterContext(applyCommands(small, [{ type: 'putScene', value: { ...small.scenes.find(scene => scene.id === 'before')!, text: '' } }]), 'bare');
  assert.equal(smallBare.relatedObjects.filter(object => object.typeId === 'setting').length, 4);
});
