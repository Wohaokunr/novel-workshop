import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { ResponseOutputItem } from 'openai/resources/responses/responses';
import type { AgentEvent, AgentRun, Command, ProviderSecret, RunRequest, Workspace } from '../shared/types.js';
import { KEEP_FINISHED_SNAPSHOTS, NovelStore } from './store.js';
import { DatabaseSync } from 'node:sqlite';
import { NovelAgentScheduler } from './agents.js';
import { DemoAgentTransport } from './agent/demo.js';
import { checkCancelled, CONTINUE_NOTICE, ModelServiceError, type ModelRequest, type ModelResponse, type ResponseTransport } from './responses.js';
import type { AgentCheckpoint } from './responses.js';
import type { PlanNode, UpstreamResult } from '../shared/agent-types.js';
import { MAX_EXPERIENCES, MAX_OUTPUT_REPAIRS } from './agent/runtime.js';

const provider: ProviderSecret = { name: 'fixture', mode: 'mock', baseURL: 'https://example.invalid/v1', model: 'fixture', apiKey: '' };
const waitingStates = ['awaitingApproval', 'awaitingInput', 'paused', 'failed', 'cancelled', 'completed'];
function reply(value: unknown): ModelResponse {
  return { id: randomUUID(), status: 'completed', output: [{ type: 'message', id: randomUUID(), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: typeof value === 'string' ? value : JSON.stringify(value), annotations: [] }] }], usage: null };
}
function tool(name: string, args: unknown): ModelResponse {
  const call: ResponseOutputItem = { type: 'function_call', id: randomUUID(), call_id: randomUUID(), name, arguments: JSON.stringify(args) };
  return { id: randomUUID(), status: 'completed', output: [call], usage: null };
}
function stream(response: ModelResponse) { return { events: (async function* () {})(), finalResponse: async () => response }; }
async function until(store: NovelStore, id: string, predicate: (run: AgentRun) => boolean) {
  for (let i = 0; i < 5000; i++) { const run = store.getRun(id)!; if (predicate(run)) return run; await delay(1); }
  throw new Error(`任务超时：${JSON.stringify(store.getRun(id))}`);
}
function harness(store: NovelStore, intercept?: (request: ModelRequest, signal: AbortSignal, demo: DemoAgentTransport) => ReturnType<ResponseTransport['stream']>, settings = provider) {
  let current: RunRequest;
  const requests: ModelRequest[] = [], events: AgentEvent[] = [];
  const scheduler = new NovelAgentScheduler(store, () => settings, event => events.push(event), () => {
    const demo = new DemoAgentTransport(current, store.getProject(current.projectId));
    return { stream: (request, signal) => { requests.push(structuredClone(request)); return intercept ? intercept(request, signal, demo) : demo.stream(request, signal); } };
  });
  return { scheduler, requests, events, start: (request: RunRequest) => { current = request; return scheduler.start(request); } };
}
async function wait(store: NovelStore, run: AgentRun) { return until(store, run.id, value => waitingStates.includes(value.status)); }
async function approve(store: NovelStore, scheduler: NovelAgentScheduler, run: AgentRun, approved = true) {
  const pending = await wait(store, run);
  assert.equal(pending.status, 'awaitingApproval', pending.error ?? pending.runtime?.pauseReason ?? '');
  const candidate = pending.runtime!.candidates.find(candidate => candidate.status === 'awaitingApproval')!;
  await scheduler.decide({ runId: run.id, candidateId: candidate.id, candidateHash: candidate.hash, approve: approved, reason: approved ? undefined : '保留作者原稿' });
  return until(store, run.id, value => !!value.finishedAt || value.status === 'paused' || value.status === 'awaitingInput');
}
function scenes(store: NovelStore, texts = ['', '']) {
  const initial = store.createProject('范围测试');
  return store.execute({ projectId: initial.id, actor: 'human', commands: texts.map((text, i) => ({ type: 'putScene', value: { id: `scene-${i}`, chapterId: initial.chapters[0]!.id, order: i, title: `场景${i}`, text, outline: '人物面对当场线索作出选择', povId: null, eventIds: [] } })) });
}

test('自然语言目标动态委派并生成审查候选，批准前正文/设定/history 零写入', { timeout: 15000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('新作'), h = harness(store);
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '构思小说并编排三幕大纲' });
    const pending = await wait(store, run);
    assert.equal(pending.status, 'awaitingApproval', pending.error ?? pending.runtime?.pauseReason ?? '');
    assert.deepEqual(store.getProject(project.id), project); assert.equal(store.history(project.id).length, 0);
    assert.ok(pending.runtime!.plan!.nodes.every(node => node.status === 'completed' && node.artifactId));
    const candidate = pending.runtime!.candidates.at(-1)!;
    // Outline and settings candidates skip review and wait for one-click approval.
    assert.equal(candidate.reviews.length, 0); assert.ok(!h.requests.some(request => request.agentId === 'continuity'));
    assert.ok(h.requests.some(request => request.agentId === 'planner'));
    assert.ok(pending.steps.find(step => step.agentId === 'coordinator')!.tools.some(activity => activity.name === 'delegate_tasks'));
    const completed = await approve(store, h.scheduler, run);
    assert.equal(completed.status, 'completed', completed.error ?? completed.runtime?.pauseReason ?? '');
    assert.equal(store.getProject(project.id).scenes.length, 3); assert.equal(store.history(project.id).length, 1);
    assert.equal(completed.runtime?.budget.usageUnknown, true); assert.equal(completed.usage.provided, false);
    await h.scheduler.decide({ runId: run.id, candidateId: candidate.id, candidateHash: candidate.hash, approve: true });
    assert.equal(store.history(project.id).length, 1); assert.equal(store.getRun(run.id)!.status, 'completed');
    assert.equal(store.getSession(project.id).messages.filter(message => message.role === 'agent').length, 1);
  } finally { store.close(); }
});

test('纯分析目标只保存报告，实际工具和专长不同于创作目标', { timeout: 10000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = scenes(store, ['人工正文']), h = harness(store);
    const result = await wait(store, h.start({ projectId: project.id, stage: 'agent', objective: '仅分析现有作品的问题，不要改动作品' }));
    assert.equal(result.status, 'completed', result.error ?? result.runtime?.pauseReason ?? '');
    assert.deepEqual(store.getProject(project.id), project); assert.equal(result.runtime!.candidates.length, 0);
    assert.ok(result.runtime!.artifacts.some(artifact => artifact.role === 'continuity')); assert.ok(!h.requests.some(request => request.agentId === 'writer'));
    assert.equal(store.getAgentMemories(project.id)[0]!.kind, 'experience');
  } finally { store.close(); }
});

test('拒绝候选回传原调用，正式内容零变化，未重复要求批准同一候选', { timeout: 10000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('拒绝测试'), h = harness(store), run = h.start({ projectId: project.id, stage: 'idea', objective: '发散小说构思' });
    const completed = await approve(store, h.scheduler, run, false);
    assert.equal(completed.status, 'completed'); assert.deepEqual(store.getProject(project.id), project); assert.equal(store.history(project.id).length, 0);
    assert.equal(completed.runtime?.candidates.at(-1)?.status, 'rejected');
    const native = (store.getAgentState(run.id)!.checkpoints.coordinator as AgentCheckpoint).input;
    assert.ok(native.some(item => item.type === 'function_call_output' && String(item.output).includes('author_declined')));
  } finally { store.close(); }
});

test('审批检查点真实 SQLite 重开后恢复，不重新生成候选或重复正式写入', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'novel-agent-reopen-')), filename = join(directory, 'workspace.sqlite');
  let store = new NovelStore(filename);
  try {
    const project = store.createProject('重开'), h = harness(store), run = h.start({ projectId: project.id, stage: 'idea', objective: '构思' });
    const pending = await wait(store, run); assert.equal(pending.status, 'awaitingApproval');
    await h.scheduler.shutdown(); const calls = pending.runtime!.budget.modelCalls; store.close(); store = new NovelStore(filename);
    const second = new NovelAgentScheduler(store, () => provider, () => {}); second.recover();
    assert.equal(store.getRun(run.id)!.status, 'awaitingApproval'); assert.equal(store.getRun(run.id)!.runtime!.budget.modelCalls, calls);
    const completed = await approve(store, second, run); assert.equal(completed.status, 'completed', completed.error ?? completed.runtime?.pauseReason ?? '');
    assert.equal(store.history(project.id).filter(batch => batch.taskId === run.id).length, 1);
    assert.equal(completed.steps.filter(step => step.agentId === 'planner').length, 1);
    assert.equal(store.undo(project.id, run.id).objects.length, project.objects.length);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('批准后立刻关闭，原回执与 checkpoint 恢复不重做写入', { timeout: 15000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('已批准中断'), h = harness(store), run = h.start({ projectId: project.id, stage: 'idea', objective: '构思' });
    const pending = await wait(store, run), candidate = pending.runtime!.candidates.at(-1)!;
    await h.scheduler.decide({ runId: run.id, candidateId: candidate.id, candidateHash: candidate.hash, approve: true });
    await h.scheduler.shutdown();
    const second = new NovelAgentScheduler(store, () => provider, () => {}); second.recover();
    const state = store.getRun(run.id)!;
    if (state.status === 'paused') await second.resume(run.id, state.runtime!.uncertain);
    const completed = await until(store, run.id, value => value.status === 'completed');
    assert.equal(store.history(project.id).filter(batch => batch.taskId === run.id).length, 1); assert.equal(completed.runtime!.candidates.filter(candidate => candidate.status === 'applied').length, 1);
  } finally { store.close(); }
});

