import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentRun, ProviderSecret, RunRequest, Workspace } from '../shared/types.js';
import type { CompanionOp } from '../shared/companion-types.js';
import { emptyStyle, styleProfile, type StyleProfile } from '../shared/style-types.js';
import { AI_CLICHES, styleBaseline, styleDirectives, styleFingerprint, styleLint } from '../shared/style-metrics.js';
import { authoredPassages, deletedWords, editPairs } from '../shared/style-provenance.js';
import { companionCommands, selectCompanionItems } from '../shared/companion.js';
import { applyCommands, createWorkspace, DomainValidationError } from './domain.js';
import { buildWriterContext, WRITER_PRIORITY } from './context.js';
import { assertWriteScope } from './agent/policy.js';
import { pickSamples, REFERENCE_NOTICE, STYLE_SAMPLE_CHARS } from './agent/style.js';
import { DemoStyleTransport, rejectionReasons, StyleLearningService } from './agent/style-learning.js';
import { DemoAgentTransport } from './agent/demo.js';
import { NovelAgentScheduler } from './agents.js';
import { NovelStore } from './store.js';

const provider: ProviderSecret = { name: 'fixture', mode: 'mock', baseURL: 'https://example.invalid/v1', model: 'fixture', apiKey: '' };
const style = (patch: Partial<StyleProfile> = {}): StyleProfile => ({ ...emptyStyle(), ...patch });

function sample(): Workspace {
  const base = createWorkspace('文风测试'), chapter = base.chapters[0]!;
  return applyCommands(base, [
    { type: 'putObject', value: { id: 'lin', typeId: 'character', name: '林舟', fields: {} } },
    { type: 'putObject', value: { id: 'shen', typeId: 'character', name: '沈卿', fields: {} } },
    { type: 'putScene', value: { id: 's1', title: '雨夜', povId: 'lin', eventIds: [], outline: '林舟在雨里等人' } },
    { type: 'putPassage', value: { id: 's1', sceneId: 's1', chapterId: chapter.id, order: 1, text: '' } },
  ]);
}

test('文风指纹：句长、对白与 AI 腔是零 token 的客观统计', () => {
  const text = '他推门。屋里没人。“你来晚了。”她说。桌上的面还冒着热气，他数了数筷子，三双。';
  const fingerprint = styleFingerprint(text);
  assert.equal(fingerprint.sentences, 5);
  assert.ok(fingerprint.dialogueRatio > 0.1 && fingerprint.dialogueRatio < 0.3);
  assert.ok(fingerprint.shortRatio >= 0.6);
  assert.equal(fingerprint.cliche, 0);
  assert.ok(styleFingerprint('她嘴角勾起一抹弧度，眼中闪过一丝光。').cliche > 0);
});

test('本地体检：禁用词、强 AI 腔与偏离作者范文的节奏都会被指出', () => {
  const ai = '她嘴角勾起一抹弧度，缓缓地说道。'.repeat(30);
  const profile = style({ avoidWords: ['缓缓地'] });
  const lint = styleLint(ai, profile, null);
  assert.ok(lint.issues.some(issue => issue.kind === 'word' && issue.message.includes('缓缓地')));
  assert.ok(lint.issues.some(issue => issue.kind === 'cliche' && issue.message.includes('勾起一抹')));
  assert.ok(lint.score < 80);
  // The author can switch the cliché list off and keep words they like.
  assert.ok(!styleLint(ai, style({ blockAiCliches: false }), null).issues.some(issue => issue.kind === 'cliche'));
  const own = '他推门。屋里没人。桌上一碗面。他没坐。'.repeat(20);
  const long = '他在门口站了很久，久到楼道里的灯熄了又亮，才终于把手按在那扇没有上锁的门上，屋里空着，只有桌上的面还在冒着热气。'.repeat(8);
  const baseline = styleBaseline(style({ samples: [{ id: 'a', label: '短句', text: own, source: 'own' }] }));
  assert.ok(baseline && baseline.avgSentence < 8);
  assert.ok(styleLint(long, style(), baseline).issues.some(issue => issue.kind === 'rhythm'));
  assert.ok(styleDirectives(style({ dials: { ...emptyStyle().dials, sentence: 1, person: 'first' } }), baseline).some(line => line.includes('短句')));
});

