import { randomUUID } from 'node:crypto';
import type { AgentRole, EvidenceSource, SpecialistRequest } from '../../shared/agent-types.js';
import type { AgentStep, CharacterState, Command, RunRequest, Workspace } from '../../shared/types.js';
import { buildCharacterContext, buildReaderContext, buildWriterContext, WRITER_CONTEXT_CHARS, WRITER_PRIORITY } from '../context.js';
import { applyCommands, DomainValidationError } from '../domain.js';
import { objectSchema, validateSchema, type AgentDefinition, type JsonSchema } from '../responses.js';
import { boundedContext, collectContext, sourceFor, sourcesForLabels } from './memory.js';
import { validatePlanTarget } from './policy.js';
import { sceneMentions } from './story-index.js';
import { STORY_OPS, STORY_OPS_HELP, storyOpsCommands } from './story-ops.js';
import type { CompanionOpKind } from '../../shared/companion-types.js';
import { openThreads, StoryView } from './story-view.js';
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

const characterInstructions = '你完全是这个角色。只依据自己的身份经历、当前亲见亲闻与已获知的记忆思考。禁止读取世界资料或借用作者全知视角，信念可能错误。写出此刻感受、真实意图、会采取的行动和不确定之处。不要迎合作者预设结局。';
const readerInstructions = '你是第一次阅读这段已呈现正文的读者。只依据可见文本检查可理解性、情绪可信度、信息顺序、悬念和阅读吸引力。没有作者大纲/未揭露世界真相。不要凭未来设定解释当下，也不要求消除合理悬念。只提出实际影响阅读的必要修改。issues 指明具体可见段落及问题，不推测作者目标。';
const evolutionInstructions = '你是小说人物演进编辑。以角色此前状态、自己的初始认知/已知记忆/当场观察为边界，归纳当前事件结束后的视角、心理和下一步动机。sceneEvidence 是作者侧论据，不是角色自动知道的材料；只吸收当前事件里这个人物亲见亲闻、被告知或由自身线索合理推断的内容，不能获知别人的内心、未揭露世界真相或后续事件。perspective/psychology/motivation 仅写这个人物当时可理解的变化，承接此前状态，允许误解、迟疑、反复和暂时不变，不强迫每幕成长。若有 actualText，以已经呈现的行动、对话和该人物视角心理为准，不用大纲推翻正文；若无正文，只依据明确标为计划的 outline/当场观察推演，并在 evidence 开头写“计划：”。evidence 指明具体正文行动/对话或计划线索，以及为何变化；证据不足就说明并保持此前状态，不虚构已经发生的行动。';
const themeInstructions = '你是独立的小说立意智能体。依据作者目标、作品风格与实际情节深化作品值得探索的问题、人物选择与代价，给出通过行动、关系和情节表达的建议。即使作者写轻小说、爽文或口水文学，也寻找其中可成立的情感与价值张力；尊重娱乐性、轻快感与作者立场，不强行说教、不要求文学腔、不替作者定唯一答案。保留已有立意中成立的部分，围绕本次操作作必要深化。question 写核心主题问题，choices 写人物的相反选择，cost 写选择代价，expression 写适合当前风格的具体表达建议。';
const stylistInstructions = '你是作者的文风编辑，只关心语言与笔触，不评价情节、设定与人物动机。依据 style（作者画像、directives、do/avoid、avoidWords、voices、samples）审阅 targetScenes 的正文是否像作者本人写的：句子长短与节奏、段落呼吸、修辞浓度、对白方式、叙述距离与人称、用词质地、是否有空泛套话或 AI 腔。lint 是本地统计出的客观偏差，可作为线索但要自己判断。precedingText 是紧邻的前文，用来判断语气是否连贯。没有设定文风时，以 precedingText 和常识判断是否有明显的套话与腔调问题。只输出 pass/revise、issues 和 recommendation；每条 issue 引用原句（不超过 40 字）并说明它偏离了哪一条文风、应往哪个方向改。整体已经贴近作者时给 pass，不为挑刺而挑刺。';
const continuityInstructions = '你是作者侧连续性审阅编辑，能看到作者设定与实际正文。依据已经写下的正文检查人物动机、视角与心理演进、事实时序、世界线与叙述线的一致性。实际正文优先于计划；不把未呈现大纲冒充已发生事实，不要求消除合理悬念。只输出 pass/revise、具体 issues 和建议，不直接修改项目。issues 必须指出具体场景/人物/事件/事实 id、矛盾的两处证据、影响与最小修正，不用笼统的“有待完善”冒充审阅结果。';
const writerInstructions = `你是小说写作者。根据场景、世界事实、叙述视角与角色参考写作；角色可判断错误，正文必须忠于当时能知道的信息。
语言与笔触：style 是作者的文风，是语言层面的最高约束，优先于你自己的写作习惯。先读 style.samples 体会句子长短、段落呼吸、描写与对白的方式，再动笔；模仿笔法而不复用范文的人物、情节与句子（有 referenceNotice 时尤其如此）。落实 style.directives、do 与 avoid；不得使用 avoidWords 中的任何词；人物对白符合 voices 中的说话方式；preferWords 可自然使用，不要硬塞。authorRules 是作者确认过的写作要求，必须遵守。文风不能凌驾于人物的认知边界与事实之上。
通过行动、细节和对话呈现，不把设定表与角色分析直接贴进小说。若有 candidateReviews（含 style 文风审阅），结合当前候选正文落实有依据的审查建议，保留成立的情节与作者方向。直接输出小说正文，不加 JSON、标题、解释或 Markdown 围栏。
eventContexts 是每个事件当时的有效世界事实与各人物实际已知；人物 state 是该事件严格之前的心理/视角，characterTransitions 是此事件结束后的写作计划或正文演进参考，须通过本场行动逐步表现，不能开场就拥有结果。theme 提供作品立意，以符合作者风格的选择与代价自然表达。无事件时间锚时 initialCharacters 只提供人物自我认知与初始记忆。人物不能借用作者资料获知未来变化。relatedObjects 与 materials 是作者参考资料，不等于人物已知。recentText 是紧接本场之前的原文（按阅读顺序，最多 6000 字），用来衔接语气与动作；更早的内容见 storySoFar 的分层摘要（全书→卷→近章→本章前几场），openThreads 是尚未回收的伏笔与悬念，entityRecall 是本场人物/物件上一次出场的摘要与原文片段。摘要是辅助记忆，与原文或设定冲突时以原文和设定为准。outlinePlan 给出本章概要与所属幕/卷的作用，用来把握本场在整体结构中的任务与节奏。sceneElements 是本场的三要素：视角与出场人物、发生地点、呈现的世界事件；环境通过感官细节、空间与世界规则自然呈现并约束人物行动，不要写成设定说明。`;
type ProposalRole = 'planner' | 'world' | 'narrative' | 'canvas' | 'cast';
const proposalInstructions: Record<ProposalRole, string> = {
  planner: '你是与作者协作的小说构思与编排编辑。完成作品定位、人物/环境初始对象、世界事实和不泄漏未来的初始知识；建立世界事件及严格因果、按读者信息与悬念安排章节/场景，世界发生顺序与叙述顺序分离。关键冲突标 critical，填写角色各自所见，建立知识获取时刻。新建场景正文为空，不伪造已完成正文。',
  world: '你是世界线编辑。补足世界事件的因果、环境规则和人物观察；严格区分世界发生顺序和读者获知顺序。修改实际事件、世界事实及已有场景的事件绑定。不要把作者真相变成人物自动知道的内容。',
  narrative: '你是叙述线编辑。完善章节或场景的大纲、叙述视角、信息揭露与悬念节奏，保留既有正文；通过 scene.eventIds 与世界事件关联，倒叙只改叙述顺序，不改变人物当时的知识。',
  canvas: '你是灵感画布编辑。把灵感卡片发展为可继续写作的人物、事件和场景，通过画布连线表达关系。优先用 opsJson：addCharacter/addEvent/addScene 会自动生成引用卡片，link 在卡片、人物、事件、场景之间连线。已引用卡片的修改要落在实际实体，不生成第二份脱节的设定。',
  cast: '你是人物塑造编辑。依据作品信息、立意、灵感与已有情节设计或丰富人物：每个人物写清身份、欲望、恐惧或秘密（content）以及他在故事里推动什么（purpose）。人物之间用 link 表达关系（title 写关系），已有人物用 id 引用、用 updateCharacter 丰富，不重复创建同名人物。只输出 opsJson，commandsJson 填 "[]"。',
};
/** Story ops each proposing role may use; ops-derived commands are checked by op, not by command type. */
const roleOps: Record<ProposalRole, readonly CompanionOpKind[]> = {
  planner: STORY_OPS, canvas: STORY_OPS,
  world: ['addEvent', 'addCause', 'addCharacter', 'updateCharacter', 'addSetting', 'updateSetting', 'link', 'addCard'],
  narrative: ['addAct', 'updateAct', 'addChapter', 'updateChapter', 'addScene', 'updateScene', 'moveScene', 'link'],
  cast: ['addCharacter', 'updateCharacter', 'link', 'addCard'],
};
const commandHelp = `你没有写入工具，只能提出候选。输出 structured {summary,commandsJson,opsJson}。人物、画布卡片与连线、事件因果、大纲优先写进 opsJson；commandsJson 只用于故事操作覆盖不到的设定（世界事实、人物知识、对象类型等），是 JSON 编码的命令数组，没有必要时使用 "[]"；opsJson 没有内容时也用 "[]"。
${STORY_OPS_HELP}
命令格式：
updateNovel{patch:{title,brief,genre,audience,theme}}；putObjectType{value:{id,name,fields:[{id,label,kind,options?}]}}；putObject{value:{id,typeId,name,fields,event?}}；putChapter{value:{id,title,order}}；putScene{value:{id,chapterId,order,title,povId,eventIds,castIds?,settingIds?,outline,text}}；putFact{value:{id,subjectId,key,value,fromEventId,replacesId?}}；putKnowledge{value:{id,characterId,content,learnedAt,source,factId?,fromCharacterId?}}；putCard{value:{id,kind,refId?,title,content,x,y,groupId?,width?,height?,collapsed?}}；putCanvasLink{value:{id,source,target}}。
对应删除命令 deleteObjectType/deleteObject/deleteChapter/deleteScene/deleteFact/deleteKnowledge/deleteCard/deleteCanvasLink 使用 id；人物阶段状态由 evolution 专家负责，正文由 writer 负责。
事件必须包含 event:{worldOrder,timeLabel,thread,participants,causes,critical,observations}，causes 只能是严格更早事件。observations 是人物 id 到各自亲见亲闻的映射，人物自己的身份经历写 selfKnowledge。fields 只用现有类型字段，不恢复作者删掉的字段；知识 source 只能 initial/witness/told/belief，learnedAt 必须遵守世界时间，不提前知道未来事实。
材料中的计划、大纲与画布备注不是已发生的事实。引用读取不等于写入授权。不得删改已有正式正文。保留已有 id、配置、人工布局；已有卡片保留 x/y/width/height/collapsed，不提供 setLayout/setReading。新实体引用必须在同批命令后能通过领域校验。候选不等于保存或已获批准。`;

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

