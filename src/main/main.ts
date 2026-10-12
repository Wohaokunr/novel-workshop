import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { NovelStore } from './store.js';
import { ProviderStore } from './providers.js';
import { NovelAgentScheduler } from './agents.js';
import { CompanionService } from './agent/companion.js';
import { DemoCompanionTransport } from './agent/companion-demo.js';
import { DemoStoryTransport, StoryMemoryService } from './agent/story-memory.js';
import { DemoStyleTransport, StyleLearningService } from './agent/style-learning.js';
import { OpenAIResponseTransport } from './responses.js';
import type { CompanionAdoptRequest, CompanionAskRequest } from '../shared/companion-types.js';
import { chapterText } from './domain.js';
import type { AgentDecision, AgentMemory } from '../shared/agent-types.js';
import type { AgentEvent, Command, CommandRequest, ProviderInput, RunRequest } from '../shared/types.js';

app.setName('叙境');
if (process.env.NOVEL_TEST_USER_DATA) { mkdirSync(process.env.NOVEL_TEST_USER_DATA, { recursive: true }); app.setPath('userData', process.env.NOVEL_TEST_USER_DATA); }
let mainWindow: BrowserWindow | null = null;
let store: NovelStore;
let scheduler: NovelAgentScheduler;
let companion: CompanionService;
let storyMemory: StoryMemoryService;
let styleLearning: StyleLearningService;
let closeAllowed = false;
let shutdownComplete = false;
const here = dirname(fileURLToPath(import.meta.url));

function handle(channel: string, action: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('无效的桌面请求');
    return action(...args);
  });
}
function fileName(title: string) { return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || '作品'; }