test('文风档案：updateStyle 合并旋钮、校验人物声音，删除人物时清掉其声音', () => {
  const workspace = sample();
  const next = applyCommands(workspace, [{ type: 'updateStyle', patch: { dials: { ...emptyStyle().dials, sentence: 2 }, voices: [{ characterId: 'lin', voice: '说话短，爱反问' }] } }]);
  assert.equal(styleProfile(next).dials.sentence, 2);
  assert.equal(next.revision, workspace.revision + 1);
  assert.throws(() => applyCommands(next, [{ type: 'updateStyle', patch: { dials: { ...emptyStyle().dials, pace: 9 as never } } }]), DomainValidationError);
  assert.throws(() => applyCommands(next, [{ type: 'updateStyle', patch: { voices: [{ characterId: 'nobody', voice: 'x' }] } }]), /人物声音/);
  assert.throws(() => applyCommands(next, [{ type: 'updateStyle', patch: { samples: [{ id: 'x', label: '', text: '字'.repeat(4001), source: 'own' }] } }]), /4000/);
  assert.throws(() => applyCommands(next, [{ type: 'updateStyle', patch: { bogus: 1 } as never }]), /文风字段/);
  assert.deepEqual(styleProfile(applyCommands(next, [{ type: 'deleteObject', id: 'lin' }])).voices, []);
  // A workspace without a profile reads as the empty default and is semantically unchanged.
  assert.deepEqual(styleProfile(workspace), emptyStyle());
});

test('撤销文风修改按字段进行，不与之后无关的文风编辑冲突', () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('撤销');
    store.execute({ projectId: project.id, actor: 'human', label: '添加范文', commands: [{ type: 'updateStyle', patch: { samples: [{ id: 'a', label: '一', text: '雨下得很大。', source: 'own' }] } }] });
    const sampleBatch = store.history(project.id)[0]!;
    assert.deepEqual(sampleBatch.changes.map(change => [change.collection, change.key]), [['style', 'samples']]);
    store.execute({ projectId: project.id, actor: 'human', commands: [{ type: 'updateStyle', patch: { summary: '短句，冷' } }] });
    const undone = store.undo(project.id, sampleBatch.id);
    assert.deepEqual(styleProfile(undone).samples, []);
    assert.equal(styleProfile(undone).summary, '短句，冷');
  } finally { store.close(); }
});

test('写作上下文带上文风：范文受预算限制、参考范文附说明、只给出场人物的声音', () => {
  const big = '雨下得很大。林舟没有撑伞。'.repeat(200);
  const workspace = applyCommands(sample(), [{ type: 'updateStyle', patch: {
    summary: '短句为主，情绪不直说', avoidWords: ['不禁'], rules: [{ id: 'r', kind: 'avoid', content: '不用说话标签', origin: 'author' }],
    voices: [{ characterId: 'lin', voice: '爱反问' }, { characterId: 'shen', voice: '慢条斯理' }],
    samples: [{ id: 'ref', label: '参考', text: '远处的钟声一下一下。', source: 'reference', author: '某作家' }, { id: 'own', label: '亲笔', text: big, source: 'own' }, { id: 'own2', label: '亲笔二', text: '林舟说：“走吧。”', source: 'own' }],
  } }]);
  const context = buildWriterContext(workspace, 's1');
  assert.ok(WRITER_PRIORITY.indexOf('style') < WRITER_PRIORITY.indexOf('recentText'));
  assert.equal(context.style.summary, '短句为主，情绪不直说');
  assert.ok(context.style.avoidWords.includes('不禁') && context.style.avoidWords.includes(AI_CLICHES.find(item => item.tier === 'strong')!.phrase));
  assert.deepEqual(context.style.voices, [{ name: '林舟', voice: '爱反问' }]);
  assert.deepEqual(context.style.samples.map(item => item.label), ['亲笔', '亲笔二', '参考']);
  assert.ok(context.style.samples.reduce((sum, item) => sum + item.text.length, 0) <= STYLE_SAMPLE_CHARS + 10);
  assert.equal(context.style.referenceNotice, REFERENCE_NOTICE);
  assert.ok(context.sources.includes('style'));
  // Pinned samples lead even when they are references.
  const pinned = applyCommands(workspace, [{ type: 'updateStyle', patch: { samples: styleProfile(workspace).samples.map(item => item.id === 'ref' ? { ...item, pinned: true } : item) } }]);
  assert.equal(pickSamples(pinned, [])[0]!.id, 'ref');
});

test('正文任务不能顺带修改文风档案', () => {
  const before = sample(), request: RunRequest = { projectId: before.id, stage: 'chapter', objective: '写', passageId: 's1', chapterId: before.chapters[0]!.id };
  const after = applyCommands(before, [{ type: 'updateStyle', patch: { summary: '偷偷改' } }]);
  assert.throws(() => assertWriteScope(request, before, after, [{ collection: 'style', key: 'summary', before: '', after: '偷偷改' }]), /文风/);
});

