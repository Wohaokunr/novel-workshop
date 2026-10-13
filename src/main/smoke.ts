import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserWindow, InputEvent as ElectronInputEvent } from 'electron';
import { ProviderStore } from './providers.js';
import type { NovelStore } from './store.js';
import type { NovelAgentScheduler } from './agents.js';
import type { AgentRun, AssistTool, CanvasCard, Command, RunRequest } from '../shared/types.js';
import { StoryView } from './agent/story-view.js';

export async function runSmoke(window: BrowserWindow, store: NovelStore, scheduler: NovelAgentScheduler) {
  if (process.env.NOVEL_SMOKE_FOCUS === 'agent') { const { runAgentSmoke } = await import('./agent-smoke.js'); return runAgentSmoke(window, store); }
  if (process.env.NOVEL_SMOKE_FOCUS === 'style') { const { runStyleSmoke } = await import('./style-smoke.js'); return runStyleSmoke(window, store); }
  if (process.env.NOVEL_SMOKE_FOCUS === 'companion') { const { runCompanionSmoke } = await import('./companion-smoke.js'); return runCompanionSmoke(window, store); }
  const output = process.env.NOVEL_SMOKE_OUTPUT!;
  mkdirSync(output, { recursive: true });
  const ui = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const workflow = process.env.NOVEL_SMOKE_FOCUS === 'workflow';
  async function until<T>(check: () => Promise<T> | T, label: string): Promise<NonNullable<T>> {
    for (let i = 0; i < 240; i++) { const result = await check(); if (result) return result as NonNullable<T>; await delay(100); }
    throw new Error(`桌面检查超时：${label}`);
  }
  async function click(name: string) {
    if ((name === 'nav-objects' || name === 'nav-story') && !await ui<boolean>(`!!document.querySelector('[data-testid="${name}"]')`)) await click(name === 'nav-objects' ? 'nav-idea' : 'nav-world');
    await until(() => ui<boolean>(`(() => {const control=document.querySelector('[data-testid="${name}"]');return !!control&&!control.disabled;})()`), `${name}可用`);
    if (workflow) await nativeClick(`document.querySelector('[data-testid="${name}"]')`);
    else await ui(`document.querySelector('[data-testid="${name}"]').click()`);
    const views: Record<string, string> = { 'nav-home': 'home', 'nav-idea': 'canvas', 'nav-canvas-tab': 'canvas', 'nav-objects': 'objects', 'nav-world': 'world', 'nav-world-tab': 'world', 'nav-story': 'story', 'nav-write': 'write', 'nav-read': 'reader', 'nav-monitor': 'monitor' };
    const view = views[name];
    if (view) {
      await until(() => ui<boolean>(`!!document.querySelector('.app.view-${view}')`), `${name}界面切换`);
    }
    await delay(180);
  }
  async function fill(name: string, value: string) {
    await until(() => ui<boolean>(`!!document.querySelector('[data-testid="${name}"]')`), name);
    if (workflow) { await nativeFill(`document.querySelector('[data-testid="${name}"]')`, value); return; }
    await ui(`(() => { const el = document.querySelector('[data-testid="${name}"]'); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await delay(150);
  }
  async function capture(name: string) {
    await ui(`Promise.all(document.getAnimations().filter(animation => animation.effect && Number.isFinite(animation.effect.getComputedTiming().iterations)).map(animation => animation.finished.catch(() => {}))).then(() => null)`);
    await delay(50);
    if (window.webContents.isOffscreen()) await new Promise<void>(resolve => { window.webContents.once('paint', () => resolve()); window.webContents.invalidate(); });
    writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG());
  }
  async function createProject(title: string) {
    await click('open-create-project'); await fill('project-title-input', title); await click('create-project');
    await until(() => ui<boolean>(`!document.querySelector('.app-dialog[open]')`), '新建作品对话框关闭');
  }
  async function selectTask(stage: RunRequest['stage'], tool?: AssistTool) {
    await setPanel('ai', true);
    const value = tool ? `assist:${tool}` : stage;
    const control = `document.querySelector('[data-testid="task-type"]')`;
    if (workflow) await nativeSelect(control, value);
    else await ui(setValue(control, value, 'change'));
    await until(() => ui<boolean>(`(${control})?.value === ${JSON.stringify(value)}`), '本次任务类型');
    await delay(100);
  }
  async function expandDetails(name: string) {
    await until(() => ui<boolean>(`!!document.querySelector('[data-testid="${name}"]')`), name);
    await ui(`document.querySelector('[data-testid="${name}"]').open = true`);
  }
  const field = (label: string, scope = 'document') => `[...${scope}.querySelectorAll('label.field')].find(el => el.querySelector('span')?.textContent === ${JSON.stringify(label)})?.querySelector('input,textarea,select')`;
  const setValue = (element: string, value: string, event = 'input') => `(() => { const el = ${element}; if (!el) throw new Error('缺少输入控件'); const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`;
  // Hidden offscreen pages have no native focus events; React's onBlur listens to bubbling focusout.
  const blurField = (element: string, target = 'null') => `${element}.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: ${target} }))`;
  let editingField: string | undefined;
  async function fillField(label: string, value: string, scope = 'document') {
    const element = field(label, scope);
    await until(() => ui<boolean>(`!!(${element})`), label);
    editingField = element;
    await ui(setValue(element, value));
    await delay(100);
  }
  async function clickText(text: string, scope = 'document') {
    const element = `[...${scope}.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
    await until(() => ui<boolean>(`!!(${element})`), text);
    if (workflow) await nativeClick(element);
    else await ui(`${element}.click()`);
    await delay(100);
  }
  async function blurAndSelect(label: string, value: string, scope = 'document') {
    // Dispatch both events in one browser task to reproduce blur followed by a stale select write.
    const select = field(label, scope);
    await ui(`${editingField ? blurField(editingField, select) : ''};${setValue(select, value, 'change')}`);
    editingField = undefined;
  }
  async function finished(id: string) {
    return until(async () => {
      const run = store.getRun(id);
      if (run?.status === 'awaitingApproval') {
        const candidate = run.runtime!.candidates.find(candidate => candidate.status === 'awaitingApproval')!;
        await scheduler.decide({ runId: id, candidateId: candidate.id, candidateHash: candidate.hash, approve: true });
      }
      const latest = store.getRun(id);
      return latest?.finishedAt || latest?.status === 'paused' || latest?.status === 'awaitingInput' ? latest : null;
    }, '任务收尾');
  }
  async function closeWindow() {
    const closed = new Promise<void>(resolve => window.once('closed', () => resolve()));
    window.close();
    await Promise.race([closed, delay(10000).then(() => { throw new Error('关闭保存握手超时'); })]);
  }
  type Modifiers = NonNullable<ElectronInputEvent['modifiers']>;
  type ScreenPoint = { x: number; y: number };
  type ScreenRect = ScreenPoint & { width: number; height: number; right: number; bottom: number };
  const element = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;
  const nodeElement = (id: string, child = '') => element(`[data-testid="rf__node-${id}"]${child}`);
  const textButton = (text: string, scope = 'document') => `[...${scope}.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
  async function rectOf(expression: string): Promise<ScreenRect> {
    return until(() => ui<ScreenRect | null>(`(() => { const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom} : null; })()`), '控件可见坐标');
  }
  async function nativeClick(expression: string, modifiers: Modifiers = [], anchor?: ScreenPoint) {
    const point = await until(async () => {
      const state = await ui<{ point: ScreenPoint; visible: boolean; scroll?: ScreenPoint; distance: number } | null>(`(() => {
        const el = ${expression}; if (!el || el.disabled) return null;
        const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null;
        const point = {x:r.x + r.width * ${anchor?.x ?? 0.5}, y:r.y + r.height * ${anchor?.y ?? 0.5}};
        const hit = document.elementFromPoint(point.x,point.y);
        let parent = el.parentElement;
        while (parent && !(parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY))) parent = parent.parentElement;
        const sr = parent?.getBoundingClientRect();
        return { point, visible: point.x>0 && point.y>0 && point.x<innerWidth && point.y<innerHeight && (hit===el || el.contains(hit)), scroll:sr ? {x:sr.x+sr.width/2,y:Math.min(innerHeight-30,Math.max(30,sr.y+sr.height/2))} : undefined, distance:sr ? point.y-(sr.y+sr.height/2) : 0 };
      })()`);
      if (!state) return null;
      if (state.visible) return state.point;
      if (state.scroll) window.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(state.scroll.x), y: Math.round(state.scroll.y), deltaY: -Math.round(state.distance), canScroll: true });
      return null;
    }, '原生点击目标');
    await nativePointClick(point, modifiers);
  }
  async function withHeldModifiers(modifiers: Modifiers, action: () => Promise<void>) {
    const keys = modifiers.flatMap(modifier => modifier === 'shift' ? ['Shift'] : modifier === 'control' ? ['Control'] : []);
    for (const keyCode of keys) window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keys.length) await delay(60);
    try { await action(); }
    finally {
      for (const keyCode of keys.reverse()) window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [] });
      if (keys.length) await delay(60);
    }
  }
  async function nativePointClick(point: ScreenPoint, modifiers: Modifiers = [], clickCount = 1) {
    await withHeldModifiers(modifiers, async () => {
      const x = Math.round(point.x), y = Math.round(point.y);
      window.webContents.sendInputEvent({ type: 'mouseMove', x, y, modifiers });
      window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount, modifiers });
      window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount, modifiers });
      await delay(100);
    });
  }
  async function nativeKey(keyCode: string, modifiers: Modifiers = []) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await delay(50);
  }
  async function nativeFill(expression: string, value: string) {
    await nativeClick(expression); await nativeKey('A', ['control']);
    await window.webContents.insertText(value); await delay(100);
    assert.equal(await ui<string>(`(${expression}).value`), value, '输入必须经过真实焦点控件');
  }
  async function nativeSelect(expression: string, value: string) {
    const option = await until(() => ui<{ index: number; first: number } | null>(`(() => {const select=${expression};if(!select)return null;const options=[...select.options]; return {index:options.findIndex(o=>o.value===${JSON.stringify(value)}), first:options.findIndex(o=>!o.disabled)};})()`), '选择框加载');
    assert.ok(option.index >= 0, `缺少选项 ${value}`);
    await nativeClick(expression); await nativeKey('Home');
    for (let i = option.first; i < option.index; i++) await nativeKey('Down');
    await nativeKey('Enter');
    await until(() => ui<boolean>(`(${expression}).value===${JSON.stringify(value)}`), `选择${value}`);
  }
  async function nativeDrag(from: ScreenPoint, to: ScreenPoint, modifiers: Modifiers = []) {
    await withHeldModifiers(modifiers, async () => {
      const start = { x: Math.round(from.x), y: Math.round(from.y) };
      window.webContents.sendInputEvent({ type: 'mouseMove', ...start, modifiers });
      window.webContents.sendInputEvent({ type: 'mouseDown', ...start, button: 'left', clickCount: 1, modifiers });
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      assert.ok(distance > 0, '拖动必须有非零位移');
      window.webContents.sendInputEvent({ type: 'mouseMove', x: start.x + Math.round((to.x - from.x) / distance * 2), y: start.y + Math.round((to.y - from.y) / distance * 2), modifiers: [...modifiers, 'leftbuttondown'] });
      await ui(`new Promise(resolve => requestAnimationFrame(resolve))`);
      for (let i = 1; i <= 12; i++) {
        window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + (to.x - from.x) * i / 12), y: Math.round(from.y + (to.y - from.y) * i / 12), modifiers: [...modifiers, 'leftbuttondown'] });
        await delay(20);
      }
      window.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(to.x), y: Math.round(to.y), button: 'left', clickCount: 1, modifiers });
      await delay(180);
    });
  }
  const center = (rect: ScreenRect): ScreenPoint => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  async function blankPoint(): Promise<ScreenPoint> {
    return until(() => ui<ScreenPoint | null>(`(() => {const r=document.querySelector('.flow-container').getBoundingClientRect();const samples=[.02,.05,.1,.2,.4,.6,.8,.95,.98];for(const row of samples)for(const column of samples){const x=r.x+r.width*column,y=r.y+r.height*row; if(document.elementFromPoint(x,y)?.classList.contains('react-flow__pane'))return{x,y};}return null;})()`), '画布空白处');
  }
  async function fitCanvas() { if (workflow) await nativeClick(element('.react-flow__controls-fitview')); else await ui(`${element('.react-flow__controls-fitview')}.click()`); await delay(220); }
  async function setPanel(panel: 'details' | 'ai', open: boolean) {
    const expression = panel === 'ai' ? `!!document.querySelector('.ai-sidebar')` : `!!document.querySelector('.inspector-panel')`;
    const exists = await ui<boolean>(expression);
    if (exists === open) return;
    // A modal drawer covers the topbar; real users switch panels with the keyboard shortcut there.
    if (workflow && await ui<boolean>(`!!document.querySelector('.context-backdrop')`)) await nativeKey(panel === 'ai' ? 'J' : 'I', ['control']);
    else if (panel === 'ai') await click('toggle-assistant');
    else await click('show-details-panel');
    await until(() => ui<boolean>(`(${expression})===${open}`), `${panel}面板切换`);
  }
  interface WorkflowReport { projectId: string; title: string; revision: number; cards: CanvasCard[]; outlineRunId: string; chapterRunId: string; sceneId: string; checks: string[]; screenshots: string[]; callsRealModel: boolean }
  async function runWorkflow() {
    window.show(); window.focus(); window.webContents.focus();
    window.setSize(1510, 980); await delay(200);
    if (process.env.NOVEL_SMOKE_REOPEN) {
      const report = JSON.parse(readFileSync(join(output, 'workflow-result.json'), 'utf8')) as WorkflowReport;
      const current = store.getProject(report.projectId);
      assert.equal(current.title, report.title); assert.equal(current.revision, report.revision);
      assert.deepEqual(current.cards, report.cards);
      assert.equal(current.scenes.find(scene => scene.id === report.sceneId)?.text, '');
      assert.equal(store.getRun(report.outlineRunId)?.status, 'completed');
      assert.equal(store.getRun(report.chapterRunId)?.status, 'completed');
      assert.ok(store.history(report.projectId).some(batch => batch.taskId === report.chapterRunId && batch.undone));
      await until(() => ui<boolean>(`document.querySelector('.project-switch')?.value===${JSON.stringify(report.projectId)}`), '工作流作品重开');
      await click('nav-idea'); await capture('workflow-reopen.png');
      await closeWindow(); console.log('节点与智能体工作流重开检查通过。'); return;
    }
    await createProject('节点与智能体 · 工作流验收');
    const project = await until(() => store.listProjects().find(project => project.title === '节点与智能体 · 工作流验收'), '工作流作品创建');
    const current = () => store.getProject(project.id);
    async function selectedGroup(id: string, label: string) {
      try {
        await until(() => ui<boolean>(`(() => {const selected=[...document.querySelectorAll('.react-flow__node.selected')];return selected.length===1 && selected[0].getAttribute('data-id')===${JSON.stringify(id)} && document.querySelector('.board-inspector .section-heading h3')?.textContent==='分组详情';})()`), label);
      } catch (error) {
        console.error('分组选择等待诊断', JSON.stringify({ expectedId: id, cards: current().cards, selectedIds: await ui<string[]>(`[...document.querySelectorAll('.react-flow__node.selected')].map(el=>el.getAttribute('data-id'))`), inspector: await ui<string | null>(`document.querySelector('.board-inspector .section-heading h3')?.textContent ?? null`), viewport: await ui(`({innerWidth,innerHeight,devicePixelRatio,narrow:matchMedia('(max-width:1279px)').matches})`) }, null, 2));
        throw error;
      }
    }
    await click('nav-idea'); await setPanel('ai', false); await setPanel('details', false);
    const blank = await blankPoint();
    await nativeDrag(blank, { x: blank.x + 80, y: blank.y + 50 });
    await nativeClick(textButton('添加便笺', "document.querySelector('.board-tools')"));
    const first = await until(() => current().cards.find(card => card.kind === 'note'), '当前视口创建便笺');
    const firstRect = await rectOf(nodeElement(first.id)), canvasRect = await rectOf(element('.flow-container'));
    assert.ok(firstRect.x >= canvasRect.x && firstRect.right <= canvasRect.right && firstRect.y >= canvasRect.y && firstRect.bottom <= canvasRect.bottom, '工具栏创建必须出现在当前视口');
    const secondPoint = await blankPoint();
    await nativePointClick(secondPoint, [], 1); await nativePointClick(secondPoint, [], 2);
    const second = await until(() => current().cards.find(card => card.kind === 'note' && card.id !== first.id), '双击空白创建便笺');
    await setPanel('details', true);
    await nativeFill(field('标题', "document.querySelector('.board-inspector')"), '雾港信件与第十三声');
    await nativeFill(field('灵感与备注', "document.querySelector('.board-inspector')"), '档案员收到一封旧信，钟楼第十三声响后，信中名字从记录里消失。');
    await setPanel('details', false);
    await until(() => current().cards.find(card => card.id === second.id)?.content.includes('档案员'), '原生编辑便笺保存');
    await fitCanvas();
    await nativePointClick(await blankPoint());
    const boxes = await Promise.all([rectOf(nodeElement(first.id)), rectOf(nodeElement(second.id))]);
    const selectionCanvas = await rectOf(element('.flow-container'));
    await nativeDrag({ x: Math.min(...boxes.map(box => box.x)) - 15, y: Math.min(...boxes.map(box => box.y)) - 15 }, { x: Math.min(selectionCanvas.right - 10, Math.max(...boxes.map(box => box.right)) + 50), y: Math.min(selectionCanvas.bottom - 10, Math.max(...boxes.map(box => box.bottom)) + 65) }, ['shift']);
    await until(() => ui<boolean>(`document.querySelectorAll('.react-flow__node.selected').length===2`), 'Shift原生框选');
    await nativePointClick(await blankPoint());
    await nativeClick(nodeElement(first.id)); await nativeClick(nodeElement(second.id), ['control']);
    await until(() => ui<boolean>(`document.querySelectorAll('.react-flow__node.selected').length===2`), 'Ctrl多选保留');
    const beforeMulti = current().cards.map(card => ({ ...card })), multiStart = center(await rectOf(nodeElement(first.id)));
    await nativeDrag(multiStart, { x: multiStart.x + 32, y: multiStart.y + 24 });
    await until(() => current().cards.find(card => card.id === first.id)!.x !== first.x && current().cards.find(card => card.id === second.id)!.x !== second.x, '多选拖动全部保存');
    const delta = current().cards.find(card => card.id === first.id)!.x - beforeMulti.find(card => card.id === first.id)!.x;
    assert.ok(Math.abs(current().cards.find(card => card.id === second.id)!.x - beforeMulti.find(card => card.id === second.id)!.x - delta) < 0.001);
    assert.equal(store.history(project.id).at(0)?.changes.filter(change => change.collection === 'cards').length, 2, '多选移动应只生成一个包含两个节点的批次');
    await nativeClick(textButton('成组', "document.querySelector('.board-selection-toolbar')"));
    const inner = await until(() => current().cards.find(card => card.kind === 'group'), '多选成组');
    assert.equal(current().cards.find(card => card.id === first.id)?.groupId, inner.id);
    assert.equal(current().cards.find(card => card.id === second.id)?.groupId, inner.id);
    await selectedGroup(inner.id, '内层组完成UI选中与详情同步');
    await nativeClick(textButton('成组', "document.querySelector('.board-selection-toolbar')"));
    const outer = await until(() => current().cards.find(card => card.kind === 'group' && card.id !== inner.id), '嵌套成组');
    await selectedGroup(outer.id, '外层组完成UI选中与详情同步');
    assert.equal(current().cards.find(card => card.id === inner.id)?.groupId, outer.id);
    await fitCanvas();
    const beforeParent = current().cards.map(card => ({ ...card })), handle = await rectOf(nodeElement(outer.id, ' .group-drag-handle'));
    await nativeDrag({ x: handle.x + 24, y: handle.y + handle.height / 2 }, { x: handle.x + 94, y: handle.y + handle.height / 2 + 45 });
    await until(() => current().cards.find(card => card.id === outer.id)!.x !== beforeParent.find(card => card.id === outer.id)!.x, '父组拖动保存');
    const parentDelta = current().cards.find(card => card.id === outer.id)!.x - beforeParent.find(card => card.id === outer.id)!.x;
    for (const id of [inner.id, first.id, second.id]) assert.ok(Math.abs(current().cards.find(card => card.id === id)!.x - beforeParent.find(card => card.id === id)!.x - parentDelta) < 0.001, '后代只能平移一次');
    await fitCanvas();
    const beforeResize = current().cards.map(card => ({ ...card })), resize = center(await rectOf(nodeElement(outer.id, ' .react-flow__resize-control.handle.bottom.right')));
    await nativeDrag(resize, { x: resize.x + 60, y: resize.y + 55 });
    await until(() => current().cards.find(card => card.id === outer.id)!.width! > beforeResize.find(card => card.id === outer.id)!.width! + 10, '原生手柄缩放保存');
    for (const id of [first.id, second.id]) assert.equal(current().cards.find(card => card.id === id)!.x, beforeResize.find(card => card.id === id)!.x, '缩放不能移动成员绝对位置');
    await fitCanvas(); await nativeClick(element('.react-flow__controls-zoomout')); await nativeClick(element('.react-flow__controls-zoomout'));
    const outsidePoint = await blankPoint(); await nativePointClick(outsidePoint, [], 1); await nativePointClick(outsidePoint, [], 2);
    const outside = await until(() => current().cards.find(card => card.kind === 'note' && card.id !== first.id && card.id !== second.id), '外部分组便笺');
    assert.equal(outside.groupId, undefined);
    await delay(250); await fitCanvas();
    await nativeDrag(center(await rectOf(nodeElement(first.id, ' .react-flow__handle.source'))), center(await rectOf(nodeElement(outside.id, ' .react-flow__handle.target'))));
    const externalLink = await until(() => current().canvasLinks.find(link => link.source === first.id && link.target === outside.id), '真实连线创建');
    await nativeClick(nodeElement(outer.id, ' .group-actions'));
    await until(() => current().cards.find(card => card.id === outer.id)?.collapsed, '折叠保存');
    assert.equal(await ui<boolean>(`!!(${nodeElement(first.id)})`), false, '折叠必须隐藏后代');
    await until(() => ui<boolean>(`!!document.querySelector('.react-flow__edge[data-id="${externalLink.id}"]')`), '折叠代理仍显示外部连线');
    assert.equal(current().canvasLinks.find(link => link.id === externalLink.id)?.source, first.id, '代理边不改写真实连线端点');
    await delay(250); await nativeClick(nodeElement(outer.id, ' .group-actions'));
    await until(() => ui<boolean>(`!!(${nodeElement(first.id)})`), '展开恢复后代');
    await fitCanvas(); await nativeClick(element('.react-flow__controls-zoomout')); await nativeClick(element('.react-flow__controls-zoomout'));
    const outerRect = await rectOf(nodeElement(outer.id)), outsideStart = center(await rectOf(nodeElement(outside.id)));
    const dropPoint = { x: outerRect.right - 18, y: outerRect.bottom - 18 };
    async function dropDiagnostics(phase: string) {
      const observed = await ui(`(() => {
        const point=${JSON.stringify(dropPoint)}, ids=${JSON.stringify([outer.id, inner.id, outside.id])};
        const rects=ids.map(id=>{const el=document.querySelector('[data-testid="rf__node-'+id+'"]'),r=el?.getBoundingClientRect();return{id,rect:r?{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}:null};});
        const hit=document.elementFromPoint(Math.round(point.x),Math.round(point.y));
        const viewport=document.querySelector('.react-flow__viewport'), transform=viewport?getComputedStyle(viewport).transform:null;
        return{rects,hit:hit?{tag:hit.tagName,className:hit.getAttribute('class'),nodeId:hit.closest('.react-flow__node')?.getAttribute('data-id')??null}:null,groupsAtPoint:rects.filter(item=>item.id!==${JSON.stringify(outside.id)}&&item.rect&&point.x>=item.rect.x&&point.x<=item.rect.right&&point.y>=item.rect.y&&point.y<=item.rect.bottom).map(item=>item.id),transform,selectedIds:[...document.querySelectorAll('.react-flow__node.selected')].map(el=>el.getAttribute('data-id')),innerWidth,innerHeight,devicePixelRatio};
      })()`);
      console.log('拖入分组坐标诊断', JSON.stringify({ phase, from: outsideStart, to: dropPoint, cards: current().cards, observed }, null, 2));
    }
    try {
      await nativeDrag(outsideStart, dropPoint);
      await until(() => current().cards.find(card => card.id === outside.id)?.groupId === outer.id, '原生拖入分组');
    } catch (error) { await dropDiagnostics('failed'); throw error; }
    await fitCanvas(); await nativeClick(element('.react-flow__controls-zoomout')); await nativeClick(element('.react-flow__controls-zoomout'));
    await nativeDrag(center(await rectOf(nodeElement(outside.id))), await blankPoint());
    await until(() => !current().cards.find(card => card.id === outside.id)?.groupId, '原生拖出解除分组');
    await fitCanvas(); await nativeClick(nodeElement(outer.id, ' .group-drag-handle'), [], { x: 0.1, y: 0.5 });
    await setPanel('details', true);
    const beforeDissolve = current().cards.map(card => ({ ...card }));
    await clickText('解散并保留成员', "document.querySelector('.board-inspector')");
    await until(() => !current().cards.some(card => card.id === outer.id), '解散外层分组');
    assert.equal(current().cards.find(card => card.id === inner.id)?.groupId, undefined);
    for (const id of [inner.id, first.id, second.id, outside.id]) assert.equal(current().cards.find(card => card.id === id)!.x, beforeDissolve.find(card => card.id === id)!.x, '解散必须保留成员位置');
    await setPanel('details', false); await fitCanvas(); await nativeClick(nodeElement(inner.id, ' .group-drag-handle'), [], { x: 0.1, y: 0.5 });
    const beforePrepare = store.getRuns(project.id).length;
    await click('selection-agent-task'); await selectTask('outline');
    await until(() => ui<boolean>(`document.querySelector('[data-testid="reference-sources"]')?.textContent.includes('新的分组')`), '分组交给AI');
    assert.equal(store.getRuns(project.id).length, beforePrepare, '添加引用只准备任务，不隐式运行');
    await fill('ai-objective', '根据这组便笺编排档案员、旧信和钟楼的因果事件，形成三个有限视角场景。');
    await click('run-outline');
    assert.ok(await ui<boolean>(`!!document.querySelector('.app.view-canvas')`), '启动任务应保留当前创作界面');
    const outline = await until(() => store.getRuns(project.id).find(run => run.stage === 'outline'), '引用编排任务启动');
    assert.ok(outline.references?.some(ref => ref.kind === 'card' && ref.id === inner.id));
    assert.equal((await finished(outline.id)).status, 'completed');
    assert.ok(current().scenes.length > 0);
    await until(() => ui<boolean>(`document.querySelector('[data-testid="task-outcome"]')?.textContent.includes('已保存')`), '真实产出入口');
    await click('prepare-next-stage');
    await nativeSelect(element('[data-testid="chapter-scope"]'), 'scene');
    const targetId = await ui<string>(`document.querySelector('[data-testid="target-scene"]').value`);
    assert.ok(current().scenes.some(scene => scene.id === targetId));
    await fill('ai-objective', '只完成当前场景，保持人物所知范围，不提前透露钟楼秘密。');
    await click('run-chapter');
    const written = await until(() => store.getRuns(project.id).find(run => run.stage === 'chapter'), '当前场景正文启动');
    assert.equal(written.sceneId, targetId);
    assert.equal((await finished(written.id)).status, 'completed');
    assert.ok(current().scenes.find(scene => scene.id === targetId)!.text.length > 50);
    assert.ok(current().scenes.filter(scene => scene.id !== targetId).every(scene => !scene.text.trim()), '当前场景范围不得写入其他场景');
    await click(`open-result-${targetId}`);
    await until(() => ui<boolean>(`document.querySelector('.app.view-write') && document.querySelector('[data-testid="prose-editor"]')?.value.length>50`), '产出定位到真实正文');
    await click('nav-idea'); await setPanel('details', true); await setPanel('ai', true);
    assert.ok(await ui<boolean>(`!!document.querySelector('.board-inspector') && !!document.querySelector('.ai-sidebar') && !document.querySelector('.main').inert`), '1510宽度详情与AI并排');
    assert.ok((await rectOf(element('.flow-container'))).width >= 400, '并排面板保留画布宽度');
    await capture('workflow-1510.png');
    await setPanel('ai', false);
    window.setSize(1080, 900); await until(() => ui<boolean>(`!!document.querySelector('[data-testid="show-details-panel"]')`), '1080窄屏规则');
    await setPanel('details', true);
    await until(() => ui<boolean>(`!!document.querySelector('.board-inspector') && !document.querySelector('.ai-sidebar')`), '窄屏详情与AI互斥');
    const compactCanvas = await rectOf(element('.flow-container'));
    assert.ok(compactCanvas.width >= 400, '窄屏画布应保留可操作宽度');
    await capture('workflow-1080-details.png');
    await nativeKey('J', ['control']);
    await until(() => ui<boolean>(`!!document.querySelector('.ai-sidebar') && !document.querySelector('.board-inspector')`), '窄屏AI与详情互斥');
    await capture('workflow-1080-ai.png');
    await setPanel('ai', false);
    assert.equal(await ui<boolean>(`!!document.querySelector('.context-body')`), false, '关闭窄屏面板后保持关闭');
    await click('toggle-navigation');
    await until(() => ui<boolean>(`document.querySelector('.app')?.classList.contains('nav-collapsed')`), '导航可收起');
    await click('toggle-navigation');
    window.setSize(1510, 980); await delay(150);
    await click('nav-monitor'); await click('undo-task');
    await until(() => store.history(project.id).some(batch => batch.taskId === written.id && batch.undone), '任务撤销');
    assert.equal(current().scenes.find(scene => scene.id === targetId)?.text, '');
    assert.ok(current().cards.some(card => card.id === inner.id), '撤销正文任务不能删除人工分组');
    await click('nav-idea');
    const saved = current();
    const report: WorkflowReport = { projectId: project.id, title: saved.title, revision: saved.revision, cards: saved.cards, outlineRunId: outline.id, chapterRunId: written.id, sceneId: targetId,
      checks: ['真实鼠标创建', 'Ctrl多选与Shift框选', '多选移动原子保存', '多选成组与嵌套', '父组带动后代一次', '真实手柄缩放', '折叠代理外部连线', '拖入拖出', '解散保留成员', '分组引用编排', '单场景正文', '任务产出定位', '1510与1080面板规则', '导航收起', '任务撤销', '关闭与重开持久化'],
      screenshots: ['workflow-1510.png', 'workflow-1080-details.png', 'workflow-1080-ai.png', 'workflow-reopen.png'], callsRealModel: false };
    writeFileSync(join(output, 'workflow-result.json'), JSON.stringify(report, null, 2), 'utf8');
    await closeWindow(); console.log(`节点与智能体工作流检查通过：${report.checks.join('、')}。未调用真实模型。`);
  }
  await until(() => ui<boolean>(`!!window.novel && !!document.getElementById('root')?.textContent`), '界面与 preload 加载');
  if (workflow) { await runWorkflow(); return; }
  if (process.env.NOVEL_SMOKE_FOCUS === 'interaction') {
    const reportPath=join(output,'interaction-result.json');
    if(process.env.NOVEL_SMOKE_REOPEN){
      const report=JSON.parse(readFileSync(reportPath,'utf8')) as {projectId:string;revision:number;scroll:number};
      const current=store.getProject(report.projectId);
      assert.equal(current.revision,report.revision);assert.equal(current.reading.scroll,report.scroll);
      await click('nav-read');
      await until(()=>ui<boolean>(`Math.abs(document.querySelector('.reader-scroll').scrollTop-${report.scroll})<2`),'阅读位置重启恢复');
      assert.deepEqual(await ui<string[]>(`[document.documentElement.dataset.theme,document.documentElement.dataset.accent]`),['onedark','teal'],'外观设置重启后保留');
      await click('nav-settings');await click('theme-light');await click('accent-rose');
      assert.equal(await ui<string>(`document.documentElement.dataset.theme`),'light');
      await click('nav-home');await capture('overview-rose.png');
      await closeWindow();console.log('交互与阅读进度重开检查通过。');return;
    }
    window.show();window.focus();window.webContents.focus();await delay(200);
    console.log('交互窗口焦点',JSON.stringify({offscreen:window.webContents.isOffscreen(),focused:window.isFocused(),document:await ui<boolean>(`document.hasFocus()`)}));
    const checks:string[]=[];
    await createProject('雾港来信 · 交互验收');
    const project=store.listProjects()[0]!,initial=store.getProject(project.id);
    assert.equal(await ui<string>(`document.querySelector('.toast')?.getAttribute('role')`),'status','成功提示不打断朗读');
    const toast=await rectOf(element('.toast'));
    await ui(`window.__focusTrace=[];for(const type of ['pointerover','pointerout','focusin','focusout'])document.addEventListener(type,event=>{if(event.target.closest?.('.toast'))window.__focusTrace.push(type+' '+event.target.tagName+' to '+event.relatedTarget?.tagName)});window.addEventListener('blur',()=>window.__focusTrace.push('window blur'));`);
    window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(toast.x+30),y:Math.round(toast.y+20)});
    await delay(4700);assert.ok(await ui<boolean>(`!!document.querySelector('.toast')`),'悬停提示时暂停自动消失');
    window.focus();window.webContents.focus();await delay(100);
    await ui(`document.querySelector('.toast button')?.focus()`);
    window.webContents.sendInputEvent({type:'mouseMove',x:220,y:70});
    await delay(4700);
    const toastFocus=await ui<{present:boolean;focused:boolean;active:string;events:string[]}>(`({present:!!document.querySelector('.toast'),focused:document.hasFocus(),active:document.activeElement.tagName,events:window.__focusTrace})`);
    assert.ok(toastFocus.present,`键盘停留提示时暂停自动消失：${JSON.stringify(toastFocus)}`);
    await nativeKey('Enter');checks.push('提示悬停与键盘停留');
    const first=initial.chapters[0]!.id,second='interaction-second',scene='interaction-manuscript';
    const prose=Array.from({length:65},(_,index)=>`第${index+1}封信被放在窗边。雾从港口的石阶上漫过来，林舟把钟楼的报时写进笔记，却没有写下那封信的寄件人。`).join('\n\n');
    store.execute({projectId:project.id,expectedRevision:initial.revision,actor:'human',label:'交互验收夹具',commands:[
      {type:'updateNovel',patch:{genre:'悬疑 · 有限视角',brief:'钟楼多响了一声，一封没有寄件人的信抵达雾港。林舟必须决定：相信眼前的人，还是相信记录里的过去。'}},
      {type:'putChapter',value:{id:first,title:'第一章：雾中的来信',order:1}},
      {type:'putChapter',value:{id:second,title:'第二章：沉默的钟楼',order:2}},
      {type:'putScene',value:{id:scene,chapterId:first,title:'窗边的信',order:1,povId:null,eventIds:[],outline:'林舟收到旧信，发现报时的矛盾。',text:prose}},
      {type:'putScene',value:{id:'interaction-short',chapterId:second,title:'灯熄之后',order:1,povId:null,eventIds:[],outline:'',text:'钟楼的灯熄灭了。'}},
      {type:'setReading',value:{...initial.reading,chapterId:first,scroll:280}},
    ]});
    window.webContents.reload();
    await until(()=>ui<boolean>(`document.querySelector('.save-indicator')?.getAttribute('data-revision')==='1'`),'交互夹具加载');
    await capture('overview.png');
    await nativeClick(element('[data-testid="toggle-assistant"]'));
    await until(()=>ui<boolean>(`!!document.querySelector('.ai-sidebar')`),'桌面面板打开');
    assert.equal(await ui<boolean>(`document.querySelector('.main').inert`),false,'宽屏面板不阻止编辑器');
    window.setSize(1080,800);
    await until(()=>ui<boolean>(`document.querySelector('.main').inert && document.querySelector('.sidebar').inert && document.querySelector('.context-panel').getAttribute('aria-modal')==='true'`),'窄屏工具抽屉模态化');
    assert.ok(await ui<boolean>(`document.querySelector('.context-panel').contains(document.activeElement)`),'抽屉打开迁移焦点');
    const focusable=`[...document.querySelectorAll('.context-panel button,.context-panel input,.context-panel textarea,.context-panel select,.context-panel summary')].filter(el=>el.tabIndex>=0&&!el.disabled&&el.getClientRects().length)`;
    await ui(`(${focusable}).at(-1).focus()`);await nativeKey('Tab');
    assert.ok(await ui<boolean>(`document.activeElement===(${focusable})[0]`),'Tab 在抽屉内循环');
    await nativeKey('Tab',['shift']);
    assert.ok(await ui<boolean>(`document.activeElement===(${focusable}).at(-1)`),'Shift+Tab 在抽屉内循环');
    await capture('drawer-1080.png');
    window.setSize(1510,980);
    await until(()=>ui<boolean>(`!document.querySelector('.main').inert && !document.querySelector('.sidebar').inert`),'放大窗口解除背景锁定');
    window.setSize(1080,800);await until(()=>ui<boolean>(`document.querySelector('.main').inert`),'恢复窄屏');
    await nativeKey('Escape');
    await until(()=>ui<boolean>(`!document.querySelector('.context-panel') && !document.querySelector('.main').inert && document.activeElement?.getAttribute('data-testid')==='toggle-assistant'`),'Escape 关闭并恢复触发焦点');
    checks.push('抽屉焦点循环、背景锁定、尺寸切换与焦点恢复');
    window.setSize(1510,980);await delay(250);
    await nativeClick(element('[data-testid="continue-writing"]'));
    await until(()=>ui<boolean>(`!!document.querySelector('[data-testid="prose-editor"]')`),'继续当前场景');
    const summary=element('.more-actions summary');
    await nativeClick(summary);await nativeKey('Down');
    assert.ok(await ui<boolean>(`document.activeElement===document.querySelector('.more-actions button')`),'菜单向下聚焦第一项');
    await nativeKey('End');assert.ok(await ui<boolean>(`document.activeElement===document.querySelector('.more-actions button:last-child')`),'End 聚焦末项');
    await nativeKey('Escape');assert.ok(await ui<boolean>(`!document.querySelector('.more-actions').open && document.activeElement===${summary}`),'菜单 Escape 关闭并恢复焦点');
    await nativeClick(summary);await nativeClick(element('.writer-toolbar h2'));
    assert.equal(await ui<boolean>(`document.querySelector('.more-actions').open`),false,'外部点击收起菜单');
    await nativeClick(summary);await nativeClick(element('.more-actions button'));
    await until(()=>ui<boolean>(`!!document.querySelector('.ai-sidebar') && !document.querySelector('.more-actions').open`),'执行菜单后收起');
    await nativeClick(element('.panel-close'));
    await until(()=>ui<boolean>(`!document.querySelector('.context-panel') && document.activeElement===${summary}`),'菜单操作的面板关闭后恢复可见触发器');
    await capture('writer.png');checks.push('场景操作菜单键盘、外部点击、执行后收起');
    await click('nav-idea');await ui(`document.querySelector('.page-tabs [aria-selected="true"]').focus()`);await nativeKey('Right');
    await until(()=>ui<boolean>(`document.querySelector('.app').classList.contains('view-objects') && document.activeElement?.id==='workspace-tab-objects'`),'工作区标签方向键切换');
    await nativeKey('Left');await until(()=>ui<boolean>(`document.querySelector('.app').classList.contains('view-canvas')`),'工作区标签返回');checks.push('工作区标签键盘切换');
    await click('nav-read');
    const progressMatches=`(() => {const el=document.querySelector('.reader-scroll');const expected=el.scrollHeight<=el.clientHeight?100:Math.round(el.scrollTop/(el.scrollHeight-el.clientHeight)*100);return +document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')===expected;})()`;
    await until(()=>ui<boolean>(`document.querySelector('.reader-scroll').scrollTop>200 && ${progressMatches}`),'首次进入恢复位置与正确进度');
    await ui(`document.querySelector('.reader-scroll').scrollTo({top:480,behavior:'instant'})`);await delay(60);
    await nativeClick(element('[data-testid="nav-home"]'));
    await until(()=>store.getProject(project.id).reading.scroll>=478,'离开阅读器前保存未防抖的进度');
    await click('nav-read');await until(()=>ui<boolean>(`document.querySelector('.reader-scroll').scrollTop>=478 && ${progressMatches}`),'重新进入恢复进度');
    await nativeSelect(element('.reader-controls .field select'),second);
    await until(()=>ui<boolean>(`document.querySelector('.reader-scroll h2')?.textContent==='第二章：沉默的钟楼' && ${progressMatches} && document.querySelector('.reader-scroll').scrollTop===0`),'切换短章节重算进度');
    await nativeSelect(element('.reader-controls .field select'),first);
    await ui(`document.querySelector('.reader-scroll').scrollTo({top:360,behavior:'instant'})`);await delay(100);
    await nativeClick(element('[aria-label="放大字号"]'));
    await until(()=>ui<boolean>(`document.querySelector('.reader-controls .button-row span').textContent==='21px' && ${progressMatches}`),'字号改变后重算进度');
    await nativeClick(textButton('夜读'));await until(()=>store.getProject(project.id).reading.theme==='dark','夜读主题保存');
    await until(()=>ui<boolean>(`!!document.querySelector('.reader-page.dark')`),'夜读主题');
    window.focus();window.webContents.focus();await delay(100);
    await ui(`document.querySelector('.reader-controls .field select').focus()`);await nativeKey('Tab');
    const nightFocus=await ui<{tag:string;label:string|null;visible:boolean;focus:boolean;outline:string}>(`({tag:document.activeElement.tagName,label:document.activeElement.getAttribute('aria-label'),visible:document.activeElement.matches(':focus-visible'),focus:document.hasFocus(),outline:getComputedStyle(document.activeElement).outlineColor})`);
    assert.ok(nightFocus.tag==='BUTTON'&&nightFocus.visible,`夜读焦点经过真实键盘切换：${JSON.stringify(nightFocus)}`);
    assert.equal(nightFocus.outline,'rgb(184, 190, 255)','夜读使用高对比焦点');
    await capture('reader-dark.png');checks.push('阅读位置保存恢复、章节与字号进度重算、夜读焦点');
    await click('nav-idea');
    window.webContents.debugger.attach('1.3');
    try{
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      await until(()=>ui<boolean>(`matchMedia('(prefers-reduced-motion: reduce)').matches`),'减少动态效果模拟');
      await ui(`(() => {window.__motionQueries=0;window.__originalMatchMedia=window.matchMedia;window.matchMedia=function(query){if(query==='(prefers-reduced-motion: reduce)')window.__motionQueries++;return window.__originalMatchMedia.call(this,query);};})()`);
      await nativeClick(textButton('添加便笺',"document.querySelector('.board-tools')"));
      await until(()=>ui<boolean>(`window.__motionQueries>0`),'画布 JS 定位读取 reduced-motion');
      assert.equal(await ui<string>(`getComputedStyle(document.querySelector('.inspector-panel')).animationName`),'none','详情面板动画关闭');
      assert.equal(await ui<string>(`getComputedStyle(document.querySelector('.main-content')).animationName`),'none','页面动画关闭');
      await ui(`window.matchMedia=window.__originalMatchMedia;delete window.__originalMatchMedia;delete window.__motionQueries;`);
      await setPanel('details',false);await capture('canvas-reduced-motion.png');
    }finally{await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});window.webContents.debugger.detach();}
    checks.push('CSS 与 JS 画布动效遵循 reduced-motion');
    await click('nav-home');window.setMinimumSize(320,640);window.setSize(375,812);await delay(300);
    assert.ok(await ui<boolean>(`document.querySelector('.main-content').scrollWidth<=document.querySelector('.main-content').clientWidth+1`),'小屏概览无水平溢出');
    await capture('overview-mobile.png');window.setMinimumSize(1080,720);window.setSize(1510,980);await delay(250);
    checks.push('375px 概览布局');
    await click('theme-toggle');
    assert.equal(await ui<string>(`document.documentElement.dataset.theme`),'dark','侧栏切换深色模式');
    assert.equal(await ui<string>(`getComputedStyle(document.documentElement).backgroundColor`),'rgb(17, 17, 19)','深色背景生效');
    await capture('dark-overview.png');
    await click('nav-write');await capture('dark-writer.png');
    await click('nav-idea');await capture('dark-canvas.png');
    await click('nav-settings');await click('accent-teal');
    assert.equal(await ui<string>(`getComputedStyle(document.documentElement).getPropertyValue('--accent-base').trim()`),'#0e8174','配色方案切换');
    assert.equal(await ui<string>(`document.querySelector('[data-testid="theme-dark"]').getAttribute('aria-checked')`),'true');
    await capture('dark-settings-teal.png');
    await click('theme-onedark');await click('accent-indigo');
    assert.equal(await ui<string>(`getComputedStyle(document.documentElement).backgroundColor`),'rgb(33, 37, 43)','One Dark 背景生效');
    assert.equal(await ui<string>(`getComputedStyle(document.documentElement).getPropertyValue('--accent-base').trim()`),'#61afef','One Dark 强调色');
    await capture('onedark-settings.png');
    await click('theme-toggle');assert.equal(await ui<string>(`document.documentElement.dataset.theme`),'light');
    await click('theme-toggle');assert.equal(await ui<string>(`document.documentElement.dataset.theme`),'onedark','侧栏切回上次的深色风格');
    await click('nav-home');await capture('onedark-overview.png');
    await click('nav-write');await capture('onedark-writer.png');
    await click('nav-idea');await capture('onedark-canvas.png');
    await click('nav-settings');await click('accent-teal');
    checks.push('深色与 One Dark 切换、配色方案与重启保留');
    await click('nav-read');await ui(`document.querySelector('.reader-scroll').scrollTo({top:420,behavior:'instant'})`);await delay(80);await click('nav-home');
    const current=store.getProject(project.id);
    writeFileSync(reportPath,JSON.stringify({projectId:project.id,revision:current.revision,scroll:current.reading.scroll,checks,screenshots:['overview.png','drawer-1080.png','writer.png','reader-dark.png','canvas-reduced-motion.png','overview-mobile.png','dark-overview.png','dark-writer.png','dark-canvas.png','dark-settings-teal.png','onedark-settings.png','onedark-overview.png','onedark-writer.png','onedark-canvas.png','overview-rose.png'],callsRealModel:false},null,2),'utf8');
    await closeWindow();console.log(`前端交互检查通过：${checks.join('；')}。`);return;
  }
  if (process.env.NOVEL_SMOKE_FOCUS === 'evolution') {
    if (process.env.NOVEL_SMOKE_REOPEN) {
      const report = JSON.parse(readFileSync(join(output, 'evolution-result.json'), 'utf8')) as { projectId: string; stateCount: number; theme: string };
      const saved = store.getProject(report.projectId);
      assert.equal(saved.theme, report.theme);
      assert.equal(saved.characterStates?.length, report.stateCount);
      await until(() => ui<boolean>(`document.querySelector('.app.view-home')?.textContent.includes('立意')`), '立意重开');
      await closeWindow(); console.log('人物演进与立意持久化检查通过。'); return;
    }
    await createProject('人物演进 · 最小验收');
    const project = await until(() => store.listProjects()[0], '创建作品');
    async function runTask(stage: RunRequest['stage'], tool?: AssistTool) {
      const prior = new Set(store.getRuns(project.id).map(run => run.id));
      await selectTask(stage, tool); await click(`run-${stage}`);
      const run = await until(() => store.getRuns(project.id).find(run => !prior.has(run.id)), '启动任务');
      const result = await finished(run.id);
      assert.equal(result.status, 'completed', result.error ?? '任务未完成');
      assert.ok(result.steps.some(step => step.agentId === 'theme' && step.status === 'completed'));
      return result;
    }
    await runTask('idea'); await runTask('outline');
    const planned = store.getProject(project.id);
    assert.ok(planned.theme);
    assert.ok((planned.characterStates?.length ?? 0) >= 3);
    await click('nav-write'); await runTask('chapter');
    const written = store.getProject(project.id);
    assert.ok(written.characterStates?.some(state => !state.evidence.startsWith('计划：')));
    await click('nav-objects');
    const character = written.objects.find(object => object.typeId === 'character')!;
    await ui(`[...document.querySelectorAll('.object-row')].find(el => el.querySelector('strong')?.textContent === ${JSON.stringify(character.name)}).click()`);
    await until(() => ui<boolean>(`!!document.querySelector('[data-testid="character-evolution"] details')`), '人物演进界面');
    await ui(`document.querySelector('[data-testid="character-evolution"]').open=true;document.querySelector('[data-testid="character-evolution"] details').open=true;document.querySelector('[data-testid="character-evolution"]').scrollIntoView({block:'start'})`);
    await capture('evolution-character.png');
    await clickText(written.cards.some(card => card.kind === 'object' && card.refId === character.id) ? '在画布定位' : '添加到画布', "document.querySelector('.object-inspector')");
    await until(() => ui<boolean>(`!!document.querySelector('.app.view-canvas .canvas-direction')`), '画布作品方向');
    const state = written.characterStates!.filter(state => state.characterId === character.id).at(-1)!;
    await until(() => ui<boolean>(`document.querySelector('.flow-container')?.textContent.includes(${JSON.stringify(state.psychology.slice(0, 12))})`), '画布人物心理同步');
    await capture('evolution-canvas.png');
    const follow = await runTask('assist', 'continuity');
    assert.ok(follow.steps.some(step => step.agentId === 'assist:continuity'));
    const current = store.getProject(project.id);
    writeFileSync(join(output, 'evolution-result.json'), JSON.stringify({ projectId: project.id, stateCount: current.characterStates!.length, theme: current.theme,
      checks: ['独立立意', '世界顺序人物演进', '正文依据更新', '人物记录界面', '引用心理同步', '专项一致性工具', '重开持久化'],
      screenshots: ['evolution-character.png', 'evolution-canvas.png'], callsRealModel: false }, null, 2), 'utf8');
    await closeWindow(); console.log('人物演进、立意与画布联动检查通过。'); return;
  }
  if (process.env.NOVEL_SMOKE_REOPEN) {
    const report = JSON.parse(readFileSync(join(output, 'smoke-result.json'), 'utf8')) as { projectId: string; title: string; revision: number; regressionProjectId: string; closeSceneId: string; closeText: string; interruptedRunId: string };
    const reopened = store.getProject(report.projectId);
    assert.equal(reopened.title, report.title); assert.equal(reopened.revision, report.revision);
    assert.ok(store.getRuns(report.projectId).some(run => run.stage === 'chapter' && run.status === 'completed'));
    assert.ok(store.history(report.projectId).some(batch => batch.undone));
    assert.equal(store.getProject(report.regressionProjectId).scenes.find(scene => scene.id === report.closeSceneId)?.text, report.closeText);
    assert.equal(store.getRun(report.interruptedRunId)?.status, 'cancelled');
    assert.ok(store.getRun(report.interruptedRunId)?.finishedAt, '关闭时尚未收尾的取消任务应在启动后补全结束时间');
    console.log('桌面重启检查通过：作品、任务、撤销记录及关闭前正文已恢复。');
    await closeWindow();
    return;
  }
  const providerPath = join(process.env.NOVEL_TEST_USER_DATA!, 'smoke-provider.json');
  const vault = new ProviderStore(providerPath);
  await vault.save({ name: '加密存储测试', baseURL: 'https://api.openai.com/v1', model: 'smoke-only', mode: 'live', apiKey: 'novel-smoke-dummy-key' });
  assert.equal((await vault.secret()).apiKey, 'novel-smoke-dummy-key');
  assert.ok(!readFileSync(providerPath, 'utf8').includes('novel-smoke-dummy-key'));
  await createProject('雾港来信 · 桌面验收');
  const project = await until(() => store.listProjects()[0], '新建作品');
  assert.equal(await ui<number>(`document.querySelector('[data-testid="nav-home"]')?.closest('nav')?.querySelectorAll('button').length`), 6, '主要导航为六个入口（含文风）');
  assert.equal(await ui<boolean>(`!!document.querySelector('.ai-sidebar')`), false, '新作品默认保持AI面板关闭');
  async function stage(name: RunRequest['stage'], nav: string, button: string, objective?: string) {
    await click(nav); await selectTask(name);
    if (name === 'chapter') await ui(setValue(element('[data-testid="chapter-scope"]'), 'chapter', 'change'));
    if (objective) await fill('ai-objective', objective);
    await click(button);
    const run = await until(() => store.getRuns(project.id).find(item => item.stage === name), `${name}启动`);
    const completed = await finished(run.id);
    assert.equal(completed.status, 'completed', completed.error ?? `${name}任务未完成`);
    return completed;
  }
  await stage('idea', 'nav-idea', 'run-idea', '创作一部关于雾港失踪信件的悬疑小说，强调有限视角和误解。');
  assert.ok(store.getProject(project.id).cards.length > 0);
  await stage('outline', 'nav-world', 'run-outline');
  const outlined = store.getProject(project.id);
  assert.ok(outlined.objects.some(object => object.typeId === 'character'));
  assert.ok(outlined.objects.some(object => object.event?.critical));
  assert.ok(outlined.scenes.length > 0);
  await click('nav-world'); await setPanel('ai', false); await setPanel('details', false);
  await capture('world.png');
  await click('nav-story');
  assert.ok(await ui<number>(`document.querySelectorAll('.react-flow__node').length`) > 0);
  assert.ok(await ui<boolean>(`[...document.querySelectorAll('.react-flow__handle')].every(el => getComputedStyle(el).visibility === 'hidden')`), '叙述顺序图没有可绘制连线的手柄');
  const storyTarget = outlined.scenes[0]!.id;
  const sceneOrderBeforeMove = outlined.scenes.map(({ id, chapterId, order }) => ({ id, chapterId, order }));
  await ui(`${nodeElement(storyTarget)}.click()`);
  await until(() => ui<boolean>(`(${nodeElement(storyTarget)})?.classList.contains('selected')`), '叙述节点选中');
  await ui(`${nodeElement(storyTarget)}.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  await until(() => store.getProject(project.id).layouts[`story:${storyTarget}`], '叙述节点移动保存布局');
  assert.deepEqual(store.getProject(project.id).scenes.map(({ id, chapterId, order }) => ({ id, chapterId, order })), sceneOrderBeforeMove, '叙述图移动不能修改章节或阅读顺序');
  assert.equal(store.getProject(project.id).revision, outlined.revision, '叙述图布局不增加语义修订');
  await capture('story.png');
  const written: AgentRun = await stage('chapter', 'nav-write', 'run-chapter');
  const manuscript = store.getProject(project.id);
  assert.ok(manuscript.scenes.some(scene => scene.text.trim().length > 50));
  assert.ok(written.steps.some(step => /角色|代入/.test(step.label)), '缺少独立角色步骤');
  assert.ok(written.steps.some(step => /读者/.test(step.label)), '缺少读者评审');
  assert.equal(written.sceneId, undefined, '明确选择整章生成时不发送单场景范围');
  await setPanel('ai', false); await until(() => ui<boolean>(`document.querySelector('[data-testid="prose-editor"]')?.value.length > 50`), '真实正文编辑器');
  await capture('writer.png'); await click('nav-home'); await capture('overview.png');
  await click('nav-read'); await capture('reader.png');
  const firstText = manuscript.scenes.find(scene => scene.text.trim())!.text.split('\n').find(paragraph => paragraph.trim())!.slice(0, 20);
  await until(() => ui<boolean>(`document.querySelector('.reader-scroll')?.textContent.includes(${JSON.stringify(firstText)})`), '阅读器显示真实正文');
  await click('nav-monitor'); await capture('monitor.png');
  await click('undo-task');
  await until(() => store.history(project.id).some(batch => batch.taskId === written.id && batch.undone), '撤销章节任务');
  const undone = store.getProject(project.id);
  assert.ok(undone.scenes.every(scene => !scene.text.trim()), '任务正文未撤销');

  await click('nav-idea');
  const previousCard = store.getProject(project.id).cards[0]!;
  const beforePrepareRuns = store.getRuns(project.id).length;
  await ui(`${nodeElement(previousCard.id)}.click()`);
  await until(() => ui<boolean>(`document.querySelector('.board-selection-toolbar')?.textContent.includes('已选 1')`), '准备引用卡片');
  await click('selection-agent-task');
  await until(() => ui<boolean>(`document.querySelector('.reference-chip')?.textContent.includes(${JSON.stringify(previousCard.title)})`), '引用进入任务草稿');
  await selectTask('assist', 'world'); await fill('ai-objective', '上一部作品的指令，不应带入新作品。');
  assert.equal(store.getRuns(project.id).length, beforePrepareRuns, '引用和任务类型选择不隐式执行AI');
  await createProject('数据完整性桌面回归');
  const regression = await until(() => store.listProjects().find(item => item.title === '数据完整性桌面回归'), '回归作品');
  await setPanel('ai', true);
  assert.equal(await ui<string>(`document.querySelector('[data-testid="task-type"]')?.value`), 'agent', '创建作品重置AI任务类型');
  assert.equal(await ui<string>(`document.querySelector('[data-testid="ai-objective"]')?.value`), '', '创建作品清空旧指令');
  assert.equal(await ui<number>(`document.querySelectorAll('.reference-chip').length`), 0, '创建作品清空旧引用');
  const initial = store.getProject(regression.id), laterChapter = initial.chapters[0]!.id;
  const ids = { a: 'smoke-a', b: 'smoke-b', event: 'smoke-event', fact: 'smoke-fact', oldFact: 'smoke-old-fact', knowledge: 'smoke-knowledge', group: 'smoke-group', note: 'smoke-note', link: 'smoke-card-link', earlyChapter: 'smoke-first-chapter', earlyScene: 'smoke-first-scene', laterScene: 'smoke-later-scene', duplicateScene: 'smoke-duplicate-scene' };
  const prose = Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 段，人物沿着雾港的街道寻找信件。`).join('\n\n');
  const commands: Command[] = [
    { type: 'putObject', value: { id: ids.a, typeId: 'character', name: '回归人物甲', fields: { description: '人物甲设定' } } },
    { type: 'putObject', value: { id: ids.b, typeId: 'character', name: '回归人物乙', fields: { description: '人物乙设定' } } },
    { type: 'putObject', value: { id: ids.event, typeId: 'event', name: '回归事件', fields: {}, event: { worldOrder: 1, timeLabel: '', thread: '主线', participants: [ids.a, ids.b], causes: [], critical: false, observations: {} } } },
    { type: 'putFact', value: { id: ids.fact, subjectId: ids.a, key: '回归事实', value: '原始事实', fromEventId: null } },
    { type: 'putFact', value: { id: ids.oldFact, subjectId: ids.a, key: '回归事实', value: '被替代事实', fromEventId: null } },
    { type: 'putKnowledge', value: { id: ids.knowledge, characterId: ids.a, content: '原始认知', learnedAt: null, source: 'initial' } },
    { type: 'putCard', value: { id: ids.group, kind: 'group', title: '回归分组', content: '', x: 20, y: 20 } },
    { type: 'putCard', value: { id: ids.note, kind: 'note', title: '回归便笺', content: '原始备注', x: 400, y: 100 } },
    { type: 'putCanvasLink', value: { id: ids.link, source: ids.group, target: ids.note } },
    { type: 'putChapter', value: { id: laterChapter, title: '排序靠后的章节', order: 20 } },
    { type: 'putChapter', value: { id: ids.earlyChapter, title: '排序靠前的章节', order: 10 } },
    { type: 'putScene', value: { id: ids.laterScene, chapterId: laterChapter, order: 8, title: '数组首项但排序靠后', povId: null, eventIds: [], outline: '', text: '靠后场景正文' } },
    { type: 'putScene', value: { id: ids.earlyScene, chapterId: ids.earlyChapter, order: 7, title: '正确的默认场景', povId: null, eventIds: [], outline: '', text: prose } },
    { type: 'putScene', value: { id: ids.duplicateScene, chapterId: laterChapter, order: 9, title: '同章重复顺序占位', povId: null, eventIds: [], outline: '', text: '同章已有正文' } },
  ];
  store.execute({ projectId: regression.id, expectedRevision: initial.revision, commands, actor: 'human', label: '桌面回归夹具' });
  window.webContents.reload();
  await until(() => ui<boolean>(`document.querySelector('.save-indicator')?.getAttribute('data-revision') === '1' && document.querySelector('.project-switch')?.value === ${JSON.stringify(regression.id)}`), '回归夹具加载');
  const current = () => store.getProject(regression.id);
  await click('nav-objects');
  await ui(`[...document.querySelectorAll('.object-row')].find(el => el.querySelector('strong')?.textContent === '回归人物甲').click()`);
  await until(() => ui<boolean>(`(${field('名称')})?.value === '回归人物甲'`), '人物表单');
  await expandDetails('object-facts'); await expandDetails('object-knowledge');
  await fillField('事实内容', '事实编辑后选事件'); await blurAndSelect('从哪个事件开始生效', ids.event);
  await until(() => { const fact = current().facts.find(item => item.id === ids.fact); return fact?.value === '事实编辑后选事件' && fact.fromEventId === ids.event; }, '事实编辑与事件选择都保存');
  await fillField('事实内容', '事实编辑后选替代'); await blurAndSelect('替代旧事实（可选）', ids.oldFact);
  await until(() => { const fact = current().facts.find(item => item.id === ids.fact); return fact?.value === '事实编辑后选替代' && fact.replacesId === ids.oldFact; }, '事实编辑与替代选择都保存');
  await fillField('知道 / 相信什么', '认知编辑后关联事实'); await blurAndSelect('关联世界事实（可选）', ids.oldFact);
  await until(() => { const item = current().knowledge.find(item => item.id === ids.knowledge); return item?.content === '认知编辑后关联事实' && item.factId === ids.oldFact; }, '认知编辑与事实选择都保存');
  await blurAndSelect('认知来源', 'told');
  await until(() => ui<boolean>(`!!(${field('告知者')})`), '告知者输入');
  await fillField('知道 / 相信什么', '认知编辑后选告知者'); await blurAndSelect('告知者', ids.b);
  await until(() => { const item = current().knowledge.find(item => item.id === ids.knowledge); return item?.content === '认知编辑后选告知者' && item.fromCharacterId === ids.b; }, '认知编辑与告知者选择都保存');
  await fillField('名称', '人物甲已修订', `document.querySelector('.object-inspector')`);
  await ui(`${blurField(field('名称', "document.querySelector('.object-inspector')"))};[...document.querySelectorAll('.object-row')].find(el => el.querySelector('strong')?.textContent === '回归人物乙').click()`);
  editingField = undefined;
  await until(() => ui<boolean>(`(${field('名称', "document.querySelector('.object-inspector')")})?.value === '回归人物乙' && (${field('作者设定')})?.value === '人物乙设定'`), '对象切换隔离表单草稿');
  assert.equal(current().objects.find(item => item.id === ids.a)?.name, '人物甲已修订');
  await clickText('管理类型与字段'); await clickText('添加字段');
  const numericField = await until(() => current().objectTypes.find(type => type.id === 'character')?.fields.find(item => item.label === '新字段'), '新增空字段');
  const labelInput = `document.querySelector('.type-field-row:last-child input')`;
  await ui(setValue(labelInput, '回归数字字段')); await delay(100);
  await ui(`${blurField(labelInput, "document.querySelector('.type-field-row:last-child select')")};${setValue("document.querySelector('.type-field-row:last-child select')", 'number', 'change')}`);
  await until(() => { const item = current().objectTypes.find(type => type.id === 'character')?.fields.find(item => item.id === numericField.id); return item?.label === '回归数字字段' && item.kind === 'number'; }, '字段标签与类型都保存');

  await click('nav-idea');
  await ui(`document.querySelector('.react-flow__node[data-id="${ids.note}"]').click()`);
  await fillField('标题', '便笺编辑后选分组', `document.querySelector('.board-inspector')`); await blurAndSelect('所属分组', ids.group);
  await until(() => { const card = current().cards.find(item => item.id === ids.note); return card?.title === '便笺编辑后选分组' && card.groupId === ids.group; }, '卡片标题与分组都保存');
  await fillField('灵感与备注', '备注编辑后移出分组'); await blurAndSelect('所属分组', '');
  await until(() => { const card = current().cards.find(item => item.id === ids.note); return card?.content === '备注编辑后移出分组' && !card.groupId; }, '卡片备注与分组都保存');
  const convertedChapter = [...current().chapters].sort((a, b) => a.order - b.order)[0]!.id;
  const maximumOrder = Math.max(0, ...current().scenes.filter(scene => scene.chapterId === convertedChapter).map(scene => scene.order));
  await clickText('转换为叙述场景');
  await until(() => current().cards.find(item => item.id === ids.note)?.kind === 'scene', '便笺转换');
  const convertedId = current().cards.find(item => item.id === ids.note)!.refId;
  assert.equal(current().scenes.find(scene => scene.id === convertedId)?.chapterId, convertedChapter, '便笺转换应采用排序后的默认章节');
  assert.equal(current().scenes.find(scene => scene.id === convertedId)?.order, maximumOrder + 1, '便笺转换应接在章内最大序号之后');

  await setPanel('details', true); await setPanel('ai', true);
  assert.ok(await ui<boolean>(`!!document.querySelector('.ai-sidebar') && !!document.querySelector('.board-inspector') && !document.querySelector('.main').inert`), '1510宽度详情与AI并排');
  await setPanel('ai', false);
  assert.ok(await ui<boolean>(`!!document.querySelector('.board-inspector') && !document.querySelector('.ai-sidebar')`), '关闭AI保留详情');
  window.setSize(1080, 900); await until(() => ui<boolean>(`matchMedia('(max-width:1279px)').matches && !!document.querySelector('.inspector-panel.drawer')`), '1080抽屉布局');
  await setPanel('ai', true);
  assert.ok(await ui<boolean>(`!!document.querySelector('.ai-sidebar') && !document.querySelector('.board-inspector')`), '1080宽度只有AI面板');
  // Measure after panel-enter finishes; its translateX(10px) start frame briefly overhangs the right edge.
  assert.ok(await ui<boolean>(`(async()=>{const panel=document.querySelector('.context-panel');if(!panel)return false;await Promise.all(panel.getAnimations().map(a=>a.finished));const r=panel.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight;})()`), '1080抽屉完整位于窗口内');
  await capture('1080.png');
  await setPanel('ai', false);
  assert.equal(await ui<boolean>(`!!document.querySelector('.context-body')`), false, '关闭抽屉不自动打开另一面板');
  window.setSize(1510, 980); await delay(180);

  await fitCanvas();
  await ui(`${nodeElement(ids.group, ' .group-drag-handle')}.click()`);
  await ui(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Control',code:'ControlLeft',ctrlKey:true,bubbles:true}))`);
  await delay(100);
  await ui(`${nodeElement(ids.note)}.dispatchEvent(new MouseEvent('click', {ctrlKey:true,bubbles:true}))`);
  await ui(`window.dispatchEvent(new KeyboardEvent('keyup', {key:'Control',code:'ControlLeft',bubbles:true}))`);
  await until(() => ui<boolean>(`document.querySelector('.board-selection-toolbar')?.textContent.includes('已选 2')`), '批量删除选择两个卡片');
  const cardsBeforeDelete = structuredClone(current().cards);
  await clickText('删除选中内容', "document.querySelector('.board-selection-toolbar')");
  await until(() => ui<boolean>(`document.querySelector('.app-dialog[open]')?.textContent.includes('删除选中的 2 个卡片')`), '批量删除只有一个聚合确认');
  assert.equal(await ui<number>(`document.querySelectorAll('.app-dialog[open]').length`), 1);
  assert.equal(await ui<number>(`(document.querySelector('.app-dialog[open]')?.textContent.match(/画布关联/g)||[]).length`), 1, '两个端点的同一关联只展示一次影响');
  assert.deepEqual(current().cards, cardsBeforeDelete, '确认前不删除内容');
  await clickText('确认删除', "document.querySelector('.app-dialog[open]')");
  await until(() => !current().cards.some(card => card.id === ids.group || card.id === ids.note), '批量删除保存');
  const deletion = store.history(regression.id)[0]!;
  assert.equal(deletion.changes.filter(change => change.collection === 'cards' && change.after === undefined).length, 2, '批量删除只写一个操作批次');
  assert.ok(!current().canvasLinks.some(link => link.id === ids.link));
  assert.ok(current().scenes.some(scene => scene.id === convertedId), '删除引用卡片保留原场景');
  await click('nav-monitor');
  await ui(`[...document.querySelectorAll('.monitor-page .segmented button')].find(button => button.textContent.startsWith('修改历史')).click()`);
  await until(() => ui<boolean>(`!!document.querySelector('.history-item')`), '删除历史');
  await ui(`[...document.querySelectorAll('.history-item')].find(item=>item.querySelector('summary strong')?.textContent===${JSON.stringify(deletion.label)}).querySelector('summary button').click()`);
  await until(() => store.history(regression.id).find(batch => batch.id === deletion.id)?.undone, '批量删除整体撤销');
  assert.deepEqual(current().cards, cardsBeforeDelete);
  assert.ok(current().canvasLinks.some(link => link.id === ids.link));

  await click('nav-write'); await selectTask('chapter');
  assert.equal(await ui<string>(`document.querySelector('.writer-toolbar h2')?.textContent`), '正确的默认场景');
  assert.equal(await ui<string>(`document.querySelector('[data-testid="chapter-scope"]')?.value`), 'scene', '从写作准备生成默认单场景');
  assert.equal(await ui<string>(`document.querySelector('[data-testid="target-scene"]')?.value`), ids.earlyScene);
  assert.equal(await ui<boolean>(`document.querySelector('[data-testid="run-chapter"]')?.disabled`), true, '已有正文的场景不能重复生成');
  await ui(setValue(element('[data-testid="target-scene"]'), convertedId!, 'change'));
  assert.equal(await ui<string>(`document.querySelector('.writer-toolbar h2')?.textContent`), '正确的默认场景', 'AI目标选择不切换编辑器场景');
  await click('run-chapter');
  const singleSceneRun = await until(() => store.getRuns(regression.id).find(run => run.stage === 'chapter'), '指定空白场景生成');
  assert.equal(singleSceneRun.sceneId, convertedId);
  assert.equal((await finished(singleSceneRun.id)).status, 'completed');
  assert.equal(current().scenes.find(scene => scene.id === ids.earlyScene)?.text, prose, '单场景生成保留其他正文');
  assert.equal(current().scenes.find(scene => scene.id === ids.laterScene)?.text, '靠后场景正文');
  await click('undo-result');
  await until(() => store.history(regression.id).some(batch => batch.taskId === singleSceneRun.id && batch.undone), '产出区域就地撤销');
  assert.equal(current().scenes.find(scene => scene.id === convertedId)?.text, '');
  await ui(setValue(element('[data-testid="target-scene"]'), ids.earlyScene, 'change'));
  await ui(setValue(element('[data-testid="chapter-scope"]'), 'chapter', 'change'));
  assert.equal(await ui<string>(`document.querySelector('[data-testid="target-chapter"]')?.value`), ids.earlyChapter);
  assert.equal(await ui<string>(`document.querySelector('.target-scene > span')?.textContent`), '目标章节');
  const beforeSelectRuns = store.getRuns(regression.id).length;
  await ui(`(() => { const el = document.querySelector('[data-testid="prose-editor"]'); el.focus(); el.setSelectionRange(0, 12); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); })()`);
  await delay(100);
  assert.equal(await ui<string>(`document.querySelector('[data-testid="task-type"]')?.value`), 'chapter', '普通选区不切换任务类型');
  assert.equal(store.getRuns(regression.id).length, beforeSelectRuns, '选中文字不隐式执行任务');
  await click('prepare-rewrite');
  assert.equal(await ui<string>(`document.querySelector('[data-testid="target-scene"]')?.value`), ids.earlyScene);
  assert.ok(await ui<boolean>(`document.querySelector('.selection-preview')?.textContent.includes(${JSON.stringify(prose.slice(0, 12))})`), '改写草稿显示实际选段');
  assert.equal(store.getRuns(regression.id).length, beforeSelectRuns, '改写行动只准备任务');
  await click('run-rewrite');
  const rewrite = await until(() => store.getRuns(regression.id).find(run => run.stage === 'rewrite'), '默认场景改写启动');
  assert.equal(rewrite.sceneId, ids.earlyScene); assert.equal((await finished(rewrite.id)).status, 'completed');
  assert.equal(current().scenes.find(scene => scene.id === ids.laterScene)?.text, '靠后场景正文');
  assert.ok(current().scenes.find(scene => scene.id === ids.earlyScene)!.text.endsWith(prose.slice(12)), '改写保留选区之外的正文');

  await ui(`(() => { const el = document.querySelector('[data-testid="prose-editor"]'); el.focus(); el.setSelectionRange(0, 8); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); })()`);
  await click('prepare-rewrite'); await fill('ai-objective', '不要带到另一部作品的选段指令');
  await ui(setValue(element('.project-switch'), project.id, 'change'));
  await until(() => ui<boolean>(`document.querySelector('.app.view-home') && document.querySelector('.project-switch')?.value === ${JSON.stringify(project.id)}`), '切换作品清空任务上下文');
  await setPanel('ai', true);
  assert.equal(await ui<string>(`document.querySelector('[data-testid="task-type"]')?.value`), 'agent', '切换作品重置AI任务类型');
  assert.equal(await ui<string>(`document.querySelector('[data-testid="ai-objective"]')?.value`), '');
  assert.equal(await ui<number>(`document.querySelectorAll('.reference-chip,.selection-preview').length`), 0, '切换作品清空旧引用和选段');
  await ui(setValue(element('.project-switch'), regression.id, 'change'));
  await until(() => ui<boolean>(`document.querySelector('.app.view-home') && document.querySelector('.project-switch')?.value === ${JSON.stringify(regression.id)}`), '返回回归作品');

  await click('nav-read');
  await ui(`document.querySelector('.reader-scroll').dispatchEvent(new Event('scroll', { bubbles: true }));${setValue("document.querySelector('.reader-controls select')", laterChapter, 'change')}`);
  await until(() => current().reading.chapterId === laterChapter, '阅读切换章节');
  await delay(1100);
  assert.equal(current().reading.chapterId, laterChapter, '旧阅读计时器不能切回上一章');
  assert.equal(await ui<string>(`document.querySelector('.reader-scroll article h2')?.textContent`), '排序靠后的章节');

  await click('nav-settings');
  await until(() => ui<boolean>(`!!document.querySelector('.story-memory .story-memory-stats')`), '故事记忆面板');
  await ui(`[...document.querySelectorAll('.story-memory button')].find(el => el.textContent === '立即整理')?.click()`);
  await until(() => ui<boolean>(`document.querySelector('.story-memory .pill')?.textContent === '已是最新'`), '故事记忆整理完成');
  const memory = new StoryView(current(), store.getStoryDigests(regression.id)).coverage();
  assert.ok(memory.scenesWithText > 0 && memory.pending === 0, '故事记忆覆盖全部已写场景');
  assert.ok(store.getStoryDigests(regression.id).some(digest => digest.kind === 'book'), '故事记忆生成全书梗概');
  await capture('story-memory.png');

  await click('nav-write');
  await ui(`[...document.querySelectorAll('.scene-row > button')].find(el => el.querySelector('strong')?.textContent === '数组首项但排序靠后').click()`);
  await until(() => ui<boolean>(`document.querySelector('.writer-toolbar h2')?.textContent === '数组首项但排序靠后'`), '队列恢复场景');
  await clickText('场景大纲');
  await fillField('阅读顺序（章内）', '9'); await ui(blurField(field('阅读顺序（章内）')));
  editingField = undefined;
  await until(() => ui<boolean>(`document.querySelector('.toast.error')?.textContent.includes('场景顺序不能重复')`), '重复顺序保存失败');
  assert.equal(current().scenes.find(scene => scene.id === ids.laterScene)?.order, 8, '失败操作没有写入领域数据');
  assert.equal(await ui<string>(`(${field('阅读顺序（章内）')})?.value`), '9', '普通字段保存失败保留输入');
  await ui(`document.querySelector('[data-testid="nav-home"]').click()`); await delay(180);
  assert.ok(await ui<boolean>(`!!document.querySelector('.app.view-write')`), '普通字段失败草稿阻止离开页面');
  assert.equal(await ui<string>(`(${field('阅读顺序（章内）')})?.value`), '9');
  await fillField('阅读顺序（章内）', '8'); await ui(blurField(field('阅读顺序（章内）'))); editingField = undefined;
  await until(() => ui<boolean>(`!document.querySelector('.inspector-body .field-error')`), '重新编辑修复失败草稿');
  const countBeforeRecovery = current().scenes.length;
  await ui(`[...document.querySelectorAll('.chapter-block')].find(el => el.querySelector('.chapter-title input')?.value === '排序靠后的章节').querySelector('.add-scene').click()`);
  await until(() => current().scenes.length === countBeforeRecovery + 1, '失败队列后仍可新增场景');
  await ui(`[...document.querySelectorAll('.scene-row > button')].find(el => el.querySelector('strong')?.textContent === '正确的默认场景').click()`);
  await until(() => ui<boolean>(`document.querySelector('.writer-toolbar h2')?.textContent === '正确的默认场景'`), '回到冲突测试场景');
  const savedBeforeConflict = current().scenes.find(scene => scene.id === ids.earlyScene)!.text;
  const draft = '这个人工草稿必须在冲突后留在编辑器。';
  await ui(`document.querySelector('[data-testid="prose-editor"]').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))`);
  await fill('prose-editor', draft);
  const conflicting = scheduler.start({ projectId: regression.id, stage: 'rewrite', sceneId: ids.earlyScene, chapterId: ids.earlyChapter, selection: { start: 0, end: 12 }, objective: '模拟另一项保存与人工草稿冲突' });
  assert.equal((await finished(conflicting.id)).status, 'completed');
  await until(() => ui<boolean>(`!!document.querySelector('.conflict-banner')`), '正文冲突提示');
  assert.notEqual(current().scenes.find(scene => scene.id === ids.earlyScene)!.text, savedBeforeConflict);
  const countBeforeConflict = current().scenes.length;
  await ui(`document.querySelector('.chapter-block .add-scene').click()`);
  await until(() => ui<boolean>(`document.querySelector('.toast.error')?.textContent.includes('冲突')`), '冲突阻止新增场景');
  assert.equal(current().scenes.length, countBeforeConflict);
  assert.equal(await ui<string>(`document.querySelector('[data-testid="prose-editor"]')?.value`), draft);
  await ui(`document.querySelector('.toast button').click()`);
  window.close();
  await until(() => !window.isDestroyed() && ui<boolean>(`document.querySelector('.toast.error')?.textContent.includes('冲突')`), '冲突阻止窗口关闭');
  await delay(200);
  assert.ok(!window.isDestroyed(), '正文冲突时窗口应保持打开');
  assert.equal(await ui<string>(`document.querySelector('[data-testid="prose-editor"]')?.value`), draft);
  await clickText('使用当前保存内容');
  await ui(`document.querySelector('[data-testid="prose-editor"]').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))`);
  const closeText = '立即关闭窗口前输入的正文，重开后必须完整恢复。';
  const interruptedRunId = 'smoke-interrupted-cancelled';
  store.saveRun({ ...rewrite, id: interruptedRunId, status: 'cancelled', finishedAt: undefined });
  // Close before the 600 ms autosave; persistence must come from the close handshake.
  await ui(setValue("document.querySelector('[data-testid=\"prose-editor\"]')", closeText));
  await delay(40);
  await closeWindow();
  assert.equal(current().scenes.find(scene => scene.id === ids.earlyScene)?.text, closeText);
  const report = { projectId: project.id, title: undone.title, revision: undone.revision,
    regressionProjectId: regression.id, closeSceneId: ids.earlyScene, closeText, interruptedRunId,
    checks: ['SQLite', 'safeStorage', 'preload IPC', '对话框创建作品', '六项主要导航（含文风）', '构思', '双线大纲', '叙述图不改章节或顺序', '独立角色参考', '整章与单场景正文范围', '读者评审', '阅读器', '任务撤销', '表单连续编辑', '对象草稿隔离', '类型标签与类型连续修改', '便笺场景顺序', 'AI引用与选区不隐式执行', '项目切换清空AI上下文', '批量删除影响去重与整体撤销', '1510与1080单侧栏互斥', '默认改写目标与选段预览', '章节目标标签', '阅读切章计时器', '普通字段失败草稿保护与恢复', '失败队列后继续编辑', '冲突草稿拒绝新增与关闭', '关闭前保存', '中断取消任务恢复', '故事记忆整理'],
    callsRealModel: false, screenshots: ['overview.png', 'writer.png', 'world.png', 'story.png', 'reader.png', 'monitor.png', '1080.png', 'story-memory.png'] };
  writeFileSync(join(output, 'smoke-result.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`桌面流程检查通过：${report.checks.join('、')}。未调用真实模型。`);
}
