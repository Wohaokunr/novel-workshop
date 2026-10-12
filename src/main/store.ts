import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentRun, CanvasCard, Change, Command, CommandRequest, OperationBatch, ProjectSummary, Workspace } from '../shared/types.js';
import type { AgentDecision, AgentMemory, AgentReceipt, AgentSession, AgentState, EvidenceSource } from '../shared/agent-types.js';
import { applyCommands, cardContent, createWorkspace, hasSemanticChanges, NOVEL_FIELDS, validateWorkspace } from './domain.js';
import { migrateDatabase } from './migrations.js';
import { STYLE_KEYS, styleProfile, type StyleKey } from '../shared/style-types.js';
import { touchesProse } from './agent/policy.js';
import type { CompanionThread } from '../shared/companion-types.js';
import type { StoryDigest } from '../shared/story-types.js';

const collections = ['objectTypes', 'objects', 'acts', 'chapters', 'scenes', 'facts', 'knowledge', 'characterStates', 'cards', 'canvasLinks'] as const;
const metadata = NOVEL_FIELDS;
type Row = { data: string };
type ScopedRow = Row & { project_id: string };
type PreparedCommands = { workspace: Workspace; commands: Command[]; changes: Change[] };
type Backup = { workspace: Workspace };

function requireId(id: string, label: string): void {
  if (typeof id !== 'string' || !id.trim()) throw new Error(`${label}无效`);
}

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('持久化数据必须可序列化为 JSON');
  return serialized;
}

// SQLite JSON omits optional undefined fields; compare the persisted representation.
function equalJSON(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(json(left)), JSON.parse(json(right)));
}

function checkSources(sources: EvidenceSource[], projectId: string): void {
  if (!Array.isArray(sources) || sources.some(source => source.projectId !== projectId)) throw new Error('证据来源不属于此项目');
}

/** Layout-only author edits do not invalidate an approved semantic preview. */
function approvalChanges(changes: Change[]): unknown {
  return changes.map(change => {
    if (change.collection === 'cards' && change.before !== undefined) {
      return { ...change, before: cardContent(change.before as CanvasCard),
        after: change.after === undefined ? undefined : cardContent(change.after as CanvasCard) };
    }
    // Deleting an entity also cleans its layout, whose last position may have moved.
    if (change.collection === 'layouts' && change.after === undefined) return { ...change, before: true };
    return change;
  });
}

function diff(before: Workspace, after: Workspace): Change[] {
  const changes: Change[] = [];
  function add(collection: string, key: string, previous: unknown, next: unknown): void {
    if (!isDeepStrictEqual(previous, next)) changes.push({ collection, key, before: structuredClone(previous), after: structuredClone(next) });
  }
  for (const key of metadata) add('metadata', key, before[key] ?? '', after[key] ?? '');
  // Per-field so undoing one adoption does not conflict with a later, unrelated style edit.
  const styleBefore = styleProfile(before), styleAfter = styleProfile(after);
  for (const key of STYLE_KEYS) add('style', key, styleBefore[key], styleAfter[key]);
  for (const collection of collections) {
    const old = new Map<string, unknown>((before[collection] ?? []).map(item => [item.id, item]));
    const current = new Map<string, unknown>((after[collection] ?? []).map(item => [item.id, item]));
    for (const key of new Set([...old.keys(), ...current.keys()])) add(collection, key, old.get(key), current.get(key));
  }
  for (const key of new Set([...Object.keys(before.layouts), ...Object.keys(after.layouts)])) add('layouts', key, before.layouts[key], after.layouts[key]);
  // Reading progress is a preference, not an authoring operation to undo.
  return changes;
}

function changeValue(workspace: Workspace, collection: string, key: string): unknown {
  if (collection === 'metadata' && metadata.includes(key as typeof metadata[number])) return workspace[key as typeof metadata[number]] ?? '';
  if (collection === 'layouts') return workspace.layouts[key];
  if (collection === 'style' && STYLE_KEYS.includes(key as StyleKey)) return styleProfile(workspace)[key as StyleKey];
  if (collections.includes(collection as typeof collections[number])) return (workspace[collection as typeof collections[number]] ?? []).find(item => item.id === key);
  throw new Error(`不支持的历史操作集合：${collection}`);
}

function keepCardLayout(value: CanvasCard, current: CanvasCard): CanvasCard {
  return { ...cardContent(value), x: current.x, y: current.y,
    ...(current.width === undefined ? {} : { width: current.width }),
    ...(current.height === undefined ? {} : { height: current.height }),
    ...(current.collapsed === undefined ? {} : { collapsed: current.collapsed }) };
}

