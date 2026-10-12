import { personNames, STYLE_SCALES, type StyleProfile, type StyleScaleId } from './style-types.js';

/** Zero-token measurements of prose. Densities are per 1000 characters unless stated otherwise. */
export interface StyleFingerprint {
  chars: number; sentences: number; avgSentence: number; medianSentence: number;
  /** Share of sentences up to 8 / from 40 characters. */
  shortRatio: number; longRatio: number;
  avgParagraph: number; dialogueRatio: number;
  punctuation: { comma: number; period: number; exclaim: number; question: number; ellipsis: number; dash: number };
  simile: number; fourChar: number; adverb: number;
  /** Narration only, so first-person dialogue does not count. */
  firstPerson: number;
  /** AI-cliché hits per 10 000 characters. */
  cliche: number;
}

/** Common machine-prose tics in Chinese fiction. strong: almost always filler; mild: fine in moderation. */
export const AI_CLICHES: Array<{ phrase: string; pattern: RegExp; tier: 'strong' | 'mild' }> = [
  ...['嘴角勾起一抹', '勾起一抹', '嘴角微微上扬', '嘴角上扬', '眼中闪过一丝', '眼底闪过一丝', '闪过一丝', '一抹弧度', '心中一紧', '心头一震', '心中暗道',
    '空气仿佛凝固', '时间仿佛静止', '一股莫名的', '倒吸一口凉气', '瞳孔微缩', '瞳孔骤缩', '命运的齿轮', '五味杂陈', '百感交集', '不容置疑的',
    '仿佛在诉说', '似乎在诉说', '宛如一幅', '交织在一起', '声音不大，却', '带着一丝不易察觉', '一丝不易察觉'].map(phrase => ({ phrase, tier: 'strong' as const })),
  ...['仿佛', '不禁', '不由得', '缓缓地', '淡淡地', '微微一笑', '深吸一口气', '喃喃道', '沉声道', '眸子', '这一刻', '莫名的', '宛如', '与此同时'].map(phrase => ({ phrase, tier: 'mild' as const })),
].map(item => ({ ...item, pattern: new RegExp(item.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') }));

const SIMILE = /像是|好像|仿佛|如同|宛如|犹如|似乎|好似|恍若|宛若|一般/g;
const ADVERB = /[一-龥]{1,3}地(?=[一-龥])/g;
const NOT_ADVERB = /(?:天|大|土|场|当|此|各|本|外|内|墓|基|草|田|山|林|陆|高|平|空|圣|领|阵|营|盆|湿|产|属|境|源|腹|质|心|特|暗|慢慢|渐渐)地$/;
const CJK = /[一-龥A-Za-z0-9]/g;

const countChars = (text: string) => text.match(CJK)?.length ?? 0;
const per = (count: number, chars: number, unit = 1000) => chars ? Math.round(count / chars * unit * 10) / 10 : 0;
const hits = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

export function splitSentences(text: string): string[] {
  return (text.match(/[^。！？!?…\n]+(?:[。！？!?…]+[”」』]?|$)/g) ?? []).map(value => value.trim()).filter(value => countChars(value) > 0);
}
/** Text inside Chinese / Western double quotes or corner brackets. */
export function dialogueSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(/“[^”]*”|「[^」]*」|"[^"\n]*"/g)) spans.push({ start: match.index!, end: match.index! + match[0].length });
  return spans;
}
function narration(text: string): string {
  let result = '', at = 0;
  for (const span of dialogueSpans(text)) { result += text.slice(at, span.start); at = span.end; }
  return result + text.slice(at);
}

export function styleFingerprint(text: string): StyleFingerprint {
  const chars = countChars(text);
  const lengths = splitSentences(text).map(countChars).sort((a, b) => a - b);
  const paragraphs = text.split(/\n+/).map(countChars).filter(Boolean);
  const dialogue = dialogueSpans(text).reduce((sum, span) => sum + countChars(text.slice(span.start, span.end)), 0);
  const told = narration(text), toldChars = countChars(told);
  const adverbs = (text.match(ADVERB) ?? []).filter(value => !NOT_ADVERB.test(value)).length;
  const clauses = text.split(/[，。！？、；：,.!?;:\n“”「」"…—]+/).filter(clause => countChars(clause) === 4 && clause.trim().length === 4).length;
  const cliches = AI_CLICHES.filter(item => item.tier === 'strong').reduce((sum, item) => sum + hits(text, item.pattern), 0);
  const avg = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  return {
    chars, sentences: lengths.length, avgSentence: Math.round(avg * 10) / 10, medianSentence: lengths[Math.floor(lengths.length / 2)] ?? 0,
    shortRatio: lengths.length ? Math.round(lengths.filter(n => n <= 8).length / lengths.length * 100) / 100 : 0,
    longRatio: lengths.length ? Math.round(lengths.filter(n => n >= 40).length / lengths.length * 100) / 100 : 0,
    avgParagraph: paragraphs.length ? Math.round(paragraphs.reduce((a, b) => a + b, 0) / paragraphs.length) : 0,
    dialogueRatio: chars ? Math.round(dialogue / chars * 100) / 100 : 0,
    punctuation: { comma: per(hits(text, /[，,]/g), chars), period: per(hits(text, /[。.]/g), chars), exclaim: per(hits(text, /[！!]/g), chars),
      question: per(hits(text, /[？?]/g), chars), ellipsis: per(hits(text, /…{1,2}|\.{3,}/g), chars), dash: per(hits(text, /—{1,2}/g), chars) },
    simile: per(hits(text, SIMILE), chars), fourChar: per(clauses, chars), adverb: per(adverbs, chars),
    firstPerson: per(hits(told, /我/g), toldChars), cliche: per(cliches, chars, 10_000),
  };
}

/** Fingerprint of the author's own samples, falling back to prose the author wrote themselves. */
export function styleBaseline(profile: StyleProfile, fallback = ''): StyleFingerprint | null {
  const own = profile.samples.filter(sample => sample.source === 'own').map(sample => sample.text).join('\n');
  const text = countChars(own) >= 300 ? own : countChars(`${own}\n${fallback}`) >= 300 ? `${own}\n${fallback}` : '';
  return text ? styleFingerprint(text) : null;
}

const scaleDirectives: Record<StyleScaleId, [string, string, string, string, string]> = {
  distance: ['镜头贴在视角人物身上，读者与他同呼吸，叙述者几乎隐身', '贴近视角人物，偶尔拉开半步交代环境', '叙述距离适中，内外兼顾', '叙述者略有距离感，可以冷静旁观、适度概括', '疏离冷静的旁观视角，像隔着玻璃看人物，少直接抒情'],
  sentence: ['多用短句，一句一个动作或一个念头，少用长从句', '以短句为主，偶尔用一个长句收束段落', '长短句交错，随情绪调节', '偏爱舒展的长句，用逗号铺陈动作与感受', '大量绵长的句子，层层铺陈、一气呵成'],
  ornament: ['白描为主，几乎不用比喻和形容词堆叠，靠准确的名词和动词说话', '克制修辞，比喻少而准', '修辞适度，关键处给一个有画面的比喻', '修辞丰富，意象鲜明，可以连用比喻', '浓墨重彩，意象密集，语言华丽有质感'],
  dialogue: ['对白很少，主要靠叙述推进', '叙述为主，对白点到为止', '叙述与对白均衡', '对白占比较高，用对话推进冲突', '对白驱动，大段交锋，叙述只做必要的动作提示'],
  interiority: ['只写可见的动作、表情和环境，不直接写心理，让读者自己推断', '心理描写克制，多借动作外化情绪', '动作与心理并重', '较多心理活动与内心独白', '深入人物内心，意识流动、反复自省'],
  register: ['口语化、有网感，节奏轻快，可用流行表达', '偏口语，通俗好读', '通俗书面语', '书面化、讲究措辞', '典雅书面，可带文言气息，用词考究'],
  pace: ['节奏紧凑，迅速进入冲突，少铺垫，场面转换利落', '节奏偏快，铺垫简短', '张弛有度', '节奏舒缓，愿意停留在细节与氛围上', '慢节奏，大量停留在感受、环境与回忆中'],
};

/** The profile turned into concrete instructions the writer and stylist share. */
export function styleDirectives(profile: StyleProfile, baseline: StyleFingerprint | null): string[] {
  const directives: string[] = [];
  if (profile.dials.person) directives.push(`叙述人称：${personNames[profile.dials.person]}。`);
  for (const id of STYLE_SCALES) {
    const value = profile.dials[id];
    if (value) directives.push(scaleDirectives[id][value - 1] + '。');
  }
  if (baseline && baseline.chars >= 300) {
    directives.push(`作者范文的实测笔触：平均句长约 ${Math.round(baseline.avgSentence)} 字，短句占 ${Math.round(baseline.shortRatio * 100)}%，对白约占 ${Math.round(baseline.dialogueRatio * 100)}%，平均段落约 ${baseline.avgParagraph} 字，每千字比喻约 ${baseline.simile} 处。写作时向这些数值靠拢。`);
  }
  return directives;
}

export interface StyleIssue { kind: 'word' | 'cliche' | 'rhythm' | 'dialogue' | 'ornament' | 'person'; message: string; excerpt: string; at: number }
export interface StyleLint { issues: StyleIssue[]; score: number; fingerprint: StyleFingerprint }

function excerptAt(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 14), end = Math.min(text.length, at + length + 14);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\n/g, ' ')}${end < text.length ? '…' : ''}`;
}

/** Local check of prose against the profile: banned words, AI clichés and drift from the author's measured voice. */
export function styleLint(text: string, profile: StyleProfile, baseline: StyleFingerprint | null): StyleLint {
  const fingerprint = styleFingerprint(text), issues: StyleIssue[] = [];
  let penalty = 0;
  const flag = (phrase: string, kind: StyleIssue['kind'], message: (count: number) => string, weight: number) => {
    const index = text.indexOf(phrase);
    if (index < 0) return 0;
    const count = text.split(phrase).length - 1;
    issues.push({ kind, message: message(count), excerpt: excerptAt(text, index, phrase.length), at: index });
    penalty += weight * Math.min(count, 3);
    return count;
  };
  for (const word of profile.avoidWords) if (word.trim()) flag(word.trim(), 'word', count => `用了作者禁用的「${word.trim()}」${count > 1 ? ` ${count} 次` : ''}`, 6);
  if (profile.blockAiCliches) {
    const avoided = new Set(profile.avoidWords);
    let mild = 0;
    for (const cliche of AI_CLICHES) {
      if (avoided.has(cliche.phrase) || profile.preferWords.includes(cliche.phrase)) continue;
      if (cliche.tier === 'strong') flag(cliche.phrase, 'cliche', count => `AI 腔套话「${cliche.phrase}」${count > 1 ? ` ${count} 次` : ''}`, 5);
      else mild += hits(text, cliche.pattern);
    }
    if (fingerprint.chars >= 200 && mild / fingerprint.chars * 1000 > 3) {
      const first = AI_CLICHES.filter(item => item.tier === 'mild').map(item => ({ item, at: text.indexOf(item.phrase) })).filter(hit => hit.at >= 0).sort((a, b) => a.at - b.at)[0];
      issues.push({ kind: 'cliche', message: `「仿佛、不禁、缓缓地」这类词偏多（每千字 ${Math.round(mild / fingerprint.chars * 1000 * 10) / 10} 处）`, excerpt: first ? excerptAt(text, first.at, first.item.phrase.length) : '', at: first?.at ?? 0 });
      penalty += 8;
    }
  }
  if (fingerprint.chars >= 300) {
    const sentence = profile.dials.sentence, dialogue = profile.dials.dialogue, ornament = profile.dials.ornament;
    if (baseline && baseline.chars >= 300) {
      const drift = Math.abs(fingerprint.avgSentence - baseline.avgSentence) / Math.max(baseline.avgSentence, 1);
      if (drift > 0.45) { issues.push({ kind: 'rhythm', message: `平均句长 ${Math.round(fingerprint.avgSentence)} 字，作者范文约 ${Math.round(baseline.avgSentence)} 字，节奏明显不同`, excerpt: '', at: 0 }); penalty += 12; }
      if (Math.abs(fingerprint.dialogueRatio - baseline.dialogueRatio) > 0.25) { issues.push({ kind: 'dialogue', message: `对白占 ${Math.round(fingerprint.dialogueRatio * 100)}%，作者范文约 ${Math.round(baseline.dialogueRatio * 100)}%`, excerpt: '', at: 0 }); penalty += 8; }
      if (fingerprint.simile > baseline.simile * 2 + 1.5) { issues.push({ kind: 'ornament', message: `比喻每千字 ${fingerprint.simile} 处，作者范文约 ${baseline.simile} 处`, excerpt: '', at: 0 }); penalty += 8; }
    }
    if (sentence && sentence <= 2 && fingerprint.avgSentence > 24) { issues.push({ kind: 'rhythm', message: `作者要短句，但平均句长 ${Math.round(fingerprint.avgSentence)} 字`, excerpt: '', at: 0 }); penalty += 10; }
    if (sentence && sentence >= 4 && fingerprint.avgSentence < 12) { issues.push({ kind: 'rhythm', message: `作者偏爱长句，但平均句长只有 ${Math.round(fingerprint.avgSentence)} 字`, excerpt: '', at: 0 }); penalty += 10; }
    if (dialogue === 1 && fingerprint.dialogueRatio > 0.35) { issues.push({ kind: 'dialogue', message: `作者希望少对白，本段对白占 ${Math.round(fingerprint.dialogueRatio * 100)}%`, excerpt: '', at: 0 }); penalty += 8; }
    if (dialogue === 5 && fingerprint.dialogueRatio < 0.15) { issues.push({ kind: 'dialogue', message: `作者希望对白驱动，本段对白只占 ${Math.round(fingerprint.dialogueRatio * 100)}%`, excerpt: '', at: 0 }); penalty += 8; }
    if (ornament && ornament <= 2 && fingerprint.simile > 3) { issues.push({ kind: 'ornament', message: `作者偏好白描，本段比喻每千字 ${fingerprint.simile} 处`, excerpt: '', at: 0 }); penalty += 8; }
    const person = profile.dials.person;
    if (person === 'first' && fingerprint.firstPerson < 2) { issues.push({ kind: 'person', message: '作者用第一人称，但叙述中几乎没有「我」', excerpt: '', at: 0 }); penalty += 15; }
    if ((person === 'third-limited' || person === 'third-omniscient') && fingerprint.firstPerson > 8) { issues.push({ kind: 'person', message: '作者用第三人称，但叙述中频繁出现「我」', excerpt: '', at: 0 }); penalty += 15; }
  }
  return { issues: issues.slice(0, 20), score: Math.max(0, 100 - penalty), fingerprint };
}
