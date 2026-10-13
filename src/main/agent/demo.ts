import { randomUUID } from 'node:crypto';
import type { ResponseOutputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { RunRequest, Workspace } from '../../shared/types.js';
import type { PlanNode } from '../../shared/agent-types.js';
import { chapterPassages, orderedChapters, orderedScenes, scenePassages } from '../../shared/structure.js';
import { demoAssist, demoIdea, demoOutline, demoText } from '../agents.js';
import { applyCommands } from '../domain.js';
import { resolveReferences } from '../context.js';
import { checkCancelled, restoreProse, type ModelRequest, type ModelResponse, type ResponseTransport } from '../responses.js';

type Call = Extract<ResponseOutputItem, { type: 'function_call' }>;
function message(value: unknown): ResponseOutputItem {
  return { type: 'message', id: randomUUID(), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: typeof value === 'string' ? value : JSON.stringify(value), annotations: [] }] };
}
function invoke(name: string, args: unknown): Call { return { type: 'function_call', id: randomUUID(), call_id: randomUUID(), name, arguments: JSON.stringify(args) }; }
function contextOf(request: ModelRequest): Record<string, any> { return restoreProse(request.input); }

/** Offline fixtures choose real runtime tools; they are not evidence of a live model's judgment. */
export class DemoAgentTransport implements ResponseTransport {
  constructor(private request: RunRequest, private project: Workspace) {}
  stream(request: ModelRequest, signal: AbortSignal) {
    checkCancelled(signal);
    const output = request.agentId === 'coordinator' ? this.coordinate(request) : [message(this.specialist(request))];
    const text = output.flatMap(item => item.type === 'message' ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : []).join('');
    const response: ModelResponse = { id: `demo-agent-${randomUUID()}`, status: 'completed', output, output_text: text, usage: null };
    // Desktop acceptance slows the stream down so streaming UI can be seen; it is never set outside the smoke run.
    const pace = Number(process.env.NOVEL_DEMO_PACE_MS) || 0;
    return { events: (async function* (): AsyncGenerator<ResponseStreamEvent> {
      for (let index = 0; index < text.length; index += 80) {
        checkCancelled(signal); await new Promise<void>(resolve => pace ? setTimeout(resolve, pace) : setImmediate(resolve));
        yield { type: 'response.output_text.delta', delta: text.slice(index, index + 80), output_index: 0, content_index: 0, item_id: output[0]!.id, sequence_number: index } as ResponseStreamEvent;
      }
    })(), finalResponse: async () => { if (pace) await new Promise<void>(resolve => setTimeout(resolve, pace)); checkCancelled(signal); return response; } };
  }
  private history(request: ModelRequest) {
    const calls = request.input.filter((item): item is Call => item.type === 'function_call');
    return calls.flatMap(call => {
      const output = request.input.find(item => item.type === 'function_call_output' && item.call_id === call.call_id);
      if (!output || output.type !== 'function_call_output') return [];
      return [{ name: call.name, args: JSON.parse(call.arguments), result: JSON.parse(String(output.output)) as any }];
    });
  }
  private analysisOnly() {
    return this.request.stage === 'agent' && /分析|检查|说明|建议/.test(this.request.objective) && !/生成|写作|改写|构思|编排|完善|修订|修改/.test(this.request.objective);
  }
  private plan(): PlanNode[] {
    const node = (role: PlanNode['role'], id: string, patch: Partial<PlanNode> = {}): PlanNode => ({ id, role, objective: this.request.objective,
      dependsOn: [], acceptance: '产出可核对的分析或领域候选，保留既有正文和知识边界', status: 'pending', ...patch });
    if (this.analysisOnly()) return [node('continuity', 'analysis')];
    if (this.request.stage === 'chapter' || this.request.stage === 'rewrite') {
      const passages = this.request.passageId ? this.project.passages.filter(passage => passage.id === this.request.passageId)
        : chapterPassages(this.project, this.request.chapterId ?? orderedChapters(this.project)[0]?.id ?? '').filter(passage => !passage.text.trim());
      const sceneOf = (sceneId: string) => this.project.scenes.find(scene => scene.id === sceneId)!;
      // One independent character perspective on the chapter's most important event, before any prose is written.
      const perspective = this.request.stage === 'chapter' ? passages.flatMap(passage => sceneOf(passage.sceneId).eventIds.map(id => ({ passage, scene: sceneOf(passage.sceneId), event: this.project.objects.find(item => item.id === id && item.event) })))
        .filter(item => item.event).sort((a, b) => Number(!!b.event!.event!.critical) - Number(!!a.event!.event!.critical))
        .map(({ passage, scene, event }) => ({ passage, event: event!, characterId: [scene.povId, ...event!.event!.participants, ...Object.keys(event!.event!.observations)]
          .find(id => id && this.project.objects.some(item => item.id === id && item.typeId === 'character')) }))
        .find(item => item.characterId) : undefined;
      const roles = perspective ? [node('character', 'perspective', { passageId: perspective.passage.id, chapterId: perspective.passage.chapterId, characterId: perspective.characterId!, eventId: perspective.event.id })] : [];
      const writers = passages.slice(0, Math.floor((12 - roles.length) / 2)).map((passage, i) => node('writer', `write-${i}`, { passageId: passage.id, chapterId: passage.chapterId,
        dependsOn: i ? [`write-${i - 1}`] : roles.map(role => role.id) }));
      // Chapter writing also records how the people and places of each scene changed in what was written.
      const evolution = this.request.stage === 'chapter' ? writers.map((writer, i) => node('evolution', `evolve-${i}`, { passageId: writer.passageId, chapterId: writer.chapterId,
        sceneId: this.project.passages.find(passage => passage.id === writer.passageId)!.sceneId, dependsOn: [writer.id] })) : [];
      return [...roles, ...writers, ...evolution];
    }
    if (this.request.stage === 'assist' && this.request.tool === 'theme') return [node('theme', 'theme')];
    if (this.request.stage === 'agent' && /人物|角色|阵容/.test(this.request.objective)) return [node('cast', 'cast')];
    if (this.request.stage === 'assist' && this.request.tool === 'character') {
      const references = resolveReferences(this.project, this.request.references);
      const selected = references.objects.filter(object => object.typeId === 'character');
      const characters = selected.length ? selected : this.project.objects.filter(object => object.typeId === 'character');
      const participants = new Map(this.project.objects.filter(object => object.event).map(object => [object.id, object.event!.participants]));
      const nodes: PlanNode[] = [];
      // Each character through the scenes that put them on stage, in story order.
      for (const character of characters) {
        let preceding: string | undefined;
        for (const scene of orderedScenes(this.project).filter(scene => scene.povId === character.id || scene.castIds?.includes(character.id)
          || scene.eventIds.some(id => participants.get(id)?.includes(character.id)))) {
          const id = `evolve-${nodes.length}`, parts = scenePassages(this.project, scene.id);
          nodes.push(node('evolution', id, { sceneId: scene.id, characterId: character.id, ...(parts.length > 1 ? { passageId: parts.at(-1)!.id } : {}), dependsOn: preceding ? [preceding] : [] })); preceding = id;
        }
      }
      if (nodes.length) return nodes.slice(0, 12);
    }
    const role = this.request.stage === 'assist' && ['world', 'narrative', 'canvas'].includes(this.request.tool ?? '') ? this.request.tool as 'world' | 'narrative' | 'canvas' : 'planner';
    return [node(role, 'prepare')];
  }
  /** Plans, then acts only where the runtime hands control back: after the author's decision, a failure or an analysis. */
  private coordinate(request: ModelRequest): ResponseOutputItem[] {
    const history = this.history(request), last = history.at(-1);
    const artifactIds = [...new Set(history.flatMap(item => (item.result.artifacts ?? []).map((artifact: any) => artifact.artifactId)).filter(Boolean))];
    if (!last) return [invoke('set_plan', { summary: '根据目标选择必要专长，生成候选、审查后等待作者批准', nodes: this.plan().map(node => ({ ...node, status: undefined,
      passageId: node.passageId ?? null, sceneId: node.sceneId ?? null, chapterId: node.chapterId ?? null, characterId: node.characterId ?? null, eventId: node.eventId ?? null })) })];
    if (last.result.ok === false && last.name !== 'commit_candidate') {
      return [invoke('ask_author', { question: `${last.name === 'propose_changes' ? '候选未能形成' : '执行遇到问题'}：${last.result.reason}。请补充目标或结束任务后选择新范围。`, options: ['缩小范围后重试', '结束本次任务'] })];
    }
    if (last.name === 'delegate_tasks') {
      const text = (last.result.artifacts ?? []).map((artifact: any) => `${artifact.label}：${typeof artifact.conclusion === 'string' ? artifact.conclusion : JSON.stringify(artifact.conclusion)}`).join('\n\n');
      return [invoke('save_report', { label: '目标分析报告', text: text || '已检查现有资料。本次不修改正式作品。' })];
    }
    if (last.name === 'save_report') return [invoke('finish_run', { summary: '已保存分析报告；本次没有修改正式作品。', artifactIds: [...artifactIds, last.result.artifactId] })];
    if (last.name === 'review_candidate' && last.result.nextAction === 'revise_candidate') return [invoke('ask_author', { question: '审查提出了设定修订建议，请确认要保留的方向，或结束本次演示任务。', options: ['保留当前方向', '按审查意见调整'] })];
    if (last.name === 'commit_candidate') return [invoke('finish_run', { summary: last.result.ok ? '已按目标生成并审查候选，经作者批准后保存到正式作品。' : '作者已拒绝候选；正式作品保持不变，分析与草稿保留在任务记录。', artifactIds })];
    if (last.name === 'ask_author') return [invoke('save_report', { label: '作者补充意见', text: String(last.result.answer ?? '已保留任务记录。') })];
    return [message('本地演示保留了真实执行记录，请查看任务当前状态。')];
  }
  private specialist(request: ModelRequest): unknown {
    const context = contextOf(request), id = request.agentId;
    if (id === 'continuity' || id === 'reader') return { verdict: 'pass', issues: [], recommendation: '本地演示审查：信息边界与候选结构可继续核对。真实模型判断需要另行验证。' };
    if (id === 'stylist') {
      // Demo judgment comes from the local lint only: banned words and clichés ask for a revision.
      const issues = (context.targetPassages ?? []).flatMap((passage: any) => (passage.lint ?? []).map((issue: any) => ({ quote: issue.excerpt ?? '', problem: `${passage.title}：${issue.message}`,
        fix: '按作者范文的句长与用词改写这一句', severity: /禁用|AI 腔/.test(issue.message) ? 'must' : 'should' })));
      const blocking = issues.some((issue: { severity: string }) => issue.severity === 'must');
      return { verdict: blocking ? 'revise' : 'pass', issues: issues.slice(0, 6),
        recommendation: blocking ? '本地演示文风审阅：删去禁用词与套话，按作者范文的句长与节奏重写相关句子。' : '本地演示文风审阅：未发现明显偏离作者文风的句子。真实模型判断需要另行验证。' };
    }
    if (id === 'judge') return { dimensions: ['drama', 'imagery', 'dialogue', 'voice', 'fidelity'].map(name => ({ name, winner: 'tie', reason: '本地演示评审不比较文笔。' })),
      winner: 'tie', reason: '本地演示评审：只验证盲评流程，真实比较需要设置评测模型。' };
    if (id === 'theme') return { question: '证据不足时，人是否愿意为信任承担风险？', choices: '只保护自己或共同承担未知风险', cost: '信任可能遭到背叛，拒绝可能失去解决困境的机会', expression: '用当场行动与选择代价表达，不安排说教独白。' };
    if (id.startsWith('character:')) return { perspective: `此刻我只能确认：${context.perception || '眼前线索不足'}。`, intention: '保护重视的人，先核实线索', action: '追问亲见亲闻的证据', uncertainty: '我不知道别人隐瞒的真相。' };
    if (id.startsWith('evolution:')) {
      // Demo changes: each character on stage grows wary but undecided, and the place turns tense; the note quotes the prose or plan.
      const evidence = context.isPlan ? `计划：${String(context.plan?.outline ?? '').slice(0, 80)}` : `正文：「${String(context.prose?.[0]?.text ?? '').slice(0, 80)}」`;
      const subjects = (context.subjects ?? []) as Array<{ id: string; kind: string; knowledge?: { learnsHere?: string[]; perception?: Record<string, string> } }>;
      return { changes: [...subjects.filter(subject => subject.kind === '人物').slice(0, 3).map(subject => ({ subjectId: subject.id, eventId: context.events?.[0]?.id ?? '', note: evidence,
        aspects: [{ aspect: '心理', value: '戒备中开始犹豫，但不确定对方的全部意图。' },
          { aspect: '认知', value: subject.knowledge?.learnsHere?.[0] ?? Object.values(subject.knowledge?.perception ?? {})[0] ?? '只确认了眼前看到的线索。' },
          { aspect: '动机', value: '用可核对的行动保护重视的人，逐步判断是否合作。' }] })),
        ...subjects.filter(subject => subject.kind === '环境').slice(0, 1).map(subject => ({ subjectId: subject.id, eventId: '', note: evidence,
          aspects: [{ aspect: '氛围', value: '钟声之后的寂静里，每一处响动都像在催促。' }] }))] };
    }
    if (id === 'patch') {
      // Demo revision: one local edit that extends the passage's closing paragraph.
      const text = String(context.passage?.text ?? ''), last = text.split('\n\n').filter(part => part.trim()).at(-1) ?? text;
      return { edits: [{ quote: last, replacement: `${last}\n\n他停了一瞬，听见身后的脚步也停住。至少此刻，没人把他独自留在雾里。` }], note: '本地演示修订：只补写了结尾一段。' };
    }
    if (id === 'writer' || id === 'rewrite' || id === 'revision') {
      const scene = context.scene;
      if (context.cursor) return '\n\n她没有回头，只把铜片塞进袖口，朝雾里走了两步。钟又响了一下，比刚才那声更低，像是从地底传上来的。\n\n林舟追到门口，雾已经把她的背影吞掉了一半。他想喊，喉咙里却只挤出一声干咳。';
      if (typeof context.selectedText === 'string') return `她把话咽了回去，指腹沿铜片的缺口缓缓移过。${context.selectedText}`;
      return demoText(scene, id === 'revision');
    }
    if (id === 'cast') {
      const existing = this.project.objects.find(object => object.typeId === 'character');
      const lead = existing ? { parentId: existing.id, parentRef: null } : { parentId: null, parentRef: 'c1' };
      const op = (patch: Record<string, unknown>) => ({ ref: null, targetId: null, parentRef: null, parentId: null, title: null, content: null, purpose: null, order: null, povName: null, causes: [], people: [], field: null, ...patch });
      return { summary: '设计了一组人物并在画布上连出关系。', commandsJson: '[]', opsJson: JSON.stringify([
        ...(existing ? [] : [op({ op: 'addCharacter', ref: 'c1', title: '许砚', content: '主角，嘴硬心软。', purpose: '在信任与自保之间选择' })]),
        op({ op: 'addCharacter', ref: 'c2', title: '沈照', content: '看似可靠的同伴，另有所图。', purpose: '逼主角重新定义信任' }),
        op({ op: 'link', ...lead, targetId: 'c2', title: '同伴，互相隐瞒' }),
      ]) };
    }
    let commands;
    if (this.request.stage === 'idea') commands = demoIdea(this.project);
    else if (this.request.stage === 'outline') commands = demoOutline(this.project);
    else if (this.request.stage === 'assist') commands = demoAssist(this.project, this.request.tool!, resolveReferences(this.project, this.request.references));
    else { const idea = demoIdea(this.project); commands = [...idea, ...demoOutline(applyCommands(this.project, idea))]; }
    return { summary: '依据已有领域结构形成候选，尚未写入正式作品。', commandsJson: JSON.stringify(commands), opsJson: '[]' };
  }
}
