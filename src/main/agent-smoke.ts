import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserWindow } from 'electron';
import type { AgentRun } from '../shared/types.js';
import type { NovelStore } from './store.js';
import { hasSemanticChanges } from './domain.js';

export async function runAgentSmoke(window: BrowserWindow, store: NovelStore) {
  const output = process.env.NOVEL_SMOKE_OUTPUT!; mkdirSync(output, { recursive: true });
  const errors: string[] = [];
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  const ui = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const el = (name: string) => `document.querySelector('[data-testid="${name}"]')`;
  async function until<T>(check: () => Promise<T> | T, label: string): Promise<NonNullable<T>> {
    for (let i = 0; i < 200; i++) { const result = await check(); if (result) return result as NonNullable<T>; await delay(75); }
    throw new Error(`智能体桌面验收超时：${label}`);
  }
  async function click(name: string) {
    await until(() => ui<boolean>(`!!(${el(name)}) && !(${el(name)}).disabled`), `${name} 可用`);
    await ui(`${el(name)}.click()`); await delay(100);
  }
  async function fill(name: string, value: string) {
    await until(() => ui<boolean>(`!!(${el(name)})`), name);
    await ui(`(() => { const e=${el(name)};const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await delay(60);
  }
  async function capture(name: string) {
    await delay(120);
    if (window.webContents.isOffscreen()) await new Promise<void>(resolve => { window.webContents.once('paint', () => resolve()); window.webContents.invalidate(); });
    writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG());
  }
  async function closed() {
    const done = new Promise<void>(resolve => window.once('closed', () => resolve()));
    window.close(); await Promise.race([done, delay(10000).then(() => { throw new Error('保存关闭握手超时'); })]);
  }
  await until(() => ui<boolean>(`!!document.querySelector('.app') && !document.body.textContent.includes('正在打开作品')`), '工作台启动');
  const reportPath = join(output, 'agent-result.json');
  if (!process.env.NOVEL_SMOKE_REOPEN) {
    await click('open-create-project'); await fill('project-title-input', '智能体目标闭环验收'); await click('create-project');
    await until(() => ui<boolean>(`!document.querySelector('dialog[open]')`), '创建作品');
    const project = store.listProjects()[0]!, base = store.getProject(project.id);
    await click('toggle-assistant'); await fill('ai-objective', '构思小说并编排三幕大纲，保留信息边界，先形成可供审阅的候选。'); await click('run-agent');
    const run = await until(() => store.getRuns(project.id).find(run => run.status === 'awaitingApproval' || run.status === 'failed' || run.status === 'paused'), '目标生成候选');
    assert.equal(run.status, 'awaitingApproval', run.error ?? run.runtime?.pauseReason ?? '');
    assert.deepEqual(store.getProject(project.id), base); assert.equal(store.history(project.id).length, 0);
    await click('review-current-candidate'); await until(() => ui<boolean>(`!!(${el('agent-plan')}) && !!(${el('approve-candidate')})`), '候选及审查界面');
    await ui(`${el('candidate-diff')}.open=true;document.querySelector('.agent-change').open=true`);
    const styles = await ui<{ overflow: boolean; proseFamily: string; previewBorder: string }>(`(() => { const t=${el('agent-task')};const p=${el('candidate-after')};return {overflow:document.documentElement.scrollWidth>innerWidth,proseFamily:getComputedStyle(p).fontFamily,previewBorder:getComputedStyle(t).borderColor}; })()`);
    assert.equal(styles.overflow, false);
    await capture('agent-01-candidate.png');
    await click('pause-run');
    await until(() => store.getRun(run.id)?.status === 'paused', '暂停到持久检查点');
    await until(() => ui<boolean>(`!!(${el('resume-run')})`), '恢复操作可见');
    await capture('agent-02-paused.png');
    const saved = store.getRun(run.id)!;
    assert.equal(saved.runtime?.waiting?.kind, 'approval'); assert.equal(saved.runtime?.uncertain, false);
    const candidate = saved.runtime!.candidates.at(-1)!;
    writeFileSync(reportPath, JSON.stringify({ projectId: project.id, runId: run.id, candidateId: candidate.id, candidateHash: candidate.hash,
      base, modelCallsBeforeReopen: saved.runtime!.budget.modelCalls, checks: { planAndRealTools: saved.steps.some(step => step.tools.some(tool => tool.name === 'delegate_tasks')), formalUnchangedBeforeApproval: true, pausedWithPendingCall: true }, styles, consoleErrors: errors, callsRealModel: false }, null, 2));
    assert.deepEqual(errors, []); await closed(); return;
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const projectId: string = report.projectId, runId: string = report.runId;
  await until(() => ui<boolean>(`document.querySelector('.project-switch')?.value === ${JSON.stringify(projectId)}`), '重开作品');
  const reopened = store.getRun(runId)!;
  assert.equal(reopened.status, 'paused'); assert.equal(reopened.runtime!.budget.modelCalls, report.modelCallsBeforeReopen);
  assert.deepEqual(store.getProject(projectId), report.base); assert.equal(store.history(projectId).length, 0);
  await click('nav-monitor'); await click('resume-run');
  await until(() => store.getRun(runId)?.status === 'awaitingApproval', '恢复原待审批调用');
  assert.equal(store.getRun(runId)!.runtime!.budget.modelCalls, report.modelCallsBeforeReopen, '恢复待审批不重新调用模型');
  await click('approve-candidate');
  const completed = await until(() => { const run = store.getRun(runId); return run?.finishedAt ? run : null; }, '批准后完成目标');
  assert.equal(completed.status, 'completed', completed.error ?? completed.runtime?.pauseReason ?? '');
  assert.equal(store.history(projectId).filter(batch => batch.taskId === runId).length, 1);
  assert.equal(store.getProject(projectId).scenes.length, 3);
  await until(() => ui<boolean>(`document.body.textContent.includes('已批准并写入') && document.body.textContent.includes('任务总结')`), '真实保存结果展示');
  await capture('agent-03-approved.png');
  await click('toggle-assistant');
  await click('ai-tab-memory'); await fill('memory-preference', '对白克制，不提前解释尚未揭露的秘密。'); await click('save-memory');
  await until(() => store.getAgentMemories(projectId).some(memory => memory.kind === 'preference' && memory.confirmed), '项目作者偏好真实持久化');
  const memories = store.getAgentMemories(projectId);
  await click('toggle-assistant'); await click('undo-task');
  await until(() => store.history(projectId).find(batch => batch.taskId === runId)?.undone, '撤销批准批次');
  assert.equal(hasSemanticChanges(report.base, store.getProject(projectId)), false);
  await click('toggle-assistant'); await fill('ai-objective', '重新构思小说并编排三幕候选，仍需作者审批。'); await click('run-agent');
  const refused = await until(() => store.getRuns(projectId).find(run => run.id !== runId && ['awaitingApproval', 'failed', 'paused'].includes(run.status)), '第二候选');
  assert.equal(refused.status, 'awaitingApproval', refused.error ?? refused.runtime?.pauseReason ?? '');
  await click('review-current-candidate'); await click('reject-candidate'); await fill('candidate-reject-reason', '暂时保留原构思，不将此次候选写入作品。'); await click('submit-reject-candidate');
  const rejection = await until(() => { const run = store.getRun(refused.id); return run?.finishedAt ? run : null; }, '拒绝后真实收尾');
  assert.equal(rejection.status, 'completed'); assert.equal(hasSemanticChanges(report.base, store.getProject(projectId)), false);
  assert.equal(store.history(projectId).length, 1); assert.ok(store.history(projectId)[0]!.undone);
  await until(() => ui<boolean>(`document.body.textContent.includes('已拒绝')`), '拒绝候选展示'); await capture('agent-04-rejected.png');
  window.setMinimumSize(375, 600); window.setSize(375, 812); await delay(250);
  const mobileOverflow = await ui<boolean>(`document.documentElement.scrollWidth>innerWidth`); assert.equal(mobileOverflow, false);
  await capture('agent-05-narrow.png'); window.setSize(1510, 980); window.setMinimumSize(1080, 720);
  assert.deepEqual(errors, []);
  writeFileSync(reportPath, JSON.stringify({ ...report, base: undefined, reopened: true, completedStatus: completed.status, approvedRevision: completed.runtime!.candidates.at(-1)!.appliedRevision,
    checks: { ...report.checks, noAutomaticCallsOnReopen: true, resumedOriginalApproval: true, oneAtomicOperation: true, explicitMemoryPersisted: memories.some(memory => memory.kind === 'preference'), taskUndoVerified: true, rejectionPreservedFormal: true, narrowLayout: !mobileOverflow },
    consoleErrors: errors, callsRealModel: false, snapshots: ['agent-01-candidate.png', 'agent-02-paused.png', 'agent-03-approved.png', 'agent-04-rejected.png', 'agent-05-narrow.png'] }, null, 2));
  // Smoke mode keeps the app alive when windows close; finish the save handshake explicitly so the process exits.
  await closed();
}
