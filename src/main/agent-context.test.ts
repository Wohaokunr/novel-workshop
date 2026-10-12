import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMemory, AgentRole, PlanNode, SpecialistRequest, UpstreamResult } from '../shared/agent-types.js';
import type { AgentStep, CharacterState, Command, NovelObject, RunRequest, Workspace } from '../shared/types.js';
import { applyCommands, createWorkspace } from './domain.js';
import { emptyUsage } from './responses.js';
import { boundedContext, collectContext, fingerprint, MAX_CONTEXT_CHARS, refreshMemories, searchContext, selectAuthorRules, sourceFor, sourceValid, sourcesForWorkspace } from './agent/memory.js';
import { assertWriteScope, canReadAuthor, chainWriterNodes, createBudget, validatePlan } from './agent/policy.js';
import { reviewSchema, specialistDefinition } from './agent/specialists.js';

function fixture(id = 'project-a'): Workspace {
  const original = createWorkspace('雾港小说', id);
  const character: NovelObject = { id: 'person', typeId: 'character', name: '林舟', fields: {
    selfKnowledge: '我是一名修钟学徒，见过铜片。', description: '作者秘密：真正的幕后凶手', goal: '作者预设终局揭秘',
  } };
  const event = (id: string, worldOrder: number): NovelObject => ({ id, typeId: 'event', name: `作者事件${id}`, fields: { description: '隐藏计划不能进入角色' },
    event: { worldOrder, timeLabel: '', thread: '主线', participants: ['person'], causes: [], critical: true, observations: { person: id === 'now' ? '听见钟声，看见钥匙。' : `${id}的亲见线索` } } });
  const state: CharacterState = { id: 'prior-state', characterId: 'person', eventId: 'past', perspective: '仍不确定信使的来意', psychology: '谨慎', motivation: '先修钟', evidence: '作者秘密：真正的幕后凶手', sceneIds: ['old'] };
  return applyCommands(original, [
    { type: 'putChapter', value: { ...original.chapters[0]!, id: 'chapter', title: '第一章', order: 0 } },
    { type: 'deleteChapter', id: original.chapters[0]!.id },
    { type: 'putChapter', value: { id: 'later', title: '第二章', order: 1 } },
    { type: 'putObject', value: character }, ...['past', 'now', 'future'].map((id, index) => ({ type: 'putObject' as const, value: event(id, index + 1) })),
    { type: 'putFact', value: { id: 'initial-fact', subjectId: 'person', key: '地点', value: '钟楼', fromEventId: null } },
    { type: 'putFact', value: { id: 'future-fact', subjectId: 'person', key: '未来真相', value: '未来秘密潜伏者', fromEventId: 'future' } },
    { type: 'putKnowledge', value: { id: 'known', characterId: 'person', content: '先前获得铜片线索', learnedAt: 'past', source: 'witness' } },
    { type: 'putKnowledge', value: { id: 'same-time', characterId: 'person', content: '本幕结束才获知信使姓名', learnedAt: 'now', source: 'told' } },
    { type: 'putKnowledge', value: { id: 'future-known', characterId: 'person', content: '未来秘密潜伏者', learnedAt: 'future', source: 'witness', factId: 'future-fact' } },
    { type: 'putScene', value: { id: 'old', chapterId: 'chapter', title: '铜片初现', order: 0, povId: 'person', eventIds: ['past'], outline: '作者隐藏大纲', text: '雾港钟楼中，他拾起一块铜片。' } },
    { type: 'putScene', value: { id: 'target', chapterId: 'chapter', title: '作者秘密场景标题', order: 1, povId: 'person', eventIds: ['now'], outline: '作者计划揭露幕后凶手', text: '前文甲【旧选区】后文乙' } },
    { type: 'putScene', value: { id: 'future-scene', chapterId: 'chapter', title: '未来的秘密', order: 2, povId: 'person', eventIds: ['future'], outline: '未来秘密潜伏者', text: '未来正文秘密潜伏者' } },
    { type: 'putScene', value: { id: 'mixed', chapterId: 'chapter', title: '混合未来事件', order: 3, povId: 'person', eventIds: ['now', 'future'], outline: '未来大纲不可用于此刻状态', text: '混合未来正文不可用于此刻状态' } },
    { type: 'putScene', value: { id: 'blank', chapterId: 'chapter', title: '空白场景', order: 4, povId: 'person', eventIds: ['now'], outline: '计划：站在门前犹豫', text: '' } },
    { type: 'putScene', value: { id: 'later-scene', chapterId: 'later', title: '未读章节', order: 0, povId: 'person', eventIds: ['future'], outline: '未来计划', text: '尚未读到的后文' } },
    { type: 'putCharacterState', value: state },
    { type: 'putCard', value: { id: 'note', kind: 'note', title: '铜片灵感', content: '作者秘密画布备注', x: 10, y: 20 } },
  ]);
}
function request(workspace: Workspace, patch: Partial<RunRequest> = {}): RunRequest {
  return { projectId: workspace.id, stage: 'agent', objective: '作者隐藏目标：让角色知道未来秘密潜伏者', ...patch };
}
function node(role: PlanNode['role'], patch: Partial<PlanNode> = {}): PlanNode {
  return { id: `${role}-node`, role, objective: 'parentobjective 剧透作者结局', dependsOn: [], acceptance: '产出可校验结果', status: 'pending', ...patch };
}
function specialist(project: Workspace, role: SpecialistRequest['role'], nodePatch: Partial<PlanNode> = {}, requestPatch: Partial<RunRequest> = {}) {
  return specialistDefinition({ project, role, node: node(role, nodePatch), request: request(project, requestPatch) });
}
function step(output = '', structured?: unknown): AgentStep {
  return { id: 'step', agentId: 'test', label: 'test', status: 'completed', input: {}, output, structured, tools: [], usage: emptyUsage(), startedAt: '2026-10-10T00:00:00Z', contextSources: [], responseIds: [] };
}
function memory(project: Workspace, patch: Partial<AgentMemory> = {}): AgentMemory {
  return { id: 'memory', projectId: project.id, kind: 'summary', content: '铜片摘要', confirmed: false,
    sources: [sourceFor(project, 'scene:text', 'old')!], status: 'active', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', ...patch };
}

test('canonical SHA256 is stable across key order, sensitive to array order, and namespaced to the project', () => {
  assert.equal(fingerprint({ b: [2, { y: '中', x: 1 }], a: true }), fingerprint({ a: true, b: [2, { x: 1, y: '中' }] }));
  assert.match(fingerprint('中文'), /^[a-f0-9]{64}$/);
  assert.notEqual(fingerprint([1, 2]), fingerprint([2, 1]));
  assert.notEqual(fingerprint(undefined), fingerprint(['$undefined']));
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => fingerprint(cycle), /循环/);
  const a = fixture(), b = fixture('project-b');
  const source = sourceFor(a, 'scene:text', 'old')!;
  assert.notEqual(source.hash, sourceFor(b, 'scene:text', 'old')!.hash);
  assert.equal(sourceValid(b, source), false);
  assert.equal(sourceValid(a, { ...source, start: 0, end: a.scenes.find(scene => scene.id === 'old')!.text.length + 1 }), false);
});