test('改稿学习：从操作历史找出被作者改过的 AI 正文，统计反复删掉的词', () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('改稿'), chapter = project.chapters[0]!;
    const passage = { id: 's', sceneId: 's', chapterId: chapter.id, order: 1, text: '' };
    const aiText = '他缓缓地抬头。她缓缓地走近。门缓缓地开了。风很冷。';
    store.execute({ projectId: project.id, actor: 'human', commands: [{ type: 'putScene', value: { id: 's', title: '雨', povId: null, eventIds: [], outline: '' } }, { type: 'putPassage', value: passage }] });
    store.execute({ projectId: project.id, actor: 'ai', expectedRevision: store.getProject(project.id).revision, label: 'AI 正文', commands: [{ type: 'putPassage', value: { ...passage, text: aiText } }] });
    assert.equal(editPairs(store.getProject(project.id), store.history(project.id)).length, 0);
    assert.equal(authoredPassages(store.getProject(project.id), store.history(project.id)).size, 0);
    store.execute({ projectId: project.id, actor: 'human', commands: [{ type: 'putPassage', value: { ...passage, text: '他抬头。她走近。门开了。风很冷。' } }] });
    const pairs = editPairs(store.getProject(project.id), store.history(project.id));
    assert.equal(pairs.length, 1);
    assert.ok(pairs[0]!.hunks.some(hunk => hunk.before.includes('缓缓地') && !hunk.after.includes('缓缓地')));
    assert.deepEqual(deletedWords(pairs)[0], { word: '缓缓地', count: 3 });
    assert.equal(authoredPassages(store.getProject(project.id), store.history(project.id)).size, 1);
  } finally { store.close(); }
});

test('整理改稿偏好只写入待确认建议，同一改稿不重复学习', async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('学习'), chapter = project.chapters[0]!;
    const passage = { id: 's', sceneId: 's', chapterId: chapter.id, order: 1, text: '' };
    store.execute({ projectId: project.id, actor: 'human', commands: [{ type: 'putScene', value: { id: 's', title: '雨', povId: null, eventIds: [], outline: '' } }, { type: 'putPassage', value: passage }] });
    store.execute({ projectId: project.id, actor: 'ai', expectedRevision: store.getProject(project.id).revision, commands: [{ type: 'putPassage', value: { ...passage, text: '他缓缓地抬头。她缓缓地走近。门缓缓地开了。' } }] });
    store.execute({ projectId: project.id, actor: 'human', commands: [{ type: 'putPassage', value: { ...passage, text: '他抬头。她走近。门开了。' } }] });
    const events: unknown[] = [];
    const service = new StyleLearningService(store, () => provider, event => events.push(event), () => new DemoStyleTransport());
    assert.equal(service.status(project.id).pendingEdits, 1);
    const status = await service.learn(project.id);
    assert.equal(status.pendingEdits, 0, status.lastError ?? '');
    const profile = styleProfile(store.getProject(project.id));
    assert.ok(profile.suggestions.some(item => item.word?.value === '缓缓地' && item.word.list === 'avoidWords' && item.status === 'pending'));
    assert.deepEqual(profile.avoidWords, [], '建议在作者采纳前不生效');
    assert.equal(store.history(project.id)[0]!.label, '文风偏好建议');
    const revision = store.getProject(project.id).revision;
    await service.learn(project.id);
    assert.equal(store.getProject(project.id).revision, revision);
  } finally { store.close(); }
});

async function until(store: NovelStore, id: string, predicate: (run: AgentRun) => boolean) {
  for (let i = 0; i < 5000; i++) { const run = store.getRun(id)!; if (predicate(run)) return run; await delay(1); }
  throw new Error(`任务超时：${JSON.stringify(store.getRun(id))}`);
}

