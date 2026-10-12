import type { CanvasCard, CanvasLink } from './types.js';

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Rect extends Point, Size {}
export type CardSizes = ReadonlyMap<string, Size>;
export const cardSize: Size = { width: 218, height: 150 };
export const groupSize: Size = { width: 440, height: 330 };
export const collapsedGroupSize: Size = { width: 218, height: 88 };
const padding = 24;
const heading = 64;

export function cardRect(card: CanvasCard, sizes?: CardSizes, expanded = false): Rect {
  const size = card.kind === 'group'
    ? card.collapsed && !expanded ? collapsedGroupSize : { width: card.width ?? groupSize.width, height: card.height ?? groupSize.height }
    : sizes?.get(card.id) ?? cardSize;
  return { x: card.x, y: card.y, ...size };
}

export function isDescendant(cards: readonly CanvasCard[], id: string, ancestorId: string): boolean {
  let parent = cards.find(card => card.id === id)?.groupId;
  while (parent) {
    if (parent === ancestorId) return true;
    parent = cards.find(card => card.id === parent)?.groupId;
  }
  return false;
}

export function rootCards(cards: readonly CanvasCard[], ids: readonly string[]): CanvasCard[] {
  const selected = new Set(ids);
  return cards.filter(card => selected.has(card.id) && !ids.some(id => id !== card.id && isDescendant(cards, card.id, id)));
}

/** React Flow requires every parent to precede its children. */
export function orderedCards(cards: readonly CanvasCard[]): CanvasCard[] {
  const result: CanvasCard[] = [];
  const added = new Set<string>();
  const add = (card: CanvasCard) => {
    if (added.has(card.id)) return;
    const parent = cards.find(item => item.id === card.groupId);
    if (parent) add(parent);
    added.add(card.id);
    result.push(card);
  };
  cards.forEach(add);
  return result;
}

/** Return the outermost collapsed ancestor, or the card itself. */
export function visibleCardId(cards: readonly CanvasCard[], id: string): string {
  let visible = id;
  let parent = cards.find(card => card.id === id)?.groupId;
  while (parent) {
    const group = cards.find(card => card.id === parent);
    if (group?.collapsed) visible = group.id;
    parent = group?.groupId;
  }
  return visible;
}

export interface CanvasEdge { id: string; source: string; target: string; linkIds: string[]; proxy: boolean }
export function visibleLinks(cards: readonly CanvasCard[], links: readonly CanvasLink[]): CanvasEdge[] {
  const result = new Map<string, CanvasEdge>();
  for (const link of links) {
    const source = visibleCardId(cards, link.source), target = visibleCardId(cards, link.target);
    if (source === target) continue;
    const key = JSON.stringify([source, target]);
    const existing = result.get(key);
    if (existing) { existing.linkIds.push(link.id); existing.proxy ||= source !== link.source || target !== link.target; }
    else result.set(key, { id: link.id, source, target, linkIds: [link.id], proxy: source !== link.source || target !== link.target });
  }
  return [...result.values()];
}

/** Absolute positions are persisted; a selected group's descendants move exactly once. */
export function movedCards(cards: readonly CanvasCard[], positions: readonly (Point & { id: string })[]): CanvasCard[] {
  const roots = rootCards(cards, positions.map(position => position.id));
  const deltas = new Map(roots.map(card => {
    const point = positions.find(position => position.id === card.id)!;
    return [card.id, { x: point.x - card.x, y: point.y - card.y }];
  }));
  return cards.flatMap(card => {
    const root = roots.find(item => item.id === card.id || isDescendant(cards, card.id, item.id));
    const delta = root && deltas.get(root.id);
    return delta && (delta.x || delta.y) ? [{ ...card, x: card.x + delta.x, y: card.y + delta.y }] : [];
  });
}