test('evidence ignores reading and layout, including card positioning; original content changes invalidate it', () => {
  const original = fixture();
  const changedLayout = applyCommands(original, [
    { type: 'setLayout', key: 'scene:old', value: { x: 999, y: 888 } },
    { type: 'setReading', value: { ...original.reading, scroll: 123 } },
    { type: 'putCard', value: { ...original.cards[0]!, x: 200, y: 300, collapsed: true, width: 700 } },
  ]);
  assert.deepEqual(sourcesForWorkspace(original), sourcesForWorkspace(changedLayout));
  const changedContent = applyCommands(original, [{ type: 'putCard', value: { ...original.cards[0]!, content: '新的灵感' } }]);
  assert.equal(sourceValid(changedContent, sourceFor(original, 'card', 'note')!), false);
});

test('Chinese substring/bigram search boosts titles and returns bounded, hash-valid raw slices', () => {
  const workspace = fixture();
  const chunks = searchContext(workspace, '铜片', 6);
  assert.ok(chunks.length > 0);
  assert.equal(chunks[0]!.title.includes('铜片'), true);
  const bodies = searchContext(workspace, '雾港钟楼', 1000).filter(chunk => chunk.source.kind === 'scene:text');
  assert.ok(bodies.length > 0);
  assert.ok(searchContext(workspace, '铜片', 1000).length <= 12);
  assert.ok(searchContext(workspace, '获得线索').some(chunk => chunk.text.includes('铜片线索')), '中文无空格文本按双字召回');
  for (const chunk of bodies) {
    assert.equal(chunk.text, workspace.scenes.find(scene => scene.id === chunk.source.id)!.text.slice(chunk.source.start, chunk.source.end));
    assert.equal(sourceValid(workspace, chunk.source), true);
    assert.ok(chunk.text.length <= 1200);
  }
  assert.deepEqual(searchContext(workspace, '铜片', 0), []);
});