test('单场景正文与短选区改写保持其余原稿，任务撤销保持无关人工修改', { timeout: 15000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = scenes(store, ['', '人工保留正文']), h = harness(store);
    const written = await approve(store, h.scheduler, h.start({ projectId: project.id, stage: 'chapter', sceneId: 'scene-0', objective: '只写这个场景' }));
    assert.equal(written.status, 'completed'); const generated = store.getProject(project.id); assert.equal(generated.scenes[1]!.text, '人工保留正文');
    const original = generated.scenes[0]!.text, selection = { start: 4, end: 18 };
    const rewritten = await approve(store, h.scheduler, h.start({ projectId: project.id, stage: 'rewrite', sceneId: 'scene-0', selection, objective: '只改选区' }));
    assert.equal(rewritten.status, 'completed'); const after = store.getProject(project.id).scenes[0]!.text;
    assert.ok(after.startsWith(original.slice(0, selection.start))); assert.ok(after.endsWith(original.slice(selection.end)));
    const current = store.getProject(project.id); store.execute({ projectId: project.id, actor: 'human', commands: [{ type: 'putScene', value: { ...current.scenes[1]!, text: '之后的人工修改' } }] });
    const restored = store.undo(project.id, rewritten.id); assert.equal(restored.scenes[0]!.text, original); assert.equal(restored.scenes[1]!.text, '之后的人工修改');
  } finally { store.close(); }
});

test('作者编辑与目标删除拒绝陈旧候选，不覆盖或扩大范围', { timeout: 10000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = scenes(store), h = harness(store), run = h.start({ projectId: project.id, stage: 'chapter', sceneId: 'scene-0', objective: '只写目标' });
    const pending = await wait(store, run), candidate = pending.runtime!.candidates.at(-1)!;
    const current = store.getProject(project.id); const edited = store.execute({ projectId: project.id, actor: 'human', commands: [{ type: 'putScene', value: { ...current.scenes[0]!, text: '人工最新正文' } }] });
    const history = store.history(project.id);
    await assert.rejects(h.scheduler.decide({ runId: run.id, candidateId: candidate.id, candidateHash: candidate.hash, approve: true }), /REVISION_CONFLICT/);
    assert.deepEqual(store.getProject(project.id), edited); assert.deepEqual(store.history(project.id), history);
    await h.scheduler.cancel(run.id);
    assert.throws(() => h.start({ projectId: project.id, stage: 'chapter', sceneId: 'deleted', objective: '不能扩大' }), /删除/);
  } finally { store.close(); }
});

test('取消待审批任务使原批准失效，不自动撤销已获批内容', { timeout: 10000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('取消'), h = harness(store), run = h.start({ projectId: project.id, stage: 'idea', objective: '构思' });
    const pending = await wait(store, run), candidate = pending.runtime!.candidates.at(-1)!;
    await h.scheduler.cancel(run.id);
    await assert.rejects(h.scheduler.decide({ runId: run.id, candidateId: candidate.id, candidateHash: candidate.hash, approve: true }), /回执|审批/);
    assert.deepEqual(store.getProject(project.id), project); assert.equal(store.getRun(run.id)!.status, 'cancelled');
  } finally { store.close(); }
});

test('暂停不确定网络请求需明确确认再恢复，未执行部分流式动作', { timeout: 10000 }, async () => {
  const store = new NovelStore(':memory:'); let block = true;
  try {
    const project = store.createProject('暂停'), h = harness(store, (request, signal, demo) => {
      if (!block) return demo.stream(request, signal);
      return { events: (async function* () { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); checkCancelled(signal); })(), finalResponse: async () => reply('不应使用的部分结果') };
    });
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '只分析作品' });
    await until(store, run.id, value => !!value.runtime?.uncertain); await h.scheduler.pause(run.id);
    assert.equal(store.getRun(run.id)!.status, 'paused'); assert.equal(store.history(project.id).length, 0);
    await assert.rejects(h.scheduler.resume(run.id), /不确定/);
    block = false; await h.scheduler.resume(run.id, true);
    const completed = await until(store, run.id, value => value.status === 'completed');
    assert.equal(completed.runtime!.budget.modelCalls, h.requests.length); assert.equal(store.getProject(project.id).revision, project.revision);
  } finally { store.close(); }
});

test('失败请求精确脱敏，不跨配置恢复或静默向新服务发送旧会话', { timeout: 10000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('secret'), apiKey = 'sk-test-private-credential';
    const h = harness(store, () => { throw new Error(`unauthorized bearer ${apiKey}`); }, { ...provider, mode: 'live', apiKey });
    const paused = await wait(store, h.start({ projectId: project.id, stage: 'idea', objective: 'test' }));
    assert.equal(paused.status, 'paused'); assert.ok(!JSON.stringify(h.events).includes(apiKey)); assert.ok(!JSON.stringify(store.getAgentState(paused.id)).includes(apiKey));
    const second = new NovelAgentScheduler(store, () => ({ ...provider, model: 'changed' }), () => {});
    await assert.rejects(second.resume(paused.id, true), /模型配置/);
  } finally { store.close(); }
});

test('共享模型预算在请求前停止；未知 usage 不绕过硬上限', { timeout: 10000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('预算'), h = harness(store);
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '只分析作品' });
    // start persists synchronously, before queueMicrotask launches the first model call.
    const state = store.getAgentState(run.id)!; state.budget.maxModelCalls = 0;
    // Use the persisted recovery path so the running object cannot silently reset the configured limit.
    await h.scheduler.pause(run.id); const saved = store.getAgentState(run.id)!; saved.budget.maxModelCalls = 0; store.saveAgentState(saved);
    await h.scheduler.resume(run.id);
    const paused = await wait(store, run);
    assert.equal(paused.status, 'paused'); assert.match(paused.runtime!.pauseReason ?? '', /预算/);
    assert.equal(paused.runtime!.budget.modelCalls, 0); assert.equal(h.requests.length, 0);
  } finally { store.close(); }
});

