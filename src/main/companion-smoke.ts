import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserWindow } from 'electron';
import type { NovelStore } from './store.js';
import { cardRect } from '../shared/canvas.js';
import { orderedPassages } from '../shared/structure.js';
import type { Command, NarrativeScene, Workspace } from '../shared/types.js';

/** A scene read in one chapter: the scene and its one passage, sharing the id. */
function scene(id: string, chapterId: string, order: number, text: string, value: Omit<NarrativeScene, 'id'>): Command[] {
  return [{ type: 'putScene', value: { id, ...value } }, { type: 'putPassage', value: { id, sceneId: id, chapterId, order, text } }];
}
/** The prose of a scene, all its passages in reading order. */
const prose = (workspace: Workspace, sceneId: string) => orderedPassages(workspace).filter(passage => passage.sceneId === sceneId).map(passage => passage.text).join('');

/** Desktop acceptance for the creative partner: every surface summons it, adoption writes undoable AI batches, threads persist. */
export async function runCompanionSmoke(window: BrowserWindow, store: NovelStore) {
  const output = process.env.NOVEL_SMOKE_OUTPUT!; mkdirSync(output, { recursive: true });
  const errors: string[] = [];
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  const ui = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const el = (name: string) => `document.querySelector('[data-testid="${name}"]')`;
  async function until<T>(check: () => Promise<T> | T, label: string): Promise<NonNullable<T>> {
    for (let i = 0; i < 200; i++) { const result = await check(); if (result) return result as NonNullable<T>; await delay(75); }
    throw new Error(`创作伙伴桌面验收超时：${label}`);
  }
  async function click(name: string) {
    await until(() => ui<boolean>(`!!(${el(name)}) && !(${el(name)}).disabled`), `${name} 可用`);
    await ui(`${el(name)}.click()`); await delay(120);
  }
  const clickText = async (selector: string, text: string) => {
    await until(() => ui<boolean>(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(e => e.textContent.includes(${JSON.stringify(text)}) && !e.disabled)`), `${text} 可点击`);
    await ui(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)}) && !e.disabled).click()`); await delay(120);
  };
  const setValue = (selector: string, value: string) => ui(`(() => { const e=document.querySelector(${JSON.stringify(selector)});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`);
  async function contextMenu(selector: string) {
    await until(() => ui<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
    await ui(`(() => { const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:2})); })()`);
    await until(() => ui<boolean>(`!!(${el('board-context-menu')})`), '右键菜单');
  }
  const replies = () => ui<number>(`document.querySelectorAll('.companion-popover [data-testid="companion-reply"]').length`);
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
  async function nav(name: string, view: string) {
    if (!await ui<boolean>(`!!(${el(name)})`)) await click(view === 'story' || view === 'outline' ? 'nav-world' : 'nav-idea');
    await click(name); await until(() => ui<boolean>(`document.querySelector('.app').classList.contains('view-${view}')`), `进入 ${view}`);
  }
  await until(() => ui<boolean>(`!!document.querySelector('.app') && !document.body.textContent.includes('正在打开作品')`), '工作台启动');
  const reportPath = join(output, 'companion-result.json');

  if (process.env.NOVEL_SMOKE_REOPEN) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { projectId: string; threads: number };
    await until(() => ui<boolean>(`document.querySelector('.project-switch')?.value === ${JSON.stringify(report.projectId)}`), '重开作品');
    assert.equal(store.getCompanionThreads(report.projectId).length, report.threads, '对话持久保存');
    await click('toggle-assistant'); await click('ai-tab-chat');
    await until(() => ui<boolean>(`document.querySelectorAll('[data-testid="companion-thread-item"]').length === ${report.threads}`), '重开后对话列表');
    await ui(`document.querySelector('[data-testid="companion-thread-item"]').click()`);
    await until(() => ui<boolean>(`!!document.querySelector('.companion-panel [data-testid="companion-reply"]')`), '重开后继续对话');
    await capture('companion-08-reopened.png');
    assert.deepEqual(errors, []);
    writeFileSync(reportPath, JSON.stringify({ ...report, reopened: true, consoleErrors: errors }, null, 2));
    await closed(); return;
  }

  await click('open-create-project'); await setValue('[data-testid="project-title-input"]', '创作伙伴验收'); await click('create-project');
  await until(() => ui<boolean>(`!document.querySelector('dialog[open]')`), '创建作品');
  const project = store.listProjects()[0]!;
  const chapter = store.getProject(project.id).chapters[0]!;

  // 0. Sparse new work: 推断立意 asks choice questions first, then offers versions that write the theme in one click.
  await click('home-develop-theme');
  await until(() => ui<boolean>(`!!document.querySelector('.companion-popover')`), '立意浮窗'); await idle();
  assert.ok(await ui<number>(`document.querySelectorAll('.companion-popover [data-testid="question-option"]').length`) >= 4, '信息稀少时先给选择题');
  assert.equal(await ui<number>(`document.querySelectorAll('.companion-popover [data-testid="companion-proposal"]').length`), 0, '先问后给');
  await ui(`document.querySelector('.companion-popover [data-testid="question-option"]').click()`); await delay(80);
  await click('answer-questions');
  await until(async () => await replies() === 2, '回答后给出版本'); await idle();
  assert.ok(await ui<number>(`document.querySelectorAll('.companion-popover [data-testid="companion-proposal"]').length`) >= 2, '多个立意版本');
  await capture('companion-00-develop-theme.png');
  await ui(`[...document.querySelectorAll('.companion-popover [data-testid="adopt-proposal"]')].at(-3).click()`);
  await until(() => !!store.getProject(project.id).theme?.trim(), '采纳立意写入作品');
  await until(() => ui<boolean>(`!!document.querySelector('.companion-popover [data-testid="companion-next-step"]')`), '采纳后提示下一步');
  await clickText('.companion-popover .companion-proposal button', '撤销');
  await until(() => !store.getProject(project.id).theme?.trim(), '撤销立意');
  await closePopover();
  // Cast: skip the questions and adopt a version; characters land in the list and on the canvas with links.
  await click('home-develop-cast'); await idle();
  await clickText('.companion-popover .companion-followups .chip', '先直接给我几个版本');
  await until(async () => await replies() === 2, '人物版本'); await idle();
  await ui(`document.querySelector('.companion-popover [data-testid="adopt-proposal"]').click()`);
  const cast = await until(() => { const value = store.getProject(project.id); return value.objects.filter(object => object.typeId === 'character').length === 3 ? value : null; }, '人物写入作品');
  assert.equal(cast.cards.filter(card => card.kind === 'object').length, 3, '人物出现在画布');
  assert.equal(cast.canvasLinks.length, 2, '人物关系连线');
  await capture('companion-00-develop-cast.png');
  await clickText('.companion-popover .companion-proposal button', '撤销');
  await until(() => !store.getProject(project.id).objects.length, '撤销人物');
  await closePopover();
  store.execute({ projectId: project.id, actor: 'human', commands: [
    { type: 'updateNovel', patch: { brief: '雾港的报时钟响了第十三声，修钟学徒与信使必须决定相信谁。', genre: '悬疑 · 奇幻' } },
    { type: 'putObject', value: { id: 'lin', typeId: 'character', name: '林舟', fields: { description: '修钟学徒' } } },
    { type: 'putObject', value: { id: 'shen', typeId: 'character', name: '沈卿', fields: { description: '信使' } } },
    { type: 'putObject', value: { id: 'bell', typeId: 'event', name: '第十三声', fields: {}, event: { worldOrder: 1, timeLabel: '第一夜', thread: '钟楼', participants: ['lin', 'shen'], causes: [], critical: true, observations: {} } } },
    ...scene('scene-a', chapter.id, 1, '雾从门缝里挤进来。', { title: '铜片', povId: 'lin', eventIds: [], outline: '林舟捡到铜片' }),
    ...scene('scene-b', chapter.id, 2, '', { title: '钟声', povId: 'shen', eventIds: ['bell'], outline: '第十三声响起' }),
    ...scene('scene-c', chapter.id, 3, '', { title: '钥匙', povId: 'lin', eventIds: [], outline: '决定是否相信' }),
    { type: 'putCard', value: { id: 'anchor', kind: 'note', title: '第十三声', content: '报时钟多响了一声', x: 200, y: 200 } },
  ] });
  window.webContents.reload();
  await until(() => ui<boolean>(`!!document.querySelector('.app') && document.querySelector('.project-switch')?.value === ${JSON.stringify(project.id)}`), '重新载入作品');

  // 1. Canvas: right-click a card → diverge in a dialog beside the cursor.
  await nav('nav-idea', 'canvas');
  await contextMenu('.react-flow__node[data-id="anchor"]');
  await clickText('[data-testid="companion-menu-item"]', '围绕它发散');
  await until(() => ui<boolean>(`!!document.querySelector('.companion-popover')`), '伙伴浮窗');
  await idle();
  assert.ok(await ui<number>(`document.querySelectorAll('.companion-popover [data-testid="companion-idea"]').length`) >= 4, '至少四个点子');
  const popover = await ui<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>(`(() => { const r=document.querySelector('.companion-popover').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}; })()`);
  assert.ok(popover.left >= 0 && popover.top >= 0 && popover.right <= popover.width && popover.bottom <= popover.height + 1, `浮窗在窗口内 ${JSON.stringify(popover)}`);
  await capture('companion-01-canvas-diverge.png');
  // Socratic answer continues the same thread.
  await setValue('.companion-popover .companion-question input', '他最怕师父知道自己碰过第十三齿。');
  await clickText('.companion-popover .companion-questions > button', '回答并继续');
  await until(async () => await replies() === 2, '第二轮回复'); await idle();
  const threadId = await ui<string>(`document.querySelector('.companion-popover [data-testid="companion-thread"]').dataset.threadId`);
  assert.equal(store.getCompanionThread(project.id, threadId)!.turns.filter(turn => turn.role === 'author').length, 2);
  const cardsBefore = store.getProject(project.id).cards.length;
  await ui(`[...document.querySelectorAll('.companion-popover [data-testid="companion-reply"]')].at(-1).querySelector('[data-testid="adopt-idea"]').click()`);
  await until(() => store.getProject(project.id).cards.length === cardsBefore + 1, '单个点子上画布');
  await click('adopt-ideas-group');
  const adopted = await until(() => { const value = store.getProject(project.id); return value.cards.some(card => card.kind === 'group') ? value : null; }, '其余点子进入新分组');
  assert.ok(adopted.canvasLinks.filter(link => link.source === 'anchor').length >= 4, '点子与锚点连线');
  assert.ok(store.history(project.id).filter(batch => batch.actor === 'ai').length >= 2);
  await capture('companion-02-canvas-adopted.png');
  await clickText('.companion-popover [data-testid="companion-idea"].adopted button', '撤销');
  await until(() => store.getProject(project.id).cards.length < adopted.cards.length, '撤销一次采纳');
  await closePopover();
  // Auto-arrange: one undoable layout batch, and top-level cards no longer overlap.
  const historyBeforeTidy = store.history(project.id).length;
  await click('board-arrange');
  await clickText('.arrange-menu button', '自动整理全部');
  await until(() => store.history(project.id).length > historyBeforeTidy, '自动整理画布保存');
  const tidied = store.getProject(project.id).cards.filter(card => !card.groupId).map(card => cardRect(card));
  for (const a of tidied) for (const b of tidied) if (a !== b) assert.ok(!(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height), '整理后顶层卡片不重叠');
  await delay(500); await capture('companion-02b-canvas-tidied.png');
  // Blank canvas: "在这里发散…" opens an empty dialog at the cursor.
  await ui(`(() => { const e=document.querySelector('.react-flow__pane');const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+r.width-200,clientY:r.top+120,button:2})); })()`);
  await until(() => ui<boolean>(`!!(${el('board-context-menu')})`), '空白处右键');
  await clickText('[data-testid="companion-menu-item"]', '在这里发散');
  await until(() => ui<boolean>(`!!document.querySelector('.companion-popover [data-testid="companion-input"]')`), '空白对话');
  await setValue('.companion-popover [data-testid="companion-input"]', '如果钟楼本身是活的？');
  await click('companion-send'); await idle();
  await closePopover();

  // 2. Outline: choose a template, draft the whole book, adopt part of it.
  await nav('nav-outline', 'outline');
  await setValue('[data-testid="structure-template"]', 'three-act');
  await until(() => store.getProject(project.id).structureTemplate === 'three-act', '选择三幕式');
  await click('outline-full-draft'); await idle();
  await until(() => ui<boolean>(`!!document.querySelector('.companion-popover [data-testid="companion-proposal"]')`), '大纲草案');
  await capture('companion-03-outline-draft.png');
  // Uncheck the last act; its chapters and scenes follow.
  await ui(`(() => { const roots=[...document.querySelectorAll('.companion-popover .op-tree > .op-node > label input')];roots.at(-1).click(); })()`);
  await clickText('.companion-popover [data-testid="adopt-proposal"]', '采纳所选');
  const outlined = await until(() => { const value = store.getProject(project.id); return value.acts?.length === 2 ? value : null; }, '部分采纳两幕');
  assert.ok(outlined.chapters.filter(item => item.actId).length >= 4);
  assert.equal(prose(outlined, 'scene-a'), '雾从门缝里挤进来。', '已有正文不变');
  await closePopover();
  await until(() => ui<boolean>(`document.querySelectorAll('[data-testid="outline-act"]').length === 2`), '大纲树显示两幕');
  await capture('companion-04-outline-tree.png');

  // 3. Narrative order: right-click a scene → restructure with a before/after preview.
  await nav('nav-story', 'story');
  await contextMenu('.react-flow__node[data-id="scene-c"]');
  await clickText('[data-testid="companion-menu-item"]', '换个开篇');
  await idle();
  await until(() => ui<boolean>(`!!document.querySelector('.companion-popover .structure-preview')`), '结构前后对比');
  await capture('companion-05-structure.png');
  await ui(`document.querySelector('.companion-popover [data-testid="adopt-proposal"]').click()`);
  await until(() => { const value = store.getProject(project.id); const first = value.passages.filter(passage => passage.chapterId === chapter.id).sort((a, b) => a.order - b.order)[0]; return first?.sceneId === 'scene-c'; }, '采纳重排');
  assert.equal(prose(store.getProject(project.id), 'scene-a'), '雾从门缝里挤进来。');
  await closePopover();

  // 3b. The diagnosis wants a scene the outline has no chapter for: the proposal opens the chapter itself.
  const chaptersBefore = store.getProject(project.id).chapters.length;
  await contextMenu('.react-flow__node[data-id="scene-c"]');
  await clickText('[data-testid="companion-menu-item"]', '这里之后还能加什么');
  await idle();
  const flashback = `[...document.querySelectorAll('.companion-popover [data-testid="companion-proposal"]')].find(e => e.querySelector('.proposal-title strong')?.textContent === '插入一章插叙')`;
  await until(() => ui<boolean>(`!!(${flashback})?.querySelector('.structure-preview')?.textContent.includes('新章')`), '新章出现在前后对比里');
  await ui(`(${flashback}).querySelector('[data-testid="adopt-proposal"]').click()`);
  const opened = await until(() => { const value = store.getProject(project.id); const created = value.chapters.find(item => item.title === '插叙 · 三十年前'); return created && value.passages.some(passage => passage.chapterId === created.id && value.scenes.find(scene => scene.id === passage.sceneId)?.title === '旧案') ? value : null; }, '新章与新场景一起采纳');
  assert.equal(opened.chapters.length, chaptersBefore + 1);
  const ordered = [...opened.chapters].sort((a, b) => a.order - b.order);
  assert.equal(ordered[ordered.findIndex(item => item.id === chapter.id) + 1]!.title, '插叙 · 三十年前', '新章紧跟在锚点场景所在章之后');
  assert.equal(prose(opened, opened.scenes.find(scene => scene.title === '旧案')!.id), '');
  await closePopover();

  // 3c. 人物与设定 is split into the three elements; settings are designed like the cast.
  await nav('nav-objects', 'objects');
  await until(() => ui<boolean>(`document.querySelectorAll('[data-testid="elements-board"] .element-column').length === 3`), '三要素分栏');
  await click('objects-design-setting'); await idle();
  await ui(`document.querySelector('.companion-popover [data-testid="adopt-proposal"]').click()`);
  await until(() => store.getProject(project.id).objects.filter(object => object.typeId === 'setting').length >= 3, '采纳故事环境');
  await closePopover();
  await until(() => ui<boolean>(`document.querySelectorAll('[data-element="place"] .object-row').length >= 3`), '环境栏显示新环境');
  await capture('companion-06b-elements.png');
  await nav('nav-story', 'story');

  // 4. World causality: right-click an event → consequences become causally linked events.
  await nav('nav-world-tab', 'world');
  await contextMenu('.react-flow__node[data-id="bell"]');
  await clickText('[data-testid="companion-menu-item"]', '推演后果');
  await idle();
  await ui(`document.querySelector('.companion-popover [data-testid="adopt-proposal"]').click()`);
  await until(() => store.getProject(project.id).objects.some(object => object.event?.causes.includes('bell')), '后果事件接入因果');
  await capture('companion-06-world.png');
  await closePopover();

  // 5. Writer: stuck → next beats appended to the scene outline.
  await ui(`document.querySelector('[data-testid="nav-write"]').click()`); await delay(200);
  await until(() => ui<boolean>(`document.querySelector('.app').classList.contains('view-write')`), '进入写作');
  await click('writer-beat'); await idle();
  const sceneId = orderedPassages(store.getProject(project.id))[0]!.sceneId;
  const outlineBefore = store.getProject(project.id).scenes.length;
  await ui(`document.querySelector('.companion-popover [data-testid="adopt-idea-outline"]').click()`);
  await until(() => store.getProject(project.id).scenes.some(scene => scene.outline.includes('· ')), '下一拍补进场景大纲');
  assert.equal(store.getProject(project.id).scenes.length, outlineBefore);
  await capture('companion-07-writer-beat.png');
  await closePopover();
  await click('show-details-panel');
  await until(() => ui<boolean>(`!!document.querySelector('.writer-details [data-testid="scene-elements"]')`), '场景三要素小结');
  await capture('companion-07b-scene-elements.png');
  await click('show-details-panel');
  const rows = await ui<number[]>(`[...document.querySelectorAll('.scene-row')].map(e => Math.round(e.getBoundingClientRect().height))`);
  assert.ok(Math.max(...rows) < 60, `空白场景目录行高度正常 ${JSON.stringify(rows)}`);

  // 6. Side panel lists every conversation.
  await click('toggle-assistant'); await click('ai-tab-chat');
  const threads = store.getCompanionThreads(project.id).length;
  assert.ok(threads >= 6, `对话数量 ${threads}`);
  await until(() => ui<boolean>(`document.querySelectorAll('[data-testid="companion-thread-item"]').length === ${threads}`), '侧栏对话列表');
  await capture('companion-09-panel.png');
  window.setMinimumSize(375, 600); window.setSize(375, 812); await delay(250);
  await click('companion-new'); await delay(150);
  const narrowOverflow = await ui<boolean>(`document.documentElement.scrollWidth>innerWidth`);
  assert.equal(narrowOverflow, false);
  window.setSize(1510, 980); window.setMinimumSize(1080, 720);

  // 7. Story memory: the settings panel reports coverage; demo digests come from the prose without a model.
  await ui(`${el('nav-settings')}.click()`);
  await until(() => ui<boolean>(`!!document.querySelector('.story-memory .story-memory-stats')`), '故事记忆面板');
  await ui(`[...document.querySelectorAll('.story-memory button')].find(e => e.textContent === '立即整理')?.click()`);
  await until(() => ui<boolean>(`document.querySelector('.story-memory .pill')?.textContent === '已是最新'`), '故事记忆整理完成');
  assert.ok(store.getStoryDigests(project.id).some(digest => digest.kind === 'passage' && digest.passageId === 'scene-a'), '已写场景生成摘要');
  await capture('companion-10-story-memory.png');
  assert.deepEqual(errors, []);
  writeFileSync(reportPath, JSON.stringify({ projectId: project.id, threads, sceneId, consoleErrors: errors, callsRealModel: false }, null, 2));
  await closed();
}