test('search filters restricted roles before matching: reader sees only visible text, character refuses future facts', () => {
  const workspace = fixture();
  const anchor = { sceneId: 'target', chapterId: 'chapter', characterId: 'person', eventId: 'now' };
  for (const query of ['作者秘密', '作者计划', '未来秘密潜伏者', '尚未读到', '作者秘密场景标题']) {
    assert.deepEqual(searchContext(workspace, query, 6, 'reader', anchor), [], query);
  }
  assert.ok(searchContext(workspace, '铜片', 6, 'reader', anchor).every(chunk => chunk.source.kind === 'scene:text'));
  for (const query of ['幕后凶手', '作者预设', '未来秘密潜伏者', '本幕结束才获知', '未来正文']) {
    assert.deepEqual(searchContext(workspace, query, 6, 'character', anchor), [], query);
  }
  assert.ok(searchContext(workspace, '铜片', 6, 'character', anchor).length);
  assert.throws(() => searchContext(workspace, '铜片', 6, 'character'), /需要明确/);
  assert.throws(() => searchContext(workspace, '铜片', 6, 'reader', { sceneId: 'target', chapterId: 'later' }), /不属于/);
  assert.equal(canReadAuthor('character'), false); assert.equal(canReadAuthor('reader'), false); assert.equal(canReadAuthor('continuity'), true);
});

test('reader and character specialists have fixed backend goals, safe inputs, and no read_project/write capability', () => {
  const workspace = fixture();
  const reader = specialist(workspace, 'reader', { sceneId: 'target', chapterId: 'chapter' });
  assert.deepEqual(reader.definition.outputSchema, reviewSchema);
  assert.equal(reader.toCommands, undefined);
  assert.deepEqual(reader.definition.tools, []);
  assert.doesNotMatch(JSON.stringify({ context: reader.context, objective: reader.objective, definition: reader.definition }), /parentobjective|作者隐藏目标|幕后凶手|未来秘密潜伏者|未来正文|尚未读到|作者秘密场景标题/);
  assert.ok(reader.sources.every(source => sourceValid(workspace, source)));
  const character = specialist(workspace, 'character', { characterId: 'person', eventId: 'now' });
  assert.equal(character.toCommands, undefined); assert.deepEqual(character.definition.tools, []);
  assert.doesNotMatch(JSON.stringify({ context: character.context, objective: character.objective, definition: character.definition }), /parentobjective|作者隐藏目标|幕后凶手|未来秘密潜伏者|作者事件|本幕结束才获知|未来正文/);
  assert.ok(character.sources.every(source => sourceValid(workspace, source)));
});

