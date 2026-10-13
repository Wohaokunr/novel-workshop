import type { Command, Workspace } from '../../shared/types.js';
import { emptyStyle, type StyleProfile } from '../../shared/style-types.js';
import { applyCommands, createWorkspace } from '../domain.js';

/** A small benchmark: sample works with known secrets, author constraints and a style profile, and specialist tasks on them.
 * Checks are deterministic phrase and style-statistics checks (see checks.ts). They catch clear regressions, not every subtle one:
 * a marker phrase is evidence of a leak or a broken constraint, its absence is not proof of compliance. */

/** Something a character in the task cannot know; any marker in the output (or in a restricted role's context) is a leak. */
export interface BenchSecret { label: string; markers: string[] }
/** A constraint the author confirmed; any marker in an output means it was broken. Passed to the specialists as an author rule. */
export interface BenchRule { content: string; markers: string[] }
export interface BenchTask {
  id: string; label: string; role: 'writer' | 'character' | 'reader';
  objective: string; sceneId?: string; chapterId?: string; characterId?: string; eventId?: string;
  secrets: BenchSecret[];
  /** Prose length bounds in characters (writer only). */
  length?: [number, number];
  /** Author-side text a restricted role must not be given (plans, outlines of unread scenes). */
  contextMustNot?: string[];
}
export interface BenchCase { id: string; title: string; build(): Workspace; rules: BenchRule[]; tasks: BenchTask[] }

const character = (id: string, name: string, description: string, selfKnowledge: string): Command =>
  ({ type: 'putObject', value: { id, typeId: 'character', name, fields: { description, selfKnowledge, goal: '' } } });
const event = (id: string, name: string, worldOrder: number, timeLabel: string, participants: string[], causes: string[], observations: Record<string, string>, description: string): Command =>
  ({ type: 'putObject', value: { id, typeId: 'event', name, fields: { description, purpose: '' }, event: { worldOrder, timeLabel, thread: '主线', participants, causes, critical: true, observations } } });
function work(id: string, title: string, genre: string, style: Partial<StyleProfile>, commands: (chapterId: string) => Command[]): Workspace {
  const base = createWorkspace(title, id);
  const chapterId = base.chapters[0]!.id;
  return applyCommands(base, [{ type: 'updateNovel', patch: { genre } }, ...commands(chapterId), { type: 'updateStyle', patch: { ...emptyStyle(), ...style } }]);
}

const theft = `雾从江面爬上码头，许砚把领子竖起来。
三号仓库的门关着。锁也挂着，铜皮上结了一层水汽。
林舟蹲在门边，手里捏着半截烟，没点。
“钥匙呢？”许砚问。
“不见了。”林舟抬头，“昨晚我亲手交给老秦的。”
许砚伸手拨了拨锁。锁是好的，没有撬痕。他凑近锁孔闻了闻，一股新鲜的机油味。
有人用钥匙开过门，又锁上了。
“老秦人呢？”
“一早就没见着。”林舟把烟塞回口袋，“巡捕房的人说中午来。”
许砚没接话。他看着雾里那排灰色的仓库，一间一间数过去。数到第三间，他想起昨晚在茶馆，沈照随口问过一句：三号仓库那把锁，是不是你家铺子配的。
他当时说是。沈照笑了笑，给他添了茶，没再问。
雾散了一点。江上有船拉汽笛，很长的一声。许砚把手揣进兜里，摸到自家铺子的铜牌，凉的。`;

const nightShift = `我叫苏晚，二十岁，大二，职业是便利店夜班店员——好吧，兼职。
凌晨一点的星屑便利店，客人比关东煮里的萝卜还少。我一边擦收银台一边想，如果萝卜会说话，它大概也想下班。
“小同学，”店长老周慢吞吞地从仓库探出头，“鱼丸要翻面了。”
“知道啦知道啦。”我嘴上应着，手却先去够手机。
“鱼丸可不会等你回完消息哦。”
“店长，你是怎么知道我在回消息的？”
“猜的。”他把一箱矿泉水放下，拍了拍手上的灰，“年轻人半夜拿手机，十个有九个在回消息，剩下一个在看小说。”
我决定不告诉他，我其实在看小说。
老周是个奇怪的人。四十来岁，永远穿同一件洗得发白的毛衣，说话像在念慢速广播，可是收银机坏了他三分钟就能修好，进货单上的数字他看一眼就知道哪里算错了。
“店长，你以前是干什么的啊？”
“卖关东煮的。”
“我是说以前！”
“以前也卖关东煮。”他笑眯眯地说，“小同学，鱼丸。”
我叹了口气，去翻鱼丸。`;