test('重规划额度耗尽后恢复同一检查点，追加额度并保留累计用量和产物', { timeout: 10000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('重规划恢复');
    const request: RunRequest = { projectId: project.id, stage: 'agent', objective: '只分析作品' };
    const intercept = (input: ModelRequest, signal: AbortSignal, demo: DemoAgentTransport) => {
      if (input.agentId !== 'coordinator') return demo.stream(input, signal);
      const calls = input.input.filter(item => item.type === 'function_call');
      if (!calls.length) return stream(tool('save_report', { label: '已有分析', text: '恢复时应保留这份报告' }));
      const planCalls = calls.filter(call => call.name === 'set_plan');
      const plans = planCalls.filter(call => JSON.parse(call.arguments).nodes.length > 0).length;
      if (planCalls.length === 1) return stream(tool('set_plan', { summary: '无效重规划不消耗额度', nodes: [] }));
      if (plans < 6) return stream(tool('set_plan', { summary: `计划 ${plans + 1}`, nodes: [{
        id: 'analysis', role: 'continuity', objective: '检查已有作品', dependsOn: [], acceptance: '提供分析报告',
        sceneId: null, chapterId: null, characterId: null, eventId: null,
      }] }));
      return demo.stream(input, signal);
    };
    const h = harness(store, intercept), run = h.start(request);
    const paused = await wait(store, run);
    assert.equal(paused.status, 'paused'); assert.match(paused.runtime!.pauseReason ?? '', /重规划预算耗尽/);
    assert.equal(paused.runtime!.budget.replans, 2); assert.equal(paused.runtime!.budget.maxReplans, 2);
    assert.equal(paused.runtime!.plan!.version, 3);
    const checkpoint = store.getAgentState(run.id)!.checkpoints.coordinator as AgentCheckpoint;
    const blockedCall = checkpoint.pendingCalls[checkpoint.cursor]!;
    assert.equal(blockedCall.type, 'function_call');
    const report = paused.runtime!.artifacts[0]!;
    await h.scheduler.shutdown();
    // Recreate the runtime to exercise persisted recovery, including old over-counted checkpoints.
    const saved = store.getAgentState(run.id)!;
    saved.budget.replans = saved.budget.maxReplans + 3;
    store.saveAgentState(saved);
    const demo = new DemoAgentTransport(request, project);
    const second = new NovelAgentScheduler(store, () => provider, () => {}, () => ({ stream: (input, signal) => intercept(input, signal, demo) }));
    second.recover(); await second.resume(run.id);
    const pausedAgain = await wait(store, run);
    assert.equal(pausedAgain.status, 'paused'); assert.match(pausedAgain.runtime!.pauseReason ?? '', /重规划预算耗尽/);
    assert.equal(pausedAgain.runtime!.plan!.version, 5);
    assert.equal(pausedAgain.runtime!.budget.maxReplans, saved.budget.replans + 2);
    assert.equal(pausedAgain.runtime!.budget.replans, saved.budget.replans + 2);
    assert.equal(pausedAgain.runtime!.budget.modelCalls, paused.runtime!.budget.modelCalls + 2);
    assert.equal(pausedAgain.runtime!.budget.toolCalls, paused.runtime!.budget.toolCalls + 2);
    const resumedCheckpoint = store.getAgentState(run.id)!.checkpoints.coordinator as AgentCheckpoint;
    assert.equal(resumedCheckpoint.input.filter(item => item.type === 'function_call_output' && blockedCall.type === 'function_call' && item.call_id === blockedCall.call_id).length, 1);
    await second.resume(run.id);
    const completed = await until(store, run.id, value => value.status === 'completed' || value.status === 'paused' || value.status === 'failed');
    assert.equal(completed.status, 'completed', completed.runtime?.pauseReason ?? completed.error ?? '');
    assert.equal(completed.runtime!.plan!.version, 6);
    assert.equal(completed.runtime!.budget.replans, saved.budget.replans + 3);
    assert.equal(completed.runtime!.budget.maxReplans, saved.budget.replans + 4);
    assert.deepEqual(completed.runtime!.artifacts.find(artifact => artifact.id === report.id), report);
    assert.deepEqual(store.getProject(project.id), project); assert.equal(store.history(project.id).length, 0);
  } finally { store.close(); }
});

test('构思候选不经审查直接等待作者批准，批准前不写入', { timeout: 10000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('审查'), h = harness(store, (request, signal, demo) => request.agentId === 'continuity'
      ? stream(reply({ verdict: 'revise', issues: ['缺少可核对的行动依据'], recommendation: '保留原稿，补充证据' })) : demo.stream(request, signal));
    const pending = await wait(store, h.start({ projectId: project.id, stage: 'idea', objective: '构思' }));
    assert.equal(pending.status, 'awaitingApproval'); assert.equal(pending.runtime!.candidates.at(-1)!.reviews.length, 0);
    assert.ok(!h.requests.some(request => request.agentId === 'continuity'));
    assert.deepEqual(store.getProject(project.id), project); assert.equal(store.history(project.id).length, 0);
    await h.scheduler.cancel(pending.id);
  } finally { store.close(); }
});

for (const stillRevise of [false, true]) test(`自动审查直接驱动写作者修订：${stillRevise ? '修订两次仍有意见' : '一次修订后通过'}`, { timeout: 10000 }, async () => {
  const store = new NovelStore(':memory:'); let revisions = 0;
  try {
    const project = scenes(store, ['', '作者保留的正文']);
    const h = harness(store, (request, signal, demo) => {
      if (request.agentId === 'continuity' || request.agentId === 'reader') {
        return stream(reply({ verdict: stillRevise || revisions === 0 ? 'revise' : 'pass', issues: stillRevise || revisions === 0 ? ['说明谁在岸上接绳'] : [], recommendation: '交代救援站位' }));
      }
      if (request.agentId === 'rewrite') {
        const input = request.input.find(item => 'role' in item && item.role === 'user') as { content: string };
        const { context, objective } = JSON.parse(input.content);
        assert.match(objective, /审查意见修订当前正文/);
        assert.ok(context.scene.text.trim(), '修订必须读取当前候选正文');
        assert.ok(context.candidateReviews.some((review: { issues: string[] }) => review.issues.includes('说明谁在岸上接绳')));
        revisions++;
        return stream(reply(`${context.scene.text}\n\n第${revisions}次修订：少年站在岸上接住了绳子。`));
      }
      return demo.stream(request, signal);
    });
    const run = h.start({ projectId: project.id, stage: 'chapter', sceneId: 'scene-0', objective: '生成正文，保留其他场景' });
    const pending = await wait(store, run);
    assert.equal(pending.status, 'awaitingApproval', pending.error ?? pending.runtime?.pauseReason ?? '');
    const candidate = pending.runtime!.candidates.at(-1)!;
    assert.equal(revisions, stillRevise ? 2 : 1);
    assert.equal(pending.runtime!.budget.revisions, revisions);
    assert.equal(candidate.version, revisions + 1);
    assert.ok(h.requests.filter(request => request.agentId === 'coordinator').every(request => !request.input.some(item => item.type === 'function_call' && item.name === 'revise_candidate')), '自动修订不依赖协调模型调用修订工具');
    assert.ok(candidate.reviews.every(review => review.candidateHash === candidate.hash));
    assert.deepEqual(store.getProject(project.id), project); assert.equal(store.history(project.id).filter(batch => batch.taskId === run.id).length, 0);
    await h.scheduler.decide({ runId: run.id, candidateId: candidate.id, candidateHash: candidate.hash, approve: true });
    const done = await until(store, run.id, value => value.status === 'completed' || value.status === 'paused' || value.status === 'failed');
    assert.equal(done.status, 'completed', done.runtime?.pauseReason ?? done.error ?? '');
    assert.match(store.getProject(project.id).scenes[0]!.text, new RegExp(`第${revisions}次修订`));
    assert.equal(store.getProject(project.id).scenes[1]!.text, '作者保留的正文');
    assert.equal(store.history(project.id).filter(batch => batch.taskId === run.id).length, 1);
  } finally { store.close(); }
});

for (const ending of ['finish_run', 'text'] as const) test(`审查后${ending === 'text' ? '仅输出总结' : '试图结束任务'}仍交给作者审阅；恢复不重写`, { timeout: 10000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = scenes(store, ['', '保留正文']);
    const h = harness(store, (request, signal, demo) => {
      if (request.agentId === 'continuity' || request.agentId === 'reader') return stream(reply({ verdict: 'revise', issues: ['站位仍可改进'], recommendation: '补足站位' }));
      if (request.agentId === 'rewrite') {
        const input = request.input.find(item => 'role' in item && item.role === 'user') as { content: string };
        return stream(reply(`${JSON.parse(input.content).context.scene.text}\n少年在岸上接绳。`));
      }
      const last = request.input.at(-1);
      if (request.agentId === 'coordinator' && last?.type === 'function_call_output' && JSON.parse(String(last.output)).reviews) {
        return stream(ending === 'text' ? reply('候选仍有意见，尚未写入。') : tool('finish_run', { summary: '只生成了候选，尚未写入', artifactIds: [] }));
      }
      return demo.stream(request, signal);
    });
    const run = h.start({ projectId: project.id, stage: 'chapter', sceneId: 'scene-0', objective: '生成正文' });
    const pending = await wait(store, run);
    assert.equal(pending.status, 'awaitingApproval', pending.runtime?.pauseReason ?? pending.error ?? '');
    assert.equal(pending.runtime!.budget.revisions, 2, '先自动修订到上限，再交给作者');
    assert.deepEqual(store.getProject(project.id), project);
    await h.scheduler.shutdown();
    const second = new NovelAgentScheduler(store, () => provider, () => {}); second.recover();
    const calls = store.getRun(run.id)!.runtime!.budget.modelCalls;
    await second.pause(run.id); await second.resume(run.id);
    assert.equal(store.getRun(run.id)!.runtime!.budget.modelCalls, calls);
    const candidate = store.getRun(run.id)!.runtime!.candidates.at(-1)!;
    await second.decide({ runId: run.id, candidateId: candidate.id, candidateHash: candidate.hash, approve: true });
    const done = await until(store, run.id, value => value.status === 'completed' || value.status === 'paused' || value.status === 'failed');
    assert.equal(done.status, 'completed', done.runtime?.pauseReason ?? done.error ?? '');
    assert.equal(store.history(project.id).filter(batch => batch.taskId === run.id).length, 1);
  } finally { store.close(); }
});

