import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace, applyCommands, DomainValidationError, validateWorkspace } from './domain.js';
import { buildCharacterContext, buildReaderContext } from './context.js';
import { NovelStore } from './store.js';
import type { CanvasCard, CharacterState, NovelObject, Workspace } from '../shared/types.js';

const character = (id: string): NovelObject => ({ id, name: id, typeId: 'character', fields: { description: '作者隐藏的终局秘密', selfKnowledge: '我是侦探' } });
const event = (id: string, order: number, causes: string[] = []): NovelObject => ({
  id, name: `秘密事件 ${id}`, typeId: 'event', fields: { description: '不应泄漏的世界真相' },
  event: { worldOrder: order, timeLabel: '', thread: '主线', participants: ['detective'], causes, critical: false, observations: { detective: '有人敲门' } },
});
const card = (id: string, patch: Partial<CanvasCard> = {}): CanvasCard => ({ id, kind: 'note', title: id, content: '原始内容', x: 100, y: 120, ...patch });
function fixture(): Workspace {
  return applyCommands(createWorkspace('测试'), [
    { type: 'putObject', value: character('detective') },
    { type: 'putObject', value: event('earlier', 1) },
    { type: 'putObject', value: event('parallel', 2) },
    { type: 'putObject', value: event('anchor', 2, ['earlier']) },
    { type: 'putObject', value: event('future', 3, ['anchor']) },
  ]);
}

test('人物演进校验事件与正文锚点，删除清理依赖并保持独立状态', () => {
  const original = fixture(), chapterId = original.chapters[0]!.id;
  const state: CharacterState = { id: 'state', characterId: 'detective', eventId: 'earlier',
    perspective: '证人可能不可靠', psychology: '开始迟疑', motivation: '亲自查证', evidence: '他放下证人的口供', sceneIds: ['scene'] };
  const workspace = applyCommands(original, [
    { type: 'putScene', value: { id: 'scene', chapterId, order: 0, title: '迟疑', povId: 'detective', eventIds: ['earlier'], outline: '', text: '他放下证人的口供。' } },
    { type: 'putCharacterState', value: state },
    { type: 'putCharacterState', value: { ...state, id: 'later-state', eventId: 'future', sceneIds: [] } },
  ]);
  for (const value of [{ ...state, id: 'duplicate' }, { ...state, characterId: 'missing' },
    { ...state, eventId: 'detective' }, { ...state, sceneIds: ['missing'] }, { ...state, eventId: 'anchor' }]) {
    assert.throws(() => applyCommands(workspace, [{ type: 'putCharacterState', value }]), DomainValidationError);
  }
  const withoutScene = applyCommands(workspace, [{ type: 'deleteScene', id: 'scene' }]);
  assert.deepEqual(withoutScene.characterStates![0]!.sceneIds, []);
  assert.equal(withoutScene.characterStates![0]!.psychology, state.psychology);
  const detached = applyCommands(workspace, [{ type: 'putScene', value: { ...workspace.scenes[0]!, eventIds: ['anchor'] } }]);
  assert.deepEqual(detached.characterStates![0]!.sceneIds, []);
  assert.equal(applyCommands(workspace, [{ type: 'deleteObject', id: 'detective' }]).characterStates!.length, 0);
  assert.deepEqual(applyCommands(workspace, [{ type: 'deleteObject', id: 'earlier' }]).characterStates!.map(item => item.id), ['later-state']);
  assert.deepEqual(applyCommands(workspace, [{ type: 'deleteCharacterState', id: state.id }]).characterStates!.map(item => item.id), ['later-state']);
});

test('人物演进与立意进入语义修订和撤销，旧 schema 1 备份默认空状态', () => {
  const store = new NovelStore(':memory:');
  try {
    const legacy = fixture(); delete legacy.characterStates; delete legacy.theme;
    validateWorkspace(legacy);
    let workspace = store.importProject(legacy);
    assert.deepEqual(workspace.characterStates, []); assert.equal(workspace.theme, '');
    const revision = workspace.revision;
    workspace = store.execute({ projectId: workspace.id, actor: 'ai', taskId: 'evolution', expectedRevision: revision, commands: [
      { type: 'updateNovel', patch: { theme: '在信任破裂后学习承担责任' } },
      { type: 'putCharacterState', value: { id: 'state', characterId: 'detective', eventId: 'earlier',
        perspective: '我应核实证据', psychology: '由自信转为谨慎', motivation: '保护证人', evidence: '事件中的亲历', sceneIds: [] } },
    ] });
    assert.equal(workspace.revision, revision + 1);
    assert.deepEqual(store.history(workspace.id)[0]!.changes.map(change => change.collection), ['metadata', 'characterStates']);
    workspace = store.undo(workspace.id, 'evolution');
    assert.equal(workspace.theme, ''); assert.deepEqual(workspace.characterStates, []);
    assert.equal(workspace.revision, revision + 2);
  } finally { store.close(); }
});

