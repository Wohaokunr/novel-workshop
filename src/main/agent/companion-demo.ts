import { randomUUID } from 'node:crypto';
import type { ResponseOutputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';
import { checkCancelled, type ModelRequest, type ModelResponse, type ResponseTransport } from '../responses.js';

type Op = {
  op: string; ref: string | null; targetId: string | null; parentRef: string | null; parentId: string | null;
  title: string | null; content: string | null; purpose: string | null; order: number | null; povName: string | null; causes: string[]; people: string[];
  places: string[]; events: string[]; field: string | null;
};
function op(patch: Partial<Op> & Pick<Op, 'op'>): Op {
  return { ref: null, targetId: null, parentRef: null, parentId: null, title: null, content: null, purpose: null, order: null, povName: null, causes: [], people: [], places: [], events: [], field: null, ...patch };
}

/** Offline fixtures for the creative partner. They exercise the real adoption path but are not model judgments. */
export class DemoCompanionTransport implements ResponseTransport {
  stream(request: ModelRequest, signal: AbortSignal) {
    checkCancelled(signal);
    const first = request.input.find(item => 'role' in item && item.role === 'user') as { content?: string } | undefined;
    const { context, objective } = JSON.parse(String(first?.content ?? '{}')) as { context: any; objective: string };
    const mode = request.agentId.replace('companion:', '');
    const { reply, ...rest } = this.respond(mode, context ?? {}, String(objective ?? ''));
    // Strict schema: every question carries options.
    rest.questions = rest.questions.map((question: any) => ({ options: [], ...question }));
    // Same field order as the schema: reply streams first.
    const text = JSON.stringify({ reply, ...rest });
    const output: ResponseOutputItem[] = [{ type: 'message', id: randomUUID(), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }];
    const response: ModelResponse = { id: `demo-companion-${randomUUID()}`, status: 'completed', output, output_text: text, usage: null };
    return {
      events: (async function* (): AsyncGenerator<ResponseStreamEvent> {
        for (let index = 0; index < text.length; index += 60) {
          checkCancelled(signal);
          await new Promise<void>(resolve => setTimeout(resolve, 4));
          yield { type: 'response.output_text.delta', delta: text.slice(index, index + 60), output_index: 0, content_index: 0, item_id: output[0]!.id, sequence_number: index } as ResponseStreamEvent;
        }
      })(),
      finalResponse: async () => { checkCancelled(signal); return response; },
    };
  }

  private respond(mode: string, context: any, objective: string) {
    const people: string[] = (context.catalog?.characters ?? []).map((item: any) => item.name);
    const hero = people[0] ?? '主角', other = people[1] ?? '那个陌生人';
    const place: string | undefined = context.catalog?.settings?.[0]?.name;
    const anchorTitle: string = context.anchor?.cards?.[0]?.title ?? context.anchor?.objects?.[0]?.name ?? context.anchor?.scenes?.[0]?.title ?? context.project?.title ?? '这个故事';
    const round = (context.conversation ?? []).filter((turn: any) => turn.author).length;
    const base = { questions: [] as any[], ideas: [] as any[], proposals: [] as any[], followUps: [] as string[] };
    if (mode === 'diverge') return { ...base,
      reply: `（演示）围绕「${anchorTitle}」，我先往几个相反的方向推一推。${round ? '结合你刚才的回答，这一轮更偏向人物代价。' : '第二个反转最有潜力，值得先想清楚它的代价。'}`,
      questions: [
        { question: `${hero}最不愿意让谁知道这件事？`, why: '秘密指向谁，决定了冲突落在哪段关系上。' },
        { question: `如果「${anchorTitle}」最后被证明是假的，读者会失望还是兴奋？`, why: '帮你判断这是需要兑现的承诺，还是可以颠覆的误导。' },
      ],
      ideas: [
        { kind: 'whatif', title: `如果「${anchorTitle}」是${other}故意留下的`, content: `${other}早就知道${hero}会发现它，并以此测试${hero}是否值得托付。`, hook: '读者会重新怀疑此前每一次“巧合”。' },
        { kind: 'twist', title: '帮手其实是委托人', content: `一直在帮${hero}的人，正是事件背后的委托者，只是他也不知道委托的全部后果。`, hook: '盟友与敌人的界线被打乱。' },
        { kind: 'conflict', title: '代价落在无辜者身上', content: `每推进一步，就有一个与${hero}亲近的普通人失去一样东西。`, hook: '胜利开始变得沉重。' },
        { kind: 'character', title: `${hero}的旧谎言`, content: `${hero}多年前撒过一个小谎，如今正好成了解开谜团的钥匙。`, hook: '想前进就必须先承认过去。' },
        { kind: 'setting', title: '规则有一个例外', content: '世界规则存在一个只有付出记忆才能触发的例外。', hook: '能力越用越强，人却越来越不像自己。' },
      ],
      followUps: ['把第二个点子再推进一步', '给我更离谱一点的版本', '这些点子各自适合放在故事的哪个位置？'],
    };
    if (mode === 'develop') return this.develop(context, hero);
    if (mode === 'style') return this.style(context, hero);
    if (mode === 'causality') {
      const event = context.anchor?.objects?.find((item: any) => item.event) ?? context.catalog?.events?.at(-1);
      const id = event?.id ?? null, name = event?.name ?? '这件事';
      return { ...base,
        reply: `（演示）「${name}」目前像是凭空发生的。给它补一个前因，再推一步后果，世界会更扎实。`,
        questions: [{ question: `谁最希望「${name}」发生？`, why: '找到受益者，往往就找到了缺失的前因。' }],
        proposals: [
          { title: '推演后果', summary: `「${name}」之后，局势向更危险的方向滑落。`, ops: id ? [op({ op: 'addEvent', ref: 'e1', title: `${name}的余波`, content: `消息传开，${other}被迫提前行动。`, purpose: '让上一次选择的代价立刻显现。', causes: [id], people: [other] })] : [] },
          { title: '补一个前因', summary: '让这件事有可追溯的起点。', ops: id ? [op({ op: 'addEvent', ref: 'e2', targetId: id, title: '无人注意的交易', content: `有人在暗处交换了一样东西，为「${name}」埋下伏笔。`, purpose: '提供日后揭示真相的线索。', people: [hero] })] : [] },
        ].filter(proposal => proposal.ops.length),
        followUps: ['如果它根本没发生呢？', '把后果推到第三步'],
      };
    }
    if (mode === 'structure') {
      const scenes: any[] = context.catalog?.scenes ?? [];
      const proposals: any[] = [];
      // Work on the chapter of the scene the author pointed at, like a real diagnosis would.
      const anchorId = context.anchor?.scenes?.[0]?.id;
      const focus = scenes.find(scene => scene.id === anchorId) ?? scenes.at(-1);
      const siblings = focus ? scenes.filter(scene => scene.chapterId === focus.chapterId) : [];
      if (siblings.length >= 2) {
        const first = siblings[0], moved = focus === first ? siblings.at(-1) : focus;
        proposals.push({ title: '换个开篇', summary: `以「${moved.title}」开场制造悬念，再回到起点。`, ops: [op({ op: 'moveScene', targetId: moved.id, parentId: moved.chapterId, order: 1, title: moved.title })] });
        proposals.push({ title: '推迟揭露', summary: `把「${first.title}」后移，让读者多等一会儿答案。`, ops: [op({ op: 'moveScene', targetId: first.id, parentId: first.chapterId, order: 99, title: first.title })] });
      }
      const chapterId = scenes[0]?.chapterId ?? context.catalog?.chapters?.[0]?.id ?? null;
      if (chapterId) proposals.push({ title: '插入一场喘息', summary: '在紧张段落之间加入一场人物关系戏。', ops: [op({ op: 'addScene', parentId: chapterId, order: 2, title: '短暂的停顿', content: `${hero}与${other}在等待中交换了一个不该说出口的秘密。`, povName: hero, people: [other], places: place ? [place] : [] })] });
      // The outline has no chapter for a flashback yet: open one right after the focused chapter and put the scene there.
      const after = focus?.chapterId ?? chapterId;
      if (after) proposals.push({ title: '插入一章插叙', summary: '在这一章之后插入一章旧事，先让读者看见代价，再回到当下。', ops: [
        op({ op: 'addChapter', ref: 'c1', targetId: after, title: '插叙 · 三十年前', content: '用一场旧事交代代价从何而来，结尾回扣当下的悬念。' }),
        op({ op: 'addScene', parentRef: 'c1', title: '旧案', content: `${other}年轻时目睹了那件事，却选择了沉默。`, povName: other, people: [hero], places: place ? [place] : [] }),
      ] });
      return { ...base, reply: `（演示）目前共有 ${scenes.length} 个场景。开篇信息给得偏早，中段缺少节奏变化。下面是几个互斥的调整方向。`,
        questions: [{ question: '你希望读者在哪一章第一次真正担心主角？', why: '这决定了第一个高潮应该放在哪里。' }], proposals, followUps: ['再给一个以视角切换为核心的方案'] };
    }
    if (mode === 'outline') {
      const target = context.target ?? { kind: 'book' };
      const stages: any[] = context.project?.structureTemplate?.stages ?? [{ name: '开端', purpose: '建立人物与困境' }, { name: '发展', purpose: '冲突升级' }, { name: '高潮与结局', purpose: '做出最终选择' }];
      const versions = /版本/.test(objective) ? 3 : 1;
      const draft = (variant: number) => {
        const ops: Op[] = [];
        const tone = ['', '（更快节奏）', '（更重人物关系）'][variant] ?? '';
        if (target.kind === 'act' && target.id) {
          for (let c = 1; c <= 3; c++) ops.push(op({ op: 'addChapter', parentId: target.id, title: `第${c}章${tone}`, content: `${hero}在这一章${['发现异常', '付出代价', '做出选择'][c - 1]}，结尾留下新的疑问。` }));
        } else if (target.kind === 'chapter' && target.id) {
          for (let s = 1; s <= 3; s++) ops.push(op({ op: 'addScene', parentId: target.id, title: ['引子', '交锋', '余韵'][s - 1]! + tone, content: `${s === 2 ? other : hero}视角：${['察觉不对劲', '正面冲突', '独自面对后果'][s - 1]}。`, povName: s === 2 ? other : hero,
            people: s === 2 ? [hero] : [], places: place ? [place] : [] }));
        } else {
          stages.slice(0, 4).forEach((stage, a) => {
            ops.push(op({ op: 'addAct', ref: `a${a + 1}`, title: `${stage.name}${tone}`, purpose: stage.purpose, content: `${hero}在这一部分：${stage.purpose}` }));
            if (target.fullDraft) for (let c = 1; c <= 2; c++) {
              ops.push(op({ op: 'addChapter', ref: `a${a + 1}c${c}`, parentRef: `a${a + 1}`, title: `${stage.name} · ${c}`, content: `推进「${stage.name}」的第 ${c} 步，结尾留钩子。` }));
              for (let s = 1; s <= 2; s++) ops.push(op({ op: 'addScene', parentRef: `a${a + 1}c${c}`, title: `场景 ${s}`, content: `${s === 1 ? hero : other}行动，局势发生变化。`, povName: s === 1 ? hero : other }));
            }
          });
        }
        return { title: versions > 1 ? `版本 ${variant + 1}${tone}` : '大纲建议', summary: '依据所选结构模板分层展开。', ops };
      };
      return { ...base, reply: `（演示）按${context.project?.structureTemplate?.name ?? '默认三段'}结构展开了${target.fullDraft ? '完整草案' : '下一层'}。先看骨架是否对，再逐层精修。`,
        questions: [{ question: '结局时主角得到了想要的，还是需要的？', why: '决定最后一幕的情绪落点。' }],
        proposals: Array.from({ length: versions }, (_, index) => draft(index)), followUps: ['给我 3 个版本', '展开第一幕的章节'] };
    }
    return { ...base, reply: '（演示）卡住时，先想这一场结束时什么必须改变。下面是几个可以直接写的下一拍。',
      questions: [{ question: '这一场结束时，人物失去了什么？', why: '有失去，场景才有推进。' }],
      ideas: [
        { kind: 'beat', title: '一个打断', content: `门外突然有人喊${hero}的名字，对话被迫中断。`, hook: '没说完的话成为下一场的悬念。' },
        { kind: 'twist', title: '对方先开口', content: `${other}抢先说出了${hero}准备隐瞒的事。`, hook: '主动权瞬间易手。' },
        { kind: 'conflict', title: '小物件出错', content: '随身的道具出现裂痕，计划必须当场修改。', hook: '外部压力逼出真实选择。' },
      ], followUps: ['给我一个更安静的版本'] };
  }

  /** Distill: dials read mechanically off the measured fingerprint. Blind test: three fixed contrasting passages. */
  private style(context: any, hero: string) {
    const base = { questions: [] as any[], ideas: [] as any[], proposals: [] as any[], followUps: [] as string[] };
    const dial = (id: string, value: number) => op({ op: 'updateStyle', field: `dial:${id}`, content: String(value) });
    if (context.target?.focus === 'blindtest') {
      return { ...base, reply: '（演示）读一读，哪一段最像你会写的？',
        proposals: [
          { title: '版本 A', summary: `门没锁。${hero}推开，屋里没人。桌上一碗面，还冒着热气。他没坐。他数了数碗边的筷子，三双。`,
            ops: [dial('sentence', 1), dial('ornament', 1), dial('interiority', 1), op({ op: 'updateStyle', field: 'rule:do', content: '用动作和物件代替心理说明' })] },
          { title: '版本 B', summary: `${hero}在门口站了很久，久到楼道里的灯熄了又亮，他才终于把手按在那扇没有上锁的门上——屋里空着，只有桌上那碗面还在冒热气，像是有人刚刚起身，又像是有人故意要让他看见这一幕。`,
            ops: [dial('sentence', 5), dial('interiority', 4), dial('pace', 4), op({ op: 'updateStyle', field: 'rule:do', content: '长句铺陈，让环境替人物的犹豫说话' })] },
          { title: '版本 C', summary: `“有人吗？”${hero}探头。没人应。“行吧，面我先替你看着。”他拖了把椅子坐下，盯着那碗冒热气的面，“你最好是去买醋了。”`,
            ops: [dial('dialogue', 5), dial('register', 1), dial('pace', 2), op({ op: 'updateStyle', field: 'rule:do', content: '让人物用玩笑掩饰紧张' })] },
        ],
        followUps: ['再来一轮，更细一点', '根据我的选择生成文风画像'] };
    }
    const own = context.style?.fingerprint?.own;
    if (!own) return { ...base, reply: '（演示）还没有你自己写的范文，我先问几个最能区分文风的问题。',
      questions: [
        { question: '紧张的场面，你更想要哪种句子？', why: '句子长短决定了读者的呼吸。', options: ['短句连发', '长句一气呵成', '看情况交替'] },
        { question: '人物难过时，你会怎么写？', why: '决定心理描写的深浅。', options: ['只写动作，不写心理', '写一两句内心', '大段内心独白'] },
        { question: '你的叙述更像哪种声音？', why: '决定语言质地。', options: ['口语、有网感', '干净的书面语', '讲究、带点古意'] },
      ], followUps: ['先做一次文风盲测', '我贴一段自己写的文字'] };
    const scale = (value: number, low: number, high: number) => Math.max(1, Math.min(5, Math.round(1 + (value - low) / (high - low) * 4)));
    const sentence = scale(own.avgSentence, 8, 32), dialogue = scale(own.dialogueRatio, 0.05, 0.55), ornament = scale(own.simile, 0.5, 6);
    return { ...base,
      reply: `（演示）你的范文平均句长约 ${Math.round(own.avgSentence)} 字，对白约占 ${Math.round(own.dialogueRatio * 100)}%，每千字比喻 ${own.simile} 处。我据此拨好了旋钮，画像是机械生成的示例。`,
      proposals: [{ title: '依据范文的文风画像', summary: '从实测数值推出的旋钮与规则。', ops: [
        op({ op: 'updateStyle', field: 'summary', content: `${sentence <= 2 ? '句子短促利落' : sentence >= 4 ? '句子舒展绵长' : '长短句交错'}，${dialogue >= 4 ? '对白推动情节' : dialogue <= 2 ? '以叙述为主、对白克制' : '叙述与对白均衡'}，${ornament <= 2 ? '白描为主、少用比喻' : '修辞适度、意象鲜明'}。` }),
        dial('sentence', sentence), dial('dialogue', dialogue), dial('ornament', ornament),
        op({ op: 'updateStyle', field: 'rule:avoid', content: '不用“嘴角勾起一抹弧度”一类的套话写表情' }),
      ] }],
      questions: [{ question: '打斗或追逐的场面，要不要比平时更短促？', why: '范文里没有动作场面，无法判断。', options: ['更短促', '保持一致', '反而放慢'] }],
      followUps: ['再做一次文风盲测', '把禁用词也整理一下'] };
  }

  private develop(context: any, hero: string) {
    const target = context.target ?? { focus: 'profile', round: 'draft', emptyFields: [] };
    const title: string = context.project?.title ?? '这个故事', genre: string = context.project?.genre || '故事';
    const questions = [
      { question: `《${title}》读完后，你最希望读者留下什么感受？`, why: '感受决定立意落在希望还是代价上。', options: ['意难平', '热血痛快', '细思极恐', '温暖治愈'] },
      { question: '主角在故事开头最缺的是什么？', why: '缺失决定了人物要付出的代价。', options: ['信任', '勇气', '自由', '真相'] },
    ];
    if (target.round === 'ask') return { questions, ideas: [], proposals: [],
      reply: `（演示）从《${title}》和「${genre}」看，这像是一个关于选择与代价的故事，但方向还很开放。先帮我确定两件事。`,
      followUps: ['先直接给我几个版本', '你觉得哪个方向最有潜力？'] };
    const field = (name: string, content: string) => op({ op: 'updateNovel', field: name, title: name, content });
    let proposals: any[];
    if (target.focus === 'setting') {
      const lead = (context.catalog?.characters ?? [])[0];
      const world = (variant: number) => {
        const [first, second, third] = [['雾港钟楼', '潮汐市场', '旧档案馆'], ['废弃铁路站', '河心岛', '地下剧场']][variant]!;
        const ops = [
          op({ op: 'addSetting', ref: 's1', title: first, content: '故事的中心地点，旧而庄重，人人都以为了解它。', purpose: '这里的规矩不能当众打破。' }),
          op({ op: 'addSetting', ref: 's2', title: second, content: '消息流通的地方，嘈杂、热闹、谁都可能在偷听。', purpose: '交易必须当面完成。' }),
          op({ op: 'addSetting', ref: 's3', title: third, content: '保存着被人刻意遗忘的记录。', purpose: '每取走一份档案都要留下名字。' }),
        ];
        if (lead) ops.push(op({ op: 'link', parentRef: 's1', targetId: lead.id, title: '在这里长大' }));
        return { title: ['版本 1 · 旧城', '版本 2 · 边缘地带'][variant], summary: '三个地点，各有一条不能打破的规则。', ops };
      };
      proposals = [world(0), world(1)];
    } else if (target.focus === 'cast') {
      const existing = (context.catalog?.characters ?? [])[0];
      const lead = existing ? { id: existing.id, ref: null } : { id: null, ref: 'c1' };
      const cast = (variant: number) => {
        const names = [['许砚', '沈照', '老钟'], ['阿离', '韩序', '白姨']][variant]!;
        const ops = existing ? [] : [op({ op: 'addCharacter', ref: 'c1', title: names[0], content: '主角，嘴硬心软，背着一个没说出口的承诺。', purpose: '在信任与自保之间做出选择' })];
        ops.push(op({ op: 'addCharacter', ref: 'c2', title: names[1], content: '看似可靠的同伴，其实另有所图。', purpose: '逼主角重新定义信任' }),
          op({ op: 'addCharacter', ref: 'c3', title: names[2], content: '知道真相却选择沉默的长辈。', purpose: '在关键时刻揭开旧事' }),
          op({ op: 'link', parentRef: lead.ref, parentId: lead.id, targetId: 'c2', title: '同伴，互相隐瞒' }),
          op({ op: 'link', parentRef: lead.ref, parentId: lead.id, targetId: 'c3', title: '师徒，旧债未清' }));
        return { title: ['版本 1 · 信任危机', '版本 2 · 家族旧事'][variant], summary: '三个人物，两条关系线。', ops };
      };
      proposals = [cast(0), cast(1)];
    } else if (target.focus === 'profile') {
      const values: Record<string, string> = { theme: `${hero}必须在保全自己与守住承诺之间选择，而守诺的代价是失去最亲近的人。`,
        logline: `一个不愿再相信任何人的${hero}，为了一个旧承诺，被迫和最不该信的人联手。`,
        brief: `${title}讲述${hero}被卷入一场无法置身事外的风波，每前进一步都要付出代价。`, genre: genre || '悬疑', audience: '喜欢人物成长与反转的读者' };
      proposals = [{ title: '补全作品信息', summary: '只填空着的字段，可逐项勾选。', ops: (target.emptyFields as string[]).map(name => field(name, values[name] ?? '')) }];
    } else {
      const name = target.focus === 'theme' ? 'theme' : target.focus;
      const versions = [`信任需要先承担被欺骗的风险：${hero}一次次选择相信，代价是一次次失去。`, `真正的自由来自承认自己的软弱：${hero}放下伪装，才赢回选择的权利。`, `守住秘密的人最孤独：${hero}保护了所有人，却没有人知道。`];
      proposals = versions.map((content, index) => ({ title: `版本 ${index + 1}`, summary: ['侧重代价', '侧重成长', '侧重孤独'][index], ops: [field(name, content)] }));
    }
    return { reply: `（演示）结合你给的信息，我推断了几个方向。${target.focus === 'cast' ? '采纳后人物会出现在「人物与设定」和画布上。' : target.focus === 'setting' ? '采纳后环境会出现在「人物与设定」的环境一栏，场景可以绑定它们。' : '选一个最接近的直接采纳，或者回答下面的问题让我再收敛。'}`,
      questions: questions.slice(0, 1), ideas: [], proposals, followUps: ['把第一个版本再推进一步', '换一种完全不同的基调'] };
  }
}