test('自动审查修订变长的选区候选仍只替换选区，作者批准后正常结束', { timeout: 10000 }, async () => {
  const store = new NovelStore(':memory:'); let writes = 0;
  try {
    const project = scenes(store, ['前缀原始选区后缀', '其他场景']);
    const h = harness(store, (request, signal, demo) => {
      if (request.agentId === 'coordinator') {
        const output = request.input.at(-1);
        const call = output?.type === 'function_call_output' ? request.input.find(item => item.type === 'function_call' && item.call_id === output.call_id) : undefined;
        if (call?.type === 'function_call' && call.name === 'commit_candidate') return stream(reply('已完成作者决定。'));
      }
      if (request.agentId === 'reader') return stream(reply({ verdict: writes === 1 ? 'revise' : 'pass', issues: writes === 1 ? ['选区动作不够清楚'] : [], recommendation: '明确动作' }));
      if (request.agentId === 'rewrite') {
        const input = request.input.find(item => 'role' in item && item.role === 'user') as { content: string };
        const { context } = JSON.parse(input.content);
        assert.equal(context.selectedText, writes === 0 ? '原始选区' : '第一版较长的替换选区');
        writes++;
        return stream(reply(writes === 1 ? '第一版较长的替换选区' : '最终动作'));
      }
      return demo.stream(request, signal);
    });
    const run = h.start({ projectId: project.id, stage: 'rewrite', sceneId: 'scene-0', selection: { start: 2, end: 6 }, objective: '改写选区' });
    const done = await approve(store, h.scheduler, run);
    assert.equal(done.status, 'completed', done.runtime?.pauseReason ?? done.error ?? '');
    assert.equal(store.getProject(project.id).scenes[0]!.text, '前缀最终动作后缀');
    assert.equal(store.getProject(project.id).scenes[1]!.text, '其他场景');
  } finally { store.close(); }
});

test('自动修订中暂停并重开，恢复当前轮次而不重复已生成的新稿', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'novel-auto-revision-')), filename = join(directory, 'workspace.sqlite');
  let store = new NovelStore(filename), rewrites = 0, block = true;
  try {
    const project = scenes(store, ['', '原有正文']);
    const request: RunRequest = { projectId: project.id, stage: 'chapter', sceneId: 'scene-0', objective: '生成场景正文' };
    const intercept = (input: ModelRequest, signal: AbortSignal, demo: DemoAgentTransport) => {
      if (input.agentId === 'continuity' || input.agentId === 'reader') return stream(reply({ verdict: 'revise', issues: ['救援站位应更明确'], recommendation: '明确站位' }));
      if (input.agentId === 'rewrite') {
        rewrites++;
        if (block && rewrites === 2) return { events: (async function* () {
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); checkCancelled(signal);
        })(), finalResponse: async () => reply('未完成请求不应使用') };
        const user = input.input.find(item => 'role' in item && item.role === 'user') as { content: string };
        return stream(reply(`${JSON.parse(user.content).context.scene.text}\n新的站位说明。`));
      }
      return demo.stream(input, signal);
    };
    const h = harness(store, intercept), run = h.start(request);
    await until(store, run.id, () => rewrites === 2); await h.scheduler.pause(run.id); await h.scheduler.shutdown();
    const before = store.getAgentState(run.id)!;
    assert.equal(before.candidates.length, 2); assert.equal(before.budget.revisions, 1);
    const savedCandidate = before.candidates.at(-1)!;
    store.close(); store = new NovelStore(filename); block = false;
    const demo = new DemoAgentTransport(request, project);
    const second = new NovelAgentScheduler(store, () => provider, () => {}, () => ({ stream: (input, signal) => intercept(input, signal, demo) }));
    second.recover(); await second.resume(run.id, true);
    const pending = await wait(store, run);
    assert.equal(pending.status, 'awaitingApproval', pending.runtime?.pauseReason ?? pending.error ?? '');
    assert.equal(rewrites, 3, '只重发被中断的第二轮请求');
    assert.equal(pending.runtime!.candidates.length, 3); assert.equal(pending.runtime!.budget.revisions, 2);
    assert.equal(pending.runtime!.candidates[1]!.hash, savedCandidate.hash);
    assert.equal(pending.steps.filter(step => step.agentId === 'writer').length, 1);
    assert.deepEqual(store.getProject(project.id), project);
    const candidate = pending.runtime!.candidates.at(-1)!;
    await second.decide({ runId: run.id, candidateId: candidate.id, candidateHash: candidate.hash, approve: true });
    const done = await until(store, run.id, value => value.status === 'completed' || value.status === 'paused' || value.status === 'failed');
    assert.equal(done.status, 'completed', done.runtime?.pauseReason ?? done.error ?? '');
    assert.equal(store.history(project.id).filter(batch => batch.taskId === run.id).length, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('明确作者记忆、确认与失效按项目隔离，导入副本不串记忆', () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('memory'), scheduler = new NovelAgentScheduler(store, () => provider, () => {});
    const memory = scheduler.saveMemory(project.id, '对白克制，不提前解释秘密', 'preference');
    assert.equal(memory.confirmed, true); assert.equal(scheduler.getMemories(project.id)[0]!.status, 'active');
    const copy = store.importProject(project); assert.equal(scheduler.getMemories(copy.id).length, 0);
    assert.throws(() => store.deleteAgentMemory(copy.id, memory.id), /不属于/);
  } finally { store.close(); }
});

test('计划保存后由运行时执行到作者批准，协调者只规划和总结；人物塑造用故事操作落到画布并免审批准', { timeout: 15000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('人物'), h = harness(store);
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '为作品设计人物阵容' });
    const pending = await wait(store, run);
    assert.equal(pending.status, 'awaitingApproval', pending.error ?? pending.runtime?.pauseReason ?? '');
    const coordinator = () => h.requests.filter(request => request.agentId === 'coordinator');
    assert.equal(coordinator().length, 1, '保存计划后不再请求协调模型');
    const tools = pending.steps.find(step => step.agentId === 'coordinator')!.tools.map(activity => activity.name);
    assert.deepEqual(tools, ['set_plan', 'delegate_tasks', 'propose_changes', 'commit_candidate']);
    const native = (store.getAgentState(run.id)!.checkpoints.coordinator as AgentCheckpoint).input;
    assert.ok(native.filter(item => item.type === 'function_call').slice(1).every(item => item.type === 'function_call' && item.call_id.startsWith('runtime-') && !item.id),
      '运行时步骤记入对话，且不带服务端条目 ID');
    assert.ok(!h.requests.some(request => request.agentId === 'continuity'), '人物候选不经审查');
    const completed = await approve(store, h.scheduler, run);
    assert.equal(completed.status, 'completed', completed.error ?? completed.runtime?.pauseReason ?? '');
    assert.equal(coordinator().length, 2, '作者决定后只请求一次总结');
    const current = store.getProject(project.id);
    assert.deepEqual(current.objects.filter(object => object.typeId === 'character').map(object => object.name).sort(), ['沈照', '许砚'].sort());
    assert.equal(current.cards.filter(card => card.kind === 'object').length, 2);
    assert.equal(current.canvasLinks.length, 1);
  } finally { store.close(); }
});

test('propose_changes 的 opsJson 经故事操作换算，ask_author 的选项暴露给作者', { timeout: 15000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('故事操作');
    const ops = JSON.stringify([{ op: 'addCharacter', ref: 'c1', title: '林舟' }, { op: 'addCard', ref: 'n1', title: '第十三声' }, { op: 'link', parentRef: 'c1', targetId: 'n1', title: '听见' }]);
    let step = 0;
    const h = harness(store, (request, signal, demo) => {
      if (request.agentId !== 'coordinator') return demo.stream(request, signal);
      step++;
      if (step === 1) return stream(tool('ask_author', { question: '主角是谁？', options: ['学徒', '守钟人'] }));
      if (step === 2) return stream(tool('propose_changes', { label: '人物', artifactIds: [], commandsJson: '', opsJson: ops }));
      // The runtime submitted the coordinator's own proposal for approval; it is asked again only after the author's decision.
      const output = request.input.filter(item => item.type === 'function_call_output').at(-1) as { output: string };
      assert.equal(JSON.parse(output.output).ok, true);
      return stream(tool('finish_run', { summary: '已建立人物。', artifactIds: [] }));
    });
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '建立主角' });
    const asking = await wait(store, run);
    assert.equal(asking.status, 'awaitingInput');
    assert.deepEqual(asking.runtime!.waiting!.options, ['学徒', '守钟人']);
    await h.scheduler.answer(run.id, '学徒');
    const completed = await approve(store, h.scheduler, run);
    assert.equal(completed.status, 'completed', completed.error ?? completed.runtime?.pauseReason ?? '');
    assert.equal(step, 3); assert.equal(completed.runtime!.finalSummary, '已建立人物。');
    const current = store.getProject(project.id);
    assert.equal(current.objects[0]!.name, '林舟');
    assert.equal(current.cards.length, 2);
    assert.equal(current.canvasLinks.length, 1);
  } finally { store.close(); }
});