function restore(workspace: Workspace, change: Change, preserveCardLayout: boolean): void {
  if (change.collection === 'metadata') {
    if (!metadata.includes(change.key as typeof metadata[number]) || typeof change.before !== 'string') throw new Error('历史项目字段无效');
    workspace[change.key as typeof metadata[number]] = change.before; return;
  }
  if (change.collection === 'style') {
    if (!STYLE_KEYS.includes(change.key as StyleKey)) throw new Error('历史文风字段无效');
    workspace.style = { ...styleProfile(workspace), [change.key]: structuredClone(change.before) }; return;
  }
  if (change.collection === 'layouts') {
    if (change.before === undefined) delete workspace.layouts[change.key];
    else workspace.layouts[change.key] = structuredClone(change.before) as { x: number; y: number };
    return;
  }
  if (!collections.includes(change.collection as typeof collections[number])) throw new Error('历史操作集合无效');
  const items = workspace[change.collection as typeof collections[number]] as Array<{ id: string }>;
  const index = items.findIndex(item => item.id === change.key);
  if (change.before === undefined) { if (index >= 0) items.splice(index, 1); }
  else {
    let previous = structuredClone(change.before) as { id: string };
    if (!previous || previous.id !== change.key) throw new Error('历史实体 ID 无效');
    if (preserveCardLayout && change.collection === 'cards' && index >= 0) previous = keepCardLayout(previous as CanvasCard, items[index] as CanvasCard);
    if (index >= 0) items[index] = previous; else items.push(previous);
  }
}

export class NovelStore {
  private db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    try { migrateDatabase(this.db); }
    catch (error) { this.db.close(); throw error; }
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private save(workspace: Workspace): void {
    this.db.prepare('INSERT INTO projects(id,title,revision,updated_at,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,revision=excluded.revision,updated_at=excluded.updated_at,data=excluded.data')
      .run(workspace.id, workspace.title, workspace.revision, new Date().toISOString(), JSON.stringify(workspace));
  }

  listProjects(): ProjectSummary[] {
    return this.db.prepare('SELECT id,title,revision,updated_at AS updatedAt FROM projects ORDER BY updated_at DESC').all() as unknown as ProjectSummary[];
  }

  createProject(title: string): Workspace {
    const workspace = createWorkspace(title); this.save(workspace); return workspace;
  }

  getProject(id: string): Workspace {
    const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('项目不存在');
    const workspace = JSON.parse(row.data) as Workspace;
    workspace.characterStates ??= []; workspace.theme ??= ''; workspace.logline ??= ''; workspace.structureTemplate ??= ''; workspace.acts ??= [];
    return workspace;
  }

  private prepareCommands(before: Workspace, commands: Command[], actor: CommandRequest['actor']): PreparedCommands {
    const cards = new Map(before.cards.map(card => [card.id, card]));
    const protectedCommands = actor === 'ai' && Array.isArray(commands) ? commands.map(command => {
      if (command?.type === 'putCard' && command.value && typeof command.value === 'object') {
        const current = cards.get(command.value.id);
        if (current) return { ...command, value: keepCardLayout(command.value, current) };
      }
      if (command?.type === 'setLayout' && before.layouts[command.key] !== undefined) return { ...command, value: before.layouts[command.key]! };
      return command;
    }) : commands;
    const workspace = applyCommands(before, protectedCommands);
    return { workspace, commands: structuredClone(protectedCommands), changes: diff(before, workspace) };
  }

  previewCommands(workspace: Workspace, commands: Command[]): PreparedCommands {
    return this.prepareCommands(workspace, commands, 'ai');
  }

  /** Caller owns BEGIN/COMMIT so approval can include its checkpoint and receipt. */
  private executeInTransaction(request: CommandRequest, before: Workspace, prepared: PreparedCommands): { workspace: Workspace; batch?: OperationBatch } {
    const next = prepared.workspace;
    if (next.revision !== before.revision && (request.expectedRevision !== undefined || request.actor === 'ai') && request.expectedRevision !== before.revision) {
      throw new Error(`REVISION_CONFLICT：项目已更新，当前修订号 ${before.revision}；请重新读取后再修改`);
    }
    if (isDeepStrictEqual(before, next)) return { workspace: before };
    let batch: OperationBatch | undefined;
    if (prepared.changes.length) {
      batch = { id: randomUUID(), projectId: next.id, actor: request.actor,
        taskId: request.taskId, label: request.label ?? (request.actor === 'ai' ? 'AI 创作修改' : '手动编辑'), at: new Date().toISOString(), changes: prepared.changes, undone: false };
      this.db.prepare('INSERT INTO operations(id,project_id,data) VALUES(?,?,?)').run(batch.id, next.id, JSON.stringify(batch));
    }
    this.save(next);
    return { workspace: next, batch };
  }

