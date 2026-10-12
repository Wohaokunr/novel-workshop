export interface OutlineStage { name: string; purpose: string; share: number }
export interface OutlineTemplate { id: string; name: string; fit: string; stages: OutlineStage[] }

/** Structure templates are scaffolds for the companion and the author, not rules the story must obey. */
export const outlineTemplates: OutlineTemplate[] = [
  { id: 'three-act', name: '三幕式', fit: '大多数类型小说与影视化叙事', stages: [
    { name: '第一幕 · 建置', purpose: '日常、欲望与缺陷；激励事件打破平衡，主角被迫踏出第一步。', share: 25 },
    { name: '第二幕 · 对抗', purpose: '目标受阻、代价递增；中点反转改变对局面的理解，结尾跌入最低谷。', share: 50 },
    { name: '第三幕 · 解决', purpose: '主角用改变后的自己做出最终选择，主线冲突与内心问题一起收束。', share: 25 },
  ] },
  { id: 'kishotenketsu', name: '起承转合', fit: '中文传统叙事、日常与情感向作品', stages: [
    { name: '起', purpose: '引出人物与处境，埋下核心问题。', share: 20 },
    { name: '承', purpose: '顺势发展，加深关系与矛盾。', share: 30 },
    { name: '转', purpose: '意外转折，让既有理解失效。', share: 30 },
    { name: '合', purpose: '在新的理解中收束，回应开篇问题。', share: 20 },
  ] },
  { id: 'hero-journey', name: '英雄之旅', fit: '冒险、奇幻、成长', stages: [
    { name: '平凡世界', purpose: '主角的日常与缺失。', share: 8 },
    { name: '冒险召唤', purpose: '打破日常的邀请或威胁。', share: 5 },
    { name: '拒绝召唤', purpose: '恐惧与牵绊让主角犹豫。', share: 4 },
    { name: '遇见导师', purpose: '获得指引、道具或信念。', share: 5 },
    { name: '跨越门槛', purpose: '进入陌生世界，无法回头。', share: 6 },
    { name: '试炼、盟友与敌人', purpose: '学习新规则，建立关系。', share: 17 },
    { name: '接近洞穴深处', purpose: '为最大的考验做准备。', share: 8 },
    { name: '严峻考验', purpose: '直面死亡或最深恐惧。', share: 10 },
    { name: '获得奖赏', purpose: '赢得宝物、真相或和解。', share: 8 },
    { name: '回归之路', purpose: '追逐与代价，归途并不平坦。', share: 10 },
    { name: '复活', purpose: '最后的考验证明主角已经改变。', share: 12 },
    { name: '携宝而归', purpose: '带着改变回到世界。', share: 7 },
  ] },
  { id: 'save-the-cat', name: '救猫咪 15 节拍', fit: '节奏紧凑的商业类型小说', stages: [
    { name: '开场画面', purpose: '用一幅画面定调。', share: 1 }, { name: '主题陈述', purpose: '有人点出主角要学的一课。', share: 4 },
    { name: '铺垫', purpose: '主角的世界与需要改变之处。', share: 5 }, { name: '催化剂', purpose: '改变一切的事件。', share: 2 },
    { name: '争论', purpose: '主角犹豫要不要行动。', share: 8 }, { name: '进入第二幕', purpose: '主角主动选择进入新世界。', share: 2 },
    { name: 'B 故事', purpose: '承载主题的感情线或关系线。', share: 3 }, { name: '游戏时间', purpose: '兑现题材承诺的乐趣段落。', share: 25 },
    { name: '中点', purpose: '虚假的胜利或失败，赌注升级。', share: 2 }, { name: '坏人逼近', purpose: '外部压力与内部裂痕同时加剧。', share: 20 },
    { name: '一无所有', purpose: '最低点，有东西“死去”。', share: 2 }, { name: '灵魂黑夜', purpose: '主角消化失败，找到真正的答案。', share: 8 },
    { name: '进入第三幕', purpose: 'A、B 故事交汇，得出解法。', share: 2 }, { name: '终局', purpose: '用新的自己执行计划。', share: 15 },
    { name: '终场画面', purpose: '与开场画面对照，显示改变。', share: 1 },
  ] },
  { id: 'web-upgrade', name: '网文升级流', fit: '玄幻、都市、系统等长篇连载', stages: [
    { name: '开篇钩子', purpose: '三章内给出金手指或强烈困境，确立爽点类型。', share: 5 },
    { name: '小循环 · 压制', purpose: '主角被看轻或陷入困局，积累读者期待。', share: 20 },
    { name: '小循环 · 爆发', purpose: '能力或身份兑现，打脸与收获，节奏要快。', share: 20 },
    { name: '地图升级', purpose: '进入更大的舞台，旧对手退场，新规则与新敌人出现。', share: 15 },
    { name: '大高潮', purpose: '多条线汇聚的卷末决战，给出阶段性大回报。', share: 25 },
    { name: '卷尾钩子', purpose: '揭开更大的谜或威胁，引向下一卷。', share: 15 },
  ] },
  { id: 'mystery', name: '悬疑推理', fit: '推理、悬疑、惊悚', stages: [
    { name: '谜面', purpose: '案件或异常出现，给出不可能的细节。', share: 15 },
    { name: '调查', purpose: '公平地交付线索，同时展开嫌疑人。', share: 30 },
    { name: '误导', purpose: '合理但错误的推论，读者与侦探一起被引偏。', share: 20 },
    { name: '危机', purpose: '新的受害或威胁逼近，时间压力升级。', share: 15 },
    { name: '揭示', purpose: '回收线索给出真相，答案必须早已摆在明处。', share: 15 },
    { name: '余波', purpose: '真相对人物的代价。', share: 5 },
  ] },
  { id: 'romance', name: '感情线', fit: '言情、关系驱动的故事', stages: [
    { name: '相遇', purpose: '有火花也有摩擦的初见。', share: 10 },
    { name: '靠近', purpose: '被迫或自愿地相处，看到对方另一面。', share: 25 },
    { name: '阻碍', purpose: '误会、身份或信念的冲突浮出。', share: 20 },
    { name: '分离', purpose: '伤害或选择导致关系破裂。', share: 15 },
    { name: '觉悟', purpose: '各自面对真正的问题并改变。', share: 15 },
    { name: '和解', purpose: '用行动而非言语证明心意。', share: 15 },
  ] },
];

export function outlineTemplate(id: string | undefined): OutlineTemplate | undefined {
  return outlineTemplates.find(template => template.id === id);
}
