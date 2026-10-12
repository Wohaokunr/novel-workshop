import { randomUUID } from 'node:crypto';
import type { ResponseOutputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { AssistTool, Command, NarrativeScene, Workspace } from '../shared/types.js';
import { buildCharacterContext, resolveReferences } from './context.js';
import { checkCancelled, type ModelRequest, type ModelResponse, type ResponseTransport } from './responses.js';
export { NovelAgentScheduler } from './agent/scheduler.js';

export class DemoResponseTransport implements ResponseTransport {
  stream(request: ModelRequest, signal: AbortSignal) {
    checkCancelled(signal);
    const first = request.input.find(item => 'role' in item && item.role === 'user') as { content: string };
    const { context } = JSON.parse(first.content) as { context: Record<string, unknown> };
    const outputs = request.input.filter(item => item.type === 'function_call_output');
    const lastResult = outputs.length ? JSON.parse(outputs[outputs.length - 1]!.output as string) as { ok?: boolean; project?: Workspace } : undefined;
    let output: ResponseOutputItem[];
    let result: unknown;
    if ((request.agentId === 'idea' || request.agentId === 'outline' || request.agentId.startsWith('assist:')) && (!lastResult || !lastResult.ok)) {
      const project = lastResult?.project ?? context as unknown as Workspace;
      const commands = request.agentId === 'idea' ? demoIdea(project) : request.agentId === 'outline' ? demoOutline(project) : demoAssist(project, request.agentId.slice(7) as AssistTool, context.materials as ReturnType<typeof resolveReferences>);
      output = commands.length ? [{
        type: 'function_call', id: randomUUID(), call_id: randomUUID(), name: 'apply_commands',
        arguments: JSON.stringify({ expectedRevision: project.revision, commandsJson: JSON.stringify(commands) }),
      }] : [{ type: 'message', id: randomUUID(), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ summary: '所选资料中尚无可跟进的对应要素。', nextStep: '请先构思或选择相关人物、事件、场景与卡片。' }), annotations: [] }] }];
    } else {
      if (request.agentId === 'theme') {
        result = { question: '当证据不足时，人是否愿意为信任承担风险？', choices: '人物可以只保护自己，也可以在仍有疑虑时与对方共同承担风险。',
          cost: '信任可能招致背叛；拒绝信任可能失去关系和解决困境的机会。', expression: `保留${String(context.genre || '作者选择的')}风格与娱乐性，用一件小事、一次误解和付出代价的行动深化主题，不安排说教独白。` };
      } else if (request.agentId.startsWith('evolution:')) {
        const character = context.character as ReturnType<typeof buildCharacterContext>;
        const evidence = context.sceneEvidence as Array<{ id: string; title: string; outline: string; actualText: string }>;
        const written = evidence.some(scene => scene.actualText.trim());
        result = {
          perspective: `${character.state ? '承接此前判断，' : ''}此刻只能确认：${character.perception || '眼前的线索还不充分'}。`,
          psychology: character.state ? '承接此前的戒备，在新的可见线索面前开始犹豫，仍不能确定对方全部意图。' : '面对不完整线索感到戒备，也想进一步了解对方。',
          motivation: '用可以当场核对的行动保护自己重视的人，逐步判断是否可以合作。',
          evidence: `${written ? '正文：' : '计划：'}${evidence.map(scene => `${scene.title}「${(scene.actualText || scene.outline).slice(0, 100)}」`).join('；') || character.perception}；结合该人物当场所见跟进，不把未知真相视为已知。`,
        };
      } else if (request.agentId.startsWith('character:')) {
        result = {
          perspective: `我是${context.name}。眼前我只能确定：${context.perception || '这里的异样让我不安'}。${context.selfKnowledge || ''}`,
          intention: '先保护我珍惜的人，再弄清眼前发生了什么。', action: '暂不把猜测当事实，先追问并检查自己能看到的线索。',
          uncertainty: '我不知道其他人隐瞒了什么，也无法确定钟声背后的真相。',
        };
      } else if (request.agentId === 'reader') {
        const text = String(context.text ?? '');
        result = context.reviewAttempt === 0 ? {
          verdict: 'revise', issues: ['转折处可以多一个当场可见的细节，让人物的选择更有依据。'], recommendation: '补充人物行动的可见代价，保留钟声的悬念，不提前说明全部真相。',
        } : { verdict: 'pass', issues: [], recommendation: text ? '人物行动与可见线索能够互相支撑，悬念可继续发展。' : '尚无正文。' };
      } else if (['writer', 'rewrite', 'revision'].includes(request.agentId)) {
        const scene = context.scene as unknown as NarrativeScene;
        const selectedText = context.selectedText as string | null;
        result = selectedText !== null ? `她把话咽了回去，指腹沿着铜片的缺口缓缓移过。那不是一个可以草率说出口的答案。${selectedText}` : demoText(scene, Boolean(context.readerFeedback));
      } else if (request.agentId === 'connection') result = 'OK';
      else result = { summary: request.agentId === 'idea' ? '已保存作品构思、人物、环境、初始知识与画布。' : request.agentId.startsWith('assist:') ? '已通过同一小说命令保存专项辅助结果，关联实体与画布同步。' : '已保存三段世界事件、因果、关键情节、知识与叙述场景。', nextStep: request.agentId === 'idea' ? '继续编排大纲。' : '查看人物演进与关联场景，再继续写作。' };
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      output = [{ type: 'message', id: randomUUID(), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }];
    }
    const text = output.flatMap(item => item.type === 'message' ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : []).join('');
    const response: ModelResponse = { id: `demo-${randomUUID()}`, status: 'completed', output, output_text: text, usage: null };
    return {
      events: (async function* (): AsyncGenerator<ResponseStreamEvent> {
        for (let offset = 0; offset < text.length; offset += 80) {
          checkCancelled(signal);
          await new Promise<void>(resolve => setImmediate(resolve));
          yield { type: 'response.output_text.delta', delta: text.slice(offset, offset + 80), output_index: 0, content_index: 0, item_id: output[0]!.id, sequence_number: offset } as ResponseStreamEvent;
        }
      })(),
      finalResponse: async () => { checkCancelled(signal); return response; },
    };
  }
}

