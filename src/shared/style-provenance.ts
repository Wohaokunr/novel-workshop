import type { OperationBatch, Workspace } from './types.js';
import type { StyleEditPair } from './style-types.js';
import { AI_CLICHES } from './style-metrics.js';
import { passageLabel } from './structure.js';
import { diffText } from './text-diff.js';

const HUNK_CHARS = 300;
const CONTEXT_CHARS = 16;

const textOf = (value: unknown) => (value as { text?: string } | undefined)?.text ?? '';
/** Changed spans with a little surrounding text, so a model sees what was replaced by what. */
export function editHunks(before: string, after: string): Array<{ before: string; after: string }> {
  const hunks: Array<{ before: string; after: string }> = [];
  let left = '', removed = '', added = '', open = false;
  const flush = (right: string) => {
    if (!open) return;
    const context = right.slice(0, CONTEXT_CHARS);
    hunks.push({ before: `${left}${removed}${context}`.slice(-HUNK_CHARS), after: `${left}${added}${context}`.slice(-HUNK_CHARS) });
    removed = ''; added = ''; open = false;
  };
  for (const part of diffText(before, after)) {
    if (part.kind === 'same') { flush(part.text); left = part.text.slice(-CONTEXT_CHARS); continue; }
    open = true;
    if (part.kind === 'del') removed += part.text; else added += part.text;
  }
  flush('');
  // Whitespace-only hunks say nothing about voice.
  return hunks.filter(hunk => hunk.before.replace(/\s/g, '') !== hunk.after.replace(/\s/g, ''));
}

/**
 * AI-written prose the author later edited by hand, from the operation history: zero tokens.
 * history is newest first, as NovelStore.history returns it.
 */
export function editPairs(project: Workspace, history: OperationBatch[]): StyleEditPair[] {
  const drafts = new Map<string, { batchId: string; text: string; at: string; edited: boolean }>();
  for (const batch of [...history].reverse()) {
    if (batch.undone) continue;
    for (const change of batch.changes) {
      if (change.collection !== 'passages' || textOf(change.before) === textOf(change.after)) continue;
      if (change.after === undefined) { drafts.delete(change.key); continue; }
      if (batch.actor === 'ai') drafts.set(change.key, { batchId: batch.id, text: textOf(change.after), at: batch.at, edited: false });
      else { const draft = drafts.get(change.key); if (draft) draft.edited = true; }
    }
  }
  const pairs: StyleEditPair[] = [];
  for (const [passageId, draft] of drafts) {
    const passage = project.passages.find(item => item.id === passageId);
    if (!draft.edited || !passage || !draft.text.trim() || passage.text === draft.text) continue;
    const hunks = editHunks(draft.text, passage.text);
    if (hunks.length) pairs.push({ key: `edit:${draft.batchId}:${passageId}`, passageId, title: passageLabel(project, passage), hunks, at: draft.at });
  }
  return pairs.sort((a, b) => a.at.localeCompare(b.at));
}

/** Passages whose current text the author wrote rather than accepted from AI. */
export function authoredPassages(project: Workspace, history: OperationBatch[]): Set<string> {
  const last = new Map<string, 'human' | 'ai'>();
  for (const batch of [...history].reverse()) {
    if (batch.undone) continue;
    for (const change of batch.changes) if (change.collection === 'passages' && change.after !== undefined && textOf(change.before) !== textOf(change.after)) last.set(change.key, batch.actor);
  }
  return new Set(project.passages.filter(passage => passage.text.trim() && last.get(passage.id) !== 'ai').map(passage => passage.id));
}

/** Clichés, "X地" adverbs and speech tags the author keeps deleting. */
export function deletedWords(pairs: StyleEditPair[]): Array<{ word: string; count: number }> {
  const counts = new Map<string, number>();
  const candidates = (text: string) => [...AI_CLICHES.map(item => item.phrase).filter(phrase => text.includes(phrase)),
    ...(text.match(/[一-龥]{2}地(?=[一-龥])/g) ?? []), ...(text.match(/[一-龥]{1,2}道(?=[：:，,“"])/g) ?? [])];
  for (const pair of pairs) for (const hunk of pair.hunks) {
    for (const word of new Set(candidates(hunk.before))) {
      const removed = hunk.before.split(word).length - hunk.after.split(word).length;
      if (removed > 0) counts.set(word, (counts.get(word) ?? 0) + removed);
    }
  }
  // Prefer the longer phrase when a shorter one only counts inside it.
  const words = [...counts].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  return words.filter(([word, count]) => !words.some(([other, more]) => other !== word && other.includes(word) && more >= count))
    .slice(0, 12).map(([word, count]) => ({ word, count }));
}

