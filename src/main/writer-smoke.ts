import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserWindow } from 'electron';
import type { NovelStore } from './store.js';

/** Desktop acceptance for writing from the writer page: one click writes the empty scene, 续写 continues at the cursor, the prose
 * streams in place, and nothing reaches the scene before the author approves. */
export async function runWriterSmoke(window: BrowserWindow, store: NovelStore) {
  const output = process.env.NOVEL_SMOKE_OUTPUT!; mkdirSync(output, { recursive: true });
  const errors: string[] = [];
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  const ui = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const el = (name: string) => `document.querySelector('[data-testid="${name}"]')`;
  async function until<T>(check: () => Promise<T> | T, label: string): Promise<NonNullable<T>> {
    for (let i = 0; i < 300; i++) { const result = await check(); if (result) return result as NonNullable<T>; await delay(50); }
    throw new Error(`写作页桌面验收超时：${label}`);
  }
  async function click(name: string) {
    await until(() => ui<boolean>(`!!(${el(name)}) && !(${el(name)}).disabled`), `${name} 可用`);
    await ui(`${el(name)}.click()`); await delay(100);
  }
  async function capture(name: string) {
    if (window.webContents.isOffscreen()) await new Promise<void>(resolve => { window.webContents.once('paint', () => resolve()); window.webContents.invalidate(); });
    writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG());
  }
  async function closed() {
    const done = new Promise<void>(resolve => window.once('closed', () => resolve()));
    window.close(); await Promise.race([done, delay(10000).then(() => { throw new Error('保存关闭握手超时'); })]);
  }
  const settled = (projectId: string, runs: number) => until(() => {
    const all = store.getRuns(projectId);
    return all.length >= runs && all.every(run => ['completed', 'failed', 'cancelled'].includes(run.status)) ? all : undefined;
  }, '任务结束');
  await until(() => ui<boolean>(`!!document.querySelector('.app') && !document.body.textContent.includes('正在打开作品')`), '工作台启动');
  const reportPath = join(output, 'writer-result.json');
  if (process.env.NOVEL_SMOKE_REOPEN) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { projectId: string; text: string };
    await until(() => store.getProject(report.projectId).scenes[0]?.text === report.text, '重开后正文保留');
    assert.deepEqual(errors, []);
    await closed(); return;
  }

  await click('open-create-project');
  await ui(`(() => { const e=${el('project-title-input')};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'写作页验收');e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await click('create-project');
  await until(() => ui<boolean>(`!document.querySelector('dialog[open]')`), '创建作品');
  const project = store.listProjects()[0]!;
  await click('nav-write');
  await until(() => ui<boolean>(`!!document.querySelector('.add-scene')`), '添加场景按钮');
  await ui(`document.querySelector('.add-scene').click()`);
  await until(() => store.getProject(project.id).scenes.length === 1, '新建场景');

  // One click: no task form, the prose streams above the editor, the scene stays empty until approval.
  await click('prepare-chapter');
  const streaming = `(() => { const e=document.querySelector('.live-draft-text'); return !!e && !e.querySelector('.live-draft-wait') && e.textContent.length > 30; })()`;
  await until(() => ui<boolean>(streaming), '生成过程显示在编辑区');
  assert.equal(store.getProject(project.id).scenes[0]!.text, '', '批准前不写入');
  await capture('writer-01-live-draft.png');
  await click('approve-candidate');
  await settled(project.id, 1);
  const first = await until(() => store.getProject(project.id).scenes[0]!.text || undefined, '批准后写入正文');
  const writes = store.getRuns(project.id)[0]!;
  assert.ok(writes.steps.filter(step => step.agentId === 'coordinator').every(step => !step.responseIds.length), '单场景写作不向协调模型发请求');
  await until(() => ui<boolean>(`!(${el('live-draft')})`), '预览在结束后消失');

  // 续写 at the end of the scene: what is written is appended, the existing prose stays untouched.
  await until(() => ui<boolean>(`(${el('prose-editor')})?.value === ${JSON.stringify(first)}`), '编辑器显示新正文');
  await ui(`(() => { const e=${el('prose-editor')}; e.focus(); e.setSelectionRange(e.value.length, e.value.length); e.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true})); })()`);
  await click('continue-writing');
  await until(() => ui<boolean>(`(${el('live-draft')})?.textContent.includes('正在续写')`), '续写预览出现');
  await until(() => ui<boolean>(streaming), '续写过程显示在编辑区');
  await capture('writer-02-continue.png');
  await click('approve-candidate');
  await settled(project.id, 2);
  const text = await until(() => { const value = store.getProject(project.id).scenes[0]!.text; return value.length > first.length ? value : undefined; }, '续写写入');
  assert.ok(text.startsWith(first), '续写保留原有正文');
  assert.equal(store.getRuns(project.id).find(run => run.id !== writes.id)?.selection?.start, first.length, '从光标处续写');
  await capture('writer-03-done.png');

  assert.deepEqual(errors, []);
  writeFileSync(reportPath, JSON.stringify({ projectId: project.id, text, consoleErrors: errors }, null, 2));
  await closed();
}
