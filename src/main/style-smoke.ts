import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserWindow } from 'electron';
import type { NovelStore } from './store.js';
import type { AgentRun } from '../shared/types.js';
import { styleProfile } from '../shared/style-types.js';

const OWN = '雨下得很大。林舟没有撑伞。他站在桥头，数着过去的车。第七辆是白色的。他没动。车停了，又开走了。他把手插进口袋，摸到那枚铜片。还在。'.repeat(3);

/** Desktop acceptance for the 文风 page: samples, distill, dials, blind test, style review, edit learning, pin from the writer. */
export async function runStyleSmoke(window: BrowserWindow, store: NovelStore) {
  const output = process.env.NOVEL_SMOKE_OUTPUT!; mkdirSync(output, { recursive: true });
  const errors: string[] = [];
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  const ui = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const el = (name: string) => `document.querySelector('[data-testid="${name}"]')`;
  async function until<T>(check: () => Promise<T> | T, label: string): Promise<NonNullable<T>> {
    for (let i = 0; i < 200; i++) { const result = await check(); if (result) return result as NonNullable<T>; await delay(75); }
    throw new Error(`文风桌面验收超时：${label}`);
  }
  async function click(name: string) {
    await until(() => ui<boolean>(`!!(${el(name)}) && !(${el(name)}).disabled`), `${name} 可用`);
    await ui(`${el(name)}.click()`); await delay(120);
  }
  const setValue = (selector: string, value: string) => ui(`(() => { const e=document.querySelector(${JSON.stringify(selector)});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const idle = () => until(() => ui<boolean>(`(() => { const t=document.querySelector('.companion-popover [data-testid="companion-thread"]');return !!t && t.dataset.status==='idle'; })()`), '伙伴回复完成');
  const closePopover = async () => { await ui(`document.querySelector('.companion-popover [aria-label="关闭创作伙伴"]')?.click()`); await until(() => ui<boolean>(`!document.querySelector('.companion-popover')`), '关闭伙伴'); };
  async function capture(name: string) {
    await delay(150);
    if (window.webContents.isOffscreen()) await new Promise<void>(resolve => { window.webContents.once('paint', () => resolve()); window.webContents.invalidate(); });
    writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG());
  }
  async function closed() {
    const done = new Promise<void>(resolve => window.once('closed', () => resolve()));
    window.close(); await Promise.race([done, delay(10000).then(() => { throw new Error('保存关闭握手超时'); })]);
  }
  const style = (id: string) => styleProfile(store.getProject(id));
  const run = (id: string) => until(() => { const value = store.getRun(id); return value && ['awaitingApproval', 'failed', 'completed', 'paused', 'awaitingInput'].includes(value.status) ? value : undefined; }, '正文任务等待审批');
  await until(() => ui<boolean>(`!!document.querySelector('.app') && !document.body.textContent.includes('正在打开作品')`), '工作台启动');
  const reportPath = join(output, 'style-result.json');

  if (process.env.NOVEL_SMOKE_REOPEN) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { projectId: string; summary: string; samples: number };
    await until(() => ui<boolean>(`document.querySelector('.project-switch')?.value === ${JSON.stringify(report.projectId)}`), '重开作品');
    assert.equal(style(report.projectId).summary, report.summary, '文风画像持久保存');
    await click('nav-style');
    await until(() => ui<number>(`document.querySelectorAll('[data-testid="style-sample"]').length`).then(count => count === report.samples), '重开后范文库');
    assert.deepEqual(errors, []);
    await closed(); return;
  }

  // 1. A paragraph pasted while creating the work becomes the first own sample.
  await click('open-create-project'); await setValue('[data-testid="project-title-input"]', '文风验收');
  await setValue('[data-testid="project-sample-input"]', OWN); await click('create-project');
  await until(() => ui<boolean>(`!document.querySelector('dialog[open]')`), '创建作品');
  const project = store.listProjects()[0]!;
  await until(() => style(project.id).samples.length === 1, '新建作品带入范文');
  assert.equal(style(project.id).samples[0]!.source, 'own');
  await until(() => ui<boolean>(`!!(${el('home-style')})`), '概览文风卡片');

  // 2. The 文风 page: add a reference sample by hand.
  await click('nav-style');
  await until(() => ui<boolean>(`document.querySelector('.app').classList.contains('view-style')`), '进入文风页');
  await click('style-add-sample');
  await setValue('[data-testid="style-sample-label"]', '参考片段');
  await setValue('[data-testid="style-sample-text"]', '远处的钟声一下一下地敲，像有人在数她欠下的日子。');
  await ui(`[...document.querySelectorAll('[role="group"][aria-label="范文来源"] button')][1].click()`); await delay(80);
  await click('style-save-sample');
  await until(() => style(project.id).samples.length === 2, '添加参考范文');
  assert.ok(style(project.id).samples.some(sample => sample.source === 'reference'));
  assert.ok(await ui<boolean>(`!!(${el('style-fingerprint')})`), '指纹对比表');

  // 3. Distill from samples: one click adopts the profile, undoable like every adoption.
  await click('style-distill'); await idle();
  await click('adopt-proposal');
  await until(() => style(project.id).summary.trim() && style(project.id).dials.sentence, '采纳文风画像');
  await closePopover();
  await capture('style-01-profile.png');

  // 4. A dial is one click; clicking it again clears it.
  await ui(`document.querySelectorAll('[data-testid="style-dial-pace"] [role="radio"]')[1].click()`);
  await until(() => style(project.id).dials.pace === 2, '拨动节奏旋钮');

  // 5. Blind test: passages arrive unlabelled and reveal their dials once chosen.
  await click('style-blindtest'); await idle();
  assert.equal(await ui<number>(`document.querySelectorAll('.companion-popover .blind-test').length`), 3, '三个盲测版本');
  assert.equal(await ui<number>(`document.querySelectorAll('.companion-popover .blind-test .op-tree').length`), 0, '选中前不显示笔调');
  await ui(`document.querySelector('.companion-popover .blind-test [data-testid="adopt-proposal"]').click()`);
  await until(() => style(project.id).rules.some(rule => rule.origin === 'blindtest'), '采纳盲测版本');
  await until(() => ui<number>(`document.querySelectorAll('.companion-popover .blind-test .op-tree').length`).then(count => count === 1), '选中后揭晓');
  await closePopover();

  // 6. Word lists.
  await setValue('[data-testid="style-avoid-input"]', '不禁、缓缓地');
  await ui(`${el('style-avoid-input')}.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await until(() => style(project.id).avoidWords.includes('缓缓地'), '添加禁用词');

  // 7. Prose candidates get a style review; a rejection reason is kept for learning.
  const chapterId = store.getProject(project.id).chapters[0]!.id;
  store.execute({ projectId: project.id, actor: 'human', commands: [{ type: 'putScene', value: { id: 'style-scene', title: '桥头', povId: null, eventIds: [], outline: '林舟在桥头等一辆白色的车' } },
    { type: 'putPassage', value: { id: 'style-scene', sceneId: 'style-scene', chapterId, order: 1, text: '' } }] });
  const request = { projectId: project.id, stage: 'chapter' as const, objective: '写这一场', passageId: 'style-scene', chapterId };
  const first = await ui<AgentRun>(`window.novel.startRun(${JSON.stringify(request)})`);
  const pending = await run(first.id);
  assert.equal(pending.status, 'awaitingApproval', pending.error ?? pending.runtime?.pauseReason ?? '');
  const candidate = pending.runtime!.candidates.find(item => item.status === 'awaitingApproval')!;
  assert.ok(candidate.reviews.some(review => review.role === 'style'), '正文候选带文风审阅');
  await ui(`window.novel.decideCandidate(${JSON.stringify({ runId: first.id, candidateId: candidate.id, candidateHash: candidate.hash, approve: false, reason: '句子太长，形容词太多' })})`);
  await until(() => store.getRun(first.id)?.finishedAt, '拒稿后任务结束');

  // 8. Approve a draft, edit it by hand, then learn from the edit.
  const second = await ui<AgentRun>(`window.novel.startRun(${JSON.stringify(request)})`);
  const ready = await run(second.id);
  const draft = ready.runtime!.candidates.find(item => item.status === 'awaitingApproval')!;
  await ui(`window.novel.decideCandidate(${JSON.stringify({ runId: second.id, candidateId: draft.id, candidateHash: draft.hash, approve: true })})`);
  await until(() => store.getProject(project.id).passages.find(passage => passage.id === 'style-scene')?.text.trim(), '批准后写入正文');
  const passage = store.getProject(project.id).passages.find(item => item.id === 'style-scene')!;
  store.execute({ projectId: project.id, actor: 'human', commands: [{ type: 'putPassage', value: { ...passage, text: `${passage.text.slice(0, Math.floor(passage.text.length / 2))}他没动。` } }] });
  await click('nav-home'); await click('nav-style');
  await click('style-learn');
  await until(() => ui<number>(`document.querySelectorAll('[data-testid="style-suggestion"]').length`), '学到的偏好');
  assert.ok(style(project.id).suggestions.some(item => item.origin === 'rejection'), '拒稿理由成为建议');
  const rules = style(project.id).rules.length;
  await click('style-adopt-suggestion');
  await until(() => style(project.id).rules.length + style(project.id).avoidWords.length > rules + 2, '采纳建议');
  await capture('style-02-learned.png');

  // 9. In the writer, a selection becomes a sample; the style check runs locally.
  await click('nav-write');
  await until(() => ui<boolean>(`!!(${el('prose-editor')})`), '正文编辑器');
  await ui(`(() => { const e=${el('prose-editor')}; e.focus(); e.setSelectionRange(0, 8); e.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); })()`);
  const samples = style(project.id).samples.length;
  await click('pin-style-sample');
  await until(() => style(project.id).samples.length === samples + 1, '设为范文');
  await ui(`document.querySelector('[aria-label="更多场景操作"]').click()`); await delay(120);
  await click('style-check');
  await until(() => ui<boolean>(`!!(${el('style-check-result')})`), '文风体检');
  await capture('style-03-check.png');
  await ui(`document.querySelector('dialog[open] .button-row .primary')?.click()`);

  assert.deepEqual(errors, []);
  const final = style(project.id);
  writeFileSync(reportPath, JSON.stringify({ projectId: project.id, summary: final.summary, samples: final.samples.length, rules: final.rules.length, suggestions: final.suggestions.length, consoleErrors: errors }, null, 2));
  await closed();
}
