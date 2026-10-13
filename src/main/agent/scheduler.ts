import type { AgentDecision, AgentMemory } from '../../shared/agent-types.js';
import type { AgentEvent, AgentRun, ProviderSecret, RunRequest, NarrativeScene } from '../../shared/types.js';
import { NovelStore } from '../store.js';
import { resolveReferences } from '../context.js';
import { OpenAIResponseTransport, runAgent, type EmbeddingTransport, type ResponseTransport } from '../responses.js';
import { PersistentAgentRuntime } from './runtime.js';
import { DemoAgentTransport } from './demo.js';

export class NovelAgentScheduler {
  private readonly runtime: PersistentAgentRuntime;
  constructor(private store: NovelStore, private getProvider: () => ProviderSecret | Promise<ProviderSecret>, private onEvent: (event: AgentEvent) => void,
    transportFactory?: (provider: ProviderSecret) => ResponseTransport, embedderFactory?: (provider: ProviderSecret & { embeddingModel: string }) => EmbeddingTransport) {
    this.runtime = new PersistentAgentRuntime(store, getProvider, onEvent, (provider, request, project) => transportFactory?.(provider)
      ?? (provider.mode === 'mock' ? new DemoAgentTransport(request, project) : new OpenAIResponseTransport(provider)), embedderFactory);
  }
  start(request: RunRequest): AgentRun { return this.runtime.start(request); }
  async cancel(id: string) {
    if (this.store.getStoredAgentState(id)) return this.runtime.cancel(id);
    const run = this.store.getRun(id);
    if (run && !run.finishedAt) { run.status = 'cancelled'; run.finishedAt = new Date().toISOString(); this.store.saveRun(run); this.onEvent({ type: 'run', projectId: run.projectId, runId: id, run }); }
  }
  pause(id: string) { return this.runtime.pause(id); }
  resume(id: string, confirmUncertain = false) { return this.runtime.resume(id, confirmUncertain); }
  decide(decision: AgentDecision) { return this.runtime.decide(decision); }
  answer(id: string, answer: string) { return this.runtime.answer(id, answer); }
  recover() { return this.runtime.recover(); }
  shutdown() { return this.runtime.shutdown(); }
  getMemories(projectId: string) { return this.runtime.getMemories(projectId); }
  saveMemory(projectId: string, content: string, kind: AgentMemory['kind']) { return this.runtime.saveMemory(projectId, content, kind); }
  confirmMemory(projectId: string, id: string) { return this.runtime.confirmMemory(projectId, id); }
  async retry(id: string, revision: number): Promise<AgentRun> {
    if (this.store.getStoredAgentState(id)) return this.runtime.retry(id, revision);
    const previous = this.store.getRun(id);
    if (!previous || !['failed', 'cancelled'].includes(previous.status) || !previous.finishedAt) throw new Error('只有已结束的失败/停止任务可以重试');
    if (this.store.getRuns(previous.projectId).some(run => !['failed', 'cancelled', 'completed'].includes(run.status) || !run.finishedAt)) throw new Error('作品还有未结束任务');
    const project = this.store.getProject(previous.projectId);
    if (project.revision !== revision) throw new Error('REVISION_CONFLICT：作品已更新');
    resolveReferences(project, previous.references);
    const batches = this.store.history(project.id).filter(batch => batch.taskId === id && !batch.undone);
    if (previous.stage === 'rewrite') {
      const originalText = (previous.steps.find(step => step.agentId === 'rewrite')?.input as { context?: { scene?: NarrativeScene } } | undefined)?.context?.scene?.text;
      const first = [...batches].reverse().flatMap(batch => batch.changes).find(change => change.collection === 'scenes' && change.key === previous.sceneId);
      const restoredText = first ? (first.before as NarrativeScene | undefined)?.text : project.scenes.find(scene => scene.id === previous.sceneId)?.text;
      if (typeof originalText !== 'string' || restoredText !== originalText) throw new Error('原改写正文无法确认，请重新选择正文发起任务');
    }
    if (batches.length) { this.store.undo(project.id, id); this.onEvent({ type: 'projectChanged', projectId: project.id, runId: id }); }
    const { projectId, stage, tool, objective, chapterId, sceneId, selection, references } = previous;
    return this.start({ projectId, stage, tool, objective, chapterId, sceneId, selection, references });
  }
  async testProvider(): Promise<string> {
    const provider = await this.getProvider();
    if (provider.mode === 'mock') return '演示模式使用本地模拟 Responses，不会请求模型或产生费用';
    if (!provider.apiKey) throw new Error('请先填写 API Key');
    try {
      await runAgent({ id: 'connection', label: '连接测试', instructions: 'Reply briefly with OK.' }, {
        transport: new OpenAIResponseTransport(provider, { retries: 0 }), context: {}, objective: 'Reply OK.', signal: new AbortController().signal, contextSources: [],
      });
      return `已连接 ${provider.name} / ${provider.model}（Responses 流式请求成功）`;
    } catch (error) { throw new Error((error instanceof Error ? error.message : String(error)).replaceAll(provider.apiKey, '[API Key 已隐藏]')); }
  }
}
