import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NovelStore } from './store.js';
import { applyCommands, createWorkspace, DomainValidationError } from './domain.js';
import { assertWriteScope } from './agent/policy.js';
import { buildWriterContext } from './context.js';
import { checkProposals, CompanionService, companionContext, decisionLog, normalizeResponse, partialReply } from './agent/companion.js';
import { StyleLearningService } from './agent/style-learning.js';
import { DemoStyleTransport } from './agent/style-learning.js';
import { DemoCompanionTransport } from './agent/companion-demo.js';
import { companionCommands, selectCompanionItems } from '../shared/companion.js';
import type { AgentEvent, ProviderSecret, Workspace } from '../shared/types.js';
import type { CompanionAnchor, CompanionOp, CompanionResponse, CompanionThread, CompanionTurn } from '../shared/companion-types.js';
import type { ModelRequest, ResponseTransport } from './responses.js';

const provider: ProviderSecret = { name: '演示', baseURL: '', model: 'demo', mode: 'mock', apiKey: '' };

function temporaryStore(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'novel-companion-'));
  const store = new NovelStore(join(directory, 'novel.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
function op(patch: Partial<CompanionOp> & Pick<CompanionOp, 'op' | 'id'>): CompanionOp {
  return { ref: null, targetId: null, parentRef: null, parentId: null, title: null, content: null, purpose: null, order: null, povName: null, causes: [], people: [], ...patch };
}
function response(patch: Partial<CompanionResponse>): CompanionResponse {
  return { reply: '', questions: [], ideas: [], proposals: [], followUps: [], ...patch };
}
let counter = 0;
const newId = () => `id-${++counter}`;
function sample(): Workspace {
  const base = createWorkspace('伙伴测试');
  const chapter = base.chapters[0]!;
  return applyCommands(base, [
    { type: 'putObject', value: { id: 'lin', typeId: 'character', name: '林舟', fields: {} } },
    { type: 'putObject', value: { id: 'shen', typeId: 'character', name: '沈卿', fields: {} } },
    { type: 'putObject', value: { id: 'e1', typeId: 'event', name: '钟响', fields: {}, event: { worldOrder: 1, timeLabel: '', thread: '钟楼', participants: ['lin'], causes: [], critical: false, observations: {} } } },
    { type: 'putObject', value: { id: 'e2', typeId: 'event', name: '开门', fields: {}, event: { worldOrder: 2, timeLabel: '', thread: '钟楼', participants: ['lin'], causes: ['e1'], critical: false, observations: {} } } },
    { type: 'putScene', value: { id: 's1', chapterId: chapter.id, order: 1, title: '铜片', povId: 'lin', eventIds: [], outline: '捡到铜片', text: '已经写好的正文。' } },
    { type: 'putScene', value: { id: 's2', chapterId: chapter.id, order: 2, title: '钟声', povId: 'shen', eventIds: [], outline: '第十三声', text: '' } },
    { type: 'putScene', value: { id: 's3', chapterId: chapter.id, order: 3, title: '钥匙', povId: 'lin', eventIds: [], outline: '选择', text: '' } },
    { type: 'putCard', value: { id: 'anchor', kind: 'note', title: '第十三声', content: '异常钟声', x: 100, y: 100 } },
  ]);
}
const canvasAnchor: CompanionAnchor = { surface: 'canvas', references: [{ kind: 'card', id: 'anchor' }] };

test('大纲幕/卷：章节归属校验，删除幕清空归属，撤销恢复', t => {
  const store = temporaryStore(t);
  const project = store.createProject('分层大纲');
  const chapter = project.chapters[0]!;
  assert.throws(() => applyCommands(project, [{ type: 'putChapter', value: { ...chapter, actId: 'missing' } }]), DomainValidationError);
  assert.throws(() => applyCommands(project, [{ type: 'putAct', value: { id: 'a', title: '一', order: 1, purpose: '', summary: '' } }, { type: 'putAct', value: { id: 'b', title: '二', order: 1, purpose: '', summary: '' } }]), /顺序/);
  const withAct = store.execute({ projectId: project.id, actor: 'human', commands: [
    { type: 'updateNovel', patch: { logline: '学徒在第十三声后决定相信谁。', structureTemplate: 'three-act' } },
    { type: 'putAct', value: { id: 'a', title: '建置', order: 1, purpose: '激励事件', summary: '' } },
    { type: 'putChapter', value: { ...chapter, actId: 'a', summary: '捡到铜片' } },
  ] });
  assert.equal(withAct.logline, '学徒在第十三声后决定相信谁。');
  assert.equal(withAct.revision, project.revision + 1);
  const removed = store.execute({ projectId: project.id, actor: 'human', commands: [{ type: 'deleteAct', id: 'a' }] });
  assert.equal(removed.chapters[0]!.actId, undefined);
  assert.equal(removed.chapters[0]!.summary, '捡到铜片');
  const restored = store.undo(project.id, store.history(project.id)[0]!.id);
  assert.equal(restored.chapters[0]!.actId, 'a');
  assert.equal(restored.acts?.[0]?.title, '建置');
  const all = store.undo(project.id, store.history(project.id).find(batch => !batch.undone)!.id);
  assert.equal(all.logline, '');
  assert.deepEqual(all.acts, []);
});

test('正文任务不能附带修改大纲；写作上下文带上章节与幕的任务', () => {
  const before = sample();
  const chapter = before.chapters[0]!;
  const after = applyCommands(before, [{ type: 'putAct', value: { id: 'a', title: '建置', order: 1, purpose: '让主角离开日常', summary: '' } }, { type: 'putChapter', value: { ...chapter, actId: 'a', summary: '发现异常' } }]);
  const changes = [{ collection: 'acts', key: 'a', before: undefined, after: after.acts![0] }, { collection: 'chapters', key: chapter.id, before: chapter, after: after.chapters[0] }];
  assert.throws(() => assertWriteScope({ projectId: before.id, stage: 'chapter', objective: '写', sceneId: 's2' }, before, after, changes), /WRITE_SCOPE/);
  const context = buildWriterContext(after, 's2');
  assert.equal(context.outlinePlan.chapter.summary, '发现异常');
  assert.equal(context.outlinePlan.act?.purpose, '让主角离开日常');
});

test('点子围绕锚点卡片放射排布并连线，可包进新分组', () => {
  const project = sample();
  const ideas = response({ ideas: ['甲', '乙', '丙', '丁'].map((title, index) => ({ id: `i${index + 1}`, kind: 'whatif' as const, title, content: `${title}内容`, hook: '悬念' })) });
  const { commands, skipped } = companionCommands(project, selectCompanionItems(ideas, ['i1', 'i2', 'i3', 'i4']), { mode: 'diverge', anchor: canvasAnchor, group: true, newId });
  assert.deepEqual(skipped, []);
  const next = applyCommands(project, commands);
  const notes = next.cards.filter(card => card.kind === 'note' && card.id !== 'anchor');
  assert.equal(notes.length, 4);
  assert.ok(notes.every(card => card.content.includes('钩子：悬念')));
  assert.equal(next.canvasLinks.filter(link => link.source === 'anchor').length, 4);
  const group = next.cards.find(card => card.kind === 'group')!;
  assert.equal(group.title, '「第十三声」的延伸');
  assert.ok(notes.every(card => card.groupId === group.id));
  assert.ok(new Set(notes.map(card => `${Math.round(card.x)}:${Math.round(card.y)}`)).size === 4, '点子不能重叠');
  const anchorCard = next.cards.find(card => card.id === 'anchor')!;
  assert.ok(!(anchorCard.x >= group.x && anchorCard.x <= group.x + group.width!), '分组不压住锚点');
  // A second adoption around the same anchor takes free slots instead of stacking on the first.
  const one = response({ ideas: [{ id: 'i1', kind: 'twist', title: '一', content: '', hook: '' }] });
  const first = applyCommands(project, companionCommands(project, selectCompanionItems(one, ['i1']), { mode: 'diverge', anchor: canvasAnchor, newId }).commands);
  const second = applyCommands(first, companionCommands(first, selectCompanionItems(one, ['i1']), { mode: 'diverge', anchor: canvasAnchor, newId }).commands);
  const placed = second.cards.filter(card => card.id !== 'anchor');
  assert.equal(placed.length, 2);
  assert.ok(Math.abs(placed[0]!.x - placed[1]!.x) >= 218 || Math.abs(placed[0]!.y - placed[1]!.y) >= 150, '再次采纳不重叠');
  assert.ok(commands.every(command => !command.type.startsWith('delete')));
});

test('大纲草案：沿用空白第一章、解析 ref、新场景正文为空，部分采纳会带上祖先', () => {
  const blank = createWorkspace('空白书');
  const draft = response({ proposals: [{ id: 'p1', title: '草案', summary: '', ops: [
    op({ id: 'o1', op: 'addAct', ref: 'a1', title: '建置', purpose: '激励事件' }),
    op({ id: 'o2', op: 'addChapter', ref: 'c1', parentRef: 'a1', title: '雾中来信', content: '收到信' }),
    op({ id: 'o3', op: 'addScene', parentRef: 'c1', title: '铜片', content: '捡到铜片' }),
    op({ id: 'o4', op: 'addAct', ref: 'a2', title: '对抗', purpose: '升级' }),
    op({ id: 'o5', op: 'addChapter', ref: 'c2', parentRef: 'a2', title: '第十三声', content: '' }),
  ] }] });
  const selection = selectCompanionItems(draft, ['p1#o3']);
  assert.deepEqual(selection.ops.map(item => item.op.id), ['o1', 'o2', 'o3']);
  const next = applyCommands(blank, companionCommands(blank, selection, { mode: 'outline', anchor: { surface: 'outline', references: [] }, newId }).commands);
  assert.equal(next.chapters.length, 1, '空白第一章被大纲接管');
  assert.equal(next.chapters[0]!.title, '雾中来信');
  assert.equal(next.chapters[0]!.actId, next.acts![0]!.id);
  assert.equal(next.scenes[0]!.chapterId, next.chapters[0]!.id);
  assert.equal(next.scenes[0]!.text, '');
  const full = applyCommands(blank, companionCommands(blank, selectCompanionItems(draft, ['p1']), { mode: 'outline', anchor: { surface: 'outline', references: [] }, newId }).commands);
  const ordered = [...full.chapters].sort((a, b) => a.order - b.order);
  assert.deepEqual(ordered.map(chapter => chapter.title), ['雾中来信', '第十三声']);
  assert.deepEqual([...full.acts!].sort((a, b) => a.order - b.order).map(act => act.title), ['建置', '对抗']);
});

test('结构方案只重排与改大纲，不改正文；无法对应的建议被跳过', () => {
  const project = sample();
  const plan = response({ proposals: [{ id: 'p1', title: '换个开篇', summary: '', ops: [
    op({ id: 'o1', op: 'moveScene', targetId: 's3', order: 1 }),
    op({ id: 'o2', op: 'updateScene', targetId: 's1', content: '新的大纲', povName: '沈卿' }),
    op({ id: 'o3', op: 'updateScene', targetId: 'ghost', content: 'x' }),
  ] }] });
  const { commands, skipped } = companionCommands(project, selectCompanionItems(plan, ['p1']), { mode: 'structure', anchor: { surface: 'story', references: [] }, newId });
  assert.equal(skipped.length, 1);
  const next = applyCommands(project, commands);
  const order = next.scenes.filter(scene => scene.chapterId === project.chapters[0]!.id).sort((a, b) => a.order - b.order).map(scene => scene.id);
  assert.deepEqual(order, ['s3', 's1', 's2']);
  const s1 = next.scenes.find(scene => scene.id === 's1')!;
  assert.equal(s1.text, '已经写好的正文。');
  assert.equal(s1.outline, '新的大纲');
  assert.equal(s1.povId, 'shen');
});

test('结构方案可以在方案里新建章节：新章紧跟目标章，勾选场景自动带上章节，三要素一并写入', () => {
  const base = sample(), first = base.chapters[0]!;
  const project = applyCommands(base, [
    { type: 'putChapter', value: { id: 'ch2', title: '第二章', order: 1 } },
    { type: 'putScene', value: { id: 's4', chapterId: 'ch2', order: 1, title: '码头', povId: null, eventIds: [], outline: '', text: '' } },
    { type: 'putObject', value: { id: 'tower', typeId: 'setting', name: '钟楼', fields: {} } },
  ]);
  const plan = response({ proposals: [{ id: 'p1', title: '插叙', summary: '', ops: [
    op({ id: 'o1', op: 'addChapter', ref: 'c1', targetId: first.id, title: '插叙 · 三十年前', content: '交代旧案' }),
    op({ id: 'o2', op: 'addScene', parentRef: 'c1', title: '旧案', content: '沉默的目击者', povName: '沈卿', people: ['林舟', '沈卿'], places: ['钟楼'], events: ['钟响'] }),
    op({ id: 'o3', op: 'moveScene', targetId: 's3', parentRef: 'c1', order: 1 }),
  ] }] });
  const partial = selectCompanionItems(plan, ['p1#o2']);
  assert.deepEqual(partial.ops.map(item => item.op.id), ['o1', 'o2'], '勾选场景会带上它的新章节');
  const anchor: CompanionAnchor = { surface: 'story', references: [] };
  const { commands, skipped } = companionCommands(project, partial, { mode: 'structure', anchor, newId });
  assert.deepEqual(skipped, []);
  const next = applyCommands(project, commands);
  const ordered = [...next.chapters].sort((a, b) => a.order - b.order).map(chapter => chapter.title);
  assert.deepEqual(ordered, ['第一章', '插叙 · 三十年前', '第二章']);
  const flashback = next.chapters.find(chapter => chapter.title === '插叙 · 三十年前')!;
  const scene = next.scenes.find(item => item.title === '旧案')!;
  assert.equal(scene.chapterId, flashback.id);
  assert.equal(scene.text, '');
  assert.equal(scene.povId, 'shen');
  assert.deepEqual(scene.castIds, ['lin'], '视角人物不重复列为出场人物');
  assert.deepEqual(scene.settingIds, ['tower']);
  assert.deepEqual(scene.eventIds, ['e1']);
  const whole = applyCommands(project, companionCommands(project, selectCompanionItems(plan, ['p1']), { mode: 'structure', anchor, newId }).commands);
  const moved = whole.scenes.filter(item => item.chapterId === whole.chapters.find(chapter => chapter.title === '插叙 · 三十年前')!.id).sort((a, b) => a.order - b.order);
  assert.deepEqual(moved.map(item => item.id === 's3' ? 's3' : item.title), ['s3', '旧案']);
  assert.equal(whole.scenes.find(item => item.id === 's1')!.text, '已经写好的正文。');
});

test('新场景找不到章节时自动建章：同一未知句柄只建一章，按标题能对上已有章节', () => {
  const project = sample(), first = project.chapters[0]!;
  const plan = response({ proposals: [{ id: 'p1', title: '补场景', summary: '', ops: [
    op({ id: 'o1', op: 'addScene', parentId: '第二章 雨夜', title: '甲' }),
    op({ id: 'o2', op: 'addScene', parentId: '第二章 雨夜', title: '乙' }),
    op({ id: 'o3', op: 'addScene', title: '丙' }),
    op({ id: 'o4', op: 'addScene', parentId: '第一章', title: '丁', people: ['不存在的人'] }),
  ] }] });
  const anchor: CompanionAnchor = { surface: 'story', references: [{ kind: 'scene', id: 's2' }] };
  const { commands, skipped, refs } = companionCommands(project, selectCompanionItems(plan, ['p1']), { mode: 'structure', anchor, newId });
  assert.equal(skipped.length, 1, '未知人物会被报告');
  assert.match(skipped[0]!, /不存在的人/);
  const next = applyCommands(project, commands);
  const ordered = [...next.chapters].sort((a, b) => a.order - b.order);
  assert.deepEqual(ordered.map(chapter => chapter.title), ['第一章', '第二章 雨夜', '丙'], '新章按提出顺序排在锚点章之后');
  const titles = (chapterId: string) => next.scenes.filter(scene => scene.chapterId === chapterId).sort((a, b) => a.order - b.order).map(scene => scene.title);
  assert.deepEqual(titles(ordered[1]!.id), ['甲', '乙']);
  assert.deepEqual(titles(ordered[2]!.id), ['丙']);
  assert.ok(titles(first.id).includes('丁'));
  assert.equal(refs['p1:第二章 雨夜'], ordered[1]!.id, '后续部分采纳沿用同一章');
});

test('环境是一等公民：addSetting 同名沿用，updateScene 只追加三要素，设定点子可以设为环境', () => {
  const project = applyCommands(sample(), [{ type: 'putObject', value: { id: 'tower', typeId: 'setting', name: '钟楼', fields: { description: '旧钟楼' } } }]);
  const plan = response({ proposals: [{ id: 'p1', title: '环境', summary: '', ops: [
    op({ id: 'o1', op: 'addSetting', ref: 's1', title: '潮汐市场', content: '嘈杂', purpose: '交易必须当面完成' }),
    op({ id: 'o2', op: 'addSetting', title: '钟楼' }),
    op({ id: 'o3', op: 'updateScene', targetId: 's2', people: ['林舟'], places: ['s1'], events: ['开门'] }),
    op({ id: 'o4', op: 'updateScene', targetId: 's2', places: ['钟楼'] }),
    op({ id: 'o5', op: 'updateSetting', targetId: 'tower', content: '海雾里的旧钟楼', purpose: '最多敲十二下' }),
  ] }], ideas: [{ id: 'i1', kind: 'setting', title: '旧档案馆：被遗忘的记录', content: '没人来', hook: '' }] });
  const { commands, skipped } = companionCommands(project, selectCompanionItems(plan, ['p1', 'i1']), { mode: 'develop', anchor: { surface: 'panel', references: [] }, ideasAs: 'setting', newId });
  assert.deepEqual(skipped, ['钟楼：同名环境已存在，沿用原环境']);
  const next = applyCommands(project, commands);
  const market = next.objects.find(object => object.name === '潮汐市场')!;
  assert.equal(market.typeId, 'setting');
  assert.deepEqual(market.fields, { description: '嘈杂', rules: '交易必须当面完成' });
  assert.equal(next.objects.filter(object => object.name === '钟楼').length, 1);
  assert.equal(next.objects.find(object => object.id === 'tower')!.fields.rules, '最多敲十二下');
  assert.equal(next.objects.find(object => object.name === '旧档案馆')?.typeId, 'setting');
  const scene = next.scenes.find(item => item.id === 's2')!;
  assert.deepEqual(scene.castIds, ['lin']);
  assert.deepEqual(scene.settingIds, [market.id, 'tower'], '第二次更新只追加，不覆盖');
  assert.deepEqual(scene.eventIds, ['e2']);
  assert.equal(scene.povId, 'shen');
});

test('因果推演：后果晚于原因，前因插入到结果之前并接入因果链', () => {
  const project = sample();
  const plan = response({ proposals: [{ id: 'p1', title: '推演', summary: '', ops: [
    op({ id: 'o1', op: 'addEvent', ref: 'x', title: '余波', causes: ['e2'], people: ['沈卿', '不存在的人'] }),
    op({ id: 'o2', op: 'addEvent', title: '暗中交易', targetId: 'e2', causes: ['e1'] }),
    op({ id: 'o3', op: 'addEvent', title: '矛盾', targetId: 'e1', causes: ['e2'] }),
  ] }] });
  const { commands, skipped } = companionCommands(project, selectCompanionItems(plan, ['p1']), { mode: 'causality', anchor: { surface: 'world', references: [{ kind: 'object', id: 'e2' }] }, newId });
  assert.equal(skipped.length, 1, '因果倒置的建议被跳过');
  const next = applyCommands(project, commands);
  const after = next.objects.find(object => object.name === '余波')!;
  assert.ok(after.event!.worldOrder > 2);
  assert.deepEqual(after.event!.participants, ['shen']);
  const cause = next.objects.find(object => object.name === '暗中交易')!;
  assert.ok(cause.event!.worldOrder > 1 && cause.event!.worldOrder < 2);
  assert.ok(next.objects.find(object => object.id === 'e2')!.event!.causes.includes(cause.id));
});

test('下一拍可以补进当前场景大纲；流式 JSON 只取 reply', () => {
  const project = sample();
  const beats = response({ ideas: [{ id: 'i1', kind: 'beat', title: '一个打断', content: '门外有人喊', hook: '' }] });
  const next = applyCommands(project, companionCommands(project, selectCompanionItems(beats, ['i1']), { mode: 'beat', target: 'sceneOutline', anchor: { surface: 'writer', references: [], sceneId: 's2' }, newId }).commands);
  assert.equal(next.scenes.find(scene => scene.id === 's2')!.outline, '第十三声\n· 一个打断：门外有人喊');
  assert.equal(partialReply('{"reply":"你好，\\n这个'), '你好，\n这个');
  assert.equal(partialReply('{"questions":'), '');
});

class Capture implements ResponseTransport {
  requests: ModelRequest[] = [];
  constructor(private inner: ResponseTransport = new DemoCompanionTransport()) {}
  stream(request: ModelRequest, signal: AbortSignal) { this.requests.push(structuredClone(request)); return this.inner.stream(request, signal); }
}
async function settled(store: NovelStore, projectId: string, id: string): Promise<CompanionThread> {
  for (let i = 0; i < 400; i++) {
    const thread = store.getCompanionThread(projectId, id)!;
    if (thread.status !== 'streaming') return thread;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('伙伴回复超时');
}

test('伙伴对话：多轮历史回灌、采纳写入可撤销、重复采纳幂等', async t => {
  const store = temporaryStore(t);
  const project = store.execute({ projectId: store.createProject('对话').id, actor: 'human', commands: sample().cards.map(value => ({ type: 'putCard' as const, value })) });
  const events: AgentEvent[] = [];
  const transport = new Capture();
  const service = new CompanionService(store, () => provider, event => events.push(event), () => transport);
  const first = service.ask({ projectId: project.id, mode: 'diverge', anchor: canvasAnchor, message: '围绕第十三声发散', intensity: 'bold' });
  assert.equal(first.status, 'streaming');
  let thread = await settled(store, project.id, first.id);
  assert.equal(thread.status, 'idle');
  const reply = thread.turns.at(-1)!;
  assert.ok(reply.response!.ideas.length >= 4);
  assert.ok(events.some(event => event.type === 'companion' && event.thread?.streaming), '流式过程中推送 reply 片段');
  assert.match(transport.requests[0]!.instructions, /大胆/);

  service.ask({ projectId: project.id, threadId: thread.id, mode: 'diverge', anchor: canvasAnchor, message: '主角最怕被师父知道', intensity: 'steady' });
  thread = await settled(store, project.id, thread.id);
  const context = JSON.parse((transport.requests[1]!.input[0] as { content: string }).content).context;
  assert.equal(context.conversation[0].author, '围绕第十三声发散');
  assert.ok(context.conversation[1].ideas.length >= 4);
  assert.equal(thread.turns.length, 4);

  const result = service.adopt({ projectId: project.id, threadId: thread.id, turnId: reply.id, itemIds: ['i1', 'i2'] });
  assert.ok(result.batchId);
  let current = store.getProject(project.id);
  assert.equal(current.cards.length, 3);
  assert.equal(current.canvasLinks.length, 2);
  assert.equal(store.history(project.id)[0]!.actor, 'ai');
  const again = service.adopt({ projectId: project.id, threadId: thread.id, turnId: reply.id, itemIds: ['i1'] });
  assert.equal(again.batchId, result.batchId);
  assert.equal(store.getProject(project.id).cards.length, 3);
  assert.throws(() => service.adopt({ projectId: project.id, threadId: thread.id, turnId: reply.id, itemIds: ['i99'] }), /不存在/);

  const undone = service.undo(project.id, thread.id, result.batchId!);
  assert.deepEqual(undone.turns.find(turn => turn.id === reply.id)!.adopted, {});
  current = store.getProject(project.id);
  assert.equal(current.cards.length, 1);
  assert.equal(service.threads(project.id).length, 1);
  service.delete(project.id, thread.id);
  assert.equal(service.threads(project.id).length, 0);
});

test('大纲分次采纳：先采纳场景会带上父级，再采纳整份草案不重复创建', async t => {
  const store = temporaryStore(t);
  const project = store.createProject('分次采纳');
  const service = new CompanionService(store, () => provider, () => {}, () => new DemoCompanionTransport());
  const asked = service.ask({ projectId: project.id, mode: 'outline', anchor: { surface: 'outline', references: [], outlineNode: { kind: 'book' } }, message: '生成全书草案', intensity: 'steady', options: { fullDraft: true } });
  const thread = await settled(store, project.id, asked.id);
  const turn = thread.turns.at(-1)!;
  const proposal = turn.response!.proposals[0]!;
  const scene = proposal.ops.find(op => op.op === 'addScene')!;
  service.adopt({ projectId: project.id, threadId: thread.id, turnId: turn.id, itemIds: [`${proposal.id}#${scene.id}`] });
  let current = store.getProject(project.id);
  assert.equal(current.acts!.length, 1);
  assert.equal(current.scenes.length, 1);
  const whole = service.adopt({ projectId: project.id, threadId: thread.id, turnId: turn.id, itemIds: [proposal.id] });
  current = store.getProject(project.id);
  const acts = proposal.ops.filter(op => op.op === 'addAct').length, scenes = proposal.ops.filter(op => op.op === 'addScene').length;
  assert.equal(current.acts!.length, acts);
  assert.equal(current.scenes.length, scenes);
  assert.ok(current.chapters.every(chapter => chapter.actId), '每章都归入了幕');
  assert.ok(current.scenes.every(item => item.text === ''));
  service.undo(project.id, thread.id, whole.batchId!);
  assert.equal(store.getProject(project.id).scenes.length, 1);
});

test('伙伴失败与停止保留作者消息，可以重试', async t => {
  const store = temporaryStore(t);
  const project = store.createProject('失败');
  const broken: ResponseTransport = { stream: (request, signal) => {
    const inner = new DemoCompanionTransport().stream({ ...request, agentId: 'companion:none' }, signal);
    return { ...inner, finalResponse: async () => { const value = await inner.finalResponse(); return { ...value, output_text: '{"reply":1}' }; } };
  } };
  let transport: ResponseTransport = broken;
  const service = new CompanionService(store, () => provider, () => {}, () => transport);
  const asked = service.ask({ projectId: project.id, mode: 'beat', anchor: { surface: 'writer', references: [] }, message: '卡住了', intensity: 'steady' });
  let thread = await settled(store, project.id, asked.id);
  assert.equal(thread.status, 'failed');
  assert.equal(thread.turns.length, 1);
  transport = new DemoCompanionTransport();
  service.ask({ projectId: project.id, threadId: thread.id, mode: 'beat', anchor: thread.anchor, message: '', intensity: 'steady', retry: true });
  thread = await settled(store, project.id, thread.id);
  assert.equal(thread.status, 'idle');
  assert.equal(thread.turns.length, 2);

  const slow: ResponseTransport = { stream: (request, signal) => new DemoCompanionTransport().stream(request, signal) };
  transport = slow;
  service.ask({ projectId: project.id, threadId: thread.id, mode: 'beat', anchor: thread.anchor, message: '再来', intensity: 'steady' });
  assert.throws(() => service.ask({ projectId: project.id, threadId: thread.id, mode: 'beat', anchor: thread.anchor, message: '抢话', intensity: 'steady' }), /上一条/);
  service.cancel(project.id, thread.id);
  thread = await settled(store, project.id, thread.id);
  assert.equal(thread.status, 'failed');
  assert.equal(thread.error, '已停止');
  const other = store.createProject('其他');
  assert.throws(() => store.getCompanionThread(other.id, thread.id), /不属于/);
});

test('模型给出的条目 id 被替换为本地 id', () => {
  const normalized = normalizeResponse({ reply: ' 好 ', questions: [{ question: 'Q', why: 'W' }], ideas: [{ kind: 'twist', title: 'T', content: 'C', hook: 'H' }],
    proposals: [{ title: 'P', summary: 'S', ops: [{ ...op({ op: 'addCard', id: 'ignored' }), id: undefined }] }], followUps: [] });
  assert.equal(normalized.reply, '好');
  assert.equal(normalized.ideas[0]!.id, 'i1');
  assert.equal(normalized.proposals[0]!.id, 'p1');
  assert.equal(normalized.proposals[0]!.ops[0]!.id, 'o1');
  assert.ok(randomUUID());
});

test('人物与连线：新人物可被事件和场景引用，连线自动补建引用卡，因果守护时序', () => {
  const project = sample();
  const plan = response({ proposals: [{ id: 'p1', title: '阵容', summary: '', ops: [
    op({ id: 'o1', op: 'addCharacter', ref: 'c1', title: '许砚', content: '守钟人', purpose: '逼主角选择' }),
    op({ id: 'o2', op: 'addCharacter', ref: 'c2', title: '林舟', content: '重复' }),
    op({ id: 'o3', op: 'link', parentRef: 'c1', targetId: 'lin', title: '师徒' }),
    op({ id: 'o4', op: 'link', parentId: 'anchor', targetId: 'e1' }),
    op({ id: 'o5', op: 'addEvent', title: '夜访', causes: ['e2'], people: ['c1'] }),
    op({ id: 'o6', op: 'addScene', parentId: project.chapters[0]!.id, title: '守钟人', povName: 'c1' }),
    op({ id: 'o7', op: 'addCause', targetId: 'e1', causes: ['e2'] }),
    op({ id: 'o8', op: 'link', parentId: 'ghost', targetId: 'lin' }),
  ] }] });
  const { commands, skipped } = companionCommands(project, selectCompanionItems(plan, ['p1']), { mode: 'develop', anchor: canvasAnchor, newId });
  assert.equal(skipped.length, 3, skipped.join('；'));
  const next = applyCommands(project, commands);
  const xu = next.objects.find(object => object.name === '许砚')!;
  assert.equal(xu.typeId, 'character');
  assert.deepEqual(xu.fields, { description: '守钟人', goal: '逼主角选择' });
  assert.equal(next.objects.filter(object => object.name === '林舟').length, 1, '同名人物不重复创建');
  assert.deepEqual(next.objects.find(object => object.name === '夜访')!.event!.participants, [xu.id]);
  assert.equal(next.scenes.find(scene => scene.title === '守钟人')!.povId, xu.id);
  const cardOf = (id: string) => next.cards.find(card => card.refId === id)!;
  assert.ok(cardOf(xu.id) && cardOf('lin') && cardOf('e1'), '人物与被连线的实体都有画布卡片');
  const linked = (a: string, b: string) => next.canvasLinks.some(link => (link.source === a && link.target === b) || (link.source === b && link.target === a));
  assert.ok(linked(cardOf(xu.id).id, cardOf('lin').id));
  assert.ok(linked('anchor', cardOf('e1').id));
  assert.ok(linked('anchor', cardOf(xu.id).id), '新人物连到锚点');
  assert.deepEqual(next.objects.find(object => object.id === 'e1')!.event!.causes, [], '前因必须早于结果');
});

test('updateNovel 只改白名单字段；角色点子可以直接设为人物', () => {
  const project = sample();
  const plan = response({ proposals: [{ id: 'p1', title: '立意', summary: '', ops: [
    op({ id: 'o1', op: 'updateNovel', field: 'theme', content: '信任需要先承担被欺骗的风险。' }),
    op({ id: 'o2', op: 'updateNovel', field: 'title', content: '改名' }),
    op({ id: 'o3', op: 'updateNovel', purpose: 'logline', content: '一句话' }),
  ] }], ideas: [{ id: 'i1', kind: 'character', title: '许砚：沉默的守钟人', content: '知道真相', hook: '他为什么不说' }] });
  const { commands, skipped } = companionCommands(project, selectCompanionItems(plan, ['p1', 'i1']), { mode: 'develop', anchor: { surface: 'panel', references: [] }, ideasAs: 'character', newId });
  assert.equal(skipped.length, 1);
  const next = applyCommands(project, commands);
  assert.equal(next.theme, '信任需要先承担被欺骗的风险。');
  assert.equal(next.logline, '一句话');
  assert.equal(next.title, project.title);
  const xu = next.objects.find(object => object.name === '许砚')!;
  assert.equal(xu.typeId, 'character');
  assert.match(String(xu.fields.description), /钩子：他为什么不说/);
});

test('补全构想：信息稀少先问选择题，回答后给可采纳的立意版本，撤销恢复', async t => {
  const store = temporaryStore(t);
  const project = store.createProject('钟楼');
  const transport = new Capture();
  const service = new CompanionService(store, () => provider, () => {}, () => transport);
  const anchor: CompanionAnchor = { surface: 'panel', references: [], focus: 'theme' };
  const asked = service.ask({ projectId: project.id, mode: 'develop', anchor, message: '推断立意', intensity: 'steady' });
  let thread = await settled(store, project.id, asked.id);
  const first = thread.turns.at(-1)!.response!;
  const roundOf = (index: number) => JSON.parse((transport.requests[index]!.input[0] as { content: string }).content).context.target.round;
  assert.equal(roundOf(0), 'ask');
  assert.equal(first.proposals.length, 0);
  assert.ok(first.questions.every(question => question.options!.length >= 2));
  const question = first.questions[0]!;
  service.ask({ projectId: project.id, threadId: thread.id, mode: 'develop', anchor, message: `关于「${question.question}」：${question.options![0]}`, intensity: 'steady' });
  thread = await settled(store, project.id, thread.id);
  assert.equal(roundOf(1), 'draft');
  const turn = thread.turns.at(-1)!;
  assert.ok(turn.response!.proposals.length >= 2);
  const result = service.adopt({ projectId: project.id, threadId: thread.id, turnId: turn.id, itemIds: [turn.response!.proposals[1]!.id] });
  assert.match(store.getProject(project.id).theme ?? '', /自由/);
  service.undo(project.id, thread.id, result.batchId!);
  assert.equal(store.getProject(project.id).theme, '');
});

test('补全构想：信息足够时直接给人物阵容，采纳后人物进入人物列表和画布', async t => {
  const store = temporaryStore(t);
  const created = store.createProject('钟楼');
  const project = store.execute({ projectId: created.id, actor: 'human', commands: [{ type: 'updateNovel', patch: { brief: '一座每晚多响一声的钟楼，学徒发现多出来的那一声来自三十年前的一场失踪案，而师父一直在隐瞒。' } }] });
  const service = new CompanionService(store, () => provider, () => {}, () => new DemoCompanionTransport());
  const asked = service.ask({ projectId: project.id, mode: 'develop', anchor: { surface: 'panel', references: [], focus: 'cast' }, message: '设计人物', intensity: 'steady' });
  const thread = await settled(store, project.id, asked.id);
  const turn = thread.turns.at(-1)!;
  service.adopt({ projectId: project.id, threadId: thread.id, turnId: turn.id, itemIds: [turn.response!.proposals[0]!.id] });
  const current = store.getProject(project.id);
  assert.equal(current.objects.filter(object => object.typeId === 'character').length, 3);
  assert.equal(current.cards.filter(card => card.kind === 'object').length, 3);
  assert.equal(current.canvasLinks.length, 2);
});

const contextOf = (request: ModelRequest) => JSON.parse((request.input[0] as { content: string }).content).context;

test('全书草案与跳过追问只由界面传来的明确选项触发，消息里的字眼不再触发', async t => {
  const store = temporaryStore(t), capture = new Capture();
  const project = store.createProject('选项');
  const service = new CompanionService(store, () => provider, () => {}, () => capture);
  const outline = { surface: 'outline' as const, references: [], outlineNode: { kind: 'book' as const } };
  await settled(store, project.id, service.ask({ projectId: project.id, mode: 'outline', anchor: outline, message: '给我完整的全书草案', intensity: 'steady' }).id);
  const explicit = service.ask({ projectId: project.id, mode: 'outline', anchor: outline, message: '展开', intensity: 'steady', options: { fullDraft: true } });
  const thread = await settled(store, project.id, explicit.id);
  assert.deepEqual(capture.requests.map(request => contextOf(request).target.fullDraft), [false, true]);
  assert.deepEqual(thread.turns[0]!.options, { fullDraft: true });
  const develop = { surface: 'panel' as const, references: [], focus: 'theme' as const };
  await settled(store, project.id, service.ask({ projectId: project.id, mode: 'develop', anchor: develop, message: '直接给我几个版本', intensity: 'steady' }).id);
  await settled(store, project.id, service.ask({ projectId: project.id, mode: 'develop', anchor: develop, message: '来吧', intensity: 'steady', options: { versions: true } }).id);
  assert.deepEqual(capture.requests.slice(2).map(request => contextOf(request).target.round), ['ask', 'draft']);
  assert.throws(() => service.ask({ projectId: project.id, mode: 'beat', anchor: develop, message: 'x', intensity: 'steady', options: 'yes' as never }), DomainValidationError);
});

test('超过历史窗口的作者原话与已采纳内容进入 earlierDecisions；窗口内已采纳的方案带上内容', () => {
  const at = '2026-10-13T00:00:00Z', workspace = createWorkspace('决策', 'decisions');
  const response = (index: number): CompanionResponse => ({ reply: `回复${index}`, questions: [], followUps: [], ideas: [{ id: 'i1', kind: 'whatif', title: `点子${index}`, content: `点子${index}的内容`, hook: '' }],
    proposals: [{ id: 'p1', title: `方案${index}`, summary: `方案${index}的梗概`, ops: [] }] });
  const turns = Array.from({ length: 16 }, (_, index): CompanionTurn => index % 2 === 0
    ? { id: `a${index}`, role: 'author', text: index === 0 ? '主角必须是女性，结局不要大团圆' : `第${index}轮`, at }
    : { id: `c${index}`, role: 'companion', text: '', at, response: response(index), adopted: index === 1 ? { 'p1#o1': 'batch' } : index === 13 ? { p1: 'batch' } : {} });
  const thread: CompanionThread = { id: 't', projectId: workspace.id, mode: 'diverge', anchor: { surface: 'canvas', references: [] }, title: '', turns, status: 'idle', createdAt: at, updatedAt: at };
  const context = companionContext(workspace, thread, [], {}) as Record<string, any>;
  assert.deepEqual(context.earlierDecisions.entries, ['作者：主角必须是女性，结局不要大团圆', '采纳方案：方案1——方案1的梗概', '作者：第2轮']);
  assert.ok(context.conversation.some((item: any) => item.proposals?.includes('方案13（已采纳）：方案13的梗概')));
  const long = decisionLog(Array.from({ length: 60 }, (_, index) => ({ id: `a${index}`, role: 'author' as const, text: `作者第${index}次说：${'很长的想法'.repeat(20)}`, at })));
  assert.ok(long.omitted! > 0); assert.ok(long.entries.at(-1)!.startsWith('作者：作者第59次说'), '预算内保留最新的');
});

test('伙伴回复记录用量；方案生成后立即试算，标出采纳时会跳过的操作', async t => {
  const store = temporaryStore(t);
  const project = store.createProject('试算');
  const raw = { reply: '两个方案。', questions: [], ideas: [], followUps: [], proposals: [
    { title: '可行', summary: '', ops: [{ op: 'addCharacter', ref: 'c1', targetId: null, parentRef: null, parentId: null, title: '许砚', content: '学徒', purpose: null, order: null, povName: null, causes: [], people: [], places: [], events: [], field: null }] },
    { title: '有失效的操作', summary: '', ops: [
      { op: 'updateCharacter', ref: null, targetId: 'ghost', parentRef: null, parentId: null, title: '不存在的人', content: '补充', purpose: null, order: null, povName: null, causes: [], people: [], places: [], events: [], field: null },
      { op: 'addCard', ref: null, targetId: null, parentRef: null, parentId: null, title: '便笺', content: '想法', purpose: null, order: null, povName: null, causes: [], people: [], places: [], events: [], field: null }] }] };
  const transport: ResponseTransport = { stream: () => ({ events: (async function* () {})(), finalResponse: async () => ({ id: 'r', status: 'completed', output: [{ type: 'message' as const, id: 'm', role: 'assistant' as const, status: 'completed' as const,
    content: [{ type: 'output_text' as const, text: JSON.stringify(raw), annotations: [] }] }], usage: { input_tokens: 900, output_tokens: 300, total_tokens: 1200 } }) }) };
  const service = new CompanionService(store, () => provider, () => {}, () => transport);
  const anchor = { surface: 'canvas' as const, references: [] };
  let thread = await settled(store, project.id, service.ask({ projectId: project.id, mode: 'diverge', anchor, message: '想想', intensity: 'steady' }).id);
  thread = await settled(store, project.id, service.ask({ projectId: project.id, threadId: thread.id, mode: 'diverge', anchor, message: '再想想', intensity: 'steady' }).id);
  const turn = thread.turns.at(-1)!;
  assert.equal(turn.usage!.total, 1200); assert.equal(thread.usage!.total, 2400);
  const [good, partial] = turn.response!.proposals;
  assert.deepEqual(good!.check, { skipped: [] });
  assert.deepEqual(partial!.check, { skipped: [{ opId: 'o1', reason: '人物不存在' }] });
  const broken = normalizeResponse({ ...raw, proposals: [{ title: '冲突', summary: '', ops: [raw.proposals[0]!.ops[0]!, raw.proposals[0]!.ops[0]!] }] });
  checkProposals(store.getProject(project.id), thread, broken);
  assert.ok(broken.proposals[0]!.check!.skipped.length + (broken.proposals[0]!.check!.error ? 1 : 0) >= 1, '同名人物第二次创建在试算中就被标出');
});

test('作者在几个方案中采纳一个：取舍进入文风学习，学过后不再重复', async t => {
  const store = temporaryStore(t);
  const project = store.createProject('取舍');
  const service = new CompanionService(store, () => provider, () => {}, () => new DemoCompanionTransport());
  const anchor = { surface: 'style' as const, references: [], focus: 'blindtest' as const };
  const thread = await settled(store, project.id, service.ask({ projectId: project.id, mode: 'style', anchor, message: '给我几段盲测', intensity: 'steady' }).id);
  const turn = thread.turns.at(-1)!;
  assert.ok(turn.response!.proposals.length >= 2);
  const learning = new StyleLearningService(store, () => provider, () => {}, () => new DemoStyleTransport());
  assert.equal(learning.status(project.id).pendingChoices, 0, '没有采纳时没有取舍');
  service.adopt({ projectId: project.id, threadId: thread.id, turnId: turn.id, itemIds: [turn.response!.proposals[1]!.id] });
  assert.equal(learning.status(project.id).pendingChoices, 1);
  const status = await learning.learn(project.id);
  assert.equal(status.pendingChoices, 0); assert.equal(status.lastError, undefined);
  const suggestion = store.getProject(project.id).style!.suggestions.find(item => item.origin === 'choice');
  assert.ok(suggestion, '取舍形成待采纳的文风建议');
});
