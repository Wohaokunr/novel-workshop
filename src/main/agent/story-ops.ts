import type { Command, SourceReference, Workspace } from '../../shared/types.js';
import type { CompanionOp, CompanionOpKind, CompanionProposal } from '../../shared/companion-types.js';
import { companionCommands } from '../../shared/companion.js';
import { DomainValidationError } from '../domain.js';

export const STORY_OPS: readonly CompanionOpKind[] = ['addAct', 'updateAct', 'addChapter', 'updateChapter', 'addScene', 'updateScene', 'moveScene', 'addEvent', 'addCard',
  'updateNovel', 'addCharacter', 'updateCharacter', 'link', 'addCause'];
export const STORY_OPS_HELP = `opsJson 是 JSON 编码的故事操作数组（与创作伙伴相同的格式），由程序换算成领域命令：画布位置、引用卡片、连线和 ref 引用都自动处理，不需要编 id 或坐标。
每个操作：{op, ref, targetId, parentRef, parentId, title, content, purpose, order, povName, causes, people, field}，不需要的字段填 null 或 []。
addCharacter{title=人物名, content=作者设定, purpose=创作目标, ref}；updateCharacter{targetId, title?, content?, purpose?}；link{parentId|parentRef, targetId, title=关系}（卡片/人物/事件/场景之间在灵感画布上连线）；
addEvent{title, content, purpose, causes=前因事件 id/ref, targetId=它引发的事件, people=人物名/ref, ref}；addCause{targetId=结果事件, causes=更早的前因}；addCard{title, content, ref}；
addAct{title, purpose, content, ref}；addChapter{title, content, parentId|parentRef=幕, ref}；addScene{title, content=大纲, parentId|parentRef=章节, povName}；updateAct/updateChapter/updateScene{targetId, …}；moveScene{targetId, parentId=章节, order}；
updateNovel{field=theme|logline|brief|genre|audience, content}。新建条目用 ref（如 c1），后续操作在 parentRef/targetId/people/povName/causes 中引用它。不能删除，也不能改正文。`;

/** Fill omitted fields so loosely formatted model output still converts. */
function normalizeOp(raw: unknown, index: number, allowed: readonly CompanionOpKind[]): CompanionOp {
  if (!raw || typeof raw !== 'object') throw new DomainValidationError('opsJson 的每一项必须是对象');
  const value = raw as Record<string, unknown>;
  if (!allowed.includes(value.op as CompanionOpKind)) throw new DomainValidationError(`不支持的故事操作：${String(value.op)}`);
  const text = (key: string) => typeof value[key] === 'string' ? value[key] as string : null;
  const list = (key: string) => Array.isArray(value[key]) ? (value[key] as unknown[]).filter((item): item is string => typeof item === 'string') : [];
  return { id: `o${index + 1}`, op: value.op as CompanionOpKind, ref: text('ref'), targetId: text('targetId'), parentRef: text('parentRef'), parentId: text('parentId'),
    title: text('title'), content: text('content'), purpose: text('purpose'), order: typeof value.order === 'number' ? value.order : null, povName: text('povName'),
    causes: list('causes'), people: list('people'), field: text('field') };
}

/** Convert story ops into domain commands through the same guarded path the creative partner uses. */
export function storyOpsCommands(workspace: Workspace, opsJson: string, options: { references?: SourceReference[]; allowed?: readonly CompanionOpKind[] } = {}): { commands: Command[]; skipped: string[] } {
  if (!opsJson.trim()) return { commands: [], skipped: [] };
  if (opsJson.length > 80_000) throw new DomainValidationError('opsJson 过长');
  let parsed: unknown;
  try { parsed = JSON.parse(opsJson); } catch { throw new DomainValidationError('opsJson 必须是有效 JSON'); }
  if (!Array.isArray(parsed) || parsed.length > 120) throw new DomainValidationError('opsJson 须是至多 120 个操作的数组');
  const proposal: CompanionProposal = { id: 'agent', title: '', summary: '', ops: parsed.map((item, index) => normalizeOp(item, index, options.allowed ?? STORY_OPS)) };
  const references = (options.references ?? []).filter(reference => reference.kind === 'card' || workspace.cards.some(card => card.refId === reference.id));
  try {
    // Events and scenes get canvas cards only when the task is anchored on the canvas; characters and links always land there.
    const surface = references.some(reference => reference.kind === 'card') ? 'canvas' : 'panel';
    const { commands, skipped } = companionCommands(workspace, { ideas: [], ops: proposal.ops.map(op => ({ proposal, op })) }, { mode: 'diverge', anchor: { surface, references } });
    return { commands, skipped };
  } catch (error) { throw new DomainValidationError(error instanceof Error ? error.message : String(error)); }
}