// Keep the ESM entrypoint synchronous; Electron emits ready after it has loaded.
app.whenReady().then(async () => {
try {
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });
  store = new NovelStore(join(dataDir, 'workspaces.sqlite'));
  const providers = new ProviderStore(join(dataDir, 'provider.json'));
  const send = (event: AgentEvent) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent:event', event); };
  storyMemory = new StoryMemoryService(store, () => providers.secret(), send,
    provider => provider.mode === 'mock' ? new DemoStoryTransport() : new OpenAIResponseTransport(provider));
  styleLearning = new StyleLearningService(store, () => providers.secret(), send,
    provider => provider.mode === 'mock' ? new DemoStyleTransport() : new OpenAIResponseTransport(provider));
  // Any saved change may leave prose without an up-to-date digest.
  const relay = (event: AgentEvent) => { send(event); if (event.type === 'projectChanged') storyMemory.touch(event.projectId); };
  scheduler = new NovelAgentScheduler(store, () => providers.secret(), relay);
  companion = new CompanionService(store, () => providers.secret(), relay,
    provider => provider.mode === 'mock' ? new DemoCompanionTransport() : new OpenAIResponseTransport(provider));
  scheduler.recover();
  for (const project of store.listProjects()) for (const run of store.getRuns(project.id)) {
    if (store.getStoredAgentState(run.id)) continue;
    if (run.status === 'running' || run.status === 'queued' || (run.status === 'cancelled' && !run.finishedAt)) {
      store.saveRun({ ...run, status: run.status === 'cancelled' ? 'cancelled' : 'failed', finishedAt: new Date().toISOString(),
        ...(run.status !== 'cancelled' ? { error: '应用关闭时任务中断，可以重新运行。' } : {}) });
    }
  }
  handle('novel:list', () => store.listProjects());
  handle('novel:create', (title: string) => { if (typeof title !== 'string' || !title.trim()) throw new Error('请输入作品名称'); return store.createProject(title.trim()); });
  handle('novel:load', (id: string) => { const project = store.getProject(id); storyMemory.touch(id); return project; });
  handle('novel:execute', (request: CommandRequest) => {
    if (!request || request.actor !== 'human' || request.taskId !== undefined) throw new Error('AI 修改只能经候选审批执行');
    const project = store.execute(request); storyMemory.touch(project.id); return project;
  });
  handle('novel:impact', (id: string, command: Command) => store.deleteImpact(id, command));
  handle('novel:history', (id: string) => store.history(id));
  handle('novel:undo', (id: string, batch: string) => { const project = store.undo(id, batch); storyMemory.touch(id); return project; });
  handle('novel:runs', (id: string) => store.getRuns(id));
  handle('agent:start', (request: RunRequest) => scheduler.start(request));
  handle('agent:cancel', (id: string) => scheduler.cancel(id));
  handle('agent:retry', (id: string, revision: number) => scheduler.retry(id, revision));
  handle('agent:session', (projectId: string) => store.getSession(projectId));
  handle('agent:pause', (id: string) => scheduler.pause(id));
  handle('agent:resume', (id: string, confirmUncertain?: boolean) => {
    if (confirmUncertain !== undefined && typeof confirmUncertain !== 'boolean') throw new Error('恢复确认无效');
    return scheduler.resume(id, confirmUncertain);
  });
  handle('agent:decide', (decision: AgentDecision) => scheduler.decide(decision));
  handle('agent:answer', (id: string, answer: string) => scheduler.answer(id, answer));
  handle('agent:memories', (projectId: string) => scheduler.getMemories(projectId));
  handle('agent:memory-save', (projectId: string, content: string, kind: AgentMemory['kind']) => scheduler.saveMemory(projectId, content, kind));
  handle('agent:memory-confirm', (projectId: string, id: string) => scheduler.confirmMemory(projectId, id));
  handle('agent:memory-delete', (projectId: string, id: string) => store.deleteAgentMemory(projectId, id));
  handle('companion:ask', (request: CompanionAskRequest) => companion.ask(request));
  handle('companion:cancel', (projectId: string, threadId: string) => companion.cancel(projectId, threadId));
  handle('companion:threads', (projectId: string) => companion.threads(projectId));
  handle('companion:adopt', (request: CompanionAdoptRequest) => companion.adopt(request));
  handle('companion:undo', (projectId: string, threadId: string, batchId: string) => companion.undo(projectId, threadId, batchId));
  handle('companion:delete', (projectId: string, threadId: string) => companion.delete(projectId, threadId));
  handle('window:confirm-close', () => {
    closeAllowed = true;
    setImmediate(() => mainWindow?.close());
  });
  handle('story:status', (projectId: string) => storyMemory.status(projectId));
  handle('story:run', async (projectId: string) => { void storyMemory.run(projectId); return storyMemory.status(projectId); });
  handle('story:stop', (projectId: string) => { storyMemory.stop(projectId); return storyMemory.status(projectId); });
  handle('style:status', (projectId: string) => styleLearning.status(projectId));
  handle('style:learn', (projectId: string) => { void styleLearning.learn(projectId); return styleLearning.status(projectId); });
  handle('provider:get', () => providers.public());
  handle('provider:save', (input: ProviderInput) => providers.save(input));
  handle('provider:test', () => scheduler.testProvider());
  handle('files:backup', async (id: string) => {
    const workspace = store.getProject(id);
    const choice = await dialog.showSaveDialog(mainWindow!, { title: '备份作品', defaultPath: `${fileName(workspace.title)}.novel.json`, filters: [{ name: '叙境作品', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePath) return null;
    writeFileSync(choice.filePath, JSON.stringify({ format: 'novel-workshop', version: 1, exportedAt: new Date().toISOString(), workspace }, null, 2), 'utf8');
    return choice.filePath;
  });
  handle('files:restore', async () => {
    const choice = await dialog.showOpenDialog(mainWindow!, { title: '恢复作品（创建独立副本）', properties: ['openFile'], filters: [{ name: '叙境作品', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    return store.importProject(readFileSync(choice.filePaths[0], 'utf8'));
  });
  handle('files:export', async (id: string) => {
    const workspace = store.getProject(id);
    const choice = await dialog.showSaveDialog(mainWindow!, { title: '导出正文', defaultPath: `${fileName(workspace.title)}.txt`, filters: [{ name: '纯文本', extensions: ['txt'] }] });
    if (choice.canceled || !choice.filePath) return null;
    const text = [workspace.title, ...[...workspace.chapters].sort((a, b) => a.order - b.order).map(chapter => `${chapter.title}\n\n${chapterText(workspace, chapter.id)}`)].join('\n\n');
    writeFileSync(choice.filePath, `\uFEFF${text}`, 'utf8'); return choice.filePath;
  });

  const nativeInteraction = process.env.NOVEL_SMOKE_FOCUS === 'interaction';
  mainWindow = new BrowserWindow({ width: 1510, height: 980, minWidth: 1080, minHeight: 720, title: '叙境', show: !process.env.NOVEL_SMOKE || nativeInteraction, backgroundColor: '#f5f6f8', autoHideMenuBar: true,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: !process.env.NOVEL_SMOKE, offscreen: Boolean(process.env.NOVEL_SMOKE) && !nativeInteraction },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (!current || new URL(url).origin !== new URL(current).origin || (!process.env.NOVEL_DEV_URL && url.split('#')[0] !== current.split('#')[0])) event.preventDefault();
  });
  mainWindow.on('close', event => {
    if (!closeAllowed) {
      event.preventDefault();
      mainWindow!.webContents.send('window:close-requested');
      return;
    }
    if (!shutdownComplete) {
      event.preventDefault();
      companion.shutdown(); storyMemory.shutdown(); styleLearning.shutdown();
      void scheduler.shutdown().then(() => { shutdownComplete = true; mainWindow?.close(); }).catch(error => {
        console.error('任务关闭保存失败', error); closeAllowed = false;
        dialog.showErrorBox('任务尚未安全保存', '请检查磁盘状态后重试关闭。');
      });
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  if (process.env.NOVEL_DEV_URL) await mainWindow.loadURL(process.env.NOVEL_DEV_URL);
  else await mainWindow.loadFile(join(here, '../renderer/index.html'));
  if (process.env.NOVEL_SMOKE) { const { runSmoke } = await import('./smoke.js'); await runSmoke(mainWindow, store, scheduler); app.quit(); }
} catch (error) {
  if (process.env.NOVEL_SMOKE && process.env.NOVEL_SMOKE_OUTPUT && mainWindow && !mainWindow.isDestroyed()) {
    try { writeFileSync(join(process.env.NOVEL_SMOKE_OUTPUT, 'failure.png'), (await mainWindow.webContents.capturePage()).toPNG()); } catch {}
  }
  console.error(error);
  if (!process.env.NOVEL_SMOKE) dialog.showErrorBox('叙境启动失败', error instanceof Error ? error.message : String(error));
  app.exit(1);
}
});
app.on('window-all-closed', () => { if (!process.env.NOVEL_SMOKE) app.quit(); });
