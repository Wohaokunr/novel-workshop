import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NovelStore } from './store.js';
import { STORE_SCHEMA_VERSION } from './migrations.js';
import { applyCommands, createWorkspace } from './domain.js';
import type { AgentRun, CanvasCard, Command, OperationBatch, Workspace } from '../shared/types.js';
import type { AgentCandidate, AgentDecision, AgentMemory, AgentReceipt, AgentState } from '../shared/agent-types.js';

const at = '2026-10-10T00:00:00.000Z';
const usage = { input: 0, output: 0, total: 0, reasoning: 0, cached: 0, provided: false };
const stored = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function temporaryStore(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'novel-agent-store-'));
  const filename = join(directory, 'novel.sqlite');
  const fixture = { filename, store: new NovelStore(filename), reopen() { this.store.close(); this.store = new NovelStore(filename); return this.store; } };
  t.after(() => { fixture.store.close(); rmSync(directory, { recursive: true, force: true }); });
  return fixture;
}

function row(filename: string, sql: string): Record<string, unknown> {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return db.prepare(sql).get()!; } finally { db.close(); }
}

function makeRun(projectId: string, id: string = randomUUID()): AgentRun {
  return { id, projectId, stage: 'agent', objective: '修订正文', status: 'awaitingApproval', startedAt: at, usage: { ...usage },
    steps: [{ id: 'approval-step', agentId: 'coordinator', label: '候选审批', status: 'awaitingApproval', input: {}, output: '',
      tools: [], usage: { ...usage }, startedAt: at, contextSources: [], responseIds: [] }] };
}

function candidateFixture(store: NovelStore, commands: Command[] = [{ type: 'updateNovel', patch: { brief: '候选构思' } }], before = store.createProject('审批测试')) {
  const run = makeRun(before.id), session = store.getSession(before.id);
  const preview = store.previewCommands(before, commands);
  const candidate: AgentCandidate = { id: randomUUID(), runId: run.id, projectId: before.id, label: '作者候选', baseRevision: before.revision, version: 1,
    hash: `candidate:${randomUUID()}`, ...preview, sources: [], reviews: [], status: 'awaitingApproval', createdAt: at };
  candidate.reviews = [{ candidateHash: candidate.hash, role: 'continuity', verdict: 'pass', issues: [], recommendation: '可以提交', sources: [], stepId: 'review-step' }];
  const state: AgentState = { version: 1, runId: run.id, projectId: before.id, sessionId: session.id, toolVersion: 'test-v1', baseWorkspace: before,
    candidates: [candidate], artifacts: [], checkpoints: {}, countedResponses: [], updatedAt: at,
    budget: { maxModelCalls: 10, maxToolCalls: 20, maxChildren: 10, maxParallel: 2, maxReplans: 2, maxRevisions: 2, maxActiveMs: 60000, maxTokens: 10000,
      modelCalls: 0, toolCalls: 0, children: 0, replans: 0, revisions: 0, activeMs: 0, tokens: 0, usageUnknown: false },
    waiting: { kind: 'approval', callKey: `${run.id}:approval-step:0:commit`, callId: 'tool-commit', stepId: 'approval-step', turn: 0,
      argumentsHash: 'original-tool-arguments', candidateId: candidate.id, candidateHash: candidate.hash } };
  const receipt: AgentReceipt = { key: state.waiting!.callKey, runId: run.id, projectId: before.id, argumentsHash: state.waiting!.argumentsHash, status: 'pending', at };
  store.saveAgentState(state, run, receipt);
  const decision: AgentDecision = { runId: run.id, candidateId: candidate.id, candidateHash: candidate.hash, approve: true };
  return { before, preview, candidate, state, run, receipt, decision };
}

function completeCheckpoint(state: AgentState, result: unknown): void {
  assert.equal(state.waiting?.kind, 'approval', 'callback 必须能读取原等待工具调用');
  state.checkpoints[state.waiting!.stepId] = { callId: state.waiting!.callId, turn: state.waiting!.turn, toolResult: result };
}

const note = (id: string, patch: Partial<CanvasCard> = {}): CanvasCard => ({ id, kind: 'note', title: id, content: '原文', x: 10, y: 20, ...patch });