test('正文候选经过文风审阅；拒稿理由可被收集用于学习', { timeout: 15000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const initial = store.createProject('审阅');
    const project = store.execute({ projectId: initial.id, actor: 'human', commands: [
      { type: 'putScene', value: { id: 'scene-0', title: '场景', outline: '人物面对线索作出选择', povId: null, eventIds: [] } },
      { type: 'putPassage', value: { id: 'scene-0', sceneId: 'scene-0', chapterId: initial.chapters[0]!.id, order: 0, text: '' } },
      { type: 'updateStyle', patch: { summary: '短句为主' } },
    ] });
    let current: RunRequest;
    const agents: string[] = [];
    const scheduler = new NovelAgentScheduler(store, () => provider, () => {}, () => {
      const demo = new DemoAgentTransport(current, store.getProject(current.projectId));
      return { stream: (request, signal) => { agents.push(request.agentId); return demo.stream(request, signal); } };
    });
    current = { projectId: project.id, stage: 'chapter', objective: '写这一场', passageId: 'scene-0', chapterId: project.chapters[0]!.id };
    const run = scheduler.start(current);
    const pending = await until(store, run.id, value => ['awaitingApproval', 'failed', 'completed', 'paused', 'awaitingInput'].includes(value.status));
    assert.equal(pending.status, 'awaitingApproval', pending.error ?? pending.runtime?.pauseReason ?? '');
    assert.ok(agents.includes('stylist'));
    const candidate = pending.runtime!.candidates.find(item => item.status === 'awaitingApproval')!;
    assert.ok(candidate.reviews.some(review => review.role === 'style'));
    await scheduler.decide({ runId: run.id, candidateId: candidate.id, candidateHash: candidate.hash, approve: false, reason: '太多形容词，句子太长' });
    await until(store, run.id, value => !!value.finishedAt || value.status === 'awaitingApproval');
    const reasons = rejectionReasons(store.listAgentStates(project.id), key => store.getAgentReceipt(key));
    assert.ok(reasons.some(item => item.reason === '太多形容词，句子太长'));
  } finally { store.close(); }
});

test('创作伙伴的文风操作合并为一条 updateStyle，采纳后可撤销', () => {
  const workspace = sample();
  const op = (patch: Partial<CompanionOp> & Pick<CompanionOp, 'id'>): CompanionOp => ({ op: 'updateStyle', ref: null, targetId: null, parentRef: null, parentId: null, title: null, content: null, purpose: null, order: null, povName: null, causes: [], people: [], field: null, ...patch });
  const response = { reply: '', questions: [], ideas: [], followUps: [], proposals: [{ id: 'p1', title: '画像', summary: '', ops: [
    op({ id: 'o1', field: 'summary', content: '短句，冷' }), op({ id: 'o2', field: 'dial:sentence', content: '1' }), op({ id: 'o3', field: 'dial:person', content: '第一人称' }),
    op({ id: 'o4', field: 'rule:avoid', content: '不用说话标签' }), op({ id: 'o5', field: 'avoidWords', content: '不禁、仿佛' }),
    op({ id: 'o6', field: 'voice', povName: '林舟', content: '爱反问' }), op({ id: 'o7', field: 'dial:pace', content: '很快' }),
  ] }] };
  const { commands, skipped } = companionCommands(workspace, selectCompanionItems(response, ['p1']), { mode: 'style', anchor: { surface: 'style', references: [], focus: 'blindtest' }, newId: () => 'rule-1' });
  assert.equal(commands.length, 1); assert.equal(commands[0]!.type, 'updateStyle');
  assert.equal(skipped.length, 1);
  const next = styleProfile(applyCommands(workspace, commands));
  assert.equal(next.summary, '短句，冷'); assert.equal(next.dials.sentence, 1); assert.equal(next.dials.person, 'first');
  assert.deepEqual(next.rules, [{ id: 'rule-1', kind: 'avoid', content: '不用说话标签', origin: 'blindtest' }]);
  assert.deepEqual(next.avoidWords, ['不禁', '仿佛']); assert.deepEqual(next.voices, [{ characterId: 'lin', voice: '爱反问' }]);
  // A second round adds to an existing profile without mutating the workspace it reads.
  const adopted = applyCommands(workspace, commands), rules = JSON.stringify(styleProfile(adopted).rules);
  const again = companionCommands(adopted, selectCompanionItems({ ...response, proposals: [{ id: 'p2', title: '', summary: '', ops: [op({ id: 'o1', field: 'rule:do', content: '情绪靠动作表现' })] }] }, ['p2']),
    { mode: 'style', anchor: { surface: 'style', references: [], focus: 'distill' }, newId: () => 'rule-2' });
  assert.equal(JSON.stringify(styleProfile(adopted).rules), rules);
  assert.deepEqual(styleProfile(applyCommands(adopted, again.commands)).rules.map(rule => [rule.content, rule.origin]), [['不用说话标签', 'blindtest'], ['情绪靠动作表现', 'samples']]);
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('伙伴');
    const { batch } = store.executeBatch({ projectId: project.id, actor: 'ai', expectedRevision: project.revision, commands: [{ type: 'updateStyle', patch: { summary: '短句，冷' } }] });
    assert.equal(styleProfile(store.undo(project.id, batch!.id)).summary, '');
  } finally { store.close(); }
});