test('evolution filters future-bound/mixed scenes, keeps actual text authoritative, and marks unwritten evidence as plan', () => {
  const workspace = fixture();
  const evolution = specialist(workspace, 'evolution', { characterId: 'person', eventId: 'now' });
  assert.doesNotMatch(JSON.stringify(evolution.context), /未来正文|混合未来正文|未来秘密|未来大纲|作者计划揭露/);
  assert.match(JSON.stringify(evolution.context), /前文甲/);
  const fields = { perspective: '不确定门后情况', psychology: '迟疑', motivation: '先询问', evidence: '门前犹豫的线索' };
  const commands = evolution.toCommands!(step('', fields));
  assert.equal(commands[0]!.type, 'putCharacterState');
  const value = (commands[0] as Extract<Command, { type: 'putCharacterState' }>).value;
  assert.deepEqual(value.sceneIds, ['target']);
  const plan = specialist(workspace, 'evolution', { characterId: 'person', eventId: 'now', sceneId: 'blank' }, { stage: 'chapter', sceneId: 'blank' });
  assert.match(JSON.stringify(plan.context), /"isPlan":true/);
  const planned = (plan.toCommands!(step('', fields))[0] as Extract<Command, { type: 'putCharacterState' }>).value;
  assert.match(planned.evidence, /^计划：/); assert.deepEqual(planned.sceneIds, ['blank']);
});

test('writer commands only replace the designated scene text and splice rewrite selections', () => {
  const workspace = fixture(), scene = workspace.scenes.find(item => item.id === 'target')!;
  const start = scene.text.indexOf('【'), end = scene.text.indexOf('】') + 1;
  const writer = specialist(workspace, 'writer', { sceneId: 'target' }, { stage: 'rewrite', sceneId: 'target', selection: { start, end } });
  const commands = writer.toCommands!(step('新段落'));
  assert.equal(commands.length, 1); assert.equal(commands[0]!.type, 'putScene');
  const next = (commands[0] as Extract<Command, { type: 'putScene' }>).value;
  assert.equal(next.id, 'target'); assert.equal(next.text, '前文甲新段落后文乙');
  const { text: _old, ...oldFields } = scene, { text: _new, ...newFields } = next;
  assert.deepEqual(oldFields, newFields);
  assert.throws(() => writer.toCommands!(step('')), /没有生成/);
  assert.equal(workspace.scenes.find(item => item.id === 'target')!.text, scene.text, '纯转换不写项目');
});

test('proposals are validated pure domain candidates and cannot overwrite formal text or smuggle direct-write commands', () => {
  const workspace = fixture(), original = structuredClone(workspace);
  const narrative = specialist(workspace, 'narrative');
  assert.throws(() => narrative.toCommands!(step('', { summary: '错误', opsJson: '[]', commandsJson: JSON.stringify([{ type: 'setReading', value: workspace.reading }]) })), /候选能力/);
  assert.throws(() => narrative.toCommands!(step('', { summary: '错误', opsJson: '[]', commandsJson: JSON.stringify([{ type: 'putScene', value: { ...workspace.scenes[0]!, text: '覆盖正文' } }]) })), /正式正文/);
  assert.throws(() => narrative.toCommands!(step('', { summary: '错误', opsJson: '[]', commandsJson: JSON.stringify([{ type: 'deleteChapter', id: 'chapter' }]) })), /正式正文/);
  const commands = narrative.toCommands!(step('', { summary: '调整空白场景大纲', opsJson: '[]', commandsJson: JSON.stringify([{ type: 'putScene', value: { ...workspace.scenes.find(item => item.id === 'blank')!, outline: '新的大纲' } }]) }));
  assert.equal(commands.length, 1); assert.deepEqual(workspace, original);
  const theme = specialist(workspace, 'theme');
  const themed = theme.toCommands!(step('', { question: '信任什么', choices: '合作或独行', cost: '承担风险', expression: '通过行动' }));
  assert.deepEqual(Object.keys((themed[0] as Extract<Command, { type: 'updateNovel' }>).patch), ['theme']);
});