test('迁移无版本旧 SQLite：保留作品、历史、runs，重开后仍可执行和撤销', t => {
  const directory = mkdtempSync(join(tmpdir(), 'novel-agent-migration-')), filename = join(directory, 'old.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = createWorkspace('旧作品');
  const old = applyCommands(original, [{ type: 'updateNovel', patch: { brief: '旧构思' } }]);
  delete old.theme; delete old.characterStates;
  const batch: OperationBatch = { id: 'old-operation', projectId: old.id, actor: 'human', at, label: '旧历史', undone: false,
    changes: [{ collection: 'metadata', key: 'brief', before: '', after: '旧构思' }] };
  const run: AgentRun = { ...makeRun(old.id, 'old-run'), stage: 'outline', status: 'completed' };
  const oldJSON = JSON.stringify(old), db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE operations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
    CREATE TABLE runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),started_at TEXT NOT NULL,data TEXT NOT NULL);`);
  db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(old.id, old.title, old.revision, at, oldJSON);
  db.prepare('INSERT INTO operations VALUES(?,?,?)').run(batch.id, old.id, JSON.stringify(batch));
  db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(run.id, old.id, at, JSON.stringify(run));
  db.close();
  let store = new NovelStore(filename);
  try {
    assert.equal(row(filename, 'PRAGMA user_version').user_version, STORE_SCHEMA_VERSION);
    assert.equal(row(filename, 'SELECT data FROM projects').data, oldJSON, '迁移不重写旧作品 JSON');
    assert.equal(store.getProject(old.id).brief, '旧构思');
    assert.equal(store.getProject(old.id).theme, ''); assert.deepEqual(store.getProject(old.id).characterStates, []);
    assert.deepEqual(store.history(old.id), [batch]); assert.deepEqual(store.getRuns(old.id), [run]);
    assert.deepEqual(store.listAgentStates(), []);
    const sessionId = store.getSession(old.id).id;
    store.close(); store = new NovelStore(filename);
    assert.equal(store.getSession(old.id).id, sessionId);
    const next = store.execute({ projectId: old.id, actor: 'ai', expectedRevision: old.revision, taskId: 'new-task', commands: [{ type: 'updateNovel', patch: { theme: '新立意' } }] });
    assert.equal(next.revision, old.revision + 1);
    assert.equal(store.undo(old.id, 'new-task').theme, '');
    assert.equal(store.undo(old.id, batch.id).brief, '');
    assert.equal(store.getRuns(old.id)[0]!.id, run.id);
  } finally { store.close(); }
});

test('candidate preview 复用 AI 保护与 diff，正式项目与 operations 完全不变', t => {
  const { store, filename } = temporaryStore(t);
  const f = candidateFixture(store);
  assert.equal(f.preview.workspace.brief, '候选构思'); assert.equal(f.preview.workspace.revision, f.before.revision + 1);
  assert.deepEqual(f.preview.changes, [{ collection: 'metadata', key: 'brief', before: '', after: '候选构思' }]);
  assert.deepEqual(store.getProject(f.before.id), f.before); assert.deepEqual(store.history(f.before.id), []);
  assert.equal(row(filename, 'SELECT COUNT(*) AS count FROM operations').count, 0);
  f.preview.workspace.brief = '外部修改返回值';
  assert.equal(store.getAgentState(f.run.id)!.candidates[0]!.workspace.brief, '候选构思');
  assert.deepEqual(f.state.baseWorkspace, f.before);
});

test('批准同事务提交 changes、operation、receipt 和 checkpoint/state/run，旧 undo 仍可撤销', t => {
  const { store } = temporaryStore(t), f = candidateFixture(store);
  let callbacks = 0;
  const committed = store.commitAgentCandidate(f.decision, (state, result) => {
    callbacks++;
    assert.equal(store.getProject(f.before.id).brief, '候选构思');
    assert.equal(store.getAgentReceipt(f.receipt.key)!.status, 'completed');
    completeCheckpoint(state, result);
  });
  assert.equal(callbacks, 1); assert.equal(committed.project!.brief, '候选构思'); assert.equal(committed.run.status, 'running');
  assert.equal(committed.state.waiting, undefined);
  const candidate = committed.state.candidates[0]!, batch = store.history(f.before.id)[0]!;
  assert.equal(candidate.status, 'applied'); assert.equal(candidate.batchId, batch.id); assert.equal(candidate.commitCallKey, f.receipt.key);
  assert.equal(candidate.appliedRevision, f.before.revision + 1);
  assert.equal(batch.actor, 'ai'); assert.equal(batch.taskId, f.run.id); assert.deepEqual(batch.changes, stored(f.preview.changes));
  assert.deepEqual(store.getAgentState(f.run.id), stored(committed.state)); assert.deepEqual(store.getRun(f.run.id), stored(committed.run));
  const receipt = store.getAgentReceipt(f.receipt.key)!;
  assert.equal(receipt.argumentsHash, f.receipt.argumentsHash); assert.equal(receipt.status, 'completed');
  assert.deepEqual(receipt.result, stored(committed.result));
  assert.deepEqual(committed.state.checkpoints['approval-step'], { callId: 'tool-commit', turn: 0, toolResult: committed.result });
  assert.equal(store.undo(f.before.id, candidate.batchId!).brief, '');
});

test('批准同 hash 重复调用或重启重放只产生一次 operation，不重复 callback', t => {
  const temp = temporaryStore(t), f = candidateFixture(temp.store);
  const first = temp.store.commitAgentCandidate(f.decision, completeCheckpoint);
  temp.store.saveRun({ ...first.run, status: 'completed', finishedAt: at });
  const store = temp.reopen();
  const repeat = store.commitAgentCandidate({ ...f.decision, approve: false, reason: '晚到的重复请求' }, () => assert.fail('不可重放 callback'));
  assert.deepEqual(repeat.result, first.result); assert.equal(store.history(f.before.id).length, 1);
  assert.equal(repeat.run.status, 'completed', '重复审批不能重启已经完成的 run');
  assert.equal(repeat.state.candidates[0]!.status, 'applied');
  assert.throws(() => store.commitAgentCandidate({ ...f.decision, candidateHash: 'different-hash' }, completeCheckpoint), /hash/);
  assert.equal(store.history(f.before.id).length, 1);
});

test('拒绝正式作品/operations 零写入，持久 denied 原工具结果并恢复运行，重复拒绝相同结果', t => {
  const temp = temporaryStore(t), f = candidateFixture(temp.store);
  const formalBefore = row(temp.filename, 'SELECT data,updated_at FROM projects');
  const rejected = temp.store.commitAgentCandidate({ ...f.decision, approve: false, reason: '保留原来的构思' }, completeCheckpoint);
  assert.equal(rejected.project, undefined); assert.equal(rejected.run.status, 'running');
  assert.equal(rejected.state.candidates[0]!.status, 'rejected'); assert.equal(rejected.state.waiting, undefined);
  assert.deepEqual(rejected.result, { ok: false, reason: 'author_declined', detail: '保留原来的构思' });
  assert.deepEqual(row(temp.filename, 'SELECT data,updated_at FROM projects'), formalBefore);
  assert.deepEqual(temp.store.getProject(f.before.id), f.before); assert.equal(temp.store.history(f.before.id).length, 0);
  assert.equal(temp.store.getAgentReceipt(f.receipt.key)!.status, 'denied');
  const store = temp.reopen();
  assert.deepEqual(store.commitAgentCandidate(f.decision, () => assert.fail('拒绝也不可重放 callback')).result, rejected.result);
  assert.equal(store.history(f.before.id).length, 0);
});

test('严格 baseRevision：作者语义编辑后原子拒绝，即使候选现在为 no-op', t => {
  const { store } = temporaryStore(t), f = candidateFixture(store);
  store.execute({ projectId: f.before.id, actor: 'human', commands: f.preview.commands });
  const formal = store.getProject(f.before.id), history = store.history(f.before.id), state = store.getAgentState(f.run.id);
  assert.throws(() => store.commitAgentCandidate(f.decision, () => assert.fail('陈旧候选不执行 callback')), /REVISION_CONFLICT/);
  assert.deepEqual(store.getProject(f.before.id), formal); assert.deepEqual(store.history(f.before.id), history);
  assert.deepEqual(store.getAgentState(f.run.id), state); assert.equal(store.getAgentReceipt(f.receipt.key)!.status, 'pending');
  // Author rejection is still possible even when a candidate cannot be approved.
  assert.deepEqual(store.commitAgentCandidate({ ...f.decision, approve: false, reason: '已自行修改' }, completeCheckpoint).result,
    { ok: false, reason: 'author_declined', detail: '已自行修改' });
});

test('批准必须等待 matching candidate/hash，取消/暂停/失败运行不可写入', t => {
  const { store } = temporaryStore(t), f = candidateFixture(store);
  for (const status of ['cancelled', 'paused', 'pausing', 'failed', 'completed', 'queued'] as const) {
    store.saveRun({ ...f.run, status });
    assert.throws(() => store.commitAgentCandidate(f.decision, completeCheckpoint), /不允许审批/);
  }
  store.saveRun(f.run);
  assert.throws(() => store.commitAgentCandidate({ ...f.decision, candidateId: 'missing' }, completeCheckpoint), /ID\/hash/);
  assert.throws(() => store.commitAgentCandidate({ ...f.decision, candidateHash: 'wrong' }, completeCheckpoint), /ID\/hash/);
  const noWaiting = structuredClone(f.state); delete noWaiting.waiting; store.saveAgentState(noWaiting);
  assert.throws(() => store.commitAgentCandidate(f.decision, completeCheckpoint), /未等待/);
  const inputWaiting = structuredClone(f.state); inputWaiting.waiting!.kind = 'input'; store.saveAgentState(inputWaiting);
  assert.throws(() => store.commitAgentCandidate(f.decision, completeCheckpoint), /未等待/);
  assert.throws(() => store.saveAgentState({ ...f.state, waiting: { ...f.state.waiting!, candidateHash: 'wrong' } }), /hash/);
  assert.deepEqual(store.getProject(f.before.id), f.before); assert.equal(store.history(f.before.id).length, 0);
});

test('正文候选审批必须有当前版本的独立审查；设定候选可免审；作者可以接受带修订建议的候选', t => {
  const { store } = temporaryStore(t);
  const created = store.createProject('正文审批');
  const withScene = store.execute({ projectId: created.id, actor: 'human', commands: [{ type: 'putScene', value: { id: 's1', chapterId: created.chapters[0]!.id, order: 1, title: '开场', povId: null, eventIds: [], outline: '', text: '' } }] });
  const prose = candidateFixture(store, [{ type: 'putScene', value: { ...withScene.scenes[0]!, text: '新的正文' } }], withScene);
  const proseState = structuredClone(prose.state); proseState.candidates[0]!.reviews = []; store.saveAgentState(proseState);
  assert.throws(() => store.commitAgentCandidate(prose.decision, completeCheckpoint), /REVIEW_REQUIRED/);
  assert.equal(store.getProject(withScene.id).scenes[0]!.text, '');
  const f = candidateFixture(store);
  const stale = structuredClone(f.state); stale.candidates[0]!.reviews = [{ ...f.candidate.reviews[0]!, candidateHash: 'old-hash' }]; store.saveAgentState(stale);
  assert.throws(() => store.commitAgentCandidate(f.decision, completeCheckpoint), /REVIEW_REQUIRED/);
  assert.equal(store.history(f.before.id).length, 0); assert.equal(store.getAgentReceipt(f.receipt.key)!.status, 'pending');
  const free = candidateFixture(store);
  const unreviewed = structuredClone(free.state); unreviewed.candidates[0]!.reviews = []; store.saveAgentState(unreviewed);
  assert.equal(store.commitAgentCandidate(free.decision, completeCheckpoint).state.candidates[0]!.status, 'applied');
  const reviewed = structuredClone(f.state);
  reviewed.candidates[0]!.reviews.push({ ...f.candidate.reviews[0]!, role: 'reader', verdict: 'revise', issues: ['可以进一步展开细节'] });
  store.saveAgentState(reviewed);
  const applied = store.commitAgentCandidate(f.decision, completeCheckpoint);
  assert.equal(applied.state.candidates[0]!.status, 'applied');
  assert.equal(applied.state.candidates[0]!.reviews[1]!.verdict, 'revise');
});

test('预览与提交 commands/changes/workspace 不一致时原子阻止提交', t => {
  const { store } = temporaryStore(t), f = candidateFixture(store);
  for (const mutate of [
    (candidate: AgentCandidate) => { candidate.commands = [{ type: 'updateNovel', patch: { brief: '篡改命令' } }]; },
    (candidate: AgentCandidate) => { candidate.changes[0]!.after = '篡改预览'; },
    (candidate: AgentCandidate) => { candidate.workspace.brief = '篡改快照'; },
  ]) {
    const state = structuredClone(f.state); mutate(state.candidates[0]!); store.saveAgentState(state);
    assert.throws(() => store.commitAgentCandidate(f.decision, completeCheckpoint), /CANDIDATE_DIFF_MISMATCH/);
    assert.deepEqual(store.getProject(f.before.id), f.before); assert.equal(store.history(f.before.id).length, 0);
    assert.equal(store.getAgentReceipt(f.receipt.key)!.status, 'pending');
  }
});

test('AI 预览/正式提交保护现有布局与尺寸，候选审批期间人工纯布局编辑仍保留', t => {
  const { store } = temporaryStore(t);
  const before = store.execute({ projectId: store.createProject('AI 布局').id, actor: 'human', commands: [
    { type: 'putCard', value: note('note') }, { type: 'putCard', value: note('group', { kind: 'group' }) },
    { type: 'setLayout', key: 'world:note', value: { x: 30, y: 40 } },
  ] });
  const f = candidateFixture(store, [
    { type: 'putCard', value: note('note', { title: 'AI 标题', x: -1, y: -2, width: 1, height: 2, collapsed: true, groupId: 'group' }) },
    { type: 'putCard', value: note('group', { kind: 'group', title: 'AI 组', width: 900, collapsed: true }) },
    { type: 'putCard', value: note('new', { x: 700, y: 800, width: 240 }) },
    { type: 'setLayout', key: 'world:note', value: { x: -3, y: -4 } },
    { type: 'setLayout', key: 'story:new', value: { x: 50, y: 60 } },
  ], before);
  const previewCard = f.preview.workspace.cards.find(card => card.id === 'note')!;
  assert.deepEqual([previewCard.x, previewCard.y, previewCard.width, previewCard.collapsed], [10, 20, undefined, undefined]);
  assert.deepEqual(f.preview.workspace.layouts['world:note'], before.layouts['world:note']);
  const layout = { x: 360, y: 480, width: 500, height: 350, collapsed: false };
  const moved = store.execute({ projectId: before.id, actor: 'human', commands: [
    { type: 'putCard', value: { ...before.cards[0]!, ...layout } },
    { type: 'setLayout', key: 'world:note', value: { x: 1000, y: 2000 } },
    { type: 'setReading', value: { ...before.reading, scroll: 120 } },
  ] });
  assert.equal(moved.revision, before.revision);
  const applied = store.commitAgentCandidate(f.decision, completeCheckpoint), project = applied.project!;
  assert.deepEqual(project.cards.find(card => card.id === 'note'), { ...before.cards[0]!, ...layout, title: 'AI 标题', groupId: 'group' });
  assert.equal(project.cards.find(card => card.id === 'group')!.width, undefined);
  assert.equal(project.cards.find(card => card.id === 'group')!.collapsed, undefined);
  assert.deepEqual(project.cards.find(card => card.id === 'new'), note('new', { x: 700, y: 800, width: 240 }));
  assert.deepEqual(project.layouts, { 'world:note': { x: 1000, y: 2000 }, 'story:new': { x: 50, y: 60 } });
  assert.equal(project.reading.scroll, 120);
  assert.deepEqual(store.history(before.id)[0]!.changes, stored(applied.state.candidates[0]!.changes));
  assert.deepEqual((applied.result as { changes: unknown }).changes, stored(applied.state.candidates[0]!.changes));
  const undone = store.undo(before.id, applied.state.candidates[0]!.batchId!);
  assert.deepEqual(undone.cards.find(card => card.id === 'note'), { ...before.cards[0]!, ...layout });
  assert.equal(undone.reading.scroll, 120);
});

test('checkpoint callback 抛错回滚正式内容、operation、receipt、candidate、state/run 全部修改', t => {
  const { store, filename } = temporaryStore(t), f = candidateFixture(store);
  const stateBefore = store.getAgentState(f.run.id), runBefore = store.getRun(f.run.id), receiptBefore = store.getAgentReceipt(f.receipt.key);
  const projectBefore = row(filename, 'SELECT data,updated_at FROM projects');
  assert.throws(() => store.commitAgentCandidate(f.decision, (state, result) => {
    completeCheckpoint(state, result);
    assert.equal(store.getProject(f.before.id).brief, '候选构思');
    assert.equal(store.history(f.before.id).length, 1); assert.equal(store.getAgentReceipt(f.receipt.key)!.status, 'completed');
    throw new Error('host checkpoint failed');
  }), /host checkpoint failed/);
  assert.deepEqual(row(filename, 'SELECT data,updated_at FROM projects'), projectBefore);
  assert.deepEqual(store.getProject(f.before.id), f.before); assert.equal(store.history(f.before.id).length, 0);
  assert.deepEqual(store.getAgentState(f.run.id), stateBefore); assert.deepEqual(store.getRun(f.run.id), runBefore);
  assert.deepEqual(store.getAgentReceipt(f.receipt.key), receiptBefore);
  assert.equal(store.commitAgentCandidate(f.decision, completeCheckpoint).state.candidates[0]!.status, 'applied');
});

test('拒绝 callback 抛错和错误异步 callback 均不能提交部分回执或状态', t => {
  const { store } = temporaryStore(t), f = candidateFixture(store), state = store.getAgentState(f.run.id);
  assert.throws(() => store.commitAgentCandidate({ ...f.decision, approve: false }, () => { throw new Error('denial checkpoint failed'); }), /denial checkpoint failed/);
  assert.deepEqual(store.getAgentState(f.run.id), state); assert.equal(store.getAgentReceipt(f.receipt.key)!.status, 'pending');
  assert.throws(() => store.commitAgentCandidate(f.decision, (() => Promise.resolve()) as (state: AgentState, result: unknown) => void), /必须同步/);
  assert.deepEqual(store.getAgentState(f.run.id), state); assert.equal(store.getAgentReceipt(f.receipt.key)!.status, 'pending');
  assert.equal(store.history(f.before.id).length, 0);
});

test('saveAgentState 同事务 state+新 run+receipt，失败不留下 run，不能串项目/会话/候选/证据', t => {
  const { store } = temporaryStore(t), first = candidateFixture(store), second = candidateFixture(store);
  assert.equal(store.listAgentStates().length, 2);
  assert.deepEqual(store.listAgentStates(first.before.id).map(state => state.runId), [first.run.id]);
  const newRun = makeRun(first.before.id), newState = { ...first.state, runId: newRun.id, candidates: [], waiting: undefined };
  const badReceipt: AgentReceipt = { ...first.receipt, runId: newRun.id };
  assert.throws(() => store.saveAgentState(newState, newRun, badReceipt), /作用域|冲突/);
  assert.equal(store.getRun(newRun.id), undefined); assert.equal(store.getAgentState(newRun.id), undefined);
  assert.throws(() => store.saveRun({ ...first.run, projectId: second.before.id }), /不能转移/);
  assert.throws(() => store.saveAgentState({ ...first.state, projectId: second.before.id }), /不属于/);
  assert.throws(() => store.saveAgentState({ ...first.state, sessionId: second.state.sessionId }), /会话/);
  assert.throws(() => store.saveAgentState({ ...first.state, baseWorkspace: second.before }), /基础快照/);
  const foreignCandidate = structuredClone(first.state); foreignCandidate.candidates[0]!.runId = second.run.id;
  assert.throws(() => store.saveAgentState(foreignCandidate), /候选/);
  const foreignSource = structuredClone(first.state); foreignSource.candidates[0]!.sources = [{ projectId: second.before.id, kind: 'scene', id: 'x', hash: 'x' }];
  assert.throws(() => store.saveAgentState(foreignSource), /证据/);
  assert.deepEqual(store.getRun(first.run.id), first.run); assert.deepEqual(store.getAgentState(first.run.id), stored(first.state));
});

test('每项目持久 session，消息 run 作用域受保护；记忆更新/确认/删除与来源不串项目', t => {
  const temp = temporaryStore(t), first = candidateFixture(temp.store), second = candidateFixture(temp.store);
  const session = temp.store.getSession(first.before.id);
  session.messages.push({ id: 'author-message', role: 'author', text: '不要全知旁白', at, runId: first.run.id });
  temp.store.saveSession(session);
  assert.throws(() => temp.store.saveSession({ ...session, projectId: second.before.id }), /会话/);
  assert.throws(() => temp.store.saveSession({ ...session, messages: [{ ...session.messages[0]!, runId: second.run.id }] }), /不属于/);
  const memory: AgentMemory = { id: 'author-preference', projectId: first.before.id, kind: 'preference', content: '不要全知旁白', confirmed: false,
    sources: [], sourceMessageId: 'author-message', status: 'suggested', createdAt: at, updatedAt: at };
  temp.store.putAgentMemory(memory);
  assert.deepEqual(temp.store.getAgentMemories(first.before.id), [memory]); assert.deepEqual(temp.store.getAgentMemories(second.before.id), []);
  assert.throws(() => temp.store.putAgentMemory({ ...memory, projectId: second.before.id }), /不能转移/);
  assert.throws(() => temp.store.putAgentMemory({ ...memory, id: 'foreign-message', projectId: second.before.id }), /来源消息/);
  assert.throws(() => temp.store.putAgentMemory({ ...memory, sources: [{ projectId: second.before.id, kind: 'scene', id: 'x', hash: 'x' }] }), /证据/);
  assert.throws(() => temp.store.deleteAgentMemory(second.before.id, memory.id), /不属于/);
  temp.store.putAgentMemory({ ...memory, confirmed: true, status: 'active', content: '固定第三人称限知' });
  const store = temp.reopen();
  assert.deepEqual(store.getSession(first.before.id), session); assert.notEqual(store.getSession(second.before.id).id, session.id);
  assert.equal(store.getAgentMemories(first.before.id)[0]!.confirmed, true);
  store.deleteAgentMemory(first.before.id, memory.id); assert.deepEqual(store.getAgentMemories(first.before.id), []);
});

test('turn 请求和响应不可被不同数据覆盖，允许 pending 补响应及相同 JSON 幂等重放', t => {
  const { store, filename } = temporaryStore(t), f = candidateFixture(store);
  store.recordAgentTurn(f.run.id, 'approval-step', 0, { messages: [], model: 'mock' });
  assert.equal(row(filename, 'SELECT response FROM agent_turns').response, null);
  store.recordAgentTurn(f.run.id, 'approval-step', 0, { model: 'mock', messages: [] }, { id: 'response-1', content: '正文' });
  store.recordAgentTurn(f.run.id, 'approval-step', 0, { model: 'mock', messages: [] }, { content: '正文', id: 'response-1' });
  store.recordAgentTurn(f.run.id, 'approval-step', 0, { model: 'mock', messages: [] });
  assert.throws(() => store.recordAgentTurn(f.run.id, 'approval-step', 0, { model: 'mock', messages: [] }, { id: 'response-2' }), /响应不可覆盖/);
  assert.throws(() => store.recordAgentTurn(f.run.id, 'approval-step', 0, { model: 'other' }), /请求不可覆盖/);
  assert.throws(() => store.recordAgentTurn(f.run.id, 'foreign-step', 0, {}), /步骤/);
  assert.throws(() => store.recordAgentTurn(f.run.id, 'approval-step', -1, {}), /轮次/);
  assert.throws(() => store.recordAgentTurn('missing-run', 'approval-step', 0, {}), /不存在/);
  assert.equal(row(filename, 'SELECT COUNT(*) AS count FROM agent_turns').count, 1);
  assert.deepEqual(JSON.parse(row(filename, 'SELECT response FROM agent_turns').response as string), { id: 'response-1', content: '正文' });
});

test('receipt 唯一 key/参数 hash/项目和 run 受保护，terminal result 不可覆盖', t => {
  const { store } = temporaryStore(t), first = candidateFixture(store), second = candidateFixture(store);
  const completed: AgentReceipt = { ...first.receipt, status: 'completed', result: { ok: true, value: 1 } };
  store.saveAgentReceipt(completed);
  store.saveAgentReceipt({ ...completed, at: '2026-10-11T00:00:00.000Z', result: { value: 1, ok: true } });
  assert.deepEqual(store.getAgentReceipt(first.receipt.key), completed);
  assert.throws(() => store.saveAgentReceipt({ ...completed, argumentsHash: 'different' }), /hash 冲突/);
  assert.throws(() => store.saveAgentReceipt({ ...completed, result: { ok: false } }), /不可覆盖/);
  assert.throws(() => store.saveAgentReceipt(first.receipt), /不可覆盖/);
  assert.throws(() => store.saveAgentReceipt({ ...completed, projectId: second.before.id }), /不属于/);
  assert.throws(() => store.saveAgentReceipt({ ...completed, runId: second.run.id, projectId: second.before.id }), /冲突/);
  assert.equal(store.getAgentReceipt('missing'), undefined);
});