export function containingGroup(cards: readonly CanvasCard[], point: Point, excludedIds: readonly string[] = [], sizes?: CardSizes): CanvasCard | undefined {
  const depth = (card: CanvasCard) => {
    let result = 0, parent = card.groupId;
    while (parent) { result++; parent = cards.find(item => item.id === parent)?.groupId; }
    return result;
  };
  return cards.filter(card => card.kind === 'group').sort((a, b) => depth(b) - depth(a) || cardRect(a, sizes).width * cardRect(a, sizes).height - cardRect(b, sizes).width * cardRect(b, sizes).height).find(card => {
    if (card.collapsed || excludedIds.some(id => id === card.id || isDescendant(cards, card.id, id))) return false;
    if (visibleCardId(cards, card.id) !== card.id) return false;
    const rect = cardRect(card, sizes);
    return point.x >= rect.x && point.y >= rect.y && point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
  });
}

export function enclosingRect(cards: readonly CanvasCard[], sizes?: CardSizes): Rect {
  const rects = cards.map(card => cardRect(card, sizes, true));
  const x = Math.min(...rects.map(rect => rect.x)) - padding;
  const y = Math.min(...rects.map(rect => rect.y)) - heading;
  return {
    x, y,
    width: Math.max(280, Math.max(...rects.map(rect => rect.x + rect.width)) + padding - x),
    height: Math.max(160, Math.max(...rects.map(rect => rect.y + rect.height)) + padding - y),
  };
}

/** Expand ancestors around members without moving any member's absolute position. */
export function fitGroups(cards: readonly CanvasCard[], sizes?: CardSizes): CanvasCard[] {
  const next = cards.map(card => ({ ...card }));
  for (const group of orderedCards(next).reverse().filter(card => card.kind === 'group')) {
    const members = next.filter(card => card.groupId === group.id);
    if (!members.length) continue;
    const bounds = enclosingRect(members, sizes), current = cardRect(group, sizes, true);
    const x = Math.min(current.x, bounds.x), y = Math.min(current.y, bounds.y);
    Object.assign(group, { x, y, width: Math.max(current.x + current.width, bounds.x + bounds.width) - x, height: Math.max(current.y + current.height, bounds.y + bounds.height) - y });
  }
  return next;
}

export function assignedCards(cards: readonly CanvasCard[], ids: readonly string[], groupId: string | undefined, sizes?: CardSizes): CanvasCard[] {
  const roots = rootCards(cards, ids);
  if (groupId && roots.some(card => card.id === groupId || isDescendant(cards, groupId, card.id))) throw new Error('不能将分组移入自身或其子分组。');
  const selected = new Set(roots.map(card => card.id));
  return fitGroups(cards.map(card => selected.has(card.id) ? { ...card, groupId } : card), sizes);
}

export function createdGroup(cards: readonly CanvasCard[], ids: readonly string[], id: string, sizes?: CardSizes): CanvasCard[] {
  const members = rootCards(cards, ids);
  if (!members.length) return [...cards];
  const groupId = members.every(card => card.groupId === members[0].groupId) ? members[0].groupId : undefined;
  const bounds = enclosingRect(members, sizes);
  const group: CanvasCard = { id, kind: 'group', title: '新的分组', content: '', groupId, ...bounds };
  return assignedCards([...cards, group], members.map(card => card.id), id, sizes);
}

export function dissolvedGroup(cards: readonly CanvasCard[], id: string): CanvasCard[] {
  const group = cards.find(card => card.id === id);
  return cards.filter(card => card.id !== id).map(card => card.groupId === id ? { ...card, groupId: group?.groupId } : card);
}

export function canResizeGroup(cards: readonly CanvasCard[], id: string, rect: Rect, sizes?: CardSizes): boolean {
  const members = cards.filter(card => card.groupId === id);
  if (!members.length) return true;
  const bounds = enclosingRect(members, sizes);
  return rect.x <= bounds.x && rect.y <= bounds.y && rect.x + rect.width >= bounds.x + bounds.width && rect.y + rect.height >= bounds.y + bounds.height;
}