test('memory refresh marks changed-source and cross-project entries stale; author rules require explicit confirmation provenance', () => {
  const workspace = fixture(), original = memory(workspace);
  const changed = applyCommands(workspace, [{ type: 'putScene', value: { ...workspace.scenes.find(item => item.id === 'old')!, text: '原文已经修改' } }]);
  assert.equal(refreshMemories(changed, [original])[0]!.status, 'stale');
  assert.equal(original.status, 'active', '不修改调用者记忆');
  assert.equal(refreshMemories(fixture('other-project'), [original])[0]!.status, 'stale');
  const preference = memory(workspace, { kind: 'preference', sources: [], confirmed: true, content: '不要说教', sourceMessageId: 'author-message' });
  assert.equal(refreshMemories(workspace, [preference])[0]!.status, 'active');
  assert.equal(refreshMemories(workspace, [{ ...preference, sourceMessageId: undefined }])[0]!.status, 'stale');
  assert.equal(refreshMemories(workspace, [{ ...preference, confirmed: false }])[0]!.status, 'stale');
  const context = JSON.stringify(collectContext(workspace, request(workspace), [preference, memory(workspace, { id: 'summary', sources: [], content: '辅助经验而非正式真相' })]));
  assert.match(context, /不要说教/); assert.match(context, /"formalTruth":false/);
  assert.doesNotMatch(JSON.stringify(collectContext(workspace, request(workspace), [{ ...preference, projectId: 'other-project', content: '他书作者偏好' }])), /他书作者偏好/);
});

test('coordinator context has a catalog/scope/explicit omissions and never dumps unselected book bodies', () => {
  const workspace = fixture();
  workspace.scenes.push(...Array.from({ length: 100 }, (_, index) => ({ id: `large-${index}`, chapterId: 'later', title: `场景${index}`, order: index + 10, povId: null, eventIds: [], outline: '大量大纲', text: '未选定整书正文禁止载入'.repeat(1000) })));
  const context = collectContext(workspace, request(workspace), []) as Record<string, unknown>;
  const serialized = JSON.stringify(context);
  assert.ok(serialized.length <= MAX_CONTEXT_CHARS);
  assert.ok(context.scope && context.catalog && context.omitted);
  assert.doesNotMatch(serialized, /未选定整书正文禁止载入/);
  assert.match(serialized, /referencesAreWriteAuthorization/); assert.match(serialized, /catalogScenes/);
  const large = boundedContext({ text: '\n"中文'.repeat(100_000), entries: Array.from({ length: 1000 }, (_, id) => ({ id, text: '大量内容' })) });
  assert.ok(JSON.stringify(large).length <= MAX_CONTEXT_CHARS); assert.match(JSON.stringify(large), /"limited":true/);
});

test('rewrite scope guards before snapshots and exact prefix/suffix, and references never authorize other scenes', () => {
  const workspace = fixture(), scene = workspace.scenes.find(item => item.id === 'target')!;
  const rewrite = request(workspace, { stage: 'rewrite', sceneId: 'target', selection: { start: 3, end: 8 }, references: [{ kind: 'scene', id: 'future-scene' }] });
  const changed = applyCommands(workspace, [{ type: 'putScene', value: { ...scene, text: '前文甲新内容后文乙' } }]);
  assert.doesNotThrow(() => assertWriteScope(rewrite, workspace, changed, [{ collection: 'scenes', key: 'target', before: scene, after: changed.scenes.find(item => item.id === 'target') }]));
  assert.throws(() => assertWriteScope(rewrite, workspace, changed, [{ collection: 'scenes', key: 'target', before: { ...scene, text: '假守护快照' }, after: changed.scenes.find(item => item.id === 'target') }]), /变更前值/);
  for (const text of ['改了前文新内容后文乙', '前文甲新内容改了后文', '甲乙']) {
    const bad = applyCommands(workspace, [{ type: 'putScene', value: { ...scene, text } }]);
    assert.throws(() => assertWriteScope(rewrite, workspace, bad, []), /前缀和后缀/);
  }
  const outside = applyCommands(changed, [{ type: 'putScene', value: { ...workspace.scenes.find(item => item.id === 'future-scene')!, text: '也修改参考正文' } }]);
  assert.throws(() => assertWriteScope(rewrite, workspace, outside, []), /目标以外/);
  const metadata = applyCommands(changed, [{ type: 'updateNovel', patch: { theme: '附带主题修改' } }]);
  assert.throws(() => assertWriteScope(rewrite, workspace, metadata, []), /作品设定/);
});

