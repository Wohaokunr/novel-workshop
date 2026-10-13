import { createHash } from 'node:crypto';
import type { AgentRole, EvidenceSource, SpecialistRequest, UpstreamResult } from '../../shared/agent-types.js';
import type { AgentStep, Command, NarrativeScene, Passage, RunRequest, StateChange, Workspace } from '../../shared/types.js';
import { buildCharacterContext, buildReaderContext, buildWriterContext, WRITER_CONTEXT_CHARS, WRITER_PRIORITY } from '../context.js';
import { applyCommands, DomainValidationError } from '../domain.js';
import { objectSchema, validateSchema, type AgentDefinition, type JsonSchema } from '../responses.js';
import { boundedContext, collectContext, sourceFor, sourcesForLabels } from './memory.js';
import { nodeTarget, UPSTREAM_ROLES, validatePlanTarget } from './policy.js';
import { passageMentions } from './story-index.js';
import { ASPECT_KEY_CHARS, ASPECT_VALUE_CHARS, aspectKey, labelledAspects, MAX_STATE_ASPECTS, sceneSubjects, STATE_ASPECTS, storyTimeline, type StatePoint } from '../../shared/story-state.js';
import { orderedChapters } from '../../shared/structure.js';
import { STORY_OPS, storyOpsCommands } from './story-ops.js';
import { characterPrompt, commandHelpPrompt, continuityPrompt, evolutionPrompt, proposalPrompts, readerPrompt, reviewFormatPrompt, stylistPrompt, themePrompt, writerPrompt, writerScopePrompts } from '../prompts/specialists.js';
import type { CompanionOpKind } from '../../shared/companion-types.js';
import { openThreads, StoryView } from './story-view.js';
import { objectNames } from '../../shared/story-elements.js';
import { writerStyle } from './style.js';
import { styleProfile } from '../../shared/style-types.js';
import { styleBaseline, styleLint } from '../../shared/style-metrics.js';

export const READER_TEXT_CHARS = 12_000;
export const EVIDENCE_TEXT_CHARS = 6_000;
/** Prose a stylist or continuity review reads in full, shared among its target passages; longer text keeps its head and tail. */
export const REVIEW_TEXT_CHARS = 18_000;
/** Prose around the cursor a continuation sees beside the whole passage: what it must follow, and what it must lead into. */
const CURSOR_BEFORE_CHARS = 2000, CURSOR_AFTER_CHARS = 800;
/** People and places an evolution step may record changes for in one scene. */
export const EVOLUTION_SUBJECTS = 12;

// Match the established agents.ts result schemas; no transport or provider-specific API is introduced.
const string = { type: 'string' }, strings = { type: 'array', items: string };
const perspectiveSchema = objectSchema({ perspective: string, intention: string, action: string, uncertainty: string });
const reviewIssueSchema = objectSchema({ quote: string, problem: string, fix: string, severity: { type: 'string', enum: ['must', 'should'] } });
export const reviewSchema = objectSchema({ verdict: { type: 'string', enum: ['pass', 'revise'] }, issues: { type: 'array', items: reviewIssueSchema }, recommendation: string });
const patchSchema = objectSchema({ edits: { type: 'array', items: objectSchema({ quote: string, replacement: string }) }, note: string });
export interface ReviewIssue { quote: string; problem: string; fix: string; severity: 'must' | 'should' }

