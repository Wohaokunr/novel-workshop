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
