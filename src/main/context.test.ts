import test from 'node:test';
import assert from 'node:assert/strict';
import type { Command, NarrativeScene, NovelObject, StateChange } from '../shared/types.js';
import { applyCommands, createWorkspace } from './domain.js';
import { buildCharacterContext, buildWriterContext, resolveReferences } from './context.js';

const character: NovelObject = { id: 'character', typeId: 'character', name: '侦探', fields: { selfKnowledge: '我是一名侦探' } };
const event = (id: string, worldOrder: number): NovelObject => ({
  id, typeId: 'event', name: id, fields: {},
  event: { worldOrder, timeLabel: '', thread: '主线', participants: ['character'], causes: [], critical: false, observations: { character: `看到${id}` } },
});
/** A scene read in one chapter: the scene and its one passage, sharing the id. */
const scene = (id: string, chapterId: string, order: number, patch: Partial<NarrativeScene> & { text?: string } = {}): Command[] => {
  const { text = '', ...rest } = patch;
  return [{ type: 'putScene', value: { id, title: id, povId: null, eventIds: [], outline: '', ...rest } }, { type: 'putPassage', value: { id, sceneId: id, chapterId, order, text } }];
};

test('状态按故事时间生效：倒叙看到它那个时间的状态，同刻与未来的变化排除，作者备注只给写作者', () => {
  const original = createWorkspace('倒叙'), chapterId = original.chapters[0]!.id;
  const change = (id: string, eventId: string, patch: Partial<StateChange> = {}): StateChange => ({ id, subjectId: character.id, eventId,
    aspects: { psychology: `${id}的情绪`, perspective: `${id}的理解`, motivation: `${id}的目标` }, note: '作者知道隐藏凶手', ...patch });
  const workspace = applyCommands(original, [
    { type: 'putObject', value: character },
    ...['first', 'earlier', 'anchor', 'parallel', 'future'].map((id, index) => ({ type: 'putObject' as const, value: event(id, id === 'parallel' ? 3 : index + 1) })),
    { type: 'updateNovel', patch: { theme: '从独断走向信任' } },
    ...scene('future-scene', chapterId, 0, { title: '先叙终局', povId: character.id, eventIds: ['future'], text: '终局正文' }),
    ...scene('flashback', chapterId, 1, { title: '回到过去', povId: character.id, eventIds: ['anchor'], text: '回忆中的犹豫。' }),
    { type: 'putStateChange', value: change('first-state', 'first') },
    { type: 'putStateChange', value: change('future-state', 'future', { sceneId: 'future-scene' }) },
    { type: 'putStateChange', value: change('earlier-state', 'earlier', { aspects: { psychology: 'earlier-state的情绪', perspective: 'earlier-state的理解' } }) },
    { type: 'putStateChange', value: change('parallel-state', 'parallel') },
    { type: 'putStateChange', value: change('current-state', 'anchor', { sceneId: 'flashback' }) },
  ]);
  // The character's own view just before the event: the latest value of each aspect, never the author's note.
  const role = buildCharacterContext(workspace, character.id, 'anchor');
  assert.deepEqual(role.state, { 心理: 'earlier-state的情绪', 视角: 'earlier-state的理解', 动机: 'first-state的目标' });
  assert.doesNotMatch(JSON.stringify(role), /隐藏凶手|future-state|parallel-state|current-state|终局正文/);
  assert.equal(buildCharacterContext(workspace, character.id, 'first').state, undefined);
  // The flashback is read after the ending, yet happens before it: it starts from the state of its own time.
  const writer = buildWriterContext(workspace, 'flashback');
  assert.equal(writer.novel.theme, '从独断走向信任');
  const subject = writer.sceneState.subjects[0]!;
  assert.deepEqual(subject.before, { 心理: 'earlier-state的情绪', 视角: 'earlier-state的理解', 动机: 'first-state的目标' });
  assert.deepEqual(subject.byEndOfScene, [{ becomes: { 心理: 'current-state的情绪', 视角: 'current-state的理解', 动机: 'current-state的目标' }, event: 'anchor', note: '作者知道隐藏凶手' }]);
  assert.ok(writer.sources.includes('passage:flashback') && writer.sources.includes('stateChange:current-state') && writer.sources.includes('stateChange:earlier-state'));
  assert.ok(!writer.sources.includes('stateChange:future-state') && !writer.sources.includes('stateChange:parallel-state'));
  assert.doesNotMatch(JSON.stringify(writer.eventContexts), /earlier-state|隐藏凶手/, '事件里的人物上下文不重复状态');
  // Undated prose never happens before what was already told: a scene after the ending starts from the ending's state.
  const after = buildWriterContext(applyCommands(workspace, scene('unanchored', chapterId, 2, { title: '未定时间', povId: character.id })), 'unanchored');
  assert.equal(after.eventContexts.length, 0);
  assert.equal(after.sceneState.subjects[0]!.before.心理, 'future-state的情绪');
});