/**
 * Give new cards free positions without overlapping existing ones (mutates x/y).
 * radial: radiate around the anchor like a mind map, later calls taking the next free slots;
 * otherwise a tidy grid beside the anchor or around center.
 */
export function placeCards(existing: readonly CanvasCard[], newCards: readonly CanvasCard[], options: { anchor?: CanvasCard; center: Point; radial: boolean }): void {
  const { anchor, center } = options;
  const count = newCards.length;
  if (!count) return;
  const gap = 24;
  const taken = existing.map(card => cardRect(card));
  const overlaps = (x: number, y: number) => taken.some(rect => x < rect.x + rect.width + gap && x + cardSize.width + gap > rect.x && y < rect.y + rect.height + gap && y + cardSize.height + gap > rect.y);
  const claim = (card: CanvasCard, x: number, y: number) => { card.x = x; card.y = y; taken.push({ x, y, ...cardSize }); };
  if (anchor && options.radial) {
    const slots: Point[] = [];
    for (let ring = 0; ring < 6; ring++) {
      const radius = 300 + ring * 220, steps = 10 + ring * 4;
      for (let step = 0; step < steps; step++) {
        const angle = -Math.PI / 2 + (step / steps) * Math.PI * 2;
        slots.push({ x: center.x + Math.cos(angle) * radius - cardSize.width / 2, y: center.y + Math.sin(angle) * radius * 0.75 - cardSize.height / 2 });
      }
    }
    for (const card of newCards) {
      const slot = slots.find(item => !overlaps(item.x, item.y)) ?? slots[slots.length - 1]!;
      claim(card, slot.x, slot.y);
    }
    return;
  }
  const columns = Math.min(3, count), gapX = cardSize.width + 32, gapY = cardSize.height + 32;
  const width = columns * gapX - 32, height = Math.ceil(count / columns) * gapY - 32;
  const anchorRect = anchor ? cardRect(anchor) : undefined;
  let originX = anchorRect ? anchorRect.x + anchorRect.width + 160 : center.x - width / 2;
  let originY = anchorRect ? anchorRect.y - 40 : center.y - cardSize.height / 2;
  const blocked = (x: number, y: number) => taken.some(rect => x - 48 < rect.x + rect.width && x + width + 48 > rect.x && y - 88 < rect.y + rect.height && y + height + 48 > rect.y);
  for (let tries = 0; tries < 60 && blocked(originX, originY); tries++) {
    if (tries % 2) originX += 120; else originY += 120;
  }
  newCards.forEach((card, index) => claim(card, originX + (index % columns) * gapX, originY + Math.floor(index / columns) * gapY));
}

/* ---------- alignment, snapping and automatic layout ---------- */

export interface IdRect extends Rect { id: string }
export type Placement = Point & { id: string };
export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** Line up rects along one edge or center of their common bounds. */
export function alignPositions(rects: readonly IdRect[], mode: AlignMode): Placement[] {
  if (!rects.length) return [];
  const left = Math.min(...rects.map(rect => rect.x)), right = Math.max(...rects.map(rect => rect.x + rect.width));
  const top = Math.min(...rects.map(rect => rect.y)), bottom = Math.max(...rects.map(rect => rect.y + rect.height));
  return rects.map(rect => ({
    id: rect.id,
    x: mode === 'left' ? left : mode === 'right' ? right - rect.width : mode === 'hcenter' ? (left + right) / 2 - rect.width / 2 : rect.x,
    y: mode === 'top' ? top : mode === 'bottom' ? bottom - rect.height : mode === 'vcenter' ? (top + bottom) / 2 - rect.height / 2 : rect.y,
  }));
}