/** story: stored digests over this (possibly candidate) workspace; focusSceneIds: scenes a review must examine. */
export function specialistDefinition(specialist: SpecialistRequest & { story?: StoryView; focusSceneIds?: string[]; authorRules?: Array<{ kind: string; content: string }> }): SpecialistDefinition {
  const { role, node, project, request } = specialist;
  const authorRules = specialist.authorRules ?? [];
  const story = specialist.story ?? new StoryView(project);
  if (role !== node.role) throw new DomainValidationError('专家角色与计划节点不一致');
  validatePlanTarget(node, project, request);
  const sceneId = node.sceneId ?? request.sceneId;
  const objective = node.objective;

  if (role === 'character') {
    const context = buildCharacterContext(project, node.characterId!, node.eventId!);
    return { definition: definition(`character:${context.characterId}`, `${context.name} · 角色代入`, characterInstructions, perspectiveSchema),
      context: boundedContext({ ...context }), objective: '面对当前关键情节，你会如何理解并行动？',
      sources: sourcesForLabels(project, context.sources, role) };
  }
  if (role === 'reader') {
    const target = readerTarget(project, request, sceneId, node.chapterId);
    const context = buildReaderContext(project, target.chapterId, target.sceneId);
    const chapters = [...project.chapters].filter(chapter => chapter.order <= project.chapters.find(item => item.id === target.chapterId)!.order);
    return { definition: definition('reader', '读者 · 正文审阅', readerInstructions, reviewSchema),
      context: boundedContext({ title: context.title, earlierStory: readerEarlierStory(story, context.sources, context.text.length), text: context.text.slice(-READER_TEXT_CHARS),
        omitted: { earlierVisibleChars: Math.max(0, context.text.length - READER_TEXT_CHARS), notice: '这里只包含已呈现正文；earlierStory 是较早已读正文的摘要。未读后文和作者目标/设定未提供。' } }, undefined, ['text']),
      objective: '从读者视角审阅可见正文，给出 pass/revise、具体问题与修订建议。',
      sources: [sourceFor(project, 'novel:title', project.id)!, ...chapters.map(chapter => sourceFor(project, 'chapter:title', chapter.id)!), ...sourcesForLabels(project, context.sources, role)] };
  }
  if (role === 'writer') {
    const scene = structuredClone(project.scenes.find(item => item.id === sceneId)!);
    const selection = request.stage === 'rewrite' && request.sceneId === scene.id ? request.selection : undefined;
    const { sources: labels, ...context } = buildWriterContext(project, scene.id, request.references, story);
    return { definition: definition(request.stage === 'rewrite' ? 'rewrite' : 'writer', `${scene.title} · 正文写作`, `${writerInstructions}\n${selection ? '本次只改写选中文本，仅输出替换段落，保留选区外内容；不要重写整个场景。' : '输出这个场景完整正文，不输出其他场景正文。'}`),
      context: boundedContext({ ...context, authorRules, selectedText: selection ? scene.text.slice(selection.start, selection.end) : null }, WRITER_CONTEXT_CHARS, WRITER_PRIORITY), objective,
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
    return { definition: definition(`evolution:${character.characterId}`, `${character.name} · 人物演进`, evolutionInstructions, stateSchema),
      context: boundedContext({ character, acquiredKnowledge, event: { id: event.id, name: event.name, worldOrder: event.event!.worldOrder },
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
    return { definition: definition('stylist', '文风 · 笔触审阅', stylistInstructions, reviewSchema),
      context: boundedContext({ style,
        targetScenes: scenes.map(scene => ({ id: scene.id, title: scene.title, text: scene.text.length > EVIDENCE_TEXT_CHARS ? `${scene.text.slice(0, EVIDENCE_TEXT_CHARS / 2)}\n……\n${scene.text.slice(-EVIDENCE_TEXT_CHARS / 2)}` : scene.text,
          lint: styleLint(scene.text, profile, baseline).issues.map(issue => ({ message: issue.message, excerpt: issue.excerpt })) })),
        precedingText: before?.text.slice(-1500) ?? '' }, undefined, ['style', 'targetScenes']),
      objective: '审阅这些正文与作者文风的贴合度，给出 pass/revise、具体问题与修改方向。',
      sources: [sourceFor(project, 'style', project.id)!, ...scenes.map(scene => sourceFor(project, 'scene:text', scene.id)!)] };
  }

  const overview = collectContext(project, request, [], story) as Record<string, unknown>;
  const authorSources = [sourceFor(project, 'project', project.id)!];
  if (role === 'theme') return {
    definition: definition('theme', '立意 · 独立深化', themeInstructions, themeSchema), context: overview, objective, sources: authorSources,
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
    return { definition: definition('continuity', '作者 · 连续性审阅', continuityInstructions, reviewSchema),
      context: boundedContext({ targetScenes: scenes.map(scene => ({ ...scene, text: scene.text.slice(0, 3000), outline: scene.outline.slice(0, 1200) })),
        precedingScenes: before.map(scene => ({ id: scene.id, ...story.sceneMemory(scene.id) })),
        openThreads: scenes[0] ? openThreads(story, scenes[0].id, objects.map(object => object.name), 12).map(thread => thread.title) : [],
        authorFacts: facts.slice(0, 40), characterStates: states.slice(0, 20), authorObjects: objects.slice(0, 30), overview,
        omitted: { sceneBodies: Math.max(0, project.scenes.length - scenes.length), facts: Math.max(0, facts.length - 40), objects: Math.max(0, objects.length - 30),
          notice: '只载入审阅目标场景及其涉及人物/事件的设定；precedingScenes 为前文摘要。' } }),
      objective, sources: authorSources };
  }
  if (role === 'planner' || role === 'world' || role === 'narrative' || role === 'canvas' || role === 'cast') return {
    definition: definition(role, role === 'cast' ? '人物塑造 · 修改候选' : `${role} · 修改候选`, `${proposalInstructions[role]}\n${commandHelp}`, proposalSchema),
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