/** A reviewer's answer as stored on a candidate: only a must-fix issue asks for a revision, whatever verdict the model gave. */
export function reviewOutcome(structured: unknown): { verdict: 'pass' | 'revise'; issues: string[]; recommendation: string } {
  const review = structured as { verdict: 'pass' | 'revise'; issues: Array<ReviewIssue | string>; recommendation: string };
  // Reviews recorded before issues were structured keep their wording and verdict when a run resumes.
  if (review.issues.some(issue => typeof issue === 'string')) return { verdict: review.verdict, issues: review.issues.map(issue => typeof issue === 'string' ? issue : issue.problem), recommendation: review.recommendation };
  const issues = [...review.issues as ReviewIssue[]].sort((a, b) => (a.severity === 'must' ? 0 : 1) - (b.severity === 'must' ? 0 : 1));
  return { verdict: issues.some(issue => issue.severity === 'must') ? 'revise' : 'pass', recommendation: review.recommendation,
    issues: issues.map(issue => `${issue.severity === 'must' ? '【必须】' : '【建议】'}${issue.quote ? `「${issue.quote}」` : ''}${issue.problem}${issue.fix ? `｜改法：${issue.fix}` : ''}`) };
}
/** Applies a patch writer's edits; every quote must occur exactly once in the current text, or the writer is asked again. */
export function applyEdits(text: string, edits: Array<{ quote: string; replacement: string }>): string {
  const problems: string[] = [];
  const located = edits.map(edit => {
    const at = edit.quote ? text.indexOf(edit.quote) : -1;
    if (at < 0) problems.push(`找不到「${edit.quote.slice(0, 40)}」`);
    else if (text.indexOf(edit.quote, at + 1) >= 0) problems.push(`「${edit.quote.slice(0, 40)}」在正文中出现不止一次，请摘录更长的一段`);
    return { ...edit, at };
  }).filter(edit => edit.at >= 0).sort((a, b) => a.at - b.at);
  for (let index = 1; index < located.length; index++) if (located[index]!.at < located[index - 1]!.at + located[index - 1]!.quote.length) problems.push(`「${located[index]!.quote.slice(0, 40)}」与另一条 edit 重叠，请合并`);
  if (problems.length) throw new DomainValidationError(`edits 的 quote 必须逐字摘自当前正文且只出现一次：${problems.join('；')}`);
  let result = '', cursor = 0;
  for (const edit of located) { result += text.slice(cursor, edit.at) + edit.replacement; cursor = edit.at + edit.quote.length; }
  return result + text.slice(cursor);
}
/** A passage's prose within a review budget: whole when it fits, otherwise head and tail around a marked gap. */
function reviewText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit / 2)}\n……（中间 ${text.length - limit} 字略）……\n${text.slice(-limit / 2)}` : text;
}
const themeSchema = objectSchema({ question: string, choices: string, cost: string, expression: string });
export const evolutionSchema = objectSchema({ changes: { type: 'array', items: objectSchema({
  subjectId: string, eventId: string, aspects: { type: 'array', items: objectSchema({ aspect: string, value: string }) }, note: string,
}) } });
interface EvolutionOutput { changes: Array<{ subjectId: string; eventId: string; aspects: Array<{ aspect: string; value: string }>; note: string }> }
const proposalSchema = objectSchema({ summary: string, commandsJson: string, opsJson: string });

/** A recorded change keeps one id per subject and place, so recording the same scene again updates it instead of adding another. */
export function stateChangeId(change: Pick<StateChange, 'subjectId' | 'sceneId' | 'passageId' | 'eventId'>): string {
  return `change-${createHash('sha1').update(JSON.stringify([change.subjectId, change.sceneId ?? null, change.passageId ?? null, change.eventId ?? null]), 'utf8').digest('hex').slice(0, 20)}`;
}
const samePlace = (a: Pick<StateChange, 'subjectId' | 'sceneId' | 'passageId'>, b: typeof a) =>
  a.subjectId === b.subjectId && a.sceneId === b.sceneId && a.passageId === b.passageId;
const sameAnchor = (a: Pick<StateChange, 'subjectId' | 'sceneId' | 'passageId' | 'eventId'>, b: typeof a) => samePlace(a, b) && a.eventId === b.eventId;

export interface SpecialistDefinition {
  definition: AgentDefinition;
  context: unknown;
  objective: string;
  sources: EvidenceSource[];
  /** Pure conversion only. The coordinator must preview, assert scope, review and request approval. */
  toCommands?(step: AgentStep): Command[];
  /** Set when there is nothing for the model to do: the node completes with this note and no commands, without a model call. */
  skip?: string;
}

type ProposalRole = 'planner' | 'world' | 'narrative' | 'canvas' | 'cast';
/** Story ops each proposing role may use; ops-derived commands are checked by op, not by command type. */
const roleOps: Record<ProposalRole, readonly CompanionOpKind[]> = {
  planner: STORY_OPS, canvas: STORY_OPS,
  world: ['addEvent', 'addCause', 'addCharacter', 'updateCharacter', 'addSetting', 'updateSetting', 'changeState', 'link', 'addCard'],
  narrative: ['addAct', 'updateAct', 'addChapter', 'updateChapter', 'addScene', 'updateScene', 'moveScene', 'continueScene', 'changeState', 'link'],
  cast: ['addCharacter', 'updateCharacter', 'link', 'addCard'],
};
function definition(id: string, label: string, instructions: string, outputSchema?: JsonSchema): AgentDefinition {
  // No direct writes and, critically, no read_project escape hatch for restricted roles.
  return { id, label, instructions, tools: [], ...(outputSchema ? { outputSchema } : {}) };
}
/** Roles that read or write prose see it with its paragraphs intact (see liftProse). */
function proseDefinition(id: string, label: string, instructions: string, outputSchema?: JsonSchema): AgentDefinition {
  return { ...definition(id, label, instructions, outputSchema), proseBlocks: true };
}
function result<T>(step: AgentStep, schema: JsonSchema): T {
  validateSchema(step.structured, schema);
  return step.structured as T;
}
function readerTarget(project: Workspace, request: RunRequest, passage?: Passage, chapterId?: string) {
  const targetChapter = chapterId ?? passage?.chapterId ?? request.chapterId ?? orderedChapters(project).at(-1)?.id;
  if (!targetChapter) throw new DomainValidationError('读者审阅需要章节');
  return { passageId: passage && passage.chapterId === targetChapter ? passage.id : undefined, chapterId: targetChapter };
}
function novelSources(project: Workspace): EvidenceSource[] { return [sourceFor(project, 'novel', project.id)!]; }
function validateProposal(project: Workspace, role: ProposalRole, step: AgentStep, request: RunRequest): Command[] {
  const proposal = result<{ summary: string; commandsJson: string; opsJson: string }>(step, proposalSchema);
  if (proposal.commandsJson.length > 80_000) throw new DomainValidationError('候选命令过长');
  let commands: unknown;
  try { commands = JSON.parse(proposal.commandsJson); } catch { throw new DomainValidationError('commandsJson 必须是有效 JSON'); }
  if (!Array.isArray(commands) || commands.length > 32) throw new DomainValidationError('候选须是至多 32 条命令的数组');
  const shared = ['putCard', 'deleteCard', 'putCanvasLink', 'deleteCanvasLink'];
  const allowed: Record<ProposalRole, string[]> = {
    planner: [...shared, 'updateNovel', 'putObjectType', 'deleteObjectType', 'putObject', 'deleteObject', 'putAct', 'deleteAct', 'putChapter', 'deleteChapter', 'putScene', 'deleteScene', 'putPassage', 'deletePassage', 'putFact', 'deleteFact', 'putKnowledge', 'deleteKnowledge', 'putStateChange', 'deleteStateChange'],
    world: [...shared, 'putObjectType', 'deleteObjectType', 'putObject', 'deleteObject', 'putFact', 'deleteFact', 'putKnowledge', 'deleteKnowledge', 'putScene', 'putStateChange'],
    narrative: [...shared, 'putAct', 'deleteAct', 'putChapter', 'deleteChapter', 'putScene', 'deleteScene', 'putPassage', 'deletePassage', 'putStateChange'],
    canvas: [...shared, 'putObjectType', 'putObject', 'putFact', 'putKnowledge', 'putChapter', 'putScene', 'putPassage'],
    cast: [],
  };
  for (const command of commands) {
    if (!command || typeof command !== 'object' || !allowed[role].includes(command.type)) throw new DomainValidationError(`命令不属于 ${role} 专家的候选能力`);
    if (command.type === 'putCard') {
      const existing = project.cards.find(card => card.id === command.value?.id);
      if (existing) command.value = { ...command.value, x: existing.x, y: existing.y,
        width: existing.width, height: existing.height, collapsed: existing.collapsed };
    }
  }
  const direct = commands as Command[];
  // Ops convert against the workspace after the direct commands, so they can refer to what those create.
  const ops = storyOpsCommands(direct.length ? applyCommands(project, direct) : project, proposal.opsJson === '[]' ? '' : proposal.opsJson, { references: request.references, allowed: roleOps[role] });
  const typed = [...direct, ...ops.commands];
  const preview = applyCommands(project, typed);
  // Catch cascaded deletion as well as explicit text changes (a putScene in the old shape carries prose too).
  for (const passage of project.passages) {
    const next = preview.passages.find(item => item.id === passage.id);
    if (passage.text.trim() && (!next || passage.text !== next.text)) throw new DomainValidationError('编排专家不能删除或改写已有正式正文');
  }
  for (const passage of preview.passages) if (!project.passages.some(item => item.id === passage.id) && passage.text.trim()) throw new DomainValidationError('编排专家新建场景段的正文必须为空');
  return typed;
}

/** Which roles build on earlier specialists' conclusions is ROLE_CAPABILITIES.upstream. Evolution reads the written prose of its
 * scene, which dependency folding already places in its workspace. */
const UPSTREAM_NOTICE = '本任务中已完成的前置专长结论，在此基础上继续。角色代入是人物当时的主观理解，可能有误；与正式原文或作者设定冲突时以原文和设定为准。前置修改已并入工作区的，会直接体现在资料中，不要重复创建。';

/** story: stored digests over this (possibly candidate) workspace; focusPassageIds: passages a review must examine;
 * upstream: conclusions of the plan node's finished dependencies, dropped for roles outside UPSTREAM_ROLES. */
export function specialistDefinition(specialist: SpecialistRequest & { story?: StoryView; focusPassageIds?: string[]; authorRules?: Array<{ kind: string; content: string }>; upstream?: UpstreamResult[] }): SpecialistDefinition {
  const { role, node, project, request } = specialist;
  const authorRules = specialist.authorRules ?? [];
  const upstream = UPSTREAM_ROLES.has(role) && specialist.upstream?.length ? { notice: UPSTREAM_NOTICE, results: specialist.upstream } : undefined;
  const story = specialist.story ?? new StoryView(project);
  if (role !== node.role) throw new DomainValidationError('专家角色与计划节点不一致');
  validatePlanTarget(node, project, request);
  const target = nodeTarget(node, project, request);
  const objective = node.objective;

  if (role === 'character') {
    const context = buildCharacterContext(project, node.characterId!, node.eventId!);
    return { definition: definition(`character:${context.characterId}`, `${context.name} · 角色代入`, characterPrompt.text, perspectiveSchema),
      context: boundedContext({ ...context }), objective: '面对当前关键情节，你会如何理解并行动？',
      sources: sourcesForLabels(project, context.sources, role) };
  }
  if (role === 'reader') {
    const reading = readerTarget(project, request, target.passage, node.chapterId);
    const context = buildReaderContext(project, reading.chapterId, reading.passageId);
    const chapters = [...project.chapters].filter(chapter => chapter.order <= project.chapters.find(item => item.id === reading.chapterId)!.order);
    return { definition: proseDefinition('reader', '读者 · 正文审阅', `${readerPrompt.text}\n${reviewFormatPrompt.text}`, reviewSchema),
      context: boundedContext({ title: context.title, earlierStory: readerEarlierStory(story, context.sources, context.text.length), text: context.text.slice(-READER_TEXT_CHARS),
        omitted: { earlierVisibleChars: Math.max(0, context.text.length - READER_TEXT_CHARS), notice: '这里只包含已呈现正文；earlierStory 是较早已读正文的摘要。未读后文和作者目标/设定未提供。' } }, undefined, ['text']),
      objective: '从读者视角审阅可见正文，给出 pass/revise、具体问题与修订建议。',
      sources: [sourceFor(project, 'novel:title', project.id)!, ...chapters.map(chapter => sourceFor(project, 'chapter:title', chapter.id)!), ...sourcesForLabels(project, context.sources, role)] };
  }
  if (role === 'writer') {
    const passage = structuredClone(target.passage!), title = story.label(passage.id);
    const selection = request.stage === 'rewrite' && request.passageId === passage.id ? request.selection : undefined;
    // An empty selection is a cursor: continue the prose there instead of replacing anything.
    const insert = !!selection && selection.start === selection.end;
    const { sources: labels, ...context } = buildWriterContext(project, passage.id, request.references, story);
    const patch = node.mode === 'patch' && !selection && !!passage.text.trim();
    if (patch) return { definition: proseDefinition('patch', `${title} · 局部修订`, `${writerPrompt.text}\n${writerScopePrompts.patch.text}`, patchSchema),
      context: boundedContext({ ...context, authorRules, ...(upstream ? { upstream } : {}) }, WRITER_CONTEXT_CHARS, WRITER_PRIORITY), objective,
      sources: [...novelSources(project), ...sourcesForLabels(project, labels, role)],
      toCommands: step => {
        const { edits } = result<{ edits: Array<{ quote: string; replacement: string }> }>(step, patchSchema);
        return [{ type: 'putPassage', value: { ...structuredClone(passage), text: applyEdits(passage.text, edits) } }];
      } };
    return { definition: proseDefinition(request.stage === 'rewrite' ? 'rewrite' : 'writer', `${title} · ${insert ? '续写' : '正文写作'}`, `${writerPrompt.text}\n${(insert ? writerScopePrompts.insert : selection ? writerScopePrompts.selection : writerScopePrompts.passage).text}`),
      context: boundedContext({ ...context, authorRules, ...(upstream ? { upstream } : {}), selectedText: selection && !insert ? passage.text.slice(selection.start, selection.end) : null,
        ...(insert ? { cursor: { before: passage.text.slice(Math.max(0, selection.start - CURSOR_BEFORE_CHARS), selection.start), after: passage.text.slice(selection.end, selection.end + CURSOR_AFTER_CHARS) } } : {}) }, WRITER_CONTEXT_CHARS, [...WRITER_PRIORITY.slice(0, 1), 'cursor', ...WRITER_PRIORITY.slice(1)]), objective,
      sources: [...novelSources(project), ...sourcesForLabels(project, labels, role)],
      toCommands: step => {
        if (typeof step.output !== 'string' || !step.output.trim()) throw new DomainValidationError('模型没有生成正文');
        const text = selection ? passage.text.slice(0, selection.start) + step.output + passage.text.slice(selection.end) : step.output;
        return [{ type: 'putPassage', value: { ...structuredClone(passage), text } }];
      } };
  }
  if (role === 'evolution') return evolutionDefinition(project, request, story, target.scene!, target.passage, node.characterId, authorRules);

  if (role === 'stylist') {
    const focus = specialist.focusPassageIds?.length ? specialist.focusPassageIds : target.passage ? [target.passage.id] : [];
    const passages = focus.map(id => story.passage(id)).filter((passage): passage is Passage => !!passage?.text.trim()).slice(0, 3);
    if (!passages.length) throw new DomainValidationError('文风审阅需要已有正文的场景段');
    const profile = styleProfile(project), baseline = styleBaseline(profile);
    const before = story.order[story.positionOf(passages[0]!.id) - 1];
    const { notice: _notice, ...style } = writerStyle(project, story.sceneOf(passages[0]!.id)!, passages[0]!.text);
    return { definition: proseDefinition('stylist', '文风 · 笔触审阅', `${stylistPrompt.text}\n${reviewFormatPrompt.text}`, reviewSchema),
      context: boundedContext({ style,
        targetPassages: passages.map(passage => ({ id: passage.id, title: story.label(passage.id), text: reviewText(passage.text, Math.floor(REVIEW_TEXT_CHARS / passages.length)),
          lint: styleLint(passage.text, profile, baseline).issues.map(issue => ({ message: issue.message, excerpt: issue.excerpt })) })),
        precedingText: before?.text.slice(-1500) ?? '' }, undefined, ['style', 'targetPassages']),
      objective: '审阅这些正文与作者文风的贴合度，给出 pass/revise、具体问题与修改方向。',
      sources: [sourceFor(project, 'style', project.id)!, ...passages.map(passage => sourceFor(project, 'passage:text', passage.id)!)] };
  }

  const overview = { ...collectContext(project, request, [], story) as Record<string, unknown>, ...(authorRules.length ? { authorRules } : {}), ...(upstream ? { upstream } : {}) };
  const authorSources = [sourceFor(project, 'project', project.id)!];
  if (role === 'theme') return {
    definition: definition('theme', '立意 · 独立深化', themePrompt.text, themeSchema), context: overview, objective, sources: authorSources,
    toCommands: step => {
      const theme = result<{ question: string; choices: string; cost: string; expression: string }>(step, themeSchema);
      return [{ type: 'updateNovel', patch: { theme: `主题问题：${theme.question}\n人物选择：${theme.choices}\n选择代价：${theme.cost}\n表达建议：${theme.expression}` } }];
    },
  };
  if (role === 'continuity') {
    // Review what actually changed (or the target), wherever it sits in the book — not the first passages created.
    const focus = specialist.focusPassageIds?.length ? specialist.focusPassageIds : target.passage ? [target.passage.id]
      : story.order.filter(passage => passage.chapterId === (request.chapterId ?? story.frontierChapterId())).map(passage => passage.id);
    const passages = focus.map(id => story.passage(id)).filter((passage): passage is Passage => !!passage).slice(0, 12);
    const scenes = [...new Set(passages.map(passage => passage.sceneId))].flatMap(id => { const scene = story.scene(id); return scene ? [scene] : []; });
    const subjects = new Set<string>();
    for (const scene of scenes) {
      if (scene.povId) subjects.add(scene.povId);
      for (const id of [...(scene.castIds ?? []), ...(scene.settingIds ?? [])]) subjects.add(id);
      for (const id of scene.eventIds) { subjects.add(id); for (const person of project.objects.find(object => object.id === id)?.event?.participants ?? []) subjects.add(person); }
    }
    for (const passage of passages) for (const id of passageMentions(story.index, passage.id).keys()) subjects.add(id);
    const facts = project.facts.filter(fact => subjects.has(fact.subjectId));
    const timeline = storyTimeline(project), objects = project.objects.filter(object => subjects.has(object.id));
    // How each person and place on stage changes through the book, in the order the changes take effect, with where they happen.
    const stateChanges = objects.filter(object => !object.event).flatMap(object => timeline.history(object.id).slice(-8).map(change => ({ id: change.id, subject: object.name,
      sceneId: change.sceneId, passageId: change.passageId, eventId: change.eventId, becomes: labelledAspects(change.aspects), ...(change.note ? { note: change.note.slice(0, 300) } : {}) })));
    const shown = new Set(passages.map(passage => passage.id));
    const before = [...new Set(passages.flatMap(passage => story.order.slice(Math.max(0, story.positionOf(passage.id) - 3), story.positionOf(passage.id))))].filter(passage => !shown.has(passage.id));
    const perPassage = Math.max(3000, Math.floor(REVIEW_TEXT_CHARS / Math.max(1, passages.length)));
    return { definition: proseDefinition('continuity', '作者 · 连续性审阅', `${continuityPrompt.text}\n${reviewFormatPrompt.text}`, reviewSchema),
      context: boundedContext({ targetPassages: passages.map(passage => ({ id: passage.id, sceneId: passage.sceneId, chapterId: passage.chapterId, title: story.label(passage.id), ...(passage.beat ? { beat: passage.beat } : {}), text: reviewText(passage.text, perPassage) })),
        targetScenes: scenes.map(scene => ({ ...scene, outline: scene.outline.slice(0, 1200) })),
        precedingPassages: before.map(passage => ({ id: passage.id, ...story.passageMemory(passage.id) })),
        openThreads: passages[0] ? openThreads(story, passages[0].id, objects.flatMap(objectNames), 12).map(thread => thread.title) : [],
        authorFacts: facts.slice(0, 40), stateChanges: stateChanges.slice(0, 40), authorObjects: objects.slice(0, 30), overview,
        omitted: { passageBodies: Math.max(0, project.passages.length - passages.length), facts: Math.max(0, facts.length - 40), stateChanges: Math.max(0, stateChanges.length - 40), objects: Math.max(0, objects.length - 30),
          notice: '只载入审阅目标场景段及其涉及人物/事件的设定；precedingPassages 为前文摘要。' } }),
      objective, sources: authorSources };
  }
  if (role === 'planner' || role === 'world' || role === 'narrative' || role === 'canvas' || role === 'cast') return {
    definition: definition(role, role === 'cast' ? '人物塑造 · 修改候选' : `${role} · 修改候选`, `${proposalPrompts[role].text}\n${commandHelpPrompt.text}`, proposalSchema),
    context: overview, objective, sources: authorSources, toCommands: step => validateProposal(project, role, step, request),
  };
  throw new DomainValidationError(`不支持的专家角色：${role as AgentRole}`);
}

/** Earlier visible prose as chapter digests: only chapters / passages the reader has already read, never volume or book rollups. */
function readerEarlierStory(story: StoryView, visibleSources: string[], visibleChars: number) {
  if (visibleChars <= READER_TEXT_CHARS) return [];
  const sources = new Set(visibleSources);
  const visible = story.order.filter(passage => sources.has(`passage:${passage.id}:text`));
  let tail = 0, cut = visible.length;
  while (cut > 0 && tail < READER_TEXT_CHARS) tail += visible[--cut]!.text.length + 2;
  const earlier = visible.slice(0, cut);
  const lastChapter = visible.at(-1)?.chapterId, result: Array<{ chapter: string; summary: string }> = [];
  for (const chapter of story.chapters) {
    const passages = earlier.filter(passage => passage.chapterId === chapter.id);
    if (!passages.length) continue;
    const complete = chapter.id !== lastChapter && passages.length === story.order.filter(passage => passage.chapterId === chapter.id && passage.text.trim()).length;
    const summary = complete ? story.chapterSummary(chapter.id, true).summary : passages.map(passage => story.passageMemory(passage.id, true).summary).join(' ');
    result.push({ chapter: chapter.title, summary: summary.slice(0, 300) });
  }
  return result.slice(-20);
}

/** Records how the people and places of one scene change in it: on one of its passages when the scene runs through several chapters
 * and the task writes that passage, otherwise for the scene as a whole. Each subject's change is complete for that place, so running
 * again over the same scene updates the change it recorded before. */
function evolutionDefinition(project: Workspace, request: RunRequest, story: StoryView, scene: NarrativeScene, passage: Passage | undefined,
  focusId: string | undefined, authorRules: Array<{ kind: string; content: string }>): SpecialistDefinition {
  const parts = story.scenePassages(scene.id);
  const anchor = passage && parts.length > 1 ? passage : undefined;
  const evidence = anchor ? [anchor] : parts, written = evidence.filter(item => item.text.trim());
  const timeline = storyTimeline(project), point: StatePoint = anchor ? { passageId: anchor.id } : { sceneId: scene.id };
  const events = scene.eventIds.flatMap(id => { const event = project.objects.find(object => object.id === id && object.event); return event ? [event] : []; });
  const eventTimes = events.map(event => event.event!.worldOrder), sceneTime = eventTimes.length ? Math.min(...eventTimes) : undefined;
  // Everyone the scene puts on stage, the people of its events, then whoever its prose names; or just the person the plan names.
  const candidates = focusId ? [focusId] : [...sceneSubjects(project, scene).map(object => object.id), ...events.flatMap(event => event.event!.participants),
    ...evidence.flatMap(item => [...passageMentions(story.index, item.id).keys()])];
  const subjects = [...new Set(candidates)].flatMap(id => { const object = project.objects.find(item => item.id === id && !item.event); return object ? [object] : []; }).slice(0, EVOLUTION_SUBJECTS);
  const recordedHere = (subjectId: string) => project.stateChanges.filter(change => change.subjectId === subjectId && change.sceneId === scene.id && change.passageId === anchor?.id);
  const eventTime = new Map(events.map(event => [event.id, event.event!.worldOrder]));
  const allEvents = new Map(project.objects.filter(object => object.event).map(object => [object.id, object.event!.worldOrder]));
  const used = new Set<string>(), knowledgeIds = new Set<string>();
  const subjectContext = subjects.map(subject => {
    const held = [...timeline.stateAt(subject.id, point).values()], recorded = recordedHere(subject.id);
    for (const change of [...held.map(item => item.change), ...recorded]) used.add(change.id);
    const base = { id: subject.id, name: subject.name, kind: subject.typeId === 'character' ? '人物' : '环境',
      before: Object.fromEntries(held.map(item => [item.label, item.value])),
      ...(recorded.length ? { recorded: recorded.map(change => ({ eventId: change.eventId ?? '', becomes: labelledAspects(change.aspects), note: change.note ?? '' })) } : {}) };
    if (subject.typeId !== 'character') return base;
    // What the character can know here: from before the scene, and what the scene's events tell them.
    const known = project.knowledge.filter(item => item.characterId === subject.id && (item.learnedAt === null || sceneTime === undefined
      || (allEvents.get(item.learnedAt) ?? Infinity) < sceneTime)).slice(-12);
    const learned = project.knowledge.filter(item => item.characterId === subject.id && item.learnedAt !== null && eventTime.has(item.learnedAt));
    for (const item of [...known, ...learned]) knowledgeIds.add(item.id);
    const perception = Object.fromEntries(events.flatMap(event => event.event!.observations[subject.id] ? [[event.name, event.event!.observations[subject.id]!]] : []));
    return { ...base, knowledge: { selfKnowledge: typeof subject.fields.selfKnowledge === 'string' ? subject.fields.selfKnowledge : '',
      knows: known.map(item => item.content), learnsHere: learned.map(item => item.content), ...(Object.keys(perception).length ? { perception } : {}) } };
  });
  const allowed = new Set(subjects.map(subject => subject.id)), title = anchor ? story.label(anchor.id) : scene.title;
  const chapterTitle = (item: Passage) => story.chapters[story.chapterIndex(item.chapterId)]?.title ?? '';
  // Written prose is the evidence on its own: the outline is the plan, and only stands in for prose not written yet.
  return { ...(subjects.length ? {} : { skip: '这一场没有登场或正文提到的人物与环境，无需记录状态变化。' }),
    definition: definition(`evolution:${scene.id}`, `${title} · 人物与环境演进`, evolutionPrompt.text, evolutionSchema),
    context: boundedContext({ ...(authorRules.length ? { authorRules } : {}),
      scene: { id: scene.id, title: scene.title, ...(anchor ? { passage: { chapter: chapterTitle(anchor), part: `${parts.indexOf(anchor) + 1}/${parts.length}`, beat: anchor.beat ?? '' } } : {}) },
      events: events.map(event => ({ id: event.id, name: event.name, worldOrder: event.event!.worldOrder, participants: event.event!.participants.map(id => project.objects.find(object => object.id === id)?.name ?? id) })),
      aspects: STATE_ASPECTS.map(aspect => ({ name: aspect.label, hint: aspect.hint, for: aspect.subjects === 'character' ? '人物' : aspect.subjects === 'setting' ? '环境' : '人物与环境' })),
      subjects: subjectContext, isPlan: !written.length,
      ...(written.length ? { prose: written.map(item => ({ chapter: chapterTitle(item), text: reviewText(item.text, EVIDENCE_TEXT_CHARS) })) }
        : { plan: { outline: scene.outline, beats: evidence.map(item => item.beat ?? '').filter(Boolean) } }) }),
    objective: '记下这一场里人物与环境的状态变化，给出可核对的依据。',
    sources: [...(written.length ? [] : [sourceFor(project, 'scene:outline', scene.id)!]), ...events.map(event => sourceFor(project, 'event:time', event.id)!),
      ...written.map(item => sourceFor(project, 'passage:text', item.id)!), ...[...used].map(id => sourceFor(project, 'stateChange', id)!),
      ...[...knowledgeIds].map(id => sourceFor(project, 'knowledge', id)!)],
    toCommands: step => {
      const output = result<EvolutionOutput>(step, evolutionSchema), values: StateChange[] = [];
      for (const item of output.changes) {
        if (!allowed.has(item.subjectId)) throw new DomainValidationError(`subjectId 必须是 subjects 中的 id：${item.subjectId}`);
        const aspects: Record<string, string> = {};
        for (const { aspect, value } of item.aspects) {
          const key = aspectKey(aspect).slice(0, ASPECT_KEY_CHARS);
          if (key && value.trim() && Object.keys(aspects).length < MAX_STATE_ASPECTS) aspects[key] = value.trim().slice(0, ASPECT_VALUE_CHARS);
        }
        if (!Object.keys(aspects).length) continue;
        const eventId = item.eventId && scene.eventIds.includes(item.eventId) ? item.eventId : undefined;
        const place = { subjectId: item.subjectId, sceneId: scene.id, ...(anchor ? { passageId: anchor.id } : {}), ...(eventId ? { eventId } : {}) };
        const note = !item.note.trim() || written.length || item.note.startsWith('计划：') ? item.note.trim() : `计划：${item.note.trim()}`;
        const value: StateChange = { id: '', ...place, aspects, ...(note ? { note } : {}) };
        const index = values.findIndex(change => sameAnchor(change, value));
        if (index >= 0) values[index] = value; else values.push(value);
      }
      // A re-run updates what it recorded here before even when it names a different event (or none): the same anchor first,
      // then the subject's other change at this place, so one place never ends up with two contradicting changes.
      const recorded = project.stateChanges.filter(change => values.some(value => samePlace(change, value))), claimed = new Set<string>();
      const claim = (value: StateChange, match: (change: StateChange) => boolean) => {
        const found = value.id ? undefined : recorded.find(change => !claimed.has(change.id) && match(change));
        if (found) { value.id = found.id; claimed.add(found.id); }
      };
      for (const value of values) claim(value, change => sameAnchor(change, value));
      for (const value of values) claim(value, change => samePlace(change, value));
      for (const value of values) value.id ||= stateChangeId(value);
      const commands: Command[] = values.map(value => ({ type: 'putStateChange', value }));
      applyCommands(project, commands);
      return commands;
    } };
}