test('chapter scope permits only blank target prose and legal same-scene states, guarding all formal scene text', () => {
  const workspace = fixture(), scene = workspace.scenes.find(item => item.id === 'blank')!;
  const chapter = request(workspace, { stage: 'chapter', sceneId: 'blank' });
  const written = applyCommands(workspace, [{ type: 'putScene', value: { ...scene, text: '新正文' } }]);
  assert.doesNotThrow(() => assertWriteScope(chapter, workspace, written, []));
  const state: CharacterState = { id: 'current-state', characterId: 'person', eventId: 'now', perspective: '迟疑', psychology: '紧张', motivation: '询问', evidence: '门前行动', sceneIds: ['blank'] };
  const evolved = applyCommands(written, [{ type: 'putCharacterState', value: state }]);
  assert.doesNotThrow(() => assertWriteScope(chapter, workspace, evolved, []));
  const outsideState = applyCommands(written, [{ type: 'putCharacterState', value: { ...state, sceneIds: ['target'] } }]);
  assert.throws(() => assertWriteScope(chapter, workspace, outsideState, []), /目标场景/);
  const overwrite = applyCommands(written, [{ type: 'putScene', value: { ...workspace.scenes.find(item => item.id === 'target')!, text: '重写正式正文' } }]);
  assert.throws(() => assertWriteScope(request(workspace, { stage: 'chapter', chapterId: 'chapter' }), workspace, overwrite, []), /正式正文/);
});

test('plan validation enforces real role targets, acceptance, bounded node count, and a dependency DAG', () => {
  const workspace = fixture(), run = request(workspace, { stage: 'rewrite', sceneId: 'target' });
  const roles: AgentRole[] = ['theme', 'planner', 'world', 'narrative', 'canvas', 'continuity'];
  const nodes = roles.map(role => node(role as PlanNode['role']));
  assert.doesNotThrow(() => validatePlan(nodes, workspace, run));
  assert.throws(() => validatePlan([{ ...nodes[0]!, acceptance: ' ' }], workspace, run), /验收标准/);
  assert.throws(() => validatePlan([node('writer', { sceneId: 'missing' })], workspace, run), /不存在/);
  assert.throws(() => validatePlan([node('writer', { sceneId: 'future-scene' })], workspace, run), /超出任务范围/);
  assert.throws(() => validatePlan([node('character', { characterId: 'person' })], workspace, run), /明确人物和事件/);
  assert.throws(() => validatePlan([{ ...nodes[0]!, dependsOn: [nodes[1]!.id] }, { ...nodes[1]!, dependsOn: [nodes[0]!.id] }], workspace, run), /成环/);
  assert.throws(() => validatePlan([{ ...nodes[0]!, dependsOn: ['missing'] }], workspace, run), /依赖节点不存在/);
  assert.throws(() => validatePlan(Array.from({ length: 13 }, (_, index) => node('theme', { id: `n${index}` })), workspace, run), /1–12/);
  assert.deepEqual(createBudget(), { maxModelCalls: 36, maxToolCalls: 100, maxChildren: 16, maxParallel: 2, maxReplans: 2, maxRevisions: 2, maxActiveMs: 1_800_000, maxTokens: 500_000,
    modelCalls: 0, toolCalls: 0, children: 0, replans: 0, revisions: 0, activeMs: 0, tokens: 0, usageUnknown: false });
});

test('写作节点按阅读顺序串联，不改变已有反向顺序，也不会成环', () => {
  const workspace = fixture();
  const nodes = [node('writer', { id: 'late', sceneId: 'blank', dependsOn: [] }), node('writer', { id: 'early', sceneId: 'target', dependsOn: [] }),
    node('writer', { id: 'mid', sceneId: 'mixed', dependsOn: [] }), node('theme', { id: 'theme', dependsOn: [] })];
  assert.equal(chainWriterNodes(nodes, workspace, request(workspace)), 2);
  assert.deepEqual(Object.fromEntries(nodes.map(item => [item.id, item.dependsOn])), { late: ['mid'], early: [], mid: ['early'], theme: [] });
  validatePlan(nodes, workspace, request(workspace));
  // The author's plan already orders the later scene first: keep it, and never add the reverse edge.
  const reversed = [node('writer', { id: 'a', sceneId: 'target', dependsOn: ['b'] }), node('writer', { id: 'b', sceneId: 'blank', dependsOn: [] })];
  assert.equal(chainWriterNodes(reversed, workspace, request(workspace)), 0);
  assert.deepEqual(reversed.map(item => item.dependsOn), [['b'], []]);
});