export const BENCHMARK: BenchCase[] = [
  {
    id: 'mist-harbor', title: '雾港疑案',
    build: () => work('bench-mist-harbor', '雾港疑案', '民国悬疑', {
      summary: '短句白描，冷而克制。用动作、物件和环境写情绪，很少直接说人物心里想什么；对白简短，常常答非所问。',
      dials: { ...emptyStyle().dials, person: 'third-limited', sentence: 2, ornament: 2, dialogue: 3, interiority: 2 },
      avoidWords: ['不禁', '缓缓地', '嘴角上扬'],
      rules: [{ id: 'r1', kind: 'avoid', content: '不用“仿佛”“宛如”堆叠比喻', origin: 'author' }, { id: 'r2', kind: 'do', content: '用动作和物件写情绪，不直接说人物的感受', origin: 'author' }],
      samples: [{ id: 'own-theft', label: '失窃', text: theft, source: 'own', sceneId: 's-theft' }],
      voices: [{ characterId: 'shen', voice: '说话客气周到，爱用反问把话题岔开' }],
    }, chapterId => [
      character('xu', '许砚', '锁匠铺的少东家，心细，嘴紧。', '我是许家锁匠铺的少东家，三号仓库的锁是我家配的。'),
      character('shen', '沈照', '茶馆常客，表面是许砚的朋友，实际是巡捕房的线人。', '我替巡捕房做事，这件事谁也不能知道。'),
      character('lin', '林舟', '码头工头，许砚的旧识。', '我管着三号仓库的钥匙。'),
      event('theft', '三号仓库失窃', 1, '第一天清晨', ['xu', 'lin'], [], { xu: '门锁完好，锁孔有新机油味，钥匙不见了', lin: '昨晚亲手把钥匙交给了老秦' }, '有人用钥匙打开三号仓库，偷走货物后重新锁门。'),
      event('report', '沈照向巡捕房密报', 2, '第一天上午', ['shen'], ['theft'], { shen: '把许家配过三号仓库钥匙的事报给了巡捕房' }, '沈照把许砚家与仓库锁的关系密报给巡捕房。'),
      event('teahouse', '茶馆对质', 3, '第一天午后', ['xu', 'shen'], ['theft'], { xu: '沈照神色如常，却先问巡捕房来过没有', shen: '许砚在试探自己' }, '许砚约沈照在茶馆见面，互相试探。'),
      { type: 'putFact', value: { id: 'fact-informant', subjectId: 'shen', key: '身份', value: '巡捕房线人', fromEventId: null } },
      { type: 'putKnowledge', value: { id: 'k-shen', characterId: 'shen', content: '自己是巡捕房的线人', learnedAt: null, source: 'initial' } },
      { type: 'putKnowledge', value: { id: 'k-xu-theft', characterId: 'xu', content: '三号仓库的钥匙失踪，门锁没有撬痕，锁孔有新机油味', learnedAt: 'theft', source: 'witness' } },
      { type: 'putKnowledge', value: { id: 'k-xu-question', characterId: 'xu', content: '沈照问过三号仓库的锁是不是许家配的', learnedAt: null, source: 'initial' } },
      { type: 'putScene', value: { id: 's-theft', chapterId, order: 0, title: '失窃', povId: 'xu', castIds: ['lin'], eventIds: ['theft'], outline: '清晨，许砚在码头发现三号仓库失窃，门锁完好。', text: theft } },
      { type: 'putScene', value: { id: 's-teahouse', chapterId, order: 1, title: '茶馆', povId: 'xu', castIds: ['shen'], eventIds: ['teahouse'],
        outline: '午后，许砚约沈照在茶馆见面，试探他是否知道钥匙的下落；沈照岔开话题，反问巡捕房来过没有。许砚没有得到答案，离开时注意到沈照袖口沾着机油。', text: '' } },
    ]),
    rules: [
      { content: '不写鬼神、法术等超自然元素', markers: ['鬼魂', '闹鬼', '法术', '妖怪', '咒语', '显灵', '魂魄'] },
      { content: '林舟在第一卷不能死', markers: ['林舟死', '林舟的尸', '林舟断了气', '林舟没了气息'] },
    ],
    tasks: [
      { id: 'write-teahouse', label: '写作：茶馆（许砚视角）', role: 'writer', sceneId: 's-teahouse', objective: '按大纲写出这一场正文。', length: [400, 5000],
        secrets: [{ label: '许砚不知道沈照是巡捕房线人', markers: ['线人', '密报', '告密'] }] },
      { id: 'character-xu', label: '角色代入：许砚在茶馆对质时', role: 'character', characterId: 'xu', eventId: 'teahouse', objective: '面对茶馆里的沈照，你会怎么想、怎么做？',
        secrets: [{ label: '许砚不知道沈照是巡捕房线人', markers: ['线人', '密报', '告密'] }] },
      { id: 'reader-theft', label: '读者审阅：失窃', role: 'reader', sceneId: 's-theft', objective: '从读者视角审阅可见正文。',
        secrets: [{ label: '读者还不知道沈照是巡捕房线人', markers: ['线人', '密报', '告密'] }],
        contextMustNot: ['袖口沾着机油', '巡捕房的线人', '林舟在第一卷不能死'] },
    ],
  },
  {
    id: 'star-store', title: '星屑便利店',
    build: () => work('bench-star-store', '星屑便利店', '轻小说·日常', {
      summary: '第一人称，轻快吐槽。对白驱动，句子短，内心独白带自嘲；不煽情，温柔藏在玩笑后面。',
      dials: { ...emptyStyle().dials, person: 'first', sentence: 2, dialogue: 5, register: 1, ornament: 2 },
      avoidWords: ['宛如', '不由得', '心中一凛'],
      rules: [{ id: 'r1', kind: 'do', content: '用吐槽式的内心独白推进，轻快，不煽情', origin: 'author' }],
      samples: [{ id: 'own-night', label: '夜班', text: nightShift, source: 'own' }],
      voices: [{ characterId: 'zhou', voice: '说话慢吞吞，爱叫人“小同学”，总把话题绕回关东煮' }],
    }, chapterId => [
      character('su', '苏晚', '大二学生，便利店夜班兼职，好奇心重，嘴快。', '我是苏晚，在星屑便利店上夜班。'),
      character('zhou', '老周', '便利店店长，真实身份是星屑集团董事长的儿子，离家出走开了这家店。', '我是星屑集团董事长的儿子，不想回去继承家业。'),
      event('visitor', '深夜的西装客人', 1, '某个周五凌晨两点', ['su', 'zhou'], [], { su: '穿西装的客人对老周鞠躬，叫他“少爷”，老周把人请了出去', zhou: '父亲的秘书又来劝我回去' }, '董事长的秘书深夜来店里劝老周回家。'),
      { type: 'putFact', value: { id: 'fact-heir', subjectId: 'zhou', key: '身份', value: '星屑集团董事长的儿子、继承人', fromEventId: null } },
      { type: 'putKnowledge', value: { id: 'k-zhou', characterId: 'zhou', content: '自己是星屑集团董事长的儿子', learnedAt: null, source: 'initial' } },
      { type: 'putScene', value: { id: 's-night', chapterId, order: 0, title: '少爷', povId: 'su', castIds: ['zhou'], eventIds: ['visitor'],
        outline: '凌晨两点，苏晚值夜班，一个穿西装的客人进店找老周，叫他“少爷”。老周把人请了出去，回来后若无其事地教苏晚摆关东煮。苏晚满肚子疑问，最后决定先不问。', text: '' } },
    ]),
    rules: [{ content: '不写恋爱情节', markers: ['心动', '告白', '脸红心跳', '喜欢上他', '喜欢上了'] }],
    tasks: [
      { id: 'write-night', label: '写作：少爷（苏晚第一人称）', role: 'writer', sceneId: 's-night', objective: '按大纲写出这一场正文。', length: [400, 5000],
        secrets: [{ label: '苏晚不知道老周是集团继承人', markers: ['继承人', '董事长', '集团'] }] },
      { id: 'character-su', label: '角色代入：苏晚看到西装客人时', role: 'character', characterId: 'su', eventId: 'visitor', objective: '看到有人叫老周“少爷”，你怎么想、怎么做？',
        secrets: [{ label: '苏晚不知道老周是集团继承人', markers: ['继承人', '董事长', '集团'] }] },
    ],
  },
];
