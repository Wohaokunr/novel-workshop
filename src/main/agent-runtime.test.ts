import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { ResponseOutputItem } from 'openai/resources/responses/responses';
import type { AgentEvent, AgentRun, ProviderSecret, RunRequest } from '../shared/types.js';
import { NovelStore } from './store.js';
import { NovelAgentScheduler } from './agents.js';
import { DemoAgentTransport } from './agent/demo.js';
import { checkCancelled, type ModelRequest, type ModelResponse, type ResponseTransport } from './responses.js';
import type { AgentCheckpoint } from './responses.js';

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

test('协调者制定计划后只回文字也会被提醒继续执行；人物塑造用故事操作落到画布并免审批准', { timeout: 15000 }, async () => {
  const store = new NovelStore(':memory:');
  try {
    const project = store.createProject('人物');
    let stopped = false;
    const h = harness(store, (request, signal, demo) => {
      const calls = request.input.filter(item => item.type === 'function_call') as Array<{ name: string }>;
      if (request.agentId === 'coordinator' && !stopped && request.input.at(-1)?.type === 'function_call_output' && calls.at(-1)?.name === 'set_plan') {
        stopped = true;
        return stream(reply('计划已经制定好了。'));
      }
      return demo.stream(request, signal);
    });
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '为作品设计人物阵容' });
    const pending = await wait(store, run);
    assert.ok(stopped);
    assert.equal(pending.status, 'awaitingApproval', pending.error ?? pending.runtime?.pauseReason ?? '');
    assert.ok(h.requests.some(request => request.agentId === 'coordinator' && JSON.stringify(request.input).includes('运行时提醒')));
    assert.ok(!h.requests.some(request => request.agentId === 'continuity'), '人物候选不经审查');
    const completed = await approve(store, h.scheduler, run);
    assert.equal(completed.status, 'completed', completed.error ?? completed.runtime?.pauseReason ?? '');
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
      const output = request.input.filter(item => item.type === 'function_call_output').at(-1) as { output: string };
      const result = JSON.parse(output.output);
      if (step === 3) { assert.equal(result.nextAction, 'commit_candidate'); return stream(tool('commit_candidate', { candidateId: result.candidateId, candidateHash: result.candidateHash })); }
      if (result.completed) return stream(reply('已完成。'));
      return stream(tool('finish_run', { summary: '已建立人物。', artifactIds: [] }));
    });
    const run = h.start({ projectId: project.id, stage: 'agent', objective: '建立主角' });
    const asking = await wait(store, run);
    assert.equal(asking.status, 'awaitingInput');
    assert.deepEqual(asking.runtime!.waiting!.options, ['学徒', '守钟人']);
    await h.scheduler.answer(run.id, '学徒');
    const completed = await approve(store, h.scheduler, run);
    assert.equal(completed.status, 'completed', completed.error ?? completed.runtime?.pauseReason ?? '');
    const current = store.getProject(project.id);
    assert.equal(current.objects[0]!.name, '林舟');
    assert.equal(current.cards.length, 2);
    assert.equal(current.canvasLinks.length, 1);
  } finally { store.close(); }
});