/** Coordinator that plans one planner node and leaves the rest to the runtime. When handed a failure it re-delegates the node up to
 * `retries` times, then asks the author; otherwise it finishes. Records every result it is handed. */
function planningCoordinator(results: unknown[], retries = 0) {
  let delegated = 0;
  return (request: ModelRequest) => {
    const outputs = request.input.filter(item => item.type === 'function_call_output');
    if (!outputs.length) return stream(tool('set_plan', { summary: '编排', nodes: [{ id: 'n1', role: 'planner', objective: '补一个人物', dependsOn: [], acceptance: '人物候选',
      sceneId: null, chapterId: null, characterId: null, eventId: null }] }));
    const last = JSON.parse(String((outputs.at(-1) as { output: string }).output));
    results.push(last);
    if (last.ok === false && delegated++ < retries) return stream(tool('delegate_tasks', { nodeIds: ['n1'] }));
    if (last.ok === false) return stream(tool('ask_author', { question: '继续吗？', options: [] }));
    return stream(tool('finish_run', { summary: '已完成。', artifactIds: [] }));
  };
}
const rewritesProse = (project: Workspace) => reply({ summary: '改写正文', opsJson: '[]', commandsJson: JSON.stringify([{ type: 'putScene', value: { ...project.scenes[0]!, text: '覆盖作者正文' } }]) });
const addsCharacter = reply({ summary: '补人物', commandsJson: '[]', opsJson: JSON.stringify([{ op: 'addCharacter', ref: 'c1', title: '许砚', content: '修钟学徒' }]) });
const proposedCommands = (store: NovelStore, run: AgentRun) => store.getAgentState(run.id)!.candidates.at(-1)!.commands;

test('专长输出未通过领域校验时带着原因让同一专长修正，而不是重放被拒的旧输出', { timeout: 15000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = scenes(store, ['人工正文']), results: unknown[] = [], planner: ModelRequest[] = [];
    const coordinate = planningCoordinator(results);
    const h = harness(store, request => {
      if (request.agentId !== 'planner') return coordinate(request);
      planner.push(request);
      return stream(planner.length === 1 ? rewritesProse(project) : addsCharacter);
    });
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '补一个人物' });
    const pending = await wait(store, run);
    assert.equal(pending.status, 'awaitingApproval', pending.error ?? pending.runtime?.pauseReason ?? '');
    assert.equal(planner.length, 2);
    const repair = planner[1]!.input.at(-1) as { role: string; content: string };
    assert.equal(repair.role, 'user'); assert.match(repair.content, /运行时校验未通过：编排专家不能删除或改写已有正式正文/);
    assert.ok(proposedCommands(store, run).some(command => command.type === 'putObject'));
    assert.equal(pending.runtime!.plan!.nodes[0]!.status, 'completed');
    assert.equal(results.length, 0, '修正在专长内部完成，没有交还协调者');
  } finally { store.close(); }
});

test('修正次数用尽后节点失败并把原因交还协调者，再次委派从头开始而不是复用同一份被拒输出', { timeout: 15000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = scenes(store, ['人工正文']), results: unknown[] = [], planner: ModelRequest[] = [];
    const coordinate = planningCoordinator(results, 1);
    const h = harness(store, request => {
      if (request.agentId !== 'planner') return coordinate(request);
      planner.push(request);
      return stream(planner.length <= MAX_OUTPUT_REPAIRS + 1 ? rewritesProse(project) : addsCharacter);
    });
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '补一个人物' });
    const pending = await wait(store, run);
    assert.equal(pending.status, 'awaitingApproval', pending.error ?? pending.runtime?.pauseReason ?? '');
    const failed = results[0] as { ok: boolean; reason: string; failedNodeIds: string[]; options: string };
    assert.equal(failed.ok, false); assert.match(failed.reason, new RegExp(`^n1：.*连续 ${MAX_OUTPUT_REPAIRS + 1} 次输出未通过校验`));
    assert.deepEqual(failed.failedNodeIds, ['n1']); assert.match(failed.options, /set_plan/);
    assert.equal(planner.length, MAX_OUTPUT_REPAIRS + 2);
    // The fresh attempt sees only its context, not the rejected history.
    assert.equal(planner[MAX_OUTPUT_REPAIRS + 1]!.input.length, 1);
    assert.ok(proposedCommands(store, run).some(command => command.type === 'putObject'));
    assert.equal(pending.runtime!.plan!.nodes[0]!.error, undefined, '重新委派成功后清除失败原因');
    const steps = store.getRun(run.id)!.steps.filter(step => step.agentId === 'planner');
    assert.deepEqual(steps.map(step => step.status), ['failed', 'completed']);
  } finally { store.close(); }
});

test('不严格遵守 JSON Schema 的模型返回非 JSON 时同样获得修正机会', { timeout: 15000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = scenes(store, ['人工正文']), results: unknown[] = [], planner: ModelRequest[] = [];
    const coordinate = planningCoordinator(results);
    const h = harness(store, request => {
      if (request.agentId !== 'planner') return coordinate(request);
      planner.push(request);
      return stream(planner.length === 1 ? reply('好的，下面是我的方案：新增人物许砚。') : addsCharacter);
    });
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '补一个人物' });
    assert.equal((await wait(store, run)).status, 'awaitingApproval');
    assert.equal(planner.length, 2); assert.match(String((planner[1]!.input.at(-1) as { content: string }).content), /运行时校验未通过/);
    assert.ok(proposedCommands(store, run).some(command => command.type === 'putObject'));
  } finally { store.close(); }
});

test('创作经验不随无关修改失效；撤销该任务的修改后过期，过期与超量经验在下次完成时清理', { timeout: 20000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('经验'), h = harness(store);
    const run = h.start({ projectId: project.id, stage: 'idea', objective: '发散小说构思' });
    assert.equal((await approve(store, h.scheduler, run)).status, 'completed');
    const experience = () => store.getAgentMemories(project.id).find(memory => memory.id === `experience-${run.id}`);
    assert.equal(experience()?.status, 'active'); assert.deepEqual(experience()?.sources, []); assert.match(experience()!.content, /^目标：发散小说构思\n结果：/);
    const edited = store.execute({ projectId: project.id, expectedRevision: store.getProject(project.id).revision, actor: 'human', commands: [{ type: 'putCard', value: { id: 'human-note', kind: 'note', title: '作者便笺', content: '与本次任务无关的修改', x: 0, y: 0 } }] });
    assert.equal(h.scheduler.getMemories(project.id).find(memory => memory.id === `experience-${run.id}`)?.status, 'active');
    store.undo(edited.id, run.id);
    assert.equal(experience()?.status, 'stale');

    for (let index = 0; index < MAX_EXPERIENCES + 5; index++) {
      const at = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      store.putAgentMemory({ id: `old-${index}`, projectId: project.id, kind: 'experience', content: `旧经验${index}`, confirmed: true, status: 'active', sources: [], createdAt: at, updatedAt: at });
    }
    const analysis = h.start({ projectId: project.id, stage: 'agent', objective: '仅分析现有作品的问题，不要改动作品' });
    assert.equal((await wait(store, analysis)).status, 'completed');
    const experiences = store.getAgentMemories(project.id).filter(memory => memory.kind === 'experience');
    assert.equal(experiences.length, MAX_EXPERIENCES); assert.ok(experiences.every(memory => memory.status === 'active'));
    assert.equal(experiences[0]!.id, `experience-${analysis.id}`); assert.ok(!experiences.some(memory => memory.id === `experience-${run.id}` || memory.id === 'old-0'));
  } finally { store.close(); }
});