  execute(request: CommandRequest): Workspace {
    return this.executeBatch(request).workspace;
  }

  /** Same as execute, also returning the recorded batch so callers can offer a targeted undo. */
  executeBatch(request: CommandRequest): { workspace: Workspace; batch?: OperationBatch } {
    if (!['human', 'ai'].includes(request.actor)) throw new Error('操作者无效');
    return this.transaction(() => {
      const before = this.getProject(request.projectId);
      return this.executeInTransaction(request, before, this.prepareCommands(before, request.commands, request.actor));
    });
  }

  deleteImpact(projectId: string, command: Command): string[] {
    if (!command.type.startsWith('delete')) throw new Error('这里只能预览删除操作');
    const before = this.getProject(projectId), next = applyCommands(before, [command]);
    const labels: Record<string, string> = { objectTypes: '对象类型', objects: '对象', acts: '幕/卷', chapters: '章节', scenes: '叙述场景', facts: '世界事实', knowledge: '角色知识', characterStates: '人物演进状态', cards: '画布卡片', canvasLinks: '画布关联', layouts: '图位置' };
    return diff(before, next).map(change => {
      const item = (change.before ?? change.after) as { name?: string; title?: string; content?: string } | undefined;
      return `${labels[change.collection] ?? change.collection}「${item?.name ?? item?.title ?? item?.content?.slice(0, 30) ?? change.key}」：${change.after === undefined ? '删除' : '清理关联'}`;
    });
  }

  history(projectId: string): OperationBatch[] {
    return (this.db.prepare('SELECT data FROM operations WHERE project_id=? ORDER BY rowid DESC').all(projectId) as Row[]).map(row => JSON.parse(row.data) as OperationBatch);
  }

  undo(projectId: string, batchOrTaskId: string): Workspace {
    return this.transaction(() => {
      const before = this.getProject(projectId);
      const history = this.history(projectId);
      const exact = history.find(batch => batch.id === batchOrTaskId);
      const batches = (exact ? [exact] : history.filter(batch => batch.taskId === batchOrTaskId)).filter(batch => !batch.undone).reverse();
      if (!batches.length) throw new Error('没有可撤销的操作');
      const preserveCardLayout = batches.every(batch => batch.actor === 'ai');
      const compare = (collection: string, value: unknown) => preserveCardLayout && collection === 'cards' && value !== undefined ? cardContent(value as CanvasCard) : value;
      const combined = new Map<string, Change>();
      for (const batch of batches) for (const change of batch.changes) {
        const key = JSON.stringify([change.collection, change.key]);
        const first = combined.get(key);
        if (first) {
          if (!isDeepStrictEqual(compare(change.collection, first.after), compare(change.collection, change.before))) throw new Error('UNDO_CONFLICT：阶段操作之间存在用户或其他任务修改，无法整体撤销');
          first.after = change.after;
        } else combined.set(key, structuredClone(change));
      }
      const conflicts = [...combined.values()].filter(change => !isDeepStrictEqual(compare(change.collection, changeValue(before, change.collection, change.key)), compare(change.collection, change.after)));
      if (conflicts.length) throw new Error(`UNDO_CONFLICT：以下内容已有后续修改：${conflicts.map(change => `${change.collection}/${change.key}`).join('、')}`);
      const next = structuredClone(before);
      for (const change of combined.values()) restore(next, change, preserveCardLayout);
      // Preferences may point to a chapter introduced by the action being undone.
      if (next.reading.chapterId && !next.chapters.some(chapter => chapter.id === next.reading.chapterId)) { delete next.reading.chapterId; next.reading.scroll = 0; }
      if (hasSemanticChanges(before, next)) next.revision++;
      try { validateWorkspace(next); } catch (error) { throw new Error(`UNDO_CONFLICT：后续内容依赖本次修改，撤销未执行。${(error as Error).message}`); }
      for (const batch of batches) { batch.undone = true; this.db.prepare('UPDATE operations SET data=? WHERE id=?').run(JSON.stringify(batch), batch.id); }
      this.save(next); return next;
    });
  }

  getRuns(projectId: string): AgentRun[] {
    return (this.db.prepare('SELECT data FROM runs WHERE project_id=? ORDER BY started_at DESC, rowid DESC').all(projectId) as Row[]).map(row => JSON.parse(row.data) as AgentRun);
  }

  getRun(id: string): AgentRun | undefined {
    const row = this.db.prepare('SELECT project_id,data FROM runs WHERE id=?').get(id) as ScopedRow | undefined;
    if (!row) return undefined;
    const run = JSON.parse(row.data) as AgentRun;
    if (run.id !== id || run.projectId !== row.project_id) throw new Error('运行记录项目作用域不一致');
    return run;
  }

