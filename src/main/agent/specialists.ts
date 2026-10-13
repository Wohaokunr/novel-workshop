import { randomUUID } from 'node:crypto';
import type { AgentRole, EvidenceSource, SpecialistRequest, UpstreamResult } from '../../shared/agent-types.js';
import type { AgentStep, CharacterState, Command, RunRequest, Workspace } from '../../shared/types.js';
import { buildCharacterContext, buildReaderContext, buildWriterContext, WRITER_CONTEXT_CHARS, WRITER_PRIORITY } from '../context.js';
import { applyCommands, DomainValidationError } from '../domain.js';
import { objectSchema, validateSchema, type AgentDefinition, type JsonSchema } from '../responses.js';
import { boundedContext, collectContext, sourceFor, sourcesForLabels } from './memory.js';
import { UPSTREAM_ROLES, validatePlanTarget } from './policy.js';
import { sceneMentions } from './story-index.js';
import { STORY_OPS, storyOpsCommands } from './story-ops.js';
import { characterPrompt, commandHelpPrompt, continuityPrompt, evolutionPrompt, proposalPrompts, readerPrompt, stylistPrompt, themePrompt, writerPrompt, writerScopePrompts } from '../prompts/specialists.js';
import type { CompanionOpKind } from '../../shared/companion-types.js';
import { openThreads, StoryView } from './story-view.js';
import { objectNames } from '../../shared/story-elements.js';
import { writerStyle } from './style.js';
import { styleProfile } from '../../shared/style-types.js';
import { styleBaseline, styleLint } from '../../shared/style-metrics.js';

export const READER_TEXT_CHARS = 12_000;
export const EVIDENCE_TEXT_CHARS = 6_000;

// Match the established agents.ts result schemas; no transport or provider-specific API is introduced.
const string = { type: 'string' }, strings = { type: 'array', items: string };
const perspectiveSchema = objectSchema({ perspective: string, intention: string, action: string, uncertainty: string });
export const reviewSchema = objectSchema({ verdict: { type: 'string', enum: ['pass', 'revise'] }, issues: strings, recommendation: string });
const themeSchema = objectSchema({ question: string, choices: string, cost: string, expression: string });
const stateSchema = objectSchema({ perspective: string, psychology: string, motivation: string, evidence: string });
const proposalSchema = objectSchema({ summary: string, commandsJson: string, opsJson: string });

export interface SpecialistDefinition {
  definition: AgentDefinition;
  context: unknown;
  objective: string;
  sources: EvidenceSource[];
  /** Pure conversion only. The coordinator must preview, assert scope, review and request approval. */
  toCommands?(step: AgentStep): Command[];
}

type ProposalRole = 'planner' | 'world' | 'narrative' | 'canvas' | 'cast';
/** Story ops each proposing role may use; ops-derived commands are checked by op, not by command type. */
const roleOps: Record<ProposalRole, readonly CompanionOpKind[]> = {
  planner: STORY_OPS, canvas: STORY_OPS,
  world: ['addEvent', 'addCause', 'addCharacter', 'updateCharacter', 'addSetting', 'updateSetting', 'link', 'addCard'],
  narrative: ['addAct', 'updateAct', 'addChapter', 'updateChapter', 'addScene', 'updateScene', 'moveScene', 'link'],
  cast: ['addCharacter', 'updateCharacter', 'link', 'addCard'],
};
function definition(id: string, label: string, instructions: string, outputSchema?: JsonSchema): AgentDefinition {
  // No direct writes and, critically, no read_project escape hatch for restricted roles.
  return { id, label, instructions, tools: [], ...(outputSchema ? { outputSchema } : {}) };
}
function result<T>(step: AgentStep, schema: JsonSchema): T {
  validateSchema(step.structured, schema);
  return step.structured as T;
}
function readerTarget(project: Workspace, request: RunRequest, sceneId?: string, chapterId?: string) {
  const scene = sceneId ? project.scenes.find(item => item.id === sceneId) : undefined;
  const targetChapter = chapterId ?? scene?.chapterId ?? request.chapterId ?? [...project.chapters].sort((a, b) => b.order - a.order)[0]?.id;
  if (!targetChapter) throw new DomainValidationError('读者审阅需要章节');
  return { sceneId, chapterId: targetChapter };
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
    planner: [...shared, 'updateNovel', 'putObjectType', 'deleteObjectType', 'putObject', 'deleteObject', 'putChapter', 'deleteChapter', 'putScene', 'deleteScene', 'putFact', 'deleteFact', 'putKnowledge', 'deleteKnowledge'],
    world: [...shared, 'putObjectType', 'deleteObjectType', 'putObject', 'deleteObject', 'putFact', 'deleteFact', 'putKnowledge', 'deleteKnowledge', 'putScene'],
    narrative: [...shared, 'putChapter', 'deleteChapter', 'putScene', 'deleteScene'],
    canvas: [...shared, 'putObjectType', 'putObject', 'putFact', 'putKnowledge', 'putChapter', 'putScene'],
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
  // Catch cascaded deletion as well as explicit putScene text changes.
  for (const scene of project.scenes) {
    const next = preview.scenes.find(item => item.id === scene.id);
    if (scene.text.trim() && (!next || scene.text !== next.text)) throw new DomainValidationError('编排专家不能删除或改写已有正式正文');
  }
  for (const scene of preview.scenes) if (!project.scenes.some(item => item.id === scene.id) && scene.text.trim()) throw new DomainValidationError('编排专家新建场景的正文必须为空');
  return typed;
}

