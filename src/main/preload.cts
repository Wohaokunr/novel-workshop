import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../shared/types.js';
const api: DesktopAPI = {
  listProjects: () => ipcRenderer.invoke('novel:list'),
  createProject: title => ipcRenderer.invoke('novel:create', title),
  loadProject: id => ipcRenderer.invoke('novel:load', id),
  execute: request => ipcRenderer.invoke('novel:execute', request),
  deleteImpact: (id, command) => ipcRenderer.invoke('novel:impact', id, command),
  history: id => ipcRenderer.invoke('novel:history', id),
  undo: (id, batch) => ipcRenderer.invoke('novel:undo', id, batch),
  getRuns: id => ipcRenderer.invoke('novel:runs', id),
  startRun: request => ipcRenderer.invoke('agent:start', request),
  cancelRun: id => ipcRenderer.invoke('agent:cancel', id),
  retryRun: (id, revision) => ipcRenderer.invoke('agent:retry', id, revision),
  getSession: projectId => ipcRenderer.invoke('agent:session', projectId),
  pauseRun: id => ipcRenderer.invoke('agent:pause', id),
  resumeRun: (id, confirmUncertain) => ipcRenderer.invoke('agent:resume', id, confirmUncertain),
  decideCandidate: decision => ipcRenderer.invoke('agent:decide', decision),
  answerRun: (id, answer) => ipcRenderer.invoke('agent:answer', id, answer),
  getMemories: projectId => ipcRenderer.invoke('agent:memories', projectId),
  saveMemory: (projectId, content, kind) => ipcRenderer.invoke('agent:memory-save', projectId, content, kind),
  confirmMemory: (projectId, id) => ipcRenderer.invoke('agent:memory-confirm', projectId, id),
  deleteMemory: (projectId, id) => ipcRenderer.invoke('agent:memory-delete', projectId, id),
  askCompanion: request => ipcRenderer.invoke('companion:ask', request),
  cancelCompanion: (projectId, threadId) => ipcRenderer.invoke('companion:cancel', projectId, threadId),
  getCompanionThreads: projectId => ipcRenderer.invoke('companion:threads', projectId),
  adoptCompanion: request => ipcRenderer.invoke('companion:adopt', request),
  undoCompanion: (projectId, threadId, batchId) => ipcRenderer.invoke('companion:undo', projectId, threadId, batchId),
  deleteCompanionThread: (projectId, threadId) => ipcRenderer.invoke('companion:delete', projectId, threadId),
  getStoryMemory: projectId => ipcRenderer.invoke('story:status', projectId),
  runStoryMemory: projectId => ipcRenderer.invoke('story:run', projectId),
  stopStoryMemory: projectId => ipcRenderer.invoke('story:stop', projectId),
  getStyleLearning: projectId => ipcRenderer.invoke('style:status', projectId),
  learnStyle: projectId => ipcRenderer.invoke('style:learn', projectId),
  getProvider: () => ipcRenderer.invoke('provider:get'),
  saveProvider: input => ipcRenderer.invoke('provider:save', input),
  testProvider: () => ipcRenderer.invoke('provider:test'),
  exportProject: id => ipcRenderer.invoke('files:backup', id),
  importProject: () => ipcRenderer.invoke('files:restore'),
  exportText: id => ipcRenderer.invoke('files:export', id),
  onAgentEvent: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<Parameters<DesktopAPI['onAgentEvent']>[0]>[0]) => listener(value);
    ipcRenderer.on('agent:event', handler);
    return () => { ipcRenderer.removeListener('agent:event', handler); };
  },
  onCloseRequested: listener => {
    const handler = () => listener();
    ipcRenderer.on('window:close-requested', handler);
    return () => { ipcRenderer.removeListener('window:close-requested', handler); };
  },
  confirmClose: () => ipcRenderer.invoke('window:confirm-close'),
};
contextBridge.exposeInMainWorld('novel', api);
