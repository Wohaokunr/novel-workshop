import type { StyleProfile } from '../../shared/style-types.js';
import { styleBaseline, styleLint } from '../../shared/style-metrics.js';

/** knowledge: a character's or reader's boundary; constraint: an author rule; style: the author's voice; format: usable output. */
export type CheckKind = 'knowledge' | 'constraint' | 'style' | 'format';
export interface CheckResult { id: string; kind: CheckKind; stage: 'context' | 'output'; label: string; ok: boolean; detail?: string }

function excerpt(text: string, at: number, length: number) {
  const start = Math.max(0, at - 16), end = Math.min(text.length, at + length + 16);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

/** Fails when any marker phrase occurs; the detail quotes where. */
export function absent(id: string, kind: CheckKind, stage: CheckResult['stage'], label: string, text: string, markers: string[]): CheckResult {
  const hits = markers.flatMap(marker => { const at = text.indexOf(marker); return at < 0 ? [] : [`「${marker}」：${excerpt(text, at, marker.length)}`]; });
  return { id, kind, stage, label, ok: !hits.length, ...(hits.length ? { detail: hits.join('；') } : {}) };
}
/** Fails when any required phrase is missing. */
export function present(id: string, kind: CheckKind, stage: CheckResult['stage'], label: string, text: string, needles: string[]): CheckResult {
  const missing = needles.filter(needle => !text.includes(needle));
  return { id, kind, stage, label, ok: !missing.length, ...(missing.length ? { detail: `缺少：${missing.join('、')}` } : {}) };
}

/** Local style statistics against the author's profile: banned words, AI clichés and the wrong narrative person fail; rhythm,
 * dialogue and ornament drift are reported, and fail together only when the lint score drops below 70. */
export function styleCheck(text: string, profile: StyleProfile): CheckResult {
  const lint = styleLint(text, profile, styleBaseline(profile));
  const blocking = lint.issues.filter(issue => issue.kind === 'word' || issue.kind === 'cliche' || issue.kind === 'person');
  const ok = !blocking.length && lint.score >= 70;
  return { id: 'style', kind: 'style', stage: 'output', label: `文风贴合（本地统计 ${lint.score} 分）`, ok,
    ...(lint.issues.length ? { detail: lint.issues.map(issue => `${issue.message}${issue.excerpt ? `（${issue.excerpt}）` : ''}`).join('；') } : {}) };
}

/** Prose a writer returns: plain novel text of a sensible length, no JSON, headings, fences or commentary. */
export function proseFormat(text: string, [min, max]: [number, number]): CheckResult {
  const length = Array.from(text.replace(/\s+/g, '')).length, problems: string[] = [];
  if (length < min) problems.push(`只有 ${length} 字，少于 ${min}`);
  if (length > max) problems.push(`${length} 字，超过 ${max}`);
  if (/```/.test(text)) problems.push('含代码围栏');
  if (/^\s*#/m.test(text)) problems.push('含 Markdown 标题');
  if (/^\s*[{[]/.test(text)) problems.push('像 JSON 而不是正文');
  if (/^(好的|以下是|下面是)/.test(text.trim())) problems.push('以说明性的话开头');
  return { id: 'format', kind: 'format', stage: 'output', label: '输出为可直接使用的正文', ok: !problems.length, ...(problems.length ? { detail: problems.join('；') } : {}) };
}
/** A structured answer with every listed field filled in. */
export function filled(structured: unknown, fields: string[]): CheckResult {
  const value = (structured ?? {}) as Record<string, unknown>;
  const empty = fields.filter(field => Array.isArray(value[field]) ? false : typeof value[field] !== 'string' || !(value[field] as string).trim());
  return { id: 'format', kind: 'format', stage: 'output', label: '结构化结果字段齐全', ok: !empty.length, ...(empty.length ? { detail: `为空：${empty.join('、')}` } : {}) };
}
