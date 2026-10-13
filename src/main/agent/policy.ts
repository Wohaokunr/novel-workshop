import { isDeepStrictEqual } from 'node:util';
import type { AgentBudget, AgentRole, PlanNode } from '../../shared/agent-types.js';
import type { Change, CharacterState, NarrativeScene, RunRequest, Workspace } from '../../shared/types.js';
import { DomainValidationError, NOVEL_FIELDS, validateWorkspace } from '../domain.js';
import { STYLE_KEYS, styleProfile, type StyleKey } from '../../shared/style-types.js';

export const MAX_PLAN_NODES = 12;
/** The one role list. plan: the coordinator may put the role in a plan (the stylist only runs inside candidate review);
 * upstream: the role receives its plan dependencies' conclusions (character, reader, stylist and evolution keep bounded views). */
export const ROLE_CAPABILITIES: Readonly<Record<AgentRole, { readAuthor: boolean; proposeCommands: boolean; plan: boolean; upstream: boolean; directWrite: false }>> = Object.freeze({
  coordinator: { readAuthor: true, proposeCommands: true, plan: false, upstream: false, directWrite: false },
  theme: { readAuthor: true, proposeCommands: true, plan: true, upstream: true, directWrite: false },
  planner: { readAuthor: true, proposeCommands: true, plan: true, upstream: true, directWrite: false },
  world: { readAuthor: true, proposeCommands: true, plan: true, upstream: true, directWrite: false },
  narrative: { readAuthor: true, proposeCommands: true, plan: true, upstream: true, directWrite: false },
  canvas: { readAuthor: true, proposeCommands: true, plan: true, upstream: true, directWrite: false },
  cast: { readAuthor: true, proposeCommands: true, plan: true, upstream: true, directWrite: false },
  writer: { readAuthor: true, proposeCommands: true, plan: true, upstream: true, directWrite: false },
  evolution: { readAuthor: true, proposeCommands: true, plan: true, upstream: false, directWrite: false },
  character: { readAuthor: false, proposeCommands: false, plan: true, upstream: false, directWrite: false },
  reader: { readAuthor: false, proposeCommands: false, plan: true, upstream: false, directWrite: false },
  continuity: { readAuthor: true, proposeCommands: false, plan: true, upstream: true, directWrite: false },
  // Reads prose and the style profile only, never world truth.
  stylist: { readAuthor: false, proposeCommands: false, plan: false, upstream: false, directWrite: false },
});
const roleNames = Object.keys(ROLE_CAPABILITIES) as AgentRole[];
/** Roles a plan node may name, in a stable order (also the tool schema's enum). */
export const PLAN_ROLES = roleNames.filter(role => ROLE_CAPABILITIES[role].plan) as Array<PlanNode['role']>;
export const UPSTREAM_ROLES: ReadonlySet<AgentRole> = new Set(roleNames.filter(role => ROLE_CAPABILITIES[role].upstream));
export function isRole(role: string): role is AgentRole { return Object.hasOwn(ROLE_CAPABILITIES, role); }

/** Prose needs independent review; settings, canvas, cast and outline changes go straight to one-click approval. */
export function touchesProse(candidate: { changes: Change[] }): boolean {
  return candidate.changes.some(change => change.collection === 'scenes'
    && ((change.before as { text?: string } | undefined)?.text ?? '') !== ((change.after as { text?: string } | undefined)?.text ?? ''));
}

export function canReadAuthor(role: AgentRole): boolean { return ROLE_CAPABILITIES[role]?.readAuthor === true; }
export function canProposeCommands(role: AgentRole): boolean { return ROLE_CAPABILITIES[role]?.proposeCommands === true; }

export function createBudget(): AgentBudget {
  return {
    maxModelCalls: 36, maxToolCalls: 100, maxChildren: 16, maxParallel: 2,
    maxReplans: 2, maxRevisions: 2, maxActiveMs: 30 * 60 * 1000, maxTokens: 500_000,
    modelCalls: 0, toolCalls: 0, children: 0, replans: 0, revisions: 0,
    activeMs: 0, tokens: 0, usageUnknown: false,
  };
}

