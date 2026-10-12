import type { ReactNode } from 'react';

/**
 * Small, safe Markdown subset for model replies: headings, lists, quotes, rules,
 * **bold**, *italic* and `code`. Builds React elements; never injects HTML.
 */
type Block =
  | { kind: 'p' | 'quote'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'hr' };

function blocks(source: string): Block[] {
  const result: Block[] = [];
  const last = () => result.at(-1);
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { result.push({ kind: 'p', lines: [] }); continue; }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.、)]\s*(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    const previous = last();
    if (heading) result.push({ kind: 'h', level: heading[1]!.length, text: heading[2]! });
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) result.push({ kind: 'hr' });
    else if (bullet) previous?.kind === 'ul' ? previous.items.push(bullet[1]!) : result.push({ kind: 'ul', items: [bullet[1]!] });
    else if (numbered) previous?.kind === 'ol' ? previous.items.push(numbered[1]!) : result.push({ kind: 'ol', items: [numbered[1]!] });
    else if (quote) previous?.kind === 'quote' ? previous.lines.push(quote[1]!) : result.push({ kind: 'quote', lines: [quote[1]!] });
    else if (previous?.kind === 'p' && previous.lines.length) previous.lines.push(line);
    else if ((previous?.kind === 'ul' || previous?.kind === 'ol') && /^\s{2,}/.test(raw)) previous.items[previous.items.length - 1] += ` ${line.trim()}`;
    else result.push({ kind: 'p', lines: [line] });
  }
  return result.filter(block => block.kind !== 'p' || block.lines.length);
}

/** Inline marks; an unclosed mark (common mid-stream) renders as plain text. */
function inline(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s][^*]*)\*|「([^」]{1,40})」)/g;
  let index = 0, match: RegExpExecArray | null, n = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > index) nodes.push(text.slice(index, match.index));
    const id = `${key}-${n++}`;
    if (match[2] !== undefined) nodes.push(<strong key={id}>{match[2]}</strong>);
    else if (match[3] !== undefined) nodes.push(<code key={id}>{match[3]}</code>);
    else if (match[4] !== undefined) nodes.push(<em key={id}>{match[4]}</em>);
    else nodes.push(<span key={id} className="md-quote-mark">「{match[5]}」</span>);
    index = match.index + match[0].length;
  }
  if (index < text.length) nodes.push(text.slice(index).replace(/\*\*(?=[^*]*$)/, ''));
  return nodes;
}

export default function Markdown({ text, streaming = false, className = '' }: { text: string; streaming?: boolean; className?: string }) {
  const parsed = blocks(text);
  const caret = streaming ? <i className="md-caret" aria-hidden="true"/> : null;
  return <div className={`md ${streaming ? 'streaming' : ''} ${className}`}>
    {parsed.map((block, i) => {
      const end = i === parsed.length - 1 ? caret : null;
      const key = `b${i}`;
      switch (block.kind) {
        case 'h': { const Tag = (['h3', 'h4', 'h5'] as const)[block.level - 1]!; return <Tag key={key}>{inline(block.text, key)}{end}</Tag>; }
        case 'hr': return <hr key={key}/>;
        case 'ul': case 'ol': { const Tag = block.kind; return <Tag key={key}>{block.items.map((item, j) => <li key={j}>{inline(item, `${key}-${j}`)}{j === block.items.length - 1 && end}</li>)}</Tag>; }
        case 'quote': return <blockquote key={key}>{block.lines.map((line, j) => <p key={j}>{inline(line, `${key}-${j}`)}{j === block.lines.length - 1 && end}</p>)}</blockquote>;
        default: return <p key={key}>{block.lines.flatMap((line, j) => j ? [<br key={`br${j}`}/>, ...inline(line, `${key}-${j}`)] : inline(line, `${key}-${j}`))}{end}</p>;
      }
    })}
    {!parsed.length && caret}
  </div>;
}