function demoId(project: Workspace, suffix: string): string { return `${project.id}-demo-${suffix}`; }
function demoFields(project: Workspace, typeId: string, values: Record<string, string>): Record<string, string> {
  const fields = new Set(project.objectTypes.find(type => type.id === typeId)?.fields.map(field => field.id));
  return Object.fromEntries(Object.entries(values).filter(([key]) => fields.has(key)));
}
export function demoAssist(project: Workspace, tool: AssistTool, materials?: ReturnType<typeof resolveReferences>): Command[] {
  const objects = materials?.objects.length ? materials.objects : project.objects;
  const scenes = materials?.scenes.length ? materials.scenes : project.scenes;
  if (tool === 'character') {
    const character = objects.find(object => object.typeId === 'character');
    return character ? [{ type: 'putObject', value: { ...character, fields: { ...character.fields, ...demoFields(project, 'character', { goal: '保护自己珍惜的人，在可核对的线索中学会承担合作的风险。' }) } } }] : [];
  }
  if (tool === 'world') {
    const event = objects.find(object => object.event);
    return event ? [{ type: 'putObject', value: { ...event, fields: { ...event.fields, ...demoFields(project, event.typeId, { purpose: '用当场线索与人物选择推进冲突，让后续事件承担这次选择的代价。' }) } } }] : [];
  }
  if (tool === 'narrative' || tool === 'continuity') {
    const scene = scenes[0];
    if (!scene) return [];
    const addition = tool === 'continuity' && scene.text.trim() ? `正文已呈现：${scene.text.slice(0, 100)}` : '通过当场可见的行动推进人物选择，保留尚未揭露的信息。';
    return [{ type: 'putScene', value: { ...scene, outline: scene.outline.includes(addition) ? scene.outline : `${scene.outline}\n${addition}`.trim() } }];
  }
  if (tool === 'canvas') {
    const card = materials?.cards.find(card => card.kind === 'note') ?? project.cards.find(card => card.kind === 'note');
    const type = project.objectTypes.find(type => type.id === 'character');
    if (!card || !type) return [];
    const id = `${card.id}-character`;
    const existing = project.objects.find(object => object.id === id);
    const object = existing ?? { id, typeId: type.id, name: card.title, fields: demoFields(project, type.id, { description: card.content, goal: '在故事事件中把想法发展成具体选择。' }) };
    return [{ type: 'putObject', value: object }, { type: 'putCard', value: { ...card, kind: 'object', refId: id, title: object.name } }];
  }
  return [];
}
export function demoIdea(project: Workspace): Command[] {
  const commands: Command[] = [{ type: 'updateNovel', patch: {
    title: /未命名|新小说|新作/.test(project.title) ? '雾港的第十三声' : project.title,
    brief: '修钟学徒林舟捡到一枚铜片。雾港本该十二声的报时钟响了第十三声，他与信使沈卿必须在下一次钟响前决定相信谁。', genre: project.genre || '悬疑 · 奇幻', audience: project.audience || '喜欢人物选择与线索悬念的读者',
  } }];
  if (project.objectTypes.some(type => type.id === 'character')) {
    commands.push(
      { type: 'putObject', value: { id: demoId(project, 'lin'), typeId: 'character', name: '林舟', fields: demoFields(project, 'character', { description: '修钟学徒，谨慎但容易把沉默误解为背叛。', selfKnowledge: '我叫林舟，是雾港修钟学徒。师父失踪前让我别碰报时钟的第十三齿。我不知道师父为何这么说。', goal: '找到师父，保护钟楼。' }) } },
      { type: 'putObject', value: { id: demoId(project, 'shen'), typeId: 'character', name: '沈卿', fields: demoFields(project, 'character', { description: '信使，把重要的话留到可以兑现时才说。', selfKnowledge: '我叫沈卿，是雾港信使。我来交还失踪修钟师的一封信。信里让我在第十三声后带走钥匙，但我不知道钥匙通向哪里。', goal: '完成委托，不让林舟卷入未知危险。' }) } },
      { type: 'putKnowledge', value: { id: demoId(project, 'memory-lin'), characterId: demoId(project, 'lin'), content: '师父说过不要碰第十三齿；我相信钟楼发生异常与师父失踪有关，但没有证据。', learnedAt: null, source: 'belief' } },
      { type: 'putKnowledge', value: { id: demoId(project, 'memory-shen'), characterId: demoId(project, 'shen'), content: '我收到委托信：第十三声响后带走钥匙。', learnedAt: null, source: 'initial' } },
    );
  }
  if (project.objectTypes.some(type => type.id === 'setting')) commands.push({ type: 'putObject', value: {
    id: demoId(project, 'tower'), typeId: 'setting', name: '雾港钟楼', fields: demoFields(project, 'setting', { description: '海雾里的旧钟楼，铜齿轮刻有潮汐纹路。', rules: '正常报时最多十二声；第十三声意味着被隐藏的机构开始运作。' }),
  } }, { type: 'putFact', value: { id: demoId(project, 'fact-clock'), subjectId: demoId(project, 'tower'), key: '报时规则', value: '正常报时最多十二声', fromEventId: null } });
  commands.push(
    { type: 'putCard', value: { id: demoId(project, 'card-theme'), kind: 'note', title: '信任的代价', content: '当证据不足时，人物选择承担什么风险？以行动表达信任。', x: 70, y: 70 } },
    { type: 'putCard', value: { id: demoId(project, 'card-mystery'), kind: 'note', title: '第十三声', content: '世界真相与读者获知分开：先出现异常，再留下线索，最后让选择推动揭露。', x: 430, y: 90 } },
    { type: 'putCanvasLink', value: { id: demoId(project, 'link-theme'), source: demoId(project, 'card-theme'), target: demoId(project, 'card-mystery') } },
  );
  for (const [index, suffix] of ['lin', 'shen', 'tower'].entries()) {
    const object = commands.find(command => command.type === 'putObject' && command.value.id === demoId(project, suffix));
    if (object?.type === 'putObject') commands.push({ type: 'putCard', value: { id: demoId(project, `card-${suffix}`), kind: 'object', refId: object.value.id, title: object.value.name, content: '打开对象可编辑字段与设定。', x: 80 + index * 330, y: 300 } });
  }
  return commands;
}
export function demoOutline(project: Workspace): Command[] {
  const participants = ['lin', 'shen'].map(suffix => demoId(project, suffix)).filter(id => project.objects.some(object => object.id === id));
  const titles = ['潮汐铜片', '第十三声', '钥匙与选择'];
  const outlines = ['林舟捡到铜片，沈卿抵达；以缺口和未寄出的信留下悬念。', '钟声多出一声，林舟看到沈卿收起钥匙，以为她在隐瞒背叛；沈卿只知道委托到了执行时刻。', '林舟必须决定阻止沈卿还是共同试探未知入口，用承担风险的行动证明信任，保留师父去向的悬念。'];
  const commands: Command[] = [];
  const hasEvents = project.objectTypes.some(type => type.id === 'event');
  const maxOrder = Math.max(0, ...project.objects.filter(object => object.event && !object.id.includes('-demo-event-')).map(object => object.event!.worldOrder));
  if (hasEvents) for (let index = 0; index < 3; index++) commands.push({ type: 'putObject', value: {
    id: demoId(project, `event-${index}`), typeId: 'event', name: titles[index]!,
    fields: demoFields(project, 'event', { description: outlines[index]!, purpose: index === 1 ? '让不同人物的信息差引发冲突。' : '让线索与选择推进情节。' }),
    event: { worldOrder: maxOrder + index + 1, timeLabel: `第一夜 · ${index + 1}`, thread: '钟楼之谜', participants,
      causes: index ? [demoId(project, `event-${index - 1}`)] : [], critical: index > 0,
      observations: Object.fromEntries(participants.map(id => [id, id.endsWith('-lin')
        ? ['我看到铜片缺口，沈卿手里握着未交出的信。', '钟响了第十三声。沈卿把一枚钥匙收进衣袖，我不知道她为什么这样做。', '沈卿把手伸向门锁，钟楼梯下传来脚步声。'][index]!
        : ['我看到林舟拿着铜片，觉得他可能是修钟师提过的学徒。', '第十三声响了，委托信让我现在带走钥匙。林舟似乎怀疑我。', '我看到门锁纹样和铜片缺口相似，但不知道门后是什么。'][index]!])),
    },
  } });
  const existing = project.chapters.find(chapter => chapter.id === demoId(project, 'chapter'))
    ?? [...project.chapters].sort((a, b) => a.order - b.order).find(chapter => !project.scenes.some(scene => scene.chapterId === chapter.id));
  const chapterId = existing?.id ?? demoId(project, 'chapter');
  commands.push({ type: 'putChapter', value: { id: chapterId, title: '第一章 · 雾中来信', order: existing?.order ?? Math.max(0, ...project.chapters.map(chapter => chapter.order)) + 1 } });
  for (let index = 0; index < 3; index++) {
    const sceneId = demoId(project, `scene-${index}`);
    const current = project.scenes.find(scene => scene.id === sceneId);
    commands.push({ type: 'putScene', value: { id: sceneId, chapterId, order: index + 1, title: titles[index]!, povId: participants[index === 1 ? 1 : 0] ?? null,
      eventIds: hasEvents ? [demoId(project, `event-${index}`)] : [], outline: outlines[index]!, text: current?.text ?? '' } },
    { type: 'putCard', value: { id: demoId(project, `card-scene-${index}`), kind: 'scene', refId: sceneId, title: titles[index]!, content: outlines[index]!, x: 80 + index * 360, y: 600 } });
    if (index) commands.push({ type: 'putCanvasLink', value: { id: demoId(project, `link-scene-${index}`), source: demoId(project, `card-scene-${index - 1}`), target: demoId(project, `card-scene-${index}`) } });
  }
  if (hasEvents && participants[0]) commands.push({ type: 'putKnowledge', value: { id: demoId(project, 'memory-key'), characterId: participants[0], content: '我亲眼看到沈卿在第十三声响后收起钥匙，但还不知道她的目的。', learnedAt: demoId(project, 'event-1'), source: 'witness' } });
  return commands;
}
export function demoText(scene: NarrativeScene, revised: boolean): string {
  const index = scene.id.match(/scene-(\d)$/)?.[1] ?? '0';
  const paragraphs: Record<string, string> = {
    '0': '雾从门缝里挤进来，像有人站在钟楼外缓缓呼气。\n\n林舟把捡来的铜片放在工作台上。铜片缺了一角，边缘却没有断裂的毛刺，像是有人特意留下的记号。他试着用拇指抹去表面的盐霜，潮汐纹路从指腹下面一点点露出来。\n\n楼梯响了一声。\n\n门口的姑娘没有立刻进来。她披着被海雾打湿的斗篷，右手握着一封信，信封折痕里夹着细小的铜屑。林舟见过这样的铜屑——师父总是忘记擦净工作台。\n\n“找谁？”他问。\n\n“修钟的人。”她望向桌上的铜片，停了停，“你是林舟？”\n\n他没回答。师父失踪以后，已经有三个人来问同一个问题；前两个带走了工具，第三个把钟楼的门锁换了。\n\n姑娘把信往前递了一寸，又收住。\n\n“我叫沈卿。我想先听完报时。”\n\n林舟抬头看钟。长针正贴着十二，摆锤从雾光中切过，一下比一下沉。他忽然想起师父离开前的话：别碰第十三齿。\n\n可报时钟从来只有十二声。',
    '1': '第一声响起时，沈卿还觉得自己来早了。\n\n第二声以后，林舟从工作台边退开半步，把铜片握在掌心。她看得出他戒备，却不知道该如何解释。一封只写了半页的委托信，实在不像值得信任的凭据。\n\n第十二声落下，摆锤仍没有停。\n\n沈卿的心往下一沉。信上的字忽然清楚得刺眼：第十三声后，带走钥匙。\n\n多出来的钟声很轻，像薄杯沿被指甲碰了一下。她本能地摸向衣袖里那枚钥匙，冰凉的金属贴着手腕，刻纹与桌上铜片的缺口有些相似。她还不能确定那意味着什么。\n\n“你藏了什么？”林舟的声音挡在楼梯口。\n\n她松开钥匙，却没有拿出来。\n\n“我不知道门后是什么。”\n\n“我没问门。”\n\n两人之间只剩摆锤的声音。沈卿意识到，她答得太快，把自己并不确定的猜测也说成了答案。林舟已经将铜片收回，他的手背绷得发白。\n\n她把信摊到桌上，让他自己看。\n\n“这就是我知道的全部。”她说。\n\n钟楼下面，有人开始敲门。',
    '2': '敲门声没有催促，隔三下便停一停，像是在数什么。\n\n林舟读完那半页信。字迹像师父，纸张却比师父平日用的更薄。仅凭这几行字，他没法判断沈卿说的是不是实话。\n\n她把钥匙放在桌上，没有再伸手拿。\n\n钥匙柄缺了一角。林舟把铜片轻轻靠过去，两道潮汐纹路接成了一条完整的线。\n\n楼梯下传来金属摩擦的声音。他们换过钟楼的门锁，现在似乎又要打开它。\n\n“你可以走。”林舟对沈卿说。\n\n她看了眼钥匙。“那你呢？”\n\n他没答。师父若真留下了这封信，就一定预料到有人会来。可那个人为什么不把话说清楚？为什么又把所有风险留给一个学徒和一个信使？\n\n林舟拿起钥匙。铜片贴着掌心，缺口硌得生疼。\n\n“你读过信，知道什么时候要走。”他说，“我认识这座钟楼。我们都只知道一半。”\n\n沈卿让开了通向顶层的路。\n\n他们没有约定相信对方。林舟只是把提灯交给她，将自己的空手留在她能看到的地方。然后，他把钥匙插进了从未注意过的门锁。\n\n钟声没有再响。\n\n门后先吹出来的，是一阵温暖的风。',
  };
  return paragraphs[index]! + (revised ? '\n\n他停了一瞬，听见身后的脚步也停住。至少此刻，没人把他独自留在雾里。' : '');
}