function requireScope(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainValidationError(`WRITE_SCOPE：${message}`);
}
function requirePlan(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainValidationError(`PLAN_INVALID：${message}`);
}

/** Reading a reference never expands these write targets. */
export function scopedScenes(workspace: Workspace, request: RunRequest): NarrativeScene[] {
  requireScope(workspace.id === request.projectId, '任务与项目不匹配');
  if (request.sceneId) {
    const scene = workspace.scenes.find(item => item.id === request.sceneId);
    requireScope(scene, '目标场景不存在');
    requireScope(!request.chapterId || scene.chapterId === request.chapterId, '场景不属于目标章节');
    return [scene];
  }
  requireScope(request.stage !== 'rewrite', '改写需要明确目标场景');
  const chapterId = request.chapterId ?? [...workspace.chapters].sort((a, b) => a.order - b.order)[0]?.id;
  requireScope(chapterId && workspace.chapters.some(chapter => chapter.id === chapterId), '目标章节不存在');
  return workspace.scenes.filter(scene => scene.chapterId === chapterId);
}

/** Reused by specialist construction; dependencies are validated separately by validatePlan. */
export function validatePlanTarget(node: PlanNode, workspace: Workspace, request: RunRequest): void {
  requirePlan(workspace.id === request.projectId, '任务与项目不匹配');
  // Any specialist: review builds reader and stylist nodes too. Whether the coordinator may plan a role is checked by set_plan (PLAN_ROLES).
  requirePlan(node && isRole(node.role) && (node.role as string) !== 'coordinator', '角色无效');
  const sceneId = node.sceneId ?? request.sceneId;
  const chapterId = node.chapterId ?? request.chapterId;
  const scene = sceneId ? workspace.scenes.find(item => item.id === sceneId) : undefined;
  if (sceneId !== undefined) requirePlan(scene, '目标场景不存在');
  if (chapterId !== undefined) requirePlan(workspace.chapters.some(item => item.id === chapterId), '目标章节不存在');
  if (scene && chapterId) requirePlan(scene.chapterId === chapterId, '场景不属于目标章节');
  if (node.characterId !== undefined) requirePlan(workspace.objects.some(item => item.id === node.characterId && item.typeId === 'character'), '目标人物不存在');
  const event = node.eventId ? workspace.objects.find(item => item.id === node.eventId && item.typeId === 'event' && item.event) : undefined;
  if (node.eventId !== undefined) requirePlan(event, '目标事件不存在');
  if (scene && event) requirePlan(scene.eventIds.includes(event.id), '事件不属于目标场景');
  if (node.role === 'character' || node.role === 'evolution') {
    requirePlan(node.characterId && event?.event, '角色分析需要明确人物和事件');
    requirePlan(event.event.participants.includes(node.characterId) || Object.hasOwn(event.event.observations, node.characterId)
      || workspace.scenes.some(item => item.eventIds.includes(event.id) && item.povId === node.characterId), '人物与事件无关');
  }
  if (node.role === 'writer') {
    requirePlan(scene, '写作需要明确目标场景');
    if (request.stage === 'rewrite' || request.stage === 'chapter') {
      requirePlan(scopedScenes(workspace, request).some(item => item.id === scene.id), '写作目标超出任务范围');
      if (request.stage === 'chapter') requirePlan(!scene.text.trim(), '已有正文须使用改写任务');
    }
  }
  if (node.role === 'evolution' && request.stage === 'chapter') {
    requirePlan(scopedScenes(workspace, request).some(item => item.eventIds.includes(node.eventId!)), '人物演进超出章节写作范围');
  }
  if (request.stage === 'rewrite') {
    const target = scopedScenes(workspace, request)[0]!;
    if (request.selection) {
      const { start, end } = request.selection;
      requirePlan(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= target.text.length, '改写选区无效');
    }
  }
}