  saveRun(run: AgentRun): void {
    requireId(run.id, '运行 ID');
    this.getProject(run.projectId);
    const previous = this.getRun(run.id);
    if (previous && previous.projectId !== run.projectId) throw new Error('运行记录不能转移到其他项目');
    this.db.prepare('INSERT INTO runs(id,project_id,started_at,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(run.id, run.projectId, run.startedAt, json(run));
  }

  private requireRun(runId: string, projectId?: string): AgentRun {
    requireId(runId, '运行 ID');
    const run = this.getRun(runId);
    if (!run) throw new Error('运行记录不存在');
    if (projectId !== undefined && run.projectId !== projectId) throw new Error('运行记录不属于此项目');
    this.getProject(run.projectId);
    return run;
  }

  private validateAgentState(state: AgentState): void {
    if (state.version !== 1) throw new Error('不支持的智能体状态版本');
    this.requireRun(state.runId, state.projectId);
    const previous = this.db.prepare('SELECT project_id FROM agent_states WHERE run_id=?').get(state.runId) as { project_id: string } | undefined;
    if (previous && previous.project_id !== state.projectId) throw new Error('智能体状态不能转移到其他项目');
    const session = this.db.prepare('SELECT project_id FROM agent_sessions WHERE id=?').get(state.sessionId) as { project_id: string } | undefined;
    if (!session || session.project_id !== state.projectId) throw new Error('智能体会话不属于此项目');
    if (state.baseWorkspace.id !== state.projectId) throw new Error('智能体基础快照不属于此项目');
    validateWorkspace(state.baseWorkspace);
    const candidateIds = new Set<string>();
    for (const candidate of state.candidates) {
      requireId(candidate.id, '候选 ID'); requireId(candidate.hash, '候选 hash');
      if (candidateIds.has(candidate.id)) throw new Error('候选 ID 重复');
      candidateIds.add(candidate.id);
      if (candidate.runId !== state.runId || candidate.projectId !== state.projectId || candidate.workspace.id !== state.projectId) throw new Error('候选不属于此项目或运行');
      if (!Number.isSafeInteger(candidate.baseRevision) || candidate.baseRevision < 0) throw new Error('候选基础修订号无效');
      validateWorkspace(candidate.workspace);
      checkSources(candidate.sources, state.projectId);
      for (const review of candidate.reviews) checkSources(review.sources, state.projectId);
    }
    for (const artifact of state.artifacts) checkSources(artifact.sources, state.projectId);
    if (state.waiting?.kind === 'approval') {
      const candidate = state.candidates.find(item => item.id === state.waiting!.candidateId);
      if (!candidate || candidate.hash !== state.waiting.candidateHash) throw new Error('等待审批的候选 ID/hash 不匹配');
    }
  }

  private saveAgentStateInTransaction(state: AgentState, run?: AgentRun, receipt?: AgentReceipt): void {
    if (run) {
      if (run.id !== state.runId || run.projectId !== state.projectId) throw new Error('智能体状态与运行作用域不一致');
      this.saveRun(run);
    }
    this.validateAgentState(state);
    if (receipt) {
      if (receipt.runId !== state.runId || receipt.projectId !== state.projectId) throw new Error('智能体状态与回执作用域不一致');
      this.saveAgentReceiptInTransaction(receipt);
    }
    this.db.prepare('INSERT INTO agent_states(run_id,project_id,updated_at,data) VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data')
      .run(state.runId, state.projectId, state.updatedAt, json(state));
  }

  saveAgentState(state: AgentState, run?: AgentRun, receipt?: AgentReceipt): void {
    this.transaction(() => this.saveAgentStateInTransaction(state, run, receipt));
  }

  getAgentState(runId: string): AgentState | undefined {
    const row = this.db.prepare('SELECT project_id,data FROM agent_states WHERE run_id=?').get(runId) as ScopedRow | undefined;
    if (!row) return undefined;
    const state = JSON.parse(row.data) as AgentState;
    if (state.runId !== runId || state.projectId !== row.project_id) throw new Error('智能体状态项目作用域不一致');
    this.requireRun(runId, state.projectId);
    return state;
  }

  listAgentStates(projectId?: string): AgentState[] {
    if (projectId !== undefined) this.getProject(projectId);
    const rows = (projectId === undefined
      ? this.db.prepare('SELECT run_id FROM agent_states ORDER BY updated_at DESC,rowid DESC').all()
      : this.db.prepare('SELECT run_id FROM agent_states WHERE project_id=? ORDER BY updated_at DESC,rowid DESC').all(projectId)) as Array<{ run_id: string }>;
    return rows.map(row => this.getAgentState(row.run_id)!);
  }

  getAgentReceipt(key: string): AgentReceipt | undefined {
    const row = this.db.prepare('SELECT run_id,project_id,data FROM agent_receipts WHERE key=?').get(key) as (ScopedRow & { run_id: string }) | undefined;
    if (!row) return undefined;
    const receipt = JSON.parse(row.data) as AgentReceipt;
    if (receipt.key !== key || receipt.runId !== row.run_id || receipt.projectId !== row.project_id) throw new Error('工具回执作用域不一致');
    this.requireRun(receipt.runId, receipt.projectId);
    return receipt;
  }

  private saveAgentReceiptInTransaction(receipt: AgentReceipt): void {
    requireId(receipt.key, '工具回执 key'); requireId(receipt.argumentsHash, '工具参数 hash');
    this.requireRun(receipt.runId, receipt.projectId);
    if (!['pending', 'completed', 'denied'].includes(receipt.status)) throw new Error('工具回执状态无效');
    const previous = this.getAgentReceipt(receipt.key);
    if (previous) {
      if (previous.runId !== receipt.runId || previous.projectId !== receipt.projectId || previous.argumentsHash !== receipt.argumentsHash) throw new Error('工具回执 key 与作用域或参数 hash 冲突');
      if (previous.status !== 'pending') {
        if (previous.status !== receipt.status || !equalJSON([previous.result], [receipt.result])) throw new Error('已完成的工具回执不可覆盖');
        return;
      }
    }
    this.db.prepare('INSERT INTO agent_receipts(key,run_id,project_id,data) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data')
      .run(receipt.key, receipt.runId, receipt.projectId, json(receipt));
  }

  saveAgentReceipt(receipt: AgentReceipt): void {
    this.transaction(() => this.saveAgentReceiptInTransaction(receipt));
  }

  getSession(projectId: string): AgentSession {
    return this.transaction(() => {
      const project = this.getProject(projectId);
      const row = this.db.prepare('SELECT id,data FROM agent_sessions WHERE project_id=?').get(projectId) as (Row & { id: string }) | undefined;
      if (row) {
        const session = JSON.parse(row.data) as AgentSession;
        if (session.projectId !== projectId || session.id !== row.id) throw new Error('会话项目作用域不一致');
        return session;
      }
      const at = new Date().toISOString();
      const session: AgentSession = { id: randomUUID(), projectId, title: project.title, createdAt: at, updatedAt: at, messages: [] };
      this.saveSessionInTransaction(session);
      return session;
    });
  }

  private saveSessionInTransaction(session: AgentSession): void {
    requireId(session.id, '会话 ID'); this.getProject(session.projectId);
    const previous = this.db.prepare('SELECT id,project_id FROM agent_sessions WHERE id=? OR project_id=?').all(session.id, session.projectId) as Array<{ id: string; project_id: string }>;
    if (previous.some(row => row.id !== session.id || row.project_id !== session.projectId)) throw new Error('会话不能更换 ID 或转移到其他项目');
    const ids = new Set<string>();
    for (const message of session.messages) {
      requireId(message.id, '会话消息 ID');
      if (ids.has(message.id)) throw new Error('会话消息 ID 重复');
      ids.add(message.id);
      if (!['author', 'agent'].includes(message.role) || typeof message.text !== 'string') throw new Error('会话消息格式无效');
      if (message.runId) this.requireRun(message.runId, session.projectId);
    }
    this.db.prepare('INSERT INTO agent_sessions(project_id,id,updated_at,data) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data')
      .run(session.projectId, session.id, session.updatedAt, json(session));
  }

  saveSession(session: AgentSession): void {
    this.transaction(() => this.saveSessionInTransaction(session));
  }

  recordAgentTurn(runId: string, stepId: string, turn: number, request: unknown, response?: unknown): void {
    this.transaction(() => {
      const run = this.requireRun(runId); requireId(stepId, '步骤 ID');
      if (!run.steps.some(step => step.id === stepId)) throw new Error('步骤不属于此运行');
      if (!Number.isSafeInteger(turn) || turn < 0) throw new Error('模型轮次无效');
      const requestJSON = json(request), responseJSON = response === undefined ? null : json(response);
      const previous = this.db.prepare('SELECT request,response FROM agent_turns WHERE run_id=? AND step_id=? AND turn=?').get(runId, stepId, turn) as { request: string; response: string | null } | undefined;
      if (previous) {
        if (!equalJSON(JSON.parse(previous.request), JSON.parse(requestJSON))) throw new Error('已记录的模型请求不可覆盖');
        if (previous.response !== null && responseJSON !== null && !equalJSON(JSON.parse(previous.response), JSON.parse(responseJSON))) throw new Error('已记录的模型响应不可覆盖');
        if (previous.response !== null || responseJSON === null) return;
      }
      this.db.prepare('INSERT INTO agent_turns(run_id,project_id,step_id,turn,request,response,at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,step_id,turn) DO UPDATE SET response=COALESCE(agent_turns.response,excluded.response)')
        .run(runId, run.projectId, stepId, turn, requestJSON, responseJSON, new Date().toISOString());
    });
  }

  getAgentMemories(projectId: string): AgentMemory[] {
    this.getProject(projectId);
    const rows = this.db.prepare('SELECT id,data FROM agent_memories WHERE project_id=? ORDER BY updated_at DESC,rowid DESC').all(projectId) as (Row & { id: string })[];
    return rows.map(row => {
      const memory = JSON.parse(row.data) as AgentMemory;
      if (memory.projectId !== projectId || memory.id !== row.id) throw new Error('记忆项目作用域不一致');
      return memory;
    });
  }

  putAgentMemory(memory: AgentMemory): void {
    this.transaction(() => {
      requireId(memory.id, '记忆 ID'); this.getProject(memory.projectId);
      if (!['preference', 'constraint', 'summary', 'experience'].includes(memory.kind) || !['active', 'suggested', 'stale'].includes(memory.status) || typeof memory.content !== 'string' || typeof memory.confirmed !== 'boolean') throw new Error('记忆格式无效');
      checkSources(memory.sources, memory.projectId);
      const previous = this.db.prepare('SELECT project_id FROM agent_memories WHERE id=?').get(memory.id) as { project_id: string } | undefined;
      if (previous && previous.project_id !== memory.projectId) throw new Error('记忆不能转移到其他项目');
      if (memory.sourceMessageId) {
        const row = this.db.prepare('SELECT data FROM agent_sessions WHERE project_id=?').get(memory.projectId) as Row | undefined;
        if (!row || !(JSON.parse(row.data) as AgentSession).messages.some(message => message.id === memory.sourceMessageId)) throw new Error('记忆来源消息不属于此项目');
      }
      this.db.prepare('INSERT INTO agent_memories(id,project_id,updated_at,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data')
        .run(memory.id, memory.projectId, memory.updatedAt, json(memory));
    });
  }

  getCompanionThreads(projectId: string): CompanionThread[] {
    this.getProject(projectId);
    const rows = this.db.prepare('SELECT id,data FROM companion_threads WHERE project_id=? ORDER BY updated_at DESC,rowid DESC').all(projectId) as (Row & { id: string })[];
    return rows.map(row => {
      const thread = JSON.parse(row.data) as CompanionThread;
      if (thread.projectId !== projectId || thread.id !== row.id) throw new Error('创作伙伴对话的项目作用域不一致');
      return thread;
    });
  }

  getCompanionThread(projectId: string, id: string): CompanionThread | undefined {
    const row = this.db.prepare('SELECT project_id,data FROM companion_threads WHERE id=?').get(id) as ScopedRow | undefined;
    if (!row) return undefined;
    if (row.project_id !== projectId) throw new Error('创作伙伴对话不属于此项目');
    return JSON.parse(row.data) as CompanionThread;
  }

  saveCompanionThread(thread: CompanionThread): void {
    this.transaction(() => {
      requireId(thread.id, '对话 ID'); this.getProject(thread.projectId);
      if (!Array.isArray(thread.turns) || thread.turns.some(turn => !['author', 'companion'].includes(turn.role) || typeof turn.text !== 'string')) throw new Error('创作伙伴对话格式无效');
      const previous = this.db.prepare('SELECT project_id FROM companion_threads WHERE id=?').get(thread.id) as { project_id: string } | undefined;
      if (previous && previous.project_id !== thread.projectId) throw new Error('对话不能转移到其他项目');
      this.db.prepare('INSERT INTO companion_threads(id,project_id,updated_at,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data')
        .run(thread.id, thread.projectId, thread.updatedAt, json(thread));
    });
  }

  deleteCompanionThread(projectId: string, id: string): void {
    this.transaction(() => {
      this.getProject(projectId); requireId(id, '对话 ID');
      const previous = this.db.prepare('SELECT project_id FROM companion_threads WHERE id=?').get(id) as { project_id: string } | undefined;
      if (previous && previous.project_id !== projectId) throw new Error('对话不属于此项目');
      this.db.prepare('DELETE FROM companion_threads WHERE project_id=? AND id=?').run(projectId, id);
    });
  }

  /** Derived story memory: outside the workspace, so it never bumps revisions, enters undo history or backups. */
  getStoryDigests(projectId: string): StoryDigest[] {
    this.getProject(projectId);
    return (this.db.prepare('SELECT data FROM story_digests WHERE project_id=?').all(projectId) as Row[]).map(row => JSON.parse(row.data) as StoryDigest);
  }

  putStoryDigests(projectId: string, digests: StoryDigest[]): void {
    if (!digests.length) return;
    this.transaction(() => {
      this.getProject(projectId);
      const statement = this.db.prepare('INSERT INTO story_digests(project_id,kind,target_id,updated_at,data) VALUES(?,?,?,?,?) ON CONFLICT(project_id,kind,target_id) DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data');
      for (const digest of digests) {
        const target = digest.kind === 'scene' ? digest.sceneId : digest.targetId;
        if (!['scene', 'chapter', 'volume', 'book'].includes(digest.kind)) throw new Error('故事记忆类别无效');
        requireId(target, '故事记忆目标');
        statement.run(projectId, digest.kind, target, digest.updatedAt, json(digest));
      }
    });
  }

  /** Remove digests whose scene / chapter / volume no longer exists. */
  pruneStoryDigests(projectId: string, live: Record<'scene' | 'chapter' | 'volume' | 'book', Set<string>>): void {
    this.transaction(() => {
      const rows = this.db.prepare('SELECT kind,target_id FROM story_digests WHERE project_id=?').all(projectId) as Array<{ kind: keyof typeof live; target_id: string }>;
      const remove = this.db.prepare('DELETE FROM story_digests WHERE project_id=? AND kind=? AND target_id=?');
      for (const row of rows) if (!live[row.kind]?.has(row.target_id)) remove.run(projectId, row.kind, row.target_id);
    });
  }

  /** Edits and rejections already turned into style suggestions; local learning state, not part of a backup. */
  getStyleObservations(projectId: string): Set<string> {
    return new Set((this.db.prepare('SELECT key FROM style_observations WHERE project_id=?').all(projectId) as Array<{ key: string }>).map(row => row.key));
  }

  putStyleObservations(projectId: string, keys: string[]): void {
    this.getProject(projectId);
    this.transaction(() => {
      const statement = this.db.prepare('INSERT OR IGNORE INTO style_observations(project_id,key,at) VALUES(?,?,?)'), at = new Date().toISOString();
      for (const key of keys) { requireId(key, '文风观察'); statement.run(projectId, key, at); }
    });
  }

  deleteAgentMemory(projectId: string, id: string): void {
    this.transaction(() => {
      this.getProject(projectId); requireId(id, '记忆 ID');
      const previous = this.db.prepare('SELECT project_id FROM agent_memories WHERE id=?').get(id) as { project_id: string } | undefined;
      if (previous && previous.project_id !== projectId) throw new Error('记忆不属于此项目');
      this.db.prepare('DELETE FROM agent_memories WHERE project_id=? AND id=?').run(projectId, id);
    });
  }

  commitAgentCandidate(decision: AgentDecision, updateCheckpoint: (state: AgentState, result: unknown) => void): { state: AgentState; run: AgentRun; project?: Workspace; result: unknown } {
    if (typeof decision.approve !== 'boolean' || (decision.reason !== undefined && typeof decision.reason !== 'string')) throw new Error('审批决定格式无效');
    requireId(decision.candidateId, '候选 ID'); requireId(decision.candidateHash, '候选 hash');
    return this.transaction(() => {
      const state = this.getAgentState(decision.runId);
      if (!state) throw new Error('智能体状态不存在');
      const run = this.requireRun(state.runId, state.projectId);
      this.validateAgentState(state);
      const candidate = state.candidates.find(item => item.id === decision.candidateId);
      if (!candidate || candidate.hash !== decision.candidateHash) throw new Error('候选 ID/hash 不匹配');
      if (candidate.status === 'applied' || candidate.status === 'rejected') {
        const receipt = candidate.commitCallKey ? this.getAgentReceipt(candidate.commitCallKey) : undefined;
        if (!receipt || receipt.runId !== run.id || receipt.projectId !== state.projectId || receipt.status !== (candidate.status === 'applied' ? 'completed' : 'denied')) throw new Error('已审批候选缺少一致的持久化回执');
        return { state, run, ...(candidate.status === 'applied' ? { project: this.getProject(state.projectId) } : {}), result: receipt.result };
      }
      const waiting = state.waiting;
      if (!waiting || waiting.kind !== 'approval' || waiting.candidateId !== candidate.id || waiting.candidateHash !== candidate.hash || candidate.status !== 'awaitingApproval') throw new Error('当前运行未等待此候选审批');
      if (!['awaitingApproval', 'running'].includes(run.status)) throw new Error(`运行状态 ${run.status} 不允许审批`);
      const priorReceipt = this.getAgentReceipt(waiting.callKey);
      if (priorReceipt && (priorReceipt.runId !== run.id || priorReceipt.projectId !== state.projectId || priorReceipt.argumentsHash !== waiting.argumentsHash || priorReceipt.status !== 'pending')) throw new Error('审批工具回执与等待状态不一致');
      if (candidate.commitCallKey && candidate.commitCallKey !== waiting.callKey) throw new Error('候选提交 key 与等待状态不一致');
      const at = new Date().toISOString();
      let project: Workspace | undefined;
      let result: unknown;
      if (decision.approve) {
        const formal = this.getProject(state.projectId);
        // Unlike ordinary execute(), even no-op candidates require the exact base revision.
        if (formal.revision !== candidate.baseRevision) throw new Error(`REVISION_CONFLICT：候选基础修订号 ${candidate.baseRevision} 已过时，当前修订号 ${formal.revision}`);
        if ((touchesProse(candidate) && !candidate.reviews.length) || candidate.reviews.some(review => review.candidateHash !== candidate.hash || !['continuity', 'reader', 'style'].includes(review.role) || !['pass', 'revise'].includes(review.verdict))) throw new Error('REVIEW_REQUIRED：候选需要绑定当前 hash 的 continuity/reader/style 审查，审查建议由作者决定是否接受');
        const prepared = this.previewCommands(formal, candidate.commands);
        if (!equalJSON(approvalChanges(prepared.changes), approvalChanges(candidate.changes)) ||
          hasSemanticChanges(JSON.parse(json(prepared.workspace)) as Workspace, candidate.workspace) || prepared.workspace.revision !== candidate.workspace.revision) throw new Error('CANDIDATE_DIFF_MISMATCH：正式提交与已预览的候选修改不一致');
        const committed = this.executeInTransaction({ projectId: state.projectId, expectedRevision: candidate.baseRevision, actor: 'ai', taskId: run.id, label: candidate.label, commands: prepared.commands }, formal, prepared);
        project = committed.workspace;
        candidate.status = 'applied'; candidate.batchId = committed.batch?.id; candidate.appliedRevision = project.revision;
        candidate.commands = prepared.commands; candidate.changes = prepared.changes; candidate.workspace = structuredClone(project);
        result = { ok: true, candidateId: candidate.id, candidateHash: candidate.hash, batchId: candidate.batchId,
          appliedRevision: project.revision, revision: project.revision, changes: prepared.changes };
      } else {
        candidate.status = 'rejected';
        result = { ok: false, reason: 'author_declined', detail: decision.reason };
      }
      // Return and checkpoint the exact JSON result a later idempotent replay reads.
      result = JSON.parse(json(result));
      candidate.commitCallKey = waiting.callKey;
      const receipt: AgentReceipt = { key: waiting.callKey, runId: run.id, projectId: state.projectId,
        argumentsHash: waiting.argumentsHash, status: decision.approve ? 'completed' : 'denied', result, at };
      this.saveAgentReceiptInTransaction(receipt);
      // The callback sees the original waiting call so it can append its tool result.
      const callbackResult: unknown = updateCheckpoint(state, result);
      if (callbackResult && typeof (callbackResult as { then?: unknown }).then === 'function') throw new Error('审批 checkpoint 回调必须同步，不能返回 Promise');
      delete state.waiting; delete state.pauseReason;
      state.updatedAt = at; run.status = 'running'; delete run.finishedAt;
      if (run.runtime) {
        run.runtime = { ...run.runtime, plan: state.plan, artifacts: state.artifacts, budget: state.budget,
          candidates: state.candidates.map(({ workspace: _workspace, commands: _commands, ...summary }) => summary),
          waiting: undefined, pauseReason: state.pauseReason, finalSummary: state.finalSummary };
      }
      this.saveAgentStateInTransaction(state, run);
      return { state, run, ...(project ? { project } : {}), result };
    });
  }

  importProject(input: Workspace | Backup | string): Workspace {
    const parsed: Workspace | Backup = typeof input === 'string' ? JSON.parse(input) : input;
    if (!parsed || typeof parsed !== 'object') throw new Error('备份格式无效');
    if ('history' in parsed || 'runs' in parsed) throw new Error('项目备份只包含创作数据，不导入操作历史或运行记录');
    const backup: Backup = 'workspace' in parsed ? parsed : { workspace: parsed };
    validateWorkspace(backup.workspace);
    const workspace = structuredClone(backup.workspace); workspace.id = randomUUID();
    workspace.characterStates ??= []; workspace.theme ??= ''; workspace.logline ??= ''; workspace.structureTemplate ??= ''; workspace.acts ??= [];
    this.save(workspace); return workspace;
  }

  close(): void { this.db.close(); }
}