test('角色只知明确获知内容，不凭因果祖先推导；同刻和未来获知排除', () => {
  let workspace = fixture();
  workspace = applyCommands(workspace, [
    { type: 'putKnowledge', value: { id: 'initial', characterId: 'detective', content: '我可能认错了人', learnedAt: null, source: 'belief' } },
    { type: 'putKnowledge', value: { id: 'known', characterId: 'detective', content: '证人说门是锁着的', learnedAt: 'earlier', source: 'told' } },
    { type: 'putKnowledge', value: { id: 'parallel-knowledge', characterId: 'detective', content: '同刻不能预知', learnedAt: 'parallel', source: 'witness' } },
    { type: 'putKnowledge', value: { id: 'future-knowledge', characterId: 'detective', content: '未来不能预知', learnedAt: 'future', source: 'witness' } },
  ]);
  const context = buildCharacterContext(workspace, 'detective', 'anchor');
  assert.deepEqual(context.memories.map(item => item.id), ['initial', 'known']);
  assert.equal(context.perception, '有人敲门');
  assert.equal(context.selfKnowledge, '我是侦探');
  assert.doesNotMatch(JSON.stringify(context), /终局秘密|世界真相|同刻不能|未来不能|秘密事件/);
  workspace.knowledge[1].learnedAt = 'parallel';
  assert.deepEqual(buildCharacterContext(workspace, 'detective', 'anchor').memories.map(item => item.id), ['initial']);
});

test('知识保存当时内容快照，事实变化不能改写旧记忆', () => {
  const workspace = applyCommands(fixture(), [
    { type: 'putFact', value: { id: 'old', subjectId: 'detective', key: '门', value: '锁着', fromEventId: 'earlier' } },
    { type: 'putFact', value: { id: 'new', subjectId: 'detective', key: '门', value: '打开了', fromEventId: 'future', replacesId: 'old' } },
    { type: 'putKnowledge', value: { id: 'memory', characterId: 'detective', content: '门锁着', learnedAt: 'earlier', source: 'witness', factId: 'old' } },
  ]);
  assert.equal(buildCharacterContext(workspace, 'detective', 'future').memories[0].content, '门锁着');
  assert.throws(() => applyCommands(workspace, [{ type: 'putKnowledge', value: { id: 'leak', characterId: 'detective', content: '门打开了', learnedAt: 'earlier', source: 'witness', factId: 'new' } }]), /事实发生前/);
});

test('读者只看已写正文，多事件场景引用不暴露完整世界事实', () => {
  let workspace = fixture(); const chapterId = workspace.chapters[0].id;
  workspace = applyCommands(workspace, [
    { type: 'putScene', value: { id: 'discovery', chapterId, order: 0, title: '发现', povId: 'detective', eventIds: ['earlier', 'future'], outline: '凶手身份应隐藏', text: '他发现一扇紧闭的门。' } },
    { type: 'putScene', value: { id: 'revelation', chapterId, order: 1, title: '揭晓', povId: null, eventIds: ['future'], outline: '', text: '直到最后他才知道凶手身份。' } },
  ]);
  const context = buildReaderContext(workspace, chapterId, 'discovery');
  assert.match(context.text, /紧闭的门/);
  assert.doesNotMatch(JSON.stringify(context), /凶手|世界真相|秘密事件/);
  assert.deepEqual(context.sources, ['scene:discovery:text']);
});