export function validatePlan(nodes: PlanNode[], workspace: Workspace, request: RunRequest): void {
  requirePlan(Array.isArray(nodes) && nodes.length > 0 && nodes.length <= MAX_PLAN_NODES, `计划须包含 1–${MAX_PLAN_NODES} 个节点`);
  const ids = new Set<string>();
  for (const node of nodes) {
    requirePlan(node && typeof node.id === 'string' && node.id.trim() && !ids.has(node.id), '节点 ID 无效或重复');
    ids.add(node.id);
    requirePlan(typeof node.objective === 'string' && node.objective.trim() && node.objective.length <= 4000, '节点目标不能为空或过长');
    requirePlan(typeof node.acceptance === 'string' && node.acceptance.trim() && node.acceptance.length <= 4000, '节点验收标准不能为空或过长');
    requirePlan(['pending', 'running', 'completed', 'failed'].includes(node.status), '节点状态无效');
    requirePlan(Array.isArray(node.dependsOn) && node.dependsOn.every(id => typeof id === 'string') && new Set(node.dependsOn).size === node.dependsOn.length, '依赖节点列表无效');
    validatePlanTarget(node, workspace, request);
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (node: PlanNode): void => {
    requirePlan(!visiting.has(node.id), '依赖图不能成环');
    if (visited.has(node.id)) return;
    visiting.add(node.id);
    for (const id of node.dependsOn) {
      requirePlan(id !== node.id && byId.has(id), '依赖节点不存在或指向自身');
      visit(byId.get(id)!);
    }
    visiting.delete(node.id); visited.add(node.id);
  };
  for (const node of nodes) visit(node);
}

/** Writer nodes run in reading order, each after the previous one, so every scene is written after the prose it follows.
 * Only edges that cannot form a cycle are added (nodes already ordered either way are left alone). Returns how many were added. */
export function chainWriterNodes(nodes: PlanNode[], workspace: Workspace, request: RunRequest): number {
  const chapters = new Map([...workspace.chapters].sort((a, b) => a.order - b.order).map((chapter, index) => [chapter.id, index]));
  const position = (node: PlanNode) => {
    const scene = workspace.scenes.find(item => item.id === (node.sceneId ?? request.sceneId));
    return scene ? [chapters.get(scene.chapterId) ?? Infinity, scene.order] : [Infinity, Infinity];
  };
  const writers = nodes.filter(node => node.role === 'writer').map(node => ({ node, at: position(node) }))
    .sort((a, b) => a.at[0]! - b.at[0]! || a.at[1]! - b.at[1]!).map(item => item.node);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const reaches = (from: PlanNode, target: string, seen = new Set<string>()): boolean => from.dependsOn.some(id => {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const next = byId.get(id);
    return !!next && reaches(next, target, seen);
  });
  let added = 0;
  for (let index = 1; index < writers.length; index++) {
    const previous = writers[index - 1]!, node = writers[index]!;
    if (reaches(node, previous.id) || reaches(previous, node.id)) continue;
    node.dependsOn.push(previous.id); added++;
  }
  return added;
}

const collections = ['objectTypes', 'objects', 'acts', 'chapters', 'scenes', 'facts', 'knowledge', 'characterStates', 'cards', 'canvasLinks'] as const;
const metadata = NOVEL_FIELDS;
function changeValue(workspace: Workspace, change: Change): unknown {
  if (change.collection === 'metadata' && metadata.includes(change.key as typeof metadata[number])) return workspace[change.key as typeof metadata[number]] ?? '';
  if (change.collection === 'layouts') return workspace.layouts[change.key];
  if (change.collection === 'style' && STYLE_KEYS.includes(change.key as StyleKey)) return styleProfile(workspace)[change.key as StyleKey];
  if (collections.includes(change.collection as typeof collections[number])) return (workspace[change.collection as typeof collections[number]] ?? []).find(item => item.id === change.key);
  throw new DomainValidationError(`WRITE_SCOPE：不支持的变更集合 ${change.collection}`);
}
function legalScopedState(workspace: Workspace, state: CharacterState, scenes: Map<string, NarrativeScene>): boolean {
  const event = workspace.objects.find(item => item.id === state.eventId)?.event;
  return !!event && workspace.objects.some(item => item.id === state.characterId && item.typeId === 'character')
    && state.sceneIds.length > 0 && state.sceneIds.every(id => scenes.get(id)?.eventIds.includes(state.eventId))
    && (event.participants.includes(state.characterId) || Object.hasOwn(event.observations, state.characterId)
      || state.sceneIds.some(id => scenes.get(id)?.povId === state.characterId));
}

/** Verify actual workspaces, not only a caller-supplied diff. Store remains responsible for AI layout protection. */
export function assertWriteScope(request: RunRequest, before: Workspace, after: Workspace, changes: Change[]): void {
  requireScope(before.id === request.projectId && after.id === before.id && before.schemaVersion === after.schemaVersion, '不能跨项目或改写项目标识');
  requireScope(['agent', 'idea', 'outline', 'assist', 'chapter', 'rewrite'].includes(request.stage), '任务阶段无效');
  requireScope(Array.isArray(changes), '变更列表无效');
  for (const change of changes) {
    requireScope(isDeepStrictEqual(change.before, changeValue(before, change)), '变更前值与守护快照不匹配');
    requireScope(isDeepStrictEqual(change.after, changeValue(after, change)), '变更后值与候选快照不匹配');
  }
  validateWorkspace(after);
  if (request.stage !== 'chapter' && request.stage !== 'rewrite') return;

  const targets = new Map(scopedScenes(before, request).map(scene => [scene.id, scene]));
  for (const key of metadata) requireScope((before[key] ?? '') === (after[key] ?? ''), '正文任务不能修改作品设定');
  requireScope(isDeepStrictEqual(styleProfile(before), styleProfile(after)), '正文任务不能修改文风档案');
  requireScope(isDeepStrictEqual(before.layouts, after.layouts) && isDeepStrictEqual(before.reading, after.reading), '正文任务不能修改布局或阅读设置');
  for (const collection of collections.filter(key => key !== 'scenes' && key !== 'characterStates')) {
    requireScope(isDeepStrictEqual(before[collection], after[collection]), `正文任务不能修改 ${collection}`);
  }
  requireScope(before.scenes.length === after.scenes.length, '正文任务不能新增或删除场景');
  for (const scene of before.scenes) {
    const next = after.scenes.find(item => item.id === scene.id);
    requireScope(next, '正文任务不能删除场景');
    if (!targets.has(scene.id)) { requireScope(isDeepStrictEqual(scene, next), '不能修改目标以外的场景（参考不等于写入授权）'); continue; }
    const { text: oldText, ...oldScene } = scene;
    const { text: nextText, ...newScene } = next;
    requireScope(isDeepStrictEqual(oldScene, newScene), '正文任务只能修改场景文本');
    if (request.stage === 'chapter') requireScope(!oldText.trim() || oldText === nextText, '必须守护章节中已有的正式正文');
    if (request.stage === 'rewrite' && request.selection) {
      const { start, end } = request.selection;
      requireScope(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= oldText.length, '改写选区无效');
      const prefix = oldText.slice(0, start), suffix = oldText.slice(end);
      requireScope(nextText.length >= prefix.length + suffix.length && nextText.startsWith(prefix) && nextText.endsWith(suffix), '改写必须保留选区外的前缀和后缀');
    }
  }
  const previousStates = before.characterStates ?? [], nextStates = after.characterStates ?? [];
  if (request.stage === 'rewrite') {
    requireScope(isDeepStrictEqual(previousStates, nextStates), '改写只允许目标场景文本，不允许附带人物状态修改');
    return;
  }
  for (const old of previousStates) {
    const next = nextStates.find(state => state.id === old.id);
    requireScope(next, '章节写作不能删除人物状态');
    if (isDeepStrictEqual(old, next)) continue;
    requireScope(old.characterId === next.characterId && old.eventId === next.eventId, '不能移动人物状态的时间锚');
    requireScope(legalScopedState(before, old, targets) && legalScopedState(after, next, targets), '人物状态只能使用目标场景的合法证据');
  }
  for (const next of nextStates.filter(state => !previousStates.some(old => old.id === state.id))) {
    requireScope(legalScopedState(after, next, targets), '新增人物状态必须属于目标场景及其合法参与人物');
  }
}