test('依赖节点读到前置结论：角色代入进入写作上下文，后一场读到前一场刚写、尚未组成候选的正文', { timeout: 20000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const initial = store.createProject('依赖传递'), chapterId = initial.chapters[0]!.id;
    const project = store.execute({ projectId: initial.id, actor: 'human', commands: [
      { type: 'putObject', value: { id: 'hero', typeId: 'character', name: '林舟', fields: { selfKnowledge: '修钟学徒' } } },
      { type: 'putObject', value: { id: 'ev', typeId: 'event', name: '钟声', fields: {}, event: { worldOrder: 1, timeLabel: '', thread: '主线', participants: ['hero'], causes: [], critical: true, observations: { hero: '听见第十三声钟响' } } } },
      ...[0, 1].map(order => ({ type: 'putScene' as const, value: { id: `s${order}`, chapterId, order, title: `场景${order}`, text: '', outline: '林舟追查钟声', povId: 'hero', eventIds: ['ev'] } })),
    ] });
    const writers = new Map<string, Record<string, any>>(), order: string[] = [];
    const h = harness(store, (request, signal, demo) => {
      if (request.agentId === 'writer') {
        const { context } = JSON.parse(String((request.input[0] as { content: string }).content));
        writers.set(context.scene.id, context); order.push(context.scene.id);
        return stream(reply(context.scene.id === 's0' ? '铜钟响了第十三下，林舟攥紧了扳手。' : '他沿着钟楼的台阶往上走。'));
      }
      if (request.agentId !== 'coordinator') return demo.stream(request, signal);
      const node = (id: string, role: PlanNode['role'], patch: Partial<Record<string, string | string[] | null>>) => ({ id, role, objective: '写本章', acceptance: '完成', dependsOn: [],
        sceneId: null, chapterId: null, characterId: null, eventId: null, ...patch });
      return stream(tool('set_plan', { summary: '先代入再写', nodes: [node('p', 'character', { sceneId: 's0', characterId: 'hero', eventId: 'ev' }),
        node('w1', 'writer', { sceneId: 's1' }), node('w0', 'writer', { sceneId: 's0', dependsOn: ['p'] })] }));
    });
    const run = h.start({ projectId: project.id, stage: 'chapter', chapterId, objective: '写完本章' });
    const pending = await wait(store, run);
    assert.equal(pending.status, 'awaitingApproval', pending.error ?? pending.runtime?.pauseReason ?? '');
    assert.deepEqual(order, ['s0', 's1']);
    const native = (store.getAgentState(run.id)!.checkpoints.coordinator as AgentCheckpoint).input;
    const planned = JSON.parse(String((native.find(item => item.type === 'function_call_output') as { output: string }).output)) as { nodes: PlanNode[]; notice: string };
    assert.deepEqual(planned.nodes.find(node => node.id === 'w1')!.dependsOn, ['w0']); assert.match(planned.notice, /按阅读顺序串联/);
    const first = writers.get('s0')!, second = writers.get('s1')!;
    const perspective = first.upstream.results.find((item: UpstreamResult) => item.role === 'character');
    assert.ok(perspective?.result.conclusion.perspective, '角色代入结论进入写作上下文');
    assert.ok(second.recentText.some((item: { text: string }) => item.text.includes('铜钟响了第十三下')), '后一场读到前一场新写的正文');
    assert.ok(second.upstream.results.some((item: UpstreamResult) => item.nodeId === 'w0' && (item.result as { changesInWorkspace?: boolean }).changesInWorkspace));
    assert.equal(store.getProject(project.id).scenes.find(scene => scene.id === 's0')!.text, '', '正式作品零写入');
  } finally { store.close(); }
});

test('部分节点失败后协调者只用文字作答：已完成部分照常组成候选送作者批准，未完成的节点记在总结之后', { timeout: 20000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = scenes(store, ['人工正文']), coordinator: ModelRequest[] = [];
    const h = harness(store, (request, signal, demo) => {
      if (request.agentId === 'planner') {
        const { objective } = JSON.parse(String((request.input[0] as { content: string }).content));
        return stream(objective === '许砚' ? addsCharacter : rewritesProse(project));
      }
      if (request.agentId !== 'coordinator') return demo.stream(request, signal);
      coordinator.push(request);
      const node = (id: string, objective: string) => ({ id, role: 'planner', objective, acceptance: '人物', dependsOn: [], sceneId: null, chapterId: null, characterId: null, eventId: null });
      if (coordinator.length === 1) return stream(tool('set_plan', { summary: '两个人物', nodes: [node('n1', '许砚'), node('n2', '沈照')] }));
      return stream(reply(coordinator.length === 2 ? '沈照没能设计出来，先交许砚。' : '许砚已加入，沈照未完成。'));
    });
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '设计两个人物' });
    const pending = await wait(store, run);
    assert.equal(pending.status, 'awaitingApproval', pending.error ?? pending.runtime?.pauseReason ?? '');
    assert.equal(coordinator.length, 2, '文字作答之后不需要提醒');
    const failure = JSON.parse(String((coordinator[1]!.input.at(-1) as { output: string }).output));
    assert.equal(failure.ok, false); assert.deepEqual(failure.failedNodeIds, ['n2']); assert.equal(failure.artifacts[0].nodeId, 'n1');
    const n2 = pending.runtime!.plan!.nodes.find(node => node.id === 'n2')!;
    assert.equal(n2.status, 'failed'); assert.match(n2.error!, /连续 3 次输出未通过校验/);
    const done = await approve(store, h.scheduler, run);
    assert.equal(done.status, 'completed', done.error ?? done.runtime?.pauseReason ?? '');
    assert.equal(coordinator.length, 3);
    assert.match(done.runtime!.finalSummary!, /^许砚已加入，沈照未完成。\n\n运行时记录：计划节点未完成：n2「沈照」（.*连续 3 次输出未通过校验/);
    assert.ok(store.getProject(project.id).objects.some(object => object.name === '许砚'));
  } finally { store.close(); }
});

test('作者保存的约束进入编排专长的上下文，而不只给协调者和写作者', { timeout: 15000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('约束'), planner: ModelRequest[] = [];
    const h = harness(store, (request, signal, demo) => { if (request.agentId === 'planner') planner.push(request); return demo.stream(request, signal); });
    await h.scheduler.saveMemory(project.id, '全书不出现穿越元素', 'constraint');
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '构思小说并编排三幕大纲' });
    assert.equal((await wait(store, run)).status, 'awaitingApproval');
    const { context } = JSON.parse(String((planner[0]!.input[0] as { content: string }).content));
    assert.deepEqual(context.authorRules, [{ kind: 'constraint', content: '全书不出现穿越元素' }]);
  } finally { store.close(); }
});

test('任务日志每轮只增量写入新内容，可还原完整请求；完成的专长检查点只保留完成标记', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'novel-turns-')), filename = join(directory, 'novel.sqlite');
  const store = new NovelStore(filename);
  try {
    const project = scenes(store), h = harness(store);
    const run = h.start({ projectId: project.id, stage: 'chapter', chapterId: project.chapters[0]!.id, objective: '写完本章空白场景' });
    assert.equal((await approve(store, h.scheduler, run)).status, 'completed');
    const state = store.getAgentState(run.id)!, coordinator = state.checkpoints.coordinator as AgentCheckpoint;
    const db = new DatabaseSync(filename, { readOnly: true });
    const turns = db.prepare('SELECT turn, request FROM agent_turns WHERE run_id=? AND step_id=? ORDER BY turn').all(run.id, coordinator.step.id) as Array<{ turn: number; request: string }>;
    db.close();
    assert.equal(turns.length, 2, '规划一轮，作者决定后总结一轮');
    // The runtime's own steps are not model requests; they reach the log inside the next request's increment.
    assert.ok((JSON.parse(turns[1]!.request) as { input: Array<{ call_id?: string }> }).input.some(item => item.call_id?.startsWith('runtime-')));
    let input: unknown[] = [];
    for (const { turn, request } of turns) {
      const value = JSON.parse(request) as { instructions?: string; from?: number; input: unknown[] };
      if (turn === 0) { assert.ok(value.instructions); assert.equal(value.from, undefined); input = value.input; continue; }
      assert.equal(value.instructions, undefined); assert.equal(value.from, input.length, `第 ${turn} 轮从上一轮请求末尾接续`);
      input = [...input, ...value.input];
    }
    assert.deepEqual(input, JSON.parse(JSON.stringify(coordinator.input.slice(0, input.length))));
    const specialists = Object.entries(state.checkpoints).filter(([slot]) => slot !== 'coordinator') as Array<[string, AgentCheckpoint]>;
    assert.ok(specialists.length >= 2);
    for (const [slot, checkpoint] of specialists) {
      assert.equal(checkpoint.phase, 'completed', slot); assert.deepEqual(checkpoint.input, [], slot);
      assert.ok(state.artifacts.some(artifact => artifact.stepId === checkpoint.step.id), `${slot} 的结果保存在产物中`);
    }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('已结束任务的快照按保留数清理；对已结束任务暂停、恢复、回答给出原有提示，取消无副作用', { timeout: 30000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = scenes(store, ['人工正文']), h = harness(store), runs: AgentRun[] = [];
    for (let index = 0; index <= KEEP_FINISHED_SNAPSHOTS; index++) {
      const run = h.start({ projectId: project.id, stage: 'agent', objective: '仅分析现有作品的问题，不要改动作品' });
      assert.equal((await wait(store, run)).status, 'completed'); runs.push(run);
    }
    assert.throws(() => store.getAgentState(runs[0]!.id), /已清理/);
    assert.ok(store.getAgentState(runs.at(-1)!.id));
    const oldest = runs[0]!.id;
    await assert.rejects(h.scheduler.pause(oldest), /已经结束/);
    await assert.rejects(h.scheduler.resume(oldest), /不在可恢复状态/);
    await assert.rejects(h.scheduler.answer(oldest, '回答'), /没有等待回答/);
    await h.scheduler.cancel(oldest);
    assert.equal(store.getRun(oldest)!.status, 'completed');
  } finally { store.close(); }
});