test('跨章的场景：每段从前一段停下的地方写，本段的变化、整场的变化与留给后面几段的变化分开', () => {
  const original = createWorkspace('跨章场景'), first = original.chapters[0]!.id;
  const workspace = applyCommands(original, [
    { type: 'putObject', value: character },
    { type: 'putObject', value: { id: 'tower', typeId: 'setting', name: '钟楼', fields: {} } },
    { type: 'putChapter', value: { id: 'second', title: '第二章', order: 1 } },
    { type: 'putChapter', value: { id: 'third', title: '第三章', order: 2 } },
    { type: 'putScene', value: { id: 'standoff', title: '钟楼对峙', povId: character.id, settingIds: ['tower'], eventIds: [], outline: '对峙到摊牌' } },
    { type: 'putPassage', value: { id: 'standoff-1', sceneId: 'standoff', chapterId: first, order: 0, text: '钟声响起时，他走上钟楼。', beat: '对峙开始' } },
    { type: 'putPassage', value: { id: 'standoff-2', sceneId: 'standoff', chapterId: 'second', order: 0, text: '', beat: '他亮出底牌' } },
    { type: 'putPassage', value: { id: 'standoff-3', sceneId: 'standoff', chapterId: 'third', order: 0, text: '', beat: '对方认输' } },
    { type: 'putStateChange', value: { id: 'calm', subjectId: character.id, sceneId: 'standoff', passageId: 'standoff-1', aspects: { psychology: '强作镇定' } } },
    { type: 'putStateChange', value: { id: 'reveal', subjectId: character.id, sceneId: 'standoff', passageId: 'standoff-2', aspects: { cognition: '知道对方在说谎' } } },
    { type: 'putStateChange', value: { id: 'ending', subjectId: character.id, sceneId: 'standoff', passageId: 'standoff-3', aspects: { psychology: '如释重负' } } },
    { type: 'putStateChange', value: { id: 'storm', subjectId: 'tower', sceneId: 'standoff', aspects: { atmosphere: '暴雨将至' } } },
  ]);
  const context = buildWriterContext(workspace, 'standoff-2');
  assert.deepEqual(context.passage, { id: 'standoff-2', chapter: '第二章', part: '2/3', beat: '他亮出底牌', text: '' });
  const [person, place] = context.sceneState.subjects;
  assert.deepEqual(person!.before, { 心理: '强作镇定' }, '同一场前一段的变化已经发生');
  assert.deepEqual(person!.here, [{ becomes: { 认知: '知道对方在说谎' } }]);
  assert.deepEqual(person!.later, [{ becomes: { 心理: '如释重负' } }]);
  assert.deepEqual(place!.byEndOfScene, [{ becomes: { 氛围: '暴雨将至' } }]);
  assert.deepEqual(context.sceneLater?.parts, [{ chapter: '第三章', beat: '对方认输' }]);
  assert.deepEqual(context.recentText.map(item => item.passageId), ['standoff-1'], '上一章写下的部分作为前文原文');
  assert.ok(context.sources.includes('passage:standoff-3') && !context.sources.includes('passage:standoff-3:text'));
  // Opening the scene in the first chapter: nothing has happened yet, and the later parts are kept for later.
  const opening = buildWriterContext(workspace, 'standoff-1');
  assert.deepEqual(opening.sceneState.subjects[0]!.before, {});
  assert.deepEqual(opening.sceneState.subjects[0]!.later?.map(item => item.becomes), [{ 认知: '知道对方在说谎' }, { 心理: '如释重负' }]);
  assert.equal(opening.sceneSoFar, undefined);
});