test('因果时间/环与引用校验，删除清理保持正文和独立记忆', () => {
  const workspace = fixture();
  const cycle = structuredClone(workspace); cycle.objects.find(item => item.id === 'earlier')!.event!.causes = ['anchor'];
  assert.throws(() => validateWorkspace(cycle), /成环/);
  const reverse = structuredClone(workspace); reverse.objects.find(item => item.id === 'earlier')!.event!.worldOrder = 4;
  assert.throws(() => validateWorkspace(reverse), /因果前序必须早于/);
  const prepared = applyCommands(workspace, [
    { type: 'putFact', value: { id: 'fact', subjectId: 'detective', key: '线索', value: '脚印', fromEventId: 'earlier' } },
    { type: 'putKnowledge', value: { id: 'remember', characterId: 'detective', learnedAt: null, content: '我一直这样相信', source: 'belief' } },
    { type: 'putScene', value: { id: 'scene', chapterId: workspace.chapters[0].id, title: '正文', order: 0, povId: 'detective', eventIds: ['earlier'], outline: '', text: '保留我的文字' } },
  ]);
  const deleted = applyCommands(prepared, [{ type: 'deleteObject', id: 'earlier' }]);
  assert.equal(deleted.facts.length, 0); assert.deepEqual(deleted.objects.find(item => item.id === 'anchor')!.event!.causes, []);
  assert.deepEqual(deleted.scenes[0].eventIds, []); assert.equal(deleted.scenes[0].text, '保留我的文字');
  assert.equal(deleted.knowledge[0].content, '我一直这样相信');
});

test('阶段撤销保留无关编辑；触及同一对象或后续依赖时原子拒绝', () => {
  const store = new NovelStore(':memory:');
  try {
    let workspace = store.createProject('撤销');
    workspace = store.execute({ projectId: workspace.id, actor: 'ai', expectedRevision: workspace.revision, taskId: 'task', commands: [{ type: 'putObject', value: character('detective') }] });
    workspace = store.execute({ projectId: workspace.id, actor: 'human', expectedRevision: workspace.revision, commands: [{ type: 'updateNovel', patch: { brief: '用户另外写的构思' } }] });
    workspace = store.undo(workspace.id, 'task');
    assert.equal(workspace.brief, '用户另外写的构思'); assert.equal(workspace.objects.length, 0);
    workspace = store.execute({ projectId: workspace.id, actor: 'ai', expectedRevision: workspace.revision, taskId: 'conflict', commands: [{ type: 'putObject', value: character('detective') }] });
    workspace = store.execute({ projectId: workspace.id, actor: 'human', expectedRevision: workspace.revision, commands: [{ type: 'putObject', value: { ...character('detective'), name: '用户新名字' } }] });
    assert.throws(() => store.undo(workspace.id, 'conflict'), /UNDO_CONFLICT/);
    assert.equal(store.getProject(workspace.id).objects[0].name, '用户新名字');
    assert.equal(store.history(workspace.id).find(batch => batch.taskId === 'conflict')!.undone, false);
    workspace = store.execute({ projectId: workspace.id, actor: 'ai', expectedRevision: workspace.revision, taskId: 'referenced', commands: [{ type: 'putObject', value: event('event', 1) }] });
    workspace = store.execute({ projectId: workspace.id, actor: 'human', expectedRevision: workspace.revision, commands: [{ type: 'putScene', value: { id: 'scene', chapterId: workspace.chapters[0].id, order: 0, title: '依赖', povId: null, eventIds: ['event'], outline: '', text: '后来写的正文' } }] });
    assert.throws(() => store.undo(workspace.id, 'referenced'), /UNDO_CONFLICT/);
    assert.ok(store.getProject(workspace.id).objects.some(item => item.id === 'event'));
  } finally { store.close(); }
});