/** Keep the outermost rects in place and space the rest with equal gaps along an axis. */
export function distributePositions(rects: readonly IdRect[], axis: 'x' | 'y'): Placement[] {
  const size = axis === 'x' ? 'width' : 'height';
  const sorted = [...rects].sort((a, b) => a[axis] - b[axis]);
  if (sorted.length < 3) return sorted.map(({ id, x, y }) => ({ id, x, y }));
  const first = sorted[0]!, last = sorted.at(-1)!;
  const span = last[axis] + last[size] - first[axis];
  const gap = (span - sorted.reduce((sum, rect) => sum + rect[size], 0)) / (sorted.length - 1);
  let cursor = first[axis];
  return sorted.map(rect => {
    const placed = { id: rect.id, x: rect.x, y: rect.y, [axis]: cursor };
    cursor += rect[size] + gap;
    return placed;
  });
}

export interface AlignGuide { orientation: 'vertical' | 'horizontal'; position: number; from: number; to: number }
/** Snap a moving rect to the edges or centers of others within threshold, returning the guides to draw. */
export function snapPosition(moving: Rect, others: readonly Rect[], threshold = 6): Point & { guides: AlignGuide[] } {
  const axis = (start: 'x' | 'y', size: 'width' | 'height') => {
    let best: { delta: number; line: number } | undefined;
    const own = [moving[start], moving[start] + moving[size] / 2, moving[start] + moving[size]];
    for (const other of others) {
      for (const line of [other[start], other[start] + other[size] / 2, other[start] + other[size]]) {
        for (const edge of own) {
          const delta = line - edge;
          if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, line };
        }
      }
    }
    return best?.delta ?? 0;
  };
  const x = moving.x + axis('x', 'width'), y = moving.y + axis('y', 'height');
  const placed = { ...moving, x, y };
  const guides: AlignGuide[] = [];
  const collect = (orientation: AlignGuide['orientation'], start: 'x' | 'y', size: 'width' | 'height', cross: 'x' | 'y', crossSize: 'width' | 'height') => {
    const own = [placed[start], placed[start] + placed[size] / 2, placed[start] + placed[size]];
    const lines = new Map<number, { from: number; to: number }>();
    for (const other of others) {
      for (const line of [other[start], other[start] + other[size] / 2, other[start] + other[size]]) {
        if (!own.some(edge => Math.abs(edge - line) < .5)) continue;
        const key = Math.round(line * 2) / 2, span = lines.get(key);
        const from = Math.min(placed[cross], other[cross]), to = Math.max(placed[cross] + placed[crossSize], other[cross] + other[crossSize]);
        lines.set(key, span ? { from: Math.min(span.from, from), to: Math.max(span.to, to) } : { from, to });
      }
    }
    for (const [position, span] of lines) guides.push({ orientation, position, ...span });
  };
  if (x !== moving.x || others.length) collect('vertical', 'x', 'width', 'y', 'height');
  if (y !== moving.y || others.length) collect('horizontal', 'y', 'height', 'x', 'width');
  return { x, y, guides };
}

/** Rects in reading order: rows by vertical overlap, then left to right. */
function readingOrder<T extends Rect>(rects: readonly T[]): T[] {
  const rows: T[][] = [];
  for (const rect of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find(items => items.some(item => rect.y < item.y + item.height * .5 && item.y < rect.y + rect.height * .5));
    if (row) row.push(rect); else rows.push([rect]);
  }
  return rows.flatMap(row => row.sort((a, b) => a.x - b.x));
}

/** Shelf-pack rects into rows from origin, keeping their rough reading order. */
export function packGrid(rects: readonly IdRect[], options: { origin: Point; gap?: number; maxRowWidth?: number; ordered?: boolean }): Placement[] {
  if (!rects.length) return [];
  const gap = options.gap ?? 32;
  const items = options.ordered ? [...rects] : readingOrder(rects);
  const area = items.reduce((sum, rect) => sum + (rect.width + gap) * (rect.height + gap), 0);
  const limit = options.maxRowWidth ?? Math.max(Math.sqrt(area) * 2, ...items.map(rect => rect.width));
  const result: Placement[] = [];
  let x = 0, y = 0, rowHeight = 0;
  for (const rect of items) {
    if (x > 0 && x + rect.width > limit) { x = 0; y += rowHeight + gap; rowHeight = 0; }
    result.push({ id: rect.id, x: options.origin.x + x, y: options.origin.y + y });
    x += rect.width + gap; rowHeight = Math.max(rowHeight, rect.height);
  }
  return result;
}