/** Which roles build on earlier specialists' conclusions is ROLE_CAPABILITIES.upstream. Evolution reads the written prose of its
 * event, which dependency folding already places in its workspace. */
const UPSTREAM_NOTICE = '本任务中已完成的前置专长结论，在此基础上继续。角色代入是人物当时的主观理解，可能有误；与正式原文或作者设定冲突时以原文和设定为准。前置修改已并入工作区的，会直接体现在资料中，不要重复创建。';

/** story: stored digests over this (possibly candidate) workspace; focusSceneIds: scenes a review must examine;
 * upstream: conclusions of the plan node's finished dependencies, dropped for roles outside UPSTREAM_ROLES. */
export function specialistDefinition(specialist: SpecialistRequest & { story?: StoryView; focusSceneIds?: string[]; authorRules?: Array<{ kind: string; content: string }>; upstream?: UpstreamResult[] }): SpecialistDefinition {
  const { role, node, project, request } = specialist;
  const authorRules = specialist.authorRules ?? [];
  const upstream = UPSTREAM_ROLES.has(role) && specialist.upstream?.length ? { notice: UPSTREAM_NOTICE, results: specialist.upstream } : undefined;
  const story = specialist.story ?? new StoryView(project);
  if (role !== node.role) throw new DomainValidationError('专家角色与计划节点不一致');
  validatePlanTarget(node, project, request);
  const sceneId = node.sceneId ?? request.sceneId;
  const objective = node.objective;

  if (role === 'character') {
    const context = buildCharacterContext(project, node.characterId!, node.eventId!);
    return { definition: definition(`character:${context.characterId}`, `${context.name} · 角色代入`, characterPrompt.text, perspectiveSchema),
      context: boundedContext({ ...context }), objective: '面对当前关键情节，你会如何理解并行动？',
      sources: sourcesForLabels(project, context.sources, role) };
  }
  if (role === 'reader') {
    const target = readerTarget(project, request, sceneId, node.chapterId);
    const context = buildReaderContext(project, target.chapterId, target.sceneId);
    const chapters = [...project.chapters].filter(chapter => chapter.order <= project.chapters.find(item => item.id === target.chapterId)!.order);
    return { definition: definition('reader', '读者 · 正文审阅', readerPrompt.text, reviewSchema),
      context: boundedContext({ title: context.title, earlierStory: readerEarlierStory(story, context.sources, context.text.length), text: context.text.slice(-READER_TEXT_CHARS),
        omitted: { earlierVisibleChars: Math.max(0, context.text.length - READER_TEXT_CHARS), notice: '这里只包含已呈现正文；earlierStory 是较早已读正文的摘要。未读后文和作者目标/设定未提供。' } }, undefined, ['text']),
      objective: '从读者视角审阅可见正文，给出 pass/revise、具体问题与修订建议。',
      sources: [sourceFor(project, 'novel:title', project.id)!, ...chapters.map(chapter => sourceFor(project, 'chapter:title', chapter.id)!), ...sourcesForLabels(project, context.sources, role)] };
  }
  if (role === 'writer') {
    const scene = structuredClone(project.scenes.find(item => item.id === sceneId)!);
    const selection = request.stage === 'rewrite' && request.sceneId === scene.id ? request.selection : undefined;
    const { sources: labels, ...context } = buildWriterContext(project, scene.id, request.references, story);
    return { definition: definition(request.stage === 'rewrite' ? 'rewrite' : 'writer', `${scene.title} · 正文写作`, `${writerPrompt.text}\n${(selection ? writerScopePrompts.selection : writerScopePrompts.scene).text}`),
      context: boundedContext({ ...context, authorRules, ...(upstream ? { upstream } : {}), selectedText: selection ? scene.text.slice(selection.start, selection.end) : null }, WRITER_CONTEXT_CHARS, WRITER_PRIORITY), objective,
      sources: [...novelSources(project), ...sourcesForLabels(project, labels, role)],
      toCommands: step => {
        if (typeof step.output !== 'string' || !step.output.trim()) throw new DomainValidationError('模型没有生成正文');
        const text = selection ? scene.text.slice(0, selection.start) + step.output + scene.text.slice(selection.end) : step.output;
        return [{ type: 'putScene', value: { ...structuredClone(scene), text } }];
      } };
  }
  if (role === 'evolution') {
    const character = buildCharacterContext(project, node.characterId!, node.eventId!);
    const event = project.objects.find(item => item.id === node.eventId)!;
    const scenes = project.scenes.filter(scene => scene.eventIds.includes(event.id) && scene.eventIds.every(id => id === event.id
      || (project.objects.find(item => item.id === id)?.event?.worldOrder ?? Infinity) < event.event!.worldOrder));
    // A chapter/scene-scoped task cannot propose a state backed by another scene.
    const scoped = request.stage === 'chapter' ? scenes.filter(scene => request.sceneId ? scene.id === request.sceneId
      : scene.chapterId === (request.chapterId ?? [...project.chapters].sort((a, b) => a.order - b.order)[0]?.id)) : scenes;
    const written = scoped.filter(scene => scene.text.trim()), evidenceScenes = written.length ? written : scoped;
    const acquiredKnowledge = project.knowledge.filter(item => item.characterId === character.characterId && item.learnedAt === event.id)
      .map(item => ({ id: item.id, content: item.content, source: item.source, learnedAt: item.learnedAt }));
    const existing = project.characterStates?.find(state => state.characterId === character.characterId && state.eventId === event.id);
    const stateId = existing?.id ?? randomUUID();
    return { definition: definition(`evolution:${character.characterId}`, `${character.name} · 人物演进`, evolutionPrompt.text, stateSchema),
      context: boundedContext({ character, ...(authorRules.length ? { authorRules } : {}), acquiredKnowledge, event: { id: event.id, name: event.name, worldOrder: event.event!.worldOrder },
        sceneEvidence: evidenceScenes.map(scene => ({ id: scene.id, title: scene.title, povId: scene.povId, eventIds: scene.eventIds,
          ...(written.length ? { actualText: scene.text.length > EVIDENCE_TEXT_CHARS ? `${scene.text.slice(0, EVIDENCE_TEXT_CHARS / 2)}\n……\n${scene.text.slice(-EVIDENCE_TEXT_CHARS / 2)}` : scene.text, isPlan: false } : { outline: scene.outline, actualText: '', isPlan: true }) })) }),
      objective: '跟进这个事件后的角色视角、心理和动机，提供可核对的论据。acquiredKnowledge 是该人物在本事件中明确获知的内容快照，可进入事件结束后的状态；允许它是误解或谎言。',
      sources: [...sourcesForLabels(project, character.sources, 'character'), sourceFor(project, 'event:time', event.id)!,
        ...acquiredKnowledge.map(item => sourceFor(project, 'knowledge', item.id)!),
        ...evidenceScenes.map(scene => sourceFor(project, written.length ? 'scene:text' : 'scene:outline', scene.id)!),
        ...(existing ? [sourceFor(project, 'characterState', existing.id)!] : [])],
      toCommands: step => {
        const state = result<Pick<CharacterState, 'perspective' | 'psychology' | 'motivation' | 'evidence'>>(step, stateSchema);
        const value: CharacterState = { ...state, id: stateId, characterId: character.characterId, eventId: event.id, sceneIds: evidenceScenes.map(scene => scene.id),
          evidence: written.length || state.evidence.startsWith('计划：') ? state.evidence : `计划：${state.evidence}` };
        const commands: Command[] = [{ type: 'putCharacterState', value }];
        applyCommands(project, commands);
        return commands;
      } };
  }

  if (role === 'stylist') {
    const focus = specialist.focusSceneIds?.length ? specialist.focusSceneIds : sceneId ? [sceneId] : [];
    const scenes = focus.map(id => project.scenes.find(scene => scene.id === id)).filter((scene): scene is NonNullable<typeof scene> => !!scene?.text.trim()).slice(0, 3);
    if (!scenes.length) throw new DomainValidationError('文风审阅需要已有正文的场景');
    const profile = styleProfile(project), baseline = styleBaseline(profile);
    const before = story.order[story.positionOf(scenes[0]!.id) - 1];
    const { notice: _notice, ...style } = writerStyle(project, scenes[0]!);
    return { definition: definition('stylist', '文风 · 笔触审阅', stylistPrompt.text, reviewSchema),
      context: boundedContext({ style,
        targetScenes: scenes.map(scene => ({ id: scene.id, title: scene.title, text: scene.text.length > EVIDENCE_TEXT_CHARS ? `${scene.text.slice(0, EVIDENCE_TEXT_CHARS / 2)}\n……\n${scene.text.slice(-EVIDENCE_TEXT_CHARS / 2)}` : scene.text,
          lint: styleLint(scene.text, profile, baseline).issues.map(issue => ({ message: issue.message, excerpt: issue.excerpt })) })),
        precedingText: before?.text.slice(-1500) ?? '' }, undefined, ['style', 'targetScenes']),
      objective: '审阅这些正文与作者文风的贴合度，给出 pass/revise、具体问题与修改方向。',
      sources: [sourceFor(project, 'style', project.id)!, ...scenes.map(scene => sourceFor(project, 'scene:text', scene.id)!)] };
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
    // Review what actually changed (or the target), wherever it sits in the book — not the first scenes created.
    const focus = specialist.focusSceneIds?.length ? specialist.focusSceneIds : sceneId ? [sceneId]
      : story.order.filter(scene => scene.chapterId === (request.chapterId ?? story.frontierChapterId())).map(scene => scene.id);
    const scenes = focus.map(id => story.scene(id)).filter((scene): scene is NonNullable<typeof scene> => !!scene).slice(0, 12);
    const subjects = new Set<string>();
    for (const scene of scenes) {
      if (scene.povId) subjects.add(scene.povId);
      for (const id of scene.eventIds) { subjects.add(id); for (const person of project.objects.find(object => object.id === id)?.event?.participants ?? []) subjects.add(person); }
      for (const id of sceneMentions(story.index, scene.id).keys()) subjects.add(id);
    }
    const facts = project.facts.filter(fact => subjects.has(fact.subjectId)), states = (project.characterStates ?? []).filter(state => subjects.has(state.characterId));
    const objects = project.objects.filter(object => subjects.has(object.id));
    const shown = new Set(scenes.map(scene => scene.id));
    const before = [...new Set(scenes.flatMap(scene => story.order.slice(Math.max(0, story.positionOf(scene.id) - 3), story.positionOf(scene.id))))].filter(scene => !shown.has(scene.id));
    return { definition: definition('continuity', '作者 · 连续性审阅', continuityPrompt.text, reviewSchema),
      context: boundedContext({ targetScenes: scenes.map(scene => ({ ...scene, text: scene.text.slice(0, 3000), outline: scene.outline.slice(0, 1200) })),
        precedingScenes: before.map(scene => ({ id: scene.id, ...story.sceneMemory(scene.id) })),
        openThreads: scenes[0] ? openThreads(story, scenes[0].id, objects.flatMap(objectNames), 12).map(thread => thread.title) : [],
        authorFacts: facts.slice(0, 40), characterStates: states.slice(0, 20), authorObjects: objects.slice(0, 30), overview,
        omitted: { sceneBodies: Math.max(0, project.scenes.length - scenes.length), facts: Math.max(0, facts.length - 40), objects: Math.max(0, objects.length - 30),
          notice: '只载入审阅目标场景及其涉及人物/事件的设定；precedingScenes 为前文摘要。' } }),
      objective, sources: authorSources };
  }
  if (role === 'planner' || role === 'world' || role === 'narrative' || role === 'canvas' || role === 'cast') return {
    definition: definition(role, role === 'cast' ? '人物塑造 · 修改候选' : `${role} · 修改候选`, `${proposalPrompts[role].text}\n${commandHelpPrompt.text}`, proposalSchema),
    context: overview, objective, sources: authorSources, toCommands: step => validateProposal(project, role, step, request),
  };
  throw new DomainValidationError(`不支持的专家角色：${role as AgentRole}`);
}