test('SQLite重开、备份导入与语义修订冲突，阅读和移动不增加语义版本', () => {
  const directory = mkdtempSync(join(tmpdir(), 'novel-store-')); const filename = join(directory, 'test.sqlite');
  let store = new NovelStore(filename);
  try {
    let workspace = store.createProject('持久化'); const originalId = workspace.id;
    workspace = store.execute({ projectId: workspace.id, actor: 'human', commands: [{ type: 'setLayout', key: 'graph', value: { x: 10, y: 20 } }, { type: 'setReading', value: { ...workspace.reading, scroll: 150 } }] });
    assert.equal(workspace.revision, 0);
    workspace = store.execute({ projectId: workspace.id, actor: 'human', expectedRevision: 0, commands: [{ type: 'updateNovel', patch: { brief: '已修改' } }] });
    assert.throws(() => store.execute({ projectId: workspace.id, actor: 'ai', expectedRevision: 0, commands: [{ type: 'updateNovel', patch: { brief: '过时覆盖' } }] }), /REVISION_CONFLICT/);
    assert.equal(store.getProject(originalId).brief, '已修改');
    const history = store.history(originalId); store.close(); store = new NovelStore(filename);
    assert.equal(store.getProject(originalId).reading.scroll, 150);
    assert.throws(() => store.importProject({ workspace, history } as never), /不导入操作历史/);
    const imported = store.importProject(JSON.stringify({ workspace }));
    assert.notEqual(imported.id, originalId); assert.equal(imported.brief, '已修改');
    assert.equal(store.history(imported.id).length, 0);
    assert.equal(store.listProjects().length, 2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('嵌套分组校验与解散：成员提升到原父组，绝对位置和成员连接保留', () => {
  const store = new NovelStore(':memory:');
  try {
    let workspace = store.createProject('嵌套分组');
    const cards = [
      card('outer', { kind: 'group', x: 20, y: 30, width: 900, height: 700 }),
      card('middle', { kind: 'group', groupId: 'outer', x: 70, y: 90, width: 600, height: 450, collapsed: true }),
      card('inner', { kind: 'group', groupId: 'middle', x: 110, y: 140 }),
      card('member', { groupId: 'inner', x: 160, y: 210 }),
      card('peer', { groupId: 'middle', x: 440, y: 280 }),
    ];
    workspace = store.execute({ projectId: workspace.id, actor: 'human', commands: [
      ...cards.map(value => ({ type: 'putCard' as const, value })),
      { type: 'putCanvasLink', value: { id: 'members', source: 'member', target: 'peer' } },
    ] });
    const history = store.history(workspace.id);
    for (const patch of [{ groupId: 'inner' }, { width: 0 }, { height: NaN }, { collapsed: 'yes' as never }]) {
      assert.throws(() => store.execute({ projectId: workspace.id, actor: 'human', commands: [{ type: 'putCard', value: { ...cards[0]!, ...patch } }] }), DomainValidationError);
      assert.deepEqual(store.getProject(workspace.id), workspace);
      assert.deepEqual(store.history(workspace.id), history);
    }
    workspace = store.execute({ projectId: workspace.id, actor: 'human', commands: [{ type: 'deleteCard', id: 'middle' }] });
    assert.equal(workspace.cards.find(item => item.id === 'inner')!.groupId, 'outer');
    assert.equal(workspace.cards.find(item => item.id === 'peer')!.groupId, 'outer');
    assert.equal(workspace.cards.find(item => item.id === 'member')!.groupId, 'inner');
    for (const item of workspace.cards) assert.deepEqual([item.x, item.y], [cards.find(original => original.id === item.id)!.x, cards.find(original => original.id === item.id)!.y]);
    assert.deepEqual(workspace.canvasLinks, [{ id: 'members', source: 'member', target: 'peer' }]);
    workspace = store.undo(workspace.id, store.history(workspace.id)[0]!.id);
    assert.equal(workspace.cards.find(item => item.id === 'inner')!.groupId, 'middle');
    assert.equal(workspace.cards.find(item => item.id === 'middle')!.collapsed, true);
  } finally { store.close(); }
});

test('AI 使用批次开始布局保护已有卡片和图位置，允许新卡片初始位置与成员关系', () => {
  const store = new NovelStore(':memory:');
  try {
    let workspace = store.createProject('布局并发');
    workspace = store.execute({ projectId: workspace.id, actor: 'human', commands: [
      { type: 'putCard', value: card('note') }, { type: 'putCard', value: card('group', { kind: 'group' }) },
      { type: 'setLayout', key: 'world:note', value: { x: 20, y: 30 } },
    ] });
    const stale = workspace.cards.find(item => item.id === 'note')!;
    const revision = workspace.revision;
    const layout = { x: 360, y: 420, width: 500, height: 380, collapsed: true };
    workspace = store.execute({ projectId: workspace.id, actor: 'human', commands: [
      { type: 'putCard', value: { ...stale, ...layout } },
      { type: 'setLayout', key: 'world:note', value: { x: 800, y: 600 } },
    ] });
    assert.equal(workspace.revision, revision);
    workspace = store.execute({ projectId: workspace.id, actor: 'ai', expectedRevision: revision, taskId: 'layout-task', commands: [
      { type: 'putCard', value: { ...stale, title: 'AI 第一次更新', x: -10, width: 1 } },
      { type: 'deleteCard', id: stale.id },
      { type: 'putCard', value: { ...stale, title: 'AI 更新', groupId: 'group', x: -20, y: -30, width: 2, height: 3, collapsed: false } },
      { type: 'putCard', value: card('group', { kind: 'group', title: 'AI 分组标题', width: 999, collapsed: true }) },
      { type: 'putCard', value: card('new', { x: 700, y: 800, width: 320, height: 240, collapsed: false }) },
      { type: 'setLayout', key: 'world:note', value: { x: -1, y: -2 } },
      { type: 'setLayout', key: 'story:new', value: { x: 40, y: 50 } },
    ] });
    assert.deepEqual(workspace.cards.find(item => item.id === stale.id), { ...stale, ...layout, title: 'AI 更新', groupId: 'group' });
    assert.equal(workspace.cards.find(item => item.id === 'group')!.width, undefined);
    assert.equal(workspace.cards.find(item => item.id === 'group')!.collapsed, undefined);
    assert.deepEqual(workspace.cards.find(item => item.id === 'new'), card('new', { x: 700, y: 800, width: 320, height: 240, collapsed: false }));
    assert.deepEqual(workspace.layouts, { 'world:note': { x: 800, y: 600 }, 'story:new': { x: 40, y: 50 } });
    assert.equal(workspace.revision, revision + 1);
  } finally { store.close(); }
});

test('AI 卡片任务跨人工布局仍可整体撤销，保留最新布局；人工语义冲突原子拒绝', () => {
  const store = new NovelStore(':memory:');
  try {
    let workspace = store.createProject('布局与撤销');
    const original = card('note');
    workspace = store.execute({ projectId: workspace.id, actor: 'human', commands: [{ type: 'putCard', value: original }, { type: 'putCard', value: card('group', { kind: 'group' }) }] });
    workspace = store.execute({ projectId: workspace.id, actor: 'ai', expectedRevision: workspace.revision, taskId: 'task', commands: [{ type: 'putCard', value: { ...original, title: 'AI 标题', groupId: 'group' } }] });
    workspace = store.execute({ projectId: workspace.id, actor: 'human', commands: [{ type: 'putCard', value: { ...workspace.cards[0]!, x: 300, y: 400, collapsed: true } }] });
    workspace = store.execute({ projectId: workspace.id, actor: 'ai', expectedRevision: workspace.revision, taskId: 'task', commands: [{ type: 'putCard', value: { ...workspace.cards[0]!, content: 'AI 第二次更新' } }] });
    const layout = { x: 600, y: 700, width: 640, height: 480, collapsed: false };
    workspace = store.execute({ projectId: workspace.id, actor: 'human', commands: [{ type: 'putCard', value: { ...workspace.cards[0]!, ...layout } }] });
    workspace = store.undo(workspace.id, 'task');
    assert.deepEqual(workspace.cards.find(item => item.id === original.id), { ...original, ...layout });
    assert.ok(store.history(workspace.id).filter(batch => batch.taskId === 'task').every(batch => batch.undone));
    const restored = workspace.cards[0]!;
    const revision = workspace.revision;
    workspace = store.execute({ projectId: workspace.id, actor: 'human', commands: [{ type: 'putCard', value: { ...restored, x: 900, y: 950 } }] });
    const movement = store.history(workspace.id)[0]!;
    assert.equal(movement.changes[0]!.collection, 'cards');
    workspace = store.undo(workspace.id, movement.id);
    assert.deepEqual(workspace.cards[0], restored);
    assert.equal(workspace.revision, revision);
    workspace = store.execute({ projectId: workspace.id, actor: 'ai', expectedRevision: workspace.revision, taskId: 'conflict', commands: [
      { type: 'putCard', value: { ...restored, title: '再次 AI 更新' } }, { type: 'updateNovel', patch: { brief: '同时更新构思' } },
    ] });
    workspace = store.execute({ projectId: workspace.id, actor: 'human', commands: [{ type: 'putCard', value: { ...workspace.cards[0]!, groupId: 'group', content: '人工修订' } }] });
    const history = store.history(workspace.id);
    assert.throws(() => store.undo(workspace.id, 'conflict'), /UNDO_CONFLICT/);
    assert.deepEqual(store.getProject(workspace.id), workspace);
    assert.deepEqual(store.history(workspace.id), history);
  } finally { store.close(); }
});

test('AI 新建和删除分组可撤销，布局调整不阻塞，后续成员依赖仍阻止删除', () => {
  const store = new NovelStore(':memory:');
  try {
    let workspace = store.createProject('分组任务撤销');
    const group = card('group', { kind: 'group', x: 20, y: 30, width: 500, height: 400, collapsed: true });
    const member = card('member', { groupId: group.id });
    workspace = store.execute({ projectId: workspace.id, actor: 'human', commands: [{ type: 'putCard', value: group }, { type: 'putCard', value: member }] });
    workspace = store.execute({ projectId: workspace.id, actor: 'ai', expectedRevision: workspace.revision, taskId: 'create', commands: [{ type: 'putCard', value: card('created', { kind: 'group' }) }] });
    workspace = store.execute({ projectId: workspace.id, actor: 'human', commands: [{ type: 'putCard', value: { ...workspace.cards.find(item => item.id === 'created')!, x: 800, width: 700, collapsed: true } }] });
    workspace = store.undo(workspace.id, 'create');
    assert.ok(!workspace.cards.some(item => item.id === 'created'));
    workspace = store.execute({ projectId: workspace.id, actor: 'ai', expectedRevision: workspace.revision, taskId: 'delete', commands: [{ type: 'deleteCard', id: group.id }] });
    workspace = store.execute({ projectId: workspace.id, actor: 'human', commands: [{ type: 'putCard', value: { ...workspace.cards[0]!, x: 360, y: 420 } }] });
    workspace = store.undo(workspace.id, 'delete');
    assert.deepEqual(workspace.cards.find(item => item.id === group.id), group);
    assert.deepEqual(workspace.cards.find(item => item.id === member.id), { ...member, x: 360, y: 420 });
    workspace = store.execute({ projectId: workspace.id, actor: 'ai', expectedRevision: workspace.revision, taskId: 'dependent', commands: [{ type: 'putCard', value: card('parent', { kind: 'group' }) }] });
    workspace = store.execute({ projectId: workspace.id, actor: 'human', commands: [{ type: 'putCard', value: card('child', { groupId: 'parent' }) }] });
    const history = store.history(workspace.id);
    assert.throws(() => store.undo(workspace.id, 'dependent'), /UNDO_CONFLICT/);
    assert.deepEqual(store.getProject(workspace.id), workspace);
    assert.deepEqual(store.history(workspace.id), history);
  } finally { store.close(); }
});

test('缺失实体、类型字段或命令标识属于可纠正领域错误，事务不保存部分修改', () => {
  const store = new NovelStore(':memory:');
  try {
    const workspace = store.createProject('命令校验');
    for (const command of [null, { type: 'putObject' }, { type: 'putCard' },
      { type: 'putObjectType', value: { id: 'broken', name: '缺少字段' } },
      { type: 'putObjectType', value: { id: 'broken', name: '错误字段', fields: [null] } },
      { type: 'deleteCard' }, { type: 'unknown' }]) {
      assert.throws(() => store.execute({ projectId: workspace.id, actor: 'ai', expectedRevision: workspace.revision,
        commands: [{ type: 'updateNovel', patch: { brief: '不能部分保存' } }, command as never] }), DomainValidationError);
      assert.deepEqual(store.getProject(workspace.id), workspace);
      assert.equal(store.history(workspace.id).length, 0);
    }
  } finally { store.close(); }
});

test('SQLite 省略可选 undefined 字段后，使用原返回卡片纯移动不增加语义修订号', () => {
  const store = new NovelStore(':memory:');
  try {
    let workspace = store.createProject('可选字段布局');
    workspace = store.execute({ projectId: workspace.id, actor: 'human', commands: [
      { type: 'putCard', value: card('note', { refId: undefined, groupId: undefined }) },
    ] });
    const returned = workspace.cards[0]!, revision = workspace.revision;
    assert.equal(Object.hasOwn(returned, 'refId'), true);
    assert.equal(Object.hasOwn(store.getProject(workspace.id).cards[0]!, 'refId'), false);
    workspace = store.execute({ projectId: workspace.id, actor: 'human', expectedRevision: revision, commands: [
      { type: 'putCard', value: { ...returned, x: 350, y: 470 } },
    ] });
    assert.equal(workspace.revision, revision);
    assert.equal(store.getProject(workspace.id).revision, revision);
    workspace = store.undo(workspace.id, store.history(workspace.id)[0]!.id);
    assert.equal(workspace.cards[0]!.x, returned.x);
    assert.equal(workspace.revision, revision);
  } finally { store.close(); }
});