function translated(cards: CanvasCard[], id: string, dx: number, dy: number): void {
  if (!dx && !dy) return;
  for (const card of cards) if (card.id === id || isDescendant(cards, card.id, id)) { card.x += dx; card.y += dy; }
}

/** Groups of ids connected by links, in the order their first member appears. */
function components(ids: readonly string[], edges: ReadonlyArray<readonly [string, string]>): string[][] {
  const parent = new Map(ids.map(id => [id, id]));
  const find = (id: string): string => { const up = parent.get(id)!; if (up === id) return id; const root = find(up); parent.set(id, root); return root; };
  for (const [a, b] of edges) if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  const result = new Map<string, string[]>();
  for (const id of ids) { const root = find(id); result.set(root, [...(result.get(root) ?? []), id]); }
  return [...result.values()];
}

/**
 * Tidy the canvas: pack each group's members (deepest first) and shrink the group around them,
 * then pack the top level. With cluster, linked cards are packed into blocks that stay together.
 * ids limits the top level to those cards (and their contents).
 */
export function tidyCards(cards: readonly CanvasCard[], options: { sizes?: CardSizes; links?: readonly CanvasLink[]; ids?: readonly string[]; cluster?: boolean } = {}): CanvasCard[] {
  const { sizes, links = [] } = options;
  const next = cards.map(card => ({ ...card }));
  const scope = options.ids ? rootCards(next, options.ids) : next.filter(card => !card.groupId);
  const inScope = (card: CanvasCard) => scope.some(root => root.id === card.id || isDescendant(next, card.id, root.id));
  const rectOf = (card: CanvasCard, expanded: boolean): IdRect => ({ id: card.id, ...cardRect(card, sizes, expanded) });
  /** Linked descendants count as links between the cards that contain them. */
  const owner = (id: string, siblings: ReadonlySet<string>) => {
    let current: string | undefined = id;
    while (current && !siblings.has(current)) current = next.find(card => card.id === current)?.groupId;
    return current;
  };
  const pack = (members: CanvasCard[], origin: Point, expanded: boolean) => {
    const ids = new Set(members.map(card => card.id));
    const edges = options.cluster ? links.flatMap(link => { const a = owner(link.source, ids), b = owner(link.target, ids); return a && b && a !== b ? [[a, b] as const] : []; }) : [];
    const ordered = readingOrder(members.map(card => rectOf(card, expanded)));
    const blocks = options.cluster && edges.length ? components(ordered.map(rect => rect.id), edges) : [ordered.map(rect => rect.id)];
    if (blocks.length === 1) {
      for (const point of packGrid(ordered, { origin })) { const card = next.find(item => item.id === point.id)!; translated(next, card.id, point.x - card.x, point.y - card.y); }
      return;
    }
    // Pack each cluster on its own, then pack the clusters as blocks.
    const local = blocks.map(block => {
      const placed = packGrid(ordered.filter(rect => block.includes(rect.id)), { origin: { x: 0, y: 0 }, ordered: true, gap: 28 });
      const width = Math.max(...placed.map(point => point.x + rectOf(next.find(card => card.id === point.id)!, expanded).width));
      const height = Math.max(...placed.map(point => point.y + rectOf(next.find(card => card.id === point.id)!, expanded).height));
      return { id: block[0]!, placed, width, height, x: 0, y: 0 };
    });
    for (const point of packGrid(local, { origin, gap: 72, ordered: true })) {
      for (const item of local.find(block => block.id === point.id)!.placed) {
        const card = next.find(value => value.id === item.id)!;
        translated(next, card.id, point.x + item.x - card.x, point.y + item.y - card.y);
      }
    }
  };
  for (const group of orderedCards(next).reverse().filter(card => card.kind === 'group' && inScope(card))) {
    const members = next.filter(card => card.groupId === group.id);
    if (!members.length) continue;
    pack(members, { x: group.x + padding, y: group.y + heading }, true);
    const bounds = enclosingRect(members, sizes);
    Object.assign(group, { width: bounds.width, height: bounds.height });
  }
  if (scope.length) {
    const roots = scope.map(card => next.find(item => item.id === card.id)!);
    const rects = roots.map(card => rectOf(card, false));
    pack(roots, { x: Math.min(...rects.map(rect => rect.x)), y: Math.min(...rects.map(rect => rect.y)) }, false);
  }
  return fitGroups(next, sizes);
}