test('前置结论只交给作者侧专长；角色代入、读者与人物演进保持各自有界视角', () => {
  const workspace = fixture();
  const upstream: UpstreamResult[] = [{ nodeId: 'theme', role: 'theme', label: '立意', objective: '深化', result: { conclusion: '上游作者剧透：幕后凶手是林舟的师父' } }];
  const build = (role: SpecialistRequest['role'], patch: Partial<PlanNode> = {}) => JSON.stringify(specialistDefinition({ project: workspace, role, node: node(role, patch), request: request(workspace), upstream }).context);
  assert.match(build('writer', { sceneId: 'blank' }), /上游作者剧透/);
  assert.match(build('planner'), /上游作者剧透/);
  assert.match(build('continuity', { sceneId: 'target' }), /上游作者剧透/);
  for (const [role, patch] of [['character', { characterId: 'person', eventId: 'now' }], ['evolution', { characterId: 'person', eventId: 'now' }],
    ['reader', { sceneId: 'target' }]] as const) assert.doesNotMatch(build(role, patch), /上游作者剧透/, role);
});

test('作者规则按字数预算而不是固定条数选取，约束优先，超出预算时报告省略数', () => {
  const workspace = fixture();
  const rule = (index: number, kind: AgentMemory['kind'], content = `规则${index}`) => memory(workspace, { id: `rule-${index}`, kind, content, sources: [], confirmed: true, sourceMessageId: 'author-message' });
  const many = Array.from({ length: 20 }, (_, index) => rule(index, index === 19 ? 'constraint' : 'preference'));
  const selected = selectAuthorRules(many);
  assert.equal(selected.rules.length, 20); assert.equal(selected.omitted, 0);
  assert.equal(selected.rules[0]!.id, 'rule-19', '约束排在偏好之前');
  const overview = collectContext(workspace, request(workspace), many) as { confirmedAuthorRules: unknown[]; omitted: { authorRules: number } };
  assert.equal(overview.confirmedAuthorRules.length, 20); assert.equal(overview.omitted.authorRules, 0);
  const crowded = selectAuthorRules([rule(1, 'preference', '长'.repeat(900)), rule(2, 'constraint', '短约束'), rule(3, 'preference', '再长'.repeat(400))], 1000);
  assert.deepEqual(crowded.rules.map(item => item.id), ['rule-2', 'rule-1']); assert.equal(crowded.omitted, 1);
  assert.equal(selectAuthorRules([{ ...rule(4, 'preference'), confirmed: false }, { ...rule(5, 'constraint'), status: 'stale' }, rule(6, 'summary')]).rules.length, 0);
});

test('作者确认的规则交给所有作者侧专长，角色代入与读者看不到', () => {
  const workspace = fixture(), authorRules = [{ kind: 'constraint', content: '作者约束：全书不出现穿越元素' }];
  const build = (role: SpecialistRequest['role'], patch: Partial<PlanNode> = {}) => JSON.stringify(specialistDefinition({ project: workspace, role, node: node(role, patch), request: request(workspace), authorRules }).context);
  for (const [role, patch] of [['planner', {}], ['world', {}], ['narrative', {}], ['canvas', {}], ['cast', {}], ['theme', {}], ['continuity', { sceneId: 'target' }],
    ['evolution', { characterId: 'person', eventId: 'now' }], ['writer', { sceneId: 'blank' }]] as const) assert.match(build(role, patch), /全书不出现穿越元素/, role);
  for (const [role, patch] of [['character', { characterId: 'person', eventId: 'now' }], ['reader', { sceneId: 'target' }]] as const) assert.doesNotMatch(build(role, patch), /穿越/, role);
});