/** Earlier visible prose as chapter digests: only chapters / scenes the reader has already read, never volume or book rollups. */
function readerEarlierStory(story: StoryView, visibleSources: string[], visibleChars: number) {
  if (visibleChars <= READER_TEXT_CHARS) return [];
  const sources = new Set(visibleSources);
  const visible = story.order.filter(scene => sources.has(`scene:${scene.id}:text`));
  let tail = 0, cut = visible.length;
  while (cut > 0 && tail < READER_TEXT_CHARS) tail += visible[--cut]!.text.length + 2;
  const earlier = visible.slice(0, cut);
  const lastChapter = visible.at(-1)?.chapterId, result: Array<{ chapter: string; summary: string }> = [];
  for (const chapter of story.chapters) {
    const scenes = earlier.filter(scene => scene.chapterId === chapter.id);
    if (!scenes.length) continue;
    const complete = chapter.id !== lastChapter && scenes.length === story.order.filter(scene => scene.chapterId === chapter.id && scene.text.trim()).length;
    const summary = complete ? story.chapterSummary(chapter.id, true).summary : scenes.map(scene => story.sceneMemory(scene.id, true).summary).join(' ');
    result.push({ chapter: chapter.title, summary: summary.slice(0, 300) });
  }
  return result.slice(-20);
}
