import type { Command, SourceReference, Workspace } from '../../shared/types.js';
import type { CompanionOp, CompanionOpKind, CompanionProposal } from '../../shared/companion-types.js';
import { companionCommands } from '../../shared/companion.js';
import { DomainValidationError } from '../domain.js';

export const STORY_OPS: readonly CompanionOpKind[] = ['addAct', 'updateAct', 'addChapter', 'updateChapter', 'addScene', 'updateScene', 'moveScene', 'continueScene', 'changeState',
  'addEvent', 'addCard', 'updateNovel', 'addCharacter', 'updateCharacter', 'addSetting', 'updateSetting', 'link', 'addCause'];
export const STORY_OPS_HELP = `opsJson 是 JSON 编码的故事操作数组（与创作伙伴相同的格式），由程序换算成领域命令：画布位置、引用卡片、连线和 ref 引用都自动处理，不需要编 id 或坐标。
每个操作：{op, ref, targetId, parentRef, parentId, title, content, purpose, order, povName, causes, people, places, events, field}，不需要的字段填 null 或 []。
addCharacter{title=人物名, content=作者设定, purpose=创作目标, ref}；updateCharacter{targetId, title?, content?, purpose?}；addSetting{title=环境名, content=环境设定, purpose=世界规则, ref}；updateSetting{targetId, title?, content?, purpose?}；
link{parentId|parentRef, targetId, title=关系}（卡片/人物/环境/事件/场景之间在灵感画布上连线）；
addEvent{title, content, purpose, causes=前因事件 id/ref, targetId=它引发的事件, people=人物名/ref, ref}；addCause{targetId=结果事件, causes=更早的前因}；addCard{title, content, ref}；
addAct{title, purpose, content, ref}（卷：数十到数百章的情节阶段）；addChapter{title, content, parentId|parentRef=卷, targetId=插在哪一章之后, ref}（章：一次连载，约 project.chapterTarget 字）；
addScene{title, content=大纲, parentId|parentRef=章节, order=在该章场景段中的位置, povName=视角人物, people=出场人物, places=发生地点（环境名/id/ref）, events=呈现的世界事件}：新场景从这一章开始（建一个空的场景段）；没有合适章节时先 addChapter 再用 parentRef 引用，未指明章节时会自动新建同名章节。
场景独立于章节，一场可以跨几章：continueScene{targetId=场景 id/ref, parentId|parentRef=接着写的章节（不填则为它最后出现那一章的下一章，必要时新建）, content=这一段要写到哪里, order, ref}。
changeState{targetId=人物或环境（id/ref/名字）, parentId|parentRef=发生变化的场景（跨章场景可给场景段 id）, field=方面（心理/视角/认知/动机/状态/氛围，或作者自己的方面如“境界”）, content=从此以后的状态, purpose=为什么变、正文怎样体现, events=伴随的世界事件（须是该场景呈现的事件，可为 []）}：人物与环境的变化就是情节，一个方面一个操作。
updateAct/updateChapter/updateScene{targetId, …}（updateScene 的 people/places/events 只追加）；moveScene{targetId=场景 id（跨了几章的场景给要移动的场景段 id）, parentId|parentRef=章节, order}；
updateNovel{field=theme|logline|brief|genre|audience, content}。新建条目用 ref（如 c1），后续操作在 parentRef/targetId/people/places/events/povName/causes 中引用它。不能删除，也不能改正文。`;

/** Fill omitted fields so loosely formatted model output still converts. */
function normalizeOp(raw: unknown, index: number, allowed: readonly CompanionOpKind[]): CompanionOp {
  if (!raw || typeof raw !== 'object') throw new DomainValidationError('opsJson 的每一项必须是对象');
  const value = raw as Record<string, unknown>;
  if (!allowed.includes(value.op as CompanionOpKind)) throw new DomainValidationError(`不支持的故事操作：${String(value.op)}`);
  const text = (key: string) => typeof value[key] === 'string' ? value[key] as string : null;
  const list = (key: string) => Array.isArray(value[key]) ? (value[key] as unknown[]).filter((item): item is string => typeof item === 'string') : [];
  return { id: `o${index + 1}`, op: value.op as CompanionOpKind, ref: text('ref'), targetId: text('targetId'), parentRef: text('parentRef'), parentId: text('parentId'),
    title: text('title'), content: text('content'), purpose: text('purpose'), order: typeof value.order === 'number' ? value.order : null, povName: text('povName'),
    causes: list('causes'), people: list('people'), places: list('places'), events: list('events'), field: text('field') };
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