test('重开数据库后重发中断的后续轮请求，任务日志写入相同的增量而不冲突', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'novel-replay-')), filename = join(directory, 'novel.sqlite');
  let store = new NovelStore(filename), block = true;
  try {
    const project = store.createProject('重放'), request: RunRequest = { projectId: project.id, stage: 'agent', objective: '只分析作品' };
    const intercept = (input: ModelRequest, signal: AbortSignal, demo: DemoAgentTransport) => {
      const later = input.agentId === 'coordinator' && input.input.some(item => item.type === 'function_call_output');
      if (!later || !block) return demo.stream(input, signal);
      return { events: (async function* () { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); checkCancelled(signal); })(), finalResponse: async () => reply('不应使用') };
    };
    const h = harness(store, intercept), run = h.start(request);
    await until(store, run.id, value => !!value.runtime?.uncertain); await h.scheduler.pause(run.id); await h.scheduler.shutdown();
    store.close(); store = new NovelStore(filename); block = false;
    const demo = new DemoAgentTransport(request, project);
    const second = new NovelAgentScheduler(store, () => provider, () => {}, () => ({ stream: (input, signal) => intercept(input, signal, demo) }));
    second.recover(); await second.resume(run.id, true);
    const completed = await until(store, run.id, value => !!value.finishedAt);
    assert.equal(completed.status, 'completed', completed.error ?? completed.runtime?.pauseReason ?? '');
    const db = new DatabaseSync(filename, { readOnly: true });
    const stepId = (store.getStoredAgentState(run.id)!.checkpoints.coordinator as AgentCheckpoint).step.id;
    const requests = (db.prepare('SELECT request FROM agent_turns WHERE run_id=? AND step_id=? ORDER BY turn').all(run.id, stepId) as Array<{ request: string }>)
      .map(row => JSON.parse(row.request) as { from?: number });
    db.close();
    assert.ok(requests.length > 2); assert.ok(requests.slice(1).every(value => typeof value.from === 'number' && value.from > 0));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

function truncated(text: string, calls: ResponseOutputItem[] = []): ModelResponse {
  const output: ResponseOutputItem[] = text ? [{ type: 'message', id: randomUUID(), role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text, annotations: [] }] }] : [];
  return { id: randomUUID(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [...output, ...calls],
    usage: { input_tokens: 10, output_tokens: 16000, total_tokens: 16010, output_tokens_details: { reasoning_tokens: 9000 } } };
}

test('服务明确拒绝的请求（如限流）暂停但不要求费用确认，直接恢复即重发并完成', { timeout: 10000 }, async () => {
  const store = new NovelStore(':memory:');
  let reject = true;
  try {
    const apiKey = 'sk-test-echoed-credential', project = store.createProject('限流'), h = harness(store, (request, signal, demo) => {
      if (reject && request.agentId === 'coordinator') { reject = false; throw new ModelServiceError(`模型服务出错（已自动重试 4 次）：429 Rate limit reached for ${apiKey}`, 429); }
      return demo.stream(request, signal);
    }, { ...provider, mode: 'live', apiKey });
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '只分析作品' });
    const paused = await wait(store, run);
    assert.equal(paused.status, 'paused'); assert.equal(paused.runtime!.uncertain, false);
    assert.match(paused.runtime!.pauseReason ?? '', /429 Rate limit reached for \[API Key 已隐藏\]。这一轮没有产生结果/);
    assert.ok(!JSON.stringify(h.events).includes(apiKey)); assert.ok(!JSON.stringify(store.getAgentState(run.id)).includes(apiKey));
    await h.scheduler.resume(run.id);
    const completed = await until(store, run.id, value => !!value.finishedAt);
    assert.equal(completed.status, 'completed', completed.error ?? completed.runtime?.pauseReason ?? '');
  } finally { store.close(); }
});

test('专长的结构化输出被截断时要求精简重写；协调者被截断时提醒拆小，紧接着再被截断才暂停', { timeout: 20000 }, async () => {
  let store = new NovelStore(':memory:');
  try {
    const project = scenes(store, ['人工正文']), results: unknown[] = [], planner: ModelRequest[] = [];
    const coordinate = planningCoordinator(results);
    const h = harness(store, request => {
      if (request.agentId !== 'planner') return coordinate(request);
      planner.push(request);
      return stream(planner.length === 1 ? truncated('{"summary":"补人物","opsJson":"[{\\"op') : addsCharacter);
    });
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '补一个人物' });
    assert.equal((await wait(store, run)).status, 'awaitingApproval');
    assert.equal(planner.length, 2);
    assert.equal(planner[1]!.input.length, 2, 'the cut answer is not replayed');
    const repair = planner[1]!.input.at(-1) as { role: string; content: string };
    assert.match(repair.content, /单次上限被截断（本次输出 16000 tokens，其中推理 9000）[\s\S]*更精简/);
    assert.equal(store.getRun(run.id)!.runtime!.plan!.nodes[0]!.status, 'completed');
  } finally { store.close(); }

  for (const cuts of [1, 2]) {
    store = new NovelStore(':memory:');
    try {
      const project = store.createProject('截断'), coordinator: ModelRequest[] = [];
      let left = cuts;
      const h = harness(store, (request, signal, demo) => {
        if (request.agentId === 'coordinator') {
          coordinator.push(request);
          if (left-- > 0) return stream(truncated('', [{ type: 'function_call', id: randomUUID(), call_id: randomUUID(), name: 'save_report', arguments: '{"title":"' }]));
        }
        return demo.stream(request, signal);
      });
      const run = h.start({ projectId: project.id, stage: 'agent', objective: '只分析作品' });
      const reminder = () => coordinator[1]!.input.at(-1) as { role: string; content: string };
      if (cuts === 1) {
        const done = await until(store, run.id, value => !!value.finishedAt);
        assert.equal(done.status, 'completed', done.error ?? done.runtime?.pauseReason ?? '');
        assert.match(reminder().content, /^运行时提醒：模型输出达到单次上限被截断[\s\S]*拆小/);
      } else {
        const paused = await wait(store, run);
        assert.equal(paused.status, 'paused'); assert.equal(coordinator.length, 2);
        assert.match(paused.runtime!.pauseReason ?? '', /单次上限被截断[\s\S]*调高「单次输出上限」/);
        assert.equal(paused.runtime!.uncertain, false);
        await h.scheduler.resume(run.id);
        assert.equal((await until(store, run.id, value => !!value.finishedAt)).status, 'completed');
      }
    } finally { store.close(); }
  }
});

