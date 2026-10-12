export type DiffKind = 'same' | 'add' | 'del';
export interface DiffPart { kind: DiffKind; text: string }

/** Upper bound of LCS table cells; larger blocks degrade to whole-block replacement. */
const MAX_CELLS = 2_000_000;

/** Split prose into sentence-like tokens while keeping delimiters, so joined tokens equal the input. */
export function sentences(text: string): string[] {
  return text.match(/[^。！？!?；;…\n]*(?:[。！？!?；;…]+[”」』"')）]*|\n+|$)/g)?.filter(Boolean) ?? [];
}

function lcs<T>(a: readonly T[], b: readonly T[]): Array<[DiffKind, T]> | null {
  const n = a.length, m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;
  const width = m + 1, table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  const ops: Array<[DiffKind, T]> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push(['same', a[i]]); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) ops.push(['del', a[i++]]);
    else ops.push(['add', b[j++]]);
  }
  while (i < n) ops.push(['del', a[i++]]);
  while (j < m) ops.push(['add', b[j++]]);
  return ops;
}

function push(parts: DiffPart[], kind: DiffKind, text: string) {
  if (!text) return;
  const last = parts.at(-1);
  if (last?.kind === kind) last.text += text; else parts.push({ kind, text });
}

function characters(before: string, after: string, parts: DiffPart[]) {
  const a = [...before], b = [...after];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  push(parts, 'same', a.slice(0, start).join(''));
  const middleA = a.slice(start, a.length - end), middleB = b.slice(start, b.length - end);
  const ops = lcs(middleA, middleB);
  if (ops) for (const [kind, char] of ops) push(parts, kind, char);
  else { push(parts, 'del', middleA.join('')); push(parts, 'add', middleB.join('')); }
  push(parts, 'same', a.slice(a.length - end).join(''));
}

/** Readable diff for Chinese prose: aligns sentences first, then refines replaced sentences by character. */
export function diffText(before: string, after: string): DiffPart[] {
  const parts: DiffPart[] = [];
  if (before === after) { push(parts, 'same', before); return parts; }
  const ops = lcs(sentences(before), sentences(after));
  if (!ops) { characters(before, after, parts); return parts; }
  let removed = '', added = '';
  const flush = () => {
    if (removed && added) characters(removed, added, parts);
    else { push(parts, 'del', removed); push(parts, 'add', added); }
    removed = ''; added = '';
  };
  for (const [kind, text] of ops) {
    if (kind === 'del') removed += text;
    else if (kind === 'add') added += text;
    else { flush(); push(parts, 'same', text); }
  }
  flush();
  return parts;
}

export function diffStats(parts: readonly DiffPart[]) {
  let added = 0, removed = 0;
  for (const part of parts) {
    const length = part.text.replace(/\s/g, '').length;
    if (part.kind === 'add') added += length; else if (part.kind === 'del') removed += length;
  }
  return { added, removed };
}