test('分组参考递归展开、去重并读取真实实体，失效引用明确拒绝', () => {
  const original = createWorkspace('参考资料');
  const workspace = applyCommands(original, [
    { type: 'putObject', value: character },
    ...scene('scene', original.chapters[0]!.id, 1, { title: '真实场景', outline: '真实大纲' }),
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
    ...scene('scene', original.chapters[0]!.id, 1, { title: '普通场景', povId: character.id, eventIds: ['anchor'] }),
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
    ...scene('old', original.chapters[0]!.id, 1, { title: '旧场景', outline: '较早大纲', text: 'A'.repeat(14000) }),
    ...scene('recent', 'later-chapter', 1, { title: '最近场景', outline: '最近大纲', text: 'B'.repeat(8000) }),
    ...scene('target', 'later-chapter', 2, { title: '目标' }),
    ...scene('future', 'later-chapter', 3, { title: '未来', outline: '未来大纲', text: '后文' }),
  ]);
  const context = buildWriterContext(workspace, 'target');
  assert.deepEqual(context.recentText.map(item => item.passageId), ['recent']);
  assert.equal(context.recentText[0]!.text, 'B'.repeat(6000));
  assert.match(context.storySoFar.recentChapters[0]!.summary, /较早大纲/);
  assert.deepEqual(context.storySoFar.thisChapterEarlierPassages, [], '已作为原文提供的场景段不重复摘要');
  assert.ok(!context.sources.includes('passage:future:text'));
  assert.doesNotMatch(JSON.stringify(context), /后文|未来大纲/);
});

test('写作上下文只带入本场的环境：绑定的、大纲或前文提到的；环境很少时才全部带入', () => {
  const original = createWorkspace('环境范围');
  const chapterId = original.chapters[0]!.id;
  const settings = ['钟楼', '码头', '集市', '档案馆', '灯塔', '渡口', '旧宅'].map((name, index) => ({ type: 'putObject' as const, value: { id: `place-${index}`, typeId: 'setting', name, fields: { description: `${name}的样子` } } }));
  const workspace = applyCommands(original, [
    ...settings,
    { type: 'putObject', value: { id: 'lin', typeId: 'character', name: '林舟', fields: {} } },
    ...scene('before', chapterId, 1, { title: '前一场', text: '他从码头一路跑回来。' }),
    ...scene('target', chapterId, 2, { title: '目标', castIds: ['lin'], settingIds: ['place-0'], outline: '在档案馆找到旧卷宗' }),
    ...scene('bare', chapterId, 3, { title: '无名' }),
  ]);
  const context = buildWriterContext(workspace, 'target');
  const places = context.relatedObjects.filter(object => object.typeId === 'setting').map(object => object.name).sort();
  assert.deepEqual(places, ['档案馆', '码头', '钟楼'].sort(), '绑定 + 大纲提到 + 前文提到');
  assert.ok(context.relatedObjects.some(object => object.id === 'lin'), '出场人物进入上下文');
  assert.deepEqual(context.sceneElements.places, ['钟楼']);
  assert.deepEqual(context.sceneElements.cast, ['林舟']);
  // Seven settings and none named near the scene: none are sent, instead of the whole list.
  const bare = buildWriterContext(applyCommands(workspace, [{ type: 'putPassage', value: { ...workspace.passages.find(passage => passage.id === 'before')!, text: '' } }]), 'bare');
  assert.equal(bare.relatedObjects.filter(object => object.typeId === 'setting').length, 0);
  // A small book keeps the old behaviour.
  const small = applyCommands(workspace, ['place-4', 'place-5', 'place-6'].map(id => ({ type: 'deleteObject' as const, id })));
  const smallBare = buildWriterContext(applyCommands(small, [{ type: 'putPassage', value: { ...small.passages.find(passage => passage.id === 'before')!, text: '' } }]), 'bare');
  assert.equal(smallBare.relatedObjects.filter(object => object.typeId === 'setting').length, 4);
});