test('写作者正文达到输出上限时自动续写拼接，截断的回答与续写各记一轮日志', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'novel-continue-')), filename = join(directory, 'novel.sqlite');
  const store = new NovelStore(filename);
  try {
    const project = scenes(store, ['']), writer: ModelRequest[] = [], partial = '直到雨停下来的时候，她才推开门。';
    const h = harness(store, (request, signal, demo) => {
      if (request.agentId === 'writer') { writer.push(request); if (writer.length === 1) return stream(truncated(partial)); }
      return demo.stream(request, signal);
    });
    const run = h.start({ projectId: project.id, stage: 'chapter', chapterId: project.chapters[0]!.id, objective: '写完本章空白场景' });
    const pending = await wait(store, run);
    assert.equal(pending.status, 'awaitingApproval', pending.error ?? pending.runtime?.pauseReason ?? '');
    assert.deepEqual(writer[1]!.input.slice(-2), [{ role: 'assistant', content: partial }, { role: 'user', content: CONTINUE_NOTICE }]);
    const step = pending.steps.find(value => value.agentId === 'writer')!;
    assert.equal(step.status, 'completed'); assert.ok(step.output.startsWith(partial) && step.output.length > partial.length);
    const db = new DatabaseSync(filename, { readOnly: true });
    const turns = db.prepare('SELECT turn, request, response FROM agent_turns WHERE run_id=? AND step_id=? ORDER BY turn').all(run.id, step.id) as Array<{ turn: number; request: string; response: string | null }>;
    db.close();
    assert.deepEqual(turns.map(turn => turn.turn), [0, 1]);
    assert.ok(turns.every(turn => turn.response !== null));
    assert.equal((JSON.parse(turns[0]!.response!) as ModelResponse).status, 'incomplete');
    assert.deepEqual(JSON.parse(turns[1]!.request), { from: 1, input: [{ role: 'assistant', content: partial }, { role: 'user', content: CONTINUE_NOTICE }] });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('重新规划时未改动的已完成节点保留结果，只重做失败的节点；finish_run 完成后不再请求协调模型', { timeout: 20000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = scenes(store, ['人工正文']), coordinator: ModelRequest[] = [], planner: string[] = [];
    const node = (id: string, objective: string) => ({ id, role: 'planner', objective, acceptance: '人物', dependsOn: [], sceneId: null, chapterId: null, characterId: null, eventId: null });
    const h = harness(store, (request, signal, demo) => {
      if (request.agentId === 'planner') {
        const { objective } = JSON.parse(String((request.input[0] as { content: string }).content));
        planner.push(objective);
        if (objective === '沈照') return stream(rewritesProse(project));
        return stream(reply({ summary: objective, commandsJson: '[]', opsJson: JSON.stringify([{ op: 'addCharacter', ref: 'c1', title: objective.slice(0, 2) }]) }));
      }
      if (request.agentId !== 'coordinator') return demo.stream(request, signal);
      coordinator.push(request);
      if (coordinator.length === 1) return stream(tool('set_plan', { summary: '两个人物', nodes: [node('n1', '许砚'), node('n2', '沈照')] }));
      if (coordinator.length === 2) return stream(tool('set_plan', { summary: '调整第二个人物', nodes: [node('n1', '许砚'), node('n2', '沈照（只建人物卡）')] }));
      return stream(tool('finish_run', { summary: '两个人物都已建立。', artifactIds: [] }));
    });
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '设计两个人物' });
    const pending = await wait(store, run);
    assert.equal(pending.status, 'awaitingApproval', pending.error ?? pending.runtime?.pauseReason ?? '');
    assert.equal(planner.filter(objective => objective === '许砚').length, 1, '未改动的节点没有重做');
    assert.equal(planner.filter(objective => objective === '沈照').length, MAX_OUTPUT_REPAIRS + 1);
    const native = (store.getAgentState(run.id)!.checkpoints.coordinator as AgentCheckpoint).input;
    const plans = native.filter(item => item.type === 'function_call_output').map(item => JSON.parse(String((item as { output: string }).output)))
      .filter((output: { notice?: string }) => output.notice?.startsWith('计划已保存'));
    assert.match(plans[1].notice, /沿用上一版计划中已完成节点的结果：n1/);
    assert.equal(pending.runtime!.budget.replans, 1);
    const done = await approve(store, h.scheduler, run);
    assert.equal(done.status, 'completed', done.error ?? done.runtime?.pauseReason ?? '');
    assert.equal(coordinator.length, 3, 'finish_run 之后不再请求');
    assert.equal(done.runtime!.finalSummary, '两个人物都已建立。');
    assert.deepEqual(store.getProject(project.id).objects.filter(object => object.typeId === 'character').map(object => object.name).sort(), ['沈照', '许砚'].sort());
  } finally { store.close(); }
});

test('finish_run 可以在节点失败后结束任务，运行时把未完成的节点记在总结之后', { timeout: 15000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = scenes(store, ['人工正文']);
    const node = (id: string, role: string, objective: string) => ({ id, role, objective, acceptance: '完成', dependsOn: [], sceneId: null, chapterId: null, characterId: null, eventId: null });
    let turn = 0;
    const h = harness(store, (request, signal, demo) => {
      if (request.agentId === 'planner') return stream(rewritesProse(project));
      if (request.agentId !== 'coordinator') return demo.stream(request, signal);
      turn++;
      if (turn === 1) return stream(tool('set_plan', { summary: '分析并补人物', nodes: [node('check', 'continuity', '检查作品'), node('cast', 'planner', '补一个人物')] }));
      return stream(tool('finish_run', { summary: '分析已完成，人物没有补上。', artifactIds: [] }));
    });
    const done = await wait(store, h.start({ projectId: project.id, stage: 'agent', objective: '分析作品并补一个人物' }));
    assert.equal(done.status, 'completed', done.error ?? done.runtime?.pauseReason ?? '');
    assert.equal(turn, 2);
    assert.match(done.runtime!.finalSummary!, /^分析已完成，人物没有补上。\n\n运行时记录：计划节点未完成：cast「补一个人物」（/);
    assert.equal(done.runtime!.candidates.length, 0);
  } finally { store.close(); }
});

test('协调者直接作答即完成任务并保存为答复；空回答只提醒一次', { timeout: 15000 }, async () => {
  for (const first of ['这部作品目前只有一章，节奏偏慢。', '']) {
    const store = new NovelStore(':memory:');
    try {
      const project = scenes(store, ['人工正文']), coordinator: ModelRequest[] = [];
      const h = harness(store, request => {
        coordinator.push(request);
        return stream(reply(coordinator.length === 1 ? first : '补充：第一章的冲突出现得太晚。'));
      });
      const done = await wait(store, h.start({ projectId: project.id, stage: 'agent', objective: '这部作品现在有什么问题？' }));
      assert.equal(done.status, 'completed', done.error ?? done.runtime?.pauseReason ?? '');
      assert.equal(coordinator.length, first ? 1 : 2);
      if (!first) assert.match(String((coordinator[1]!.input.at(-1) as { content: string }).content), /^运行时提醒：请用 finish_run/);
      const answer = first || '补充：第一章的冲突出现得太晚。';
      assert.equal(done.runtime!.finalSummary, answer);
      assert.deepEqual(done.runtime!.artifacts.map(artifact => [artifact.label, artifact.text]), [['协调者答复', answer]]);
    } finally { store.close(); }
  }
});

test('运行时不重复已失败的步骤：作者中途修改作品使候选无法组成，协调者作答后任务结束并记下未提交的产物', { timeout: 15000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = scenes(store, ['人工正文']), coordinator: ModelRequest[] = [];
    const h = harness(store, (request, signal, demo) => {
      if (request.agentId === 'planner') {
        store.execute({ projectId: project.id, expectedRevision: store.getProject(project.id).revision, actor: 'human',
          commands: [{ type: 'putCard', value: { id: 'human-note', kind: 'note', title: '作者便笺', content: '任务进行中的人工修改', x: 0, y: 0 } }] });
        return stream(addsCharacter);
      }
      if (request.agentId !== 'coordinator') return demo.stream(request, signal);
      coordinator.push(request);
      if (coordinator.length === 1) return stream(tool('set_plan', { summary: '补人物', nodes: [{ id: 'n1', role: 'planner', objective: '补一个人物', acceptance: '人物', dependsOn: [],
        sceneId: null, chapterId: null, characterId: null, eventId: null }] }));
      return stream(reply('作品在任务进行中被修改，候选没有组成，请重新发起。'));
    });
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '补一个人物' });
    const done = await until(store, run.id, value => !!value.finishedAt || value.status === 'paused');
    assert.equal(done.status, 'completed', done.error ?? done.runtime?.pauseReason ?? '');
    assert.equal(coordinator.length, 2);
    const tools = done.steps.find(step => step.agentId === 'coordinator')!.tools.map(activity => activity.name);
    assert.deepEqual(tools, ['set_plan', 'delegate_tasks', 'propose_changes'], '失败的 propose_changes 不再重试');
    assert.match(done.runtime!.finalSummary!, /运行时记录：尚未组成候选的修改产物：/);
  } finally { store.close(); }
});