/**
 * Layered top-to-bottom layout of a directed graph: causes above effects.
 * Longest-path layers, barycentric ordering to reduce crossings; back edges of cycles are ignored.
 */
export function layeredLayout(ids: readonly string[], edges: ReadonlyArray<readonly [string, string]>, sizeOf: (id: string) => Size, options: { origin?: Point; gapX?: number; gapY?: number } = {}): Placement[] {
  const { origin = { x: 40, y: 40 }, gapX = 56, gapY = 96 } = options;
  const known = new Set(ids);
  const out = new Map(ids.map(id => [id, [] as string[]]));
  const state = new Map<string, 'visiting' | 'done'>();
  const forward: Array<[string, string]> = [];
  const visit = (id: string) => {
    state.set(id, 'visiting');
    for (const [from, to] of edges) {
      if (from !== id || !known.has(to) || from === to) continue;
      if (state.get(to) === 'visiting') continue; // back edge: ignore to break the cycle
      forward.push([from, to]); out.get(from)!.push(to);
      if (!state.has(to)) visit(to);
    }
    state.set(id, 'done');
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  const incoming = new Map(ids.map(id => [id, forward.filter(([, to]) => to === id).map(([from]) => from)]));
  const layer = new Map<string, number>();
  const depth = (id: string): number => {
    if (layer.has(id)) return layer.get(id)!;
    const value = Math.max(-1, ...incoming.get(id)!.map(depth)) + 1;
    layer.set(id, value); return value;
  };
  ids.forEach(depth);
  const layers: string[][] = [];
  for (const id of ids) (layers[layer.get(id)!] ??= []).push(id);
  const index = new Map<string, number>();
  const reindex = () => layers.forEach(row => row.forEach((id, i) => index.set(id, i)));
  reindex();
  const sweep = (row: string[], neighbors: (id: string) => string[]) => {
    const weight = new Map(row.map((id, i) => { const near = neighbors(id).filter(item => index.has(item)); return [id, near.length ? near.reduce((sum, item) => sum + index.get(item)!, 0) / near.length : i]; }));
    row.sort((a, b) => weight.get(a)! - weight.get(b)!);
  };
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < layers.length; i++) { sweep(layers[i]!, id => incoming.get(id)!.filter(item => layer.get(item) === i - 1)); reindex(); }
    for (let i = layers.length - 2; i >= 0; i--) { sweep(layers[i]!, id => out.get(id)!.filter(item => layer.get(item) === i + 1)); reindex(); }
  }
  const widths = layers.map(row => row.reduce((sum, id) => sum + sizeOf(id).width, 0) + gapX * (row.length - 1));
  const widest = Math.max(0, ...widths);
  const result: Placement[] = [];
  let y = origin.y;
  layers.forEach((row, i) => {
    let x = origin.x + (widest - widths[i]!) / 2;
    for (const id of row) { result.push({ id, x, y }); x += sizeOf(id).width + gapX; }
    y += Math.max(...row.map(id => sizeOf(id).height)) + gapY;
  });
  return result;
}
