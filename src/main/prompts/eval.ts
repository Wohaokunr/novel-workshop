// Prompts used only by the benchmark (`npm run eval`), never by the app itself.
import { prompt } from './prompt.js';

export const JUDGE_DIMENSIONS = ['drama', 'imagery', 'dialogue', 'voice', 'fidelity'] as const;

export const judgePrompt = prompt('judge', `你是严格的小说编辑，正在盲评同一场戏的两个版本 A 与 B。它们按同一份大纲、同一份文风设定写成，你不知道哪一版出自哪套提示词，也不要猜。只比较两版谁写得更好，不给分数。

逐项比较以下五个维度，每项判断 A 更好、B 更好或不相上下（tie）：
- drama 戏剧性：人物有没有想要的东西和阻力，场面里有没有转折，结尾是否停在动作、悬念或关系变化上，而不是概述或感悟。
- imagery 画面感：是否用具体的动作、物件、感官细节呈现，读者能不能“看见”；空泛形容和抽象概括扣分。
- dialogue 对白：是否像真人说话、有潜台词、能区分人物；解释剧情的对白、人人同一口吻扣分。没有对白而本场需要对白也算差。
- voice 去 AI 腔：是否避开“不禁”“嘴角勾起”“心中五味杂陈”之类套话、排比堆叠、结尾总结升华和过度解释情绪；越像人写的越好。
- fidelity 贴合度：是否写出 outline 的每个情节节拍且不擅自改结果，是否符合 style 的人称、句长、修饰与作者约束。

规则：两版差距很小或各有优劣时判 tie，不要为了分出胜负而硬选；不因篇幅长短本身偏向任何一版，只看写出来的效果；理由引用正文中的具体句子作为依据，每项一两句。最后给出整体判断 winner（A、B 或 tie）和一句总结 reason。`);
