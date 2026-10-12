import test from 'node:test';
import assert from 'node:assert/strict';
import { alignPositions, assignedCards, canResizeGroup, cardRect, containingGroup, createdGroup, distributePositions, dissolvedGroup, fitGroups, layeredLayout, movedCards, orderedCards, packGrid, snapPosition, tidyCards, visibleCardId, visibleLinks, type Rect } from '../shared/canvas.js';
import { applyCommands, createWorkspace } from './domain.js';
import type { CanvasCard } from '../shared/types.js';

const note = (id: string, x: number, y: number, groupId?: string): CanvasCard => ({ id, kind: 'note', title: id, content: '', x, y, groupId });
const group = (id: string, x: number, y: number, groupId?: string): CanvasCard => ({ ...note(id, x, y, groupId), kind: 'group', width: 500, height: 400 });

test('嵌套组按父子顺序生成，多选组和成员只平移一次且批量原子保存', () => {
  const cards = [note('leaf', 90, 140, 'inner'), group('inner', 60, 100, 'outer'), note('separate', 700, 30), group('outer', 0, 0)];
  assert.deepEqual(orderedCards(cards).map(card => card.id), ['outer', 'inner', 'leaf', 'separate']);
  const changes = movedCards(cards, [{ id: 'outer', x: 100, y: 50 }, { id: 'leaf', x: 190, y: 190 }, { id: 'separate', x: 740, y: 90 }]);
  assert.deepEqual(changes.map(({ id, x, y }) => ({ id, x, y })), [
    { id: 'leaf', x: 190, y: 190 }, { id: 'inner', x: 160, y: 150 }, { id: 'separate', x: 740, y: 90 }, { id: 'outer', x: 100, y: 50 },
  ]);
  const workspace = applyCommands(createWorkspace('画布移动'), cards.map(value => ({ type: 'putCard', value })));
  const next = applyCommands(workspace, changes.map(value => ({ type: 'putCard', value })));
  assert.deepEqual(next.cards.find(card => card.id === 'leaf'), { ...cards[0], x: 190, y: 190 });
  assert.equal(workspace.cards[0].x, 90, '提交不能修改旧工作区快照');
});

test('建组、移入移出、解散保留成员绝对位置并阻止嵌套成环', () => {
  const cards = [group('outer', 0, 0), note('a', 60, 100, 'outer'), note('b', 310, 100, 'outer')];
  const grouped = createdGroup(cards, ['a', 'b'], 'inner');
  assert.equal(grouped.find(card => card.id === 'inner')?.groupId, 'outer');
  for (const id of ['a', 'b']) {
    assert.equal(grouped.find(card => card.id === id)?.groupId, 'inner');
    assert.equal(grouped.find(card => card.id === id)?.x, cards.find(card => card.id === id)?.x);
    assert.equal(grouped.find(card => card.id === id)?.y, cards.find(card => card.id === id)?.y);
  }
  assert.throws(() => assignedCards(grouped, ['outer'], 'inner'), /子分组/);
  const removed = assignedCards(grouped, ['a'], undefined);
  assert.equal(removed.find(card => card.id === 'a')?.groupId, undefined);
  assert.equal(removed.find(card => card.id === 'a')?.x, 60);
  const dissolved = dissolvedGroup(grouped, 'inner');
  assert.equal(dissolved.some(card => card.id === 'inner'), false);
  assert.equal(dissolved.find(card => card.id === 'b')?.groupId, 'outer');
  assert.equal(dissolved.find(card => card.id === 'b')?.x, 310);
});

test('分组包围实测成员，缩放不能裁掉成员，旧分组尺寸仍有确定默认值', () => {
  const cards = [group('g', 0, 0), note('tall', 80, 100, 'g')];
  const measured = new Map([['tall', { width: 218, height: 500 }]]);
  const fitted = fitGroups(cards, measured), fittedGroup = fitted.find(card => card.id === 'g')!;
  assert.equal(fittedGroup.height, 624);
  assert.equal(fitted.find(card => card.id === 'tall')?.y, 100);
  assert.equal(canResizeGroup(fitted, 'g', { x: 0, y: 0, width: 500, height: 450 }, measured), false);
  assert.equal(canResizeGroup(fitted, 'g', { x: 0, y: 0, width: 500, height: 624 }, measured), true);
  const legacy = { ...group('legacy', 30, 50), width: undefined, height: undefined };
  assert.deepEqual(cardRect(legacy), { x: 30, y: 50, width: 440, height: 330 });
});

test('嵌套折叠只代理外部连线，聚合关联可定位全部原始连线', () => {
  const cards = [{ ...group('outer', 0, 0), collapsed: true }, { ...group('inner', 20, 70, 'outer'), collapsed: true }, note('a', 40, 150, 'inner'), note('b', 280, 150, 'outer'), note('outside', 700, 50)];
  assert.equal(visibleCardId(cards, 'a'), 'outer');
  assert.equal(containingGroup(cards, { x: 50, y: 60 }), undefined, '折叠组不接收创建或拖入');
  const links = [{ id: 'internal', source: 'a', target: 'b' }, { id: 'one', source: 'a', target: 'outside' }, { id: 'two', source: 'b', target: 'outside' }];
  assert.deepEqual(visibleLinks(cards, links), [{ id: 'one', source: 'outer', target: 'outside', linkIds: ['one', 'two'], proxy: true }]);
  assert.deepEqual(visibleLinks(cards.map(card => ({ ...card, collapsed: false })), links).map(link => link.id), ['internal', 'one', 'two']);
  assert.equal(cards[2].x, 40, '折叠不改变成员位置');
});

const overlapping = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('对齐与等距分布按共同边界计算，首尾保持不动', () => {
  const rects = [{ id: 'a', x: 10, y: 0, width: 100, height: 50 }, { id: 'b', x: 200, y: 40, width: 60, height: 80 }, { id: 'c', x: 90, y: 300, width: 120, height: 40 }];
  assert.deepEqual(alignPositions(rects, 'left').map(point => point.x), [10, 10, 10]);
  assert.deepEqual(alignPositions(rects, 'right').map(point => point.x), [160, 200, 140]);
  assert.deepEqual(alignPositions(rects, 'hcenter').map(point => point.x), [85, 105, 75]);
  assert.deepEqual(alignPositions(rects, 'bottom').map(point => point.y), [290, 260, 300]);
  assert.deepEqual(alignPositions(rects, 'top').map(point => point.x), [10, 200, 90], '垂直对齐不改变水平位置');
  const spread = distributePositions(rects, 'y');
  assert.deepEqual(spread.map(point => [point.id, point.y]), [['a', 0], ['b', 135], ['c', 300]]);
  assert.equal(spread.find(point => point.id === 'b')?.x, 200);
  assert.deepEqual(distributePositions(rects.slice(0, 2), 'x').map(point => point.x), [10, 200], '少于三个不分布');
});

test('拖动吸附到其他卡片的边或中线，并给出参考线', () => {
  const others = [{ x: 100, y: 100, width: 200, height: 100 }];
  const snapped = snapPosition({ x: 104, y: 400, width: 200, height: 100 }, others, 6);
  assert.equal(snapped.x, 100);
  assert.equal(snapped.y, 400, '超出阈值不吸附');
  assert.ok(snapped.guides.some(guide => guide.orientation === 'vertical' && guide.position === 100 && guide.from === 100 && guide.to === 500));
  const center = snapPosition({ x: 500, y: 128, width: 100, height: 50 }, others, 6);
  assert.equal(center.y, 125, '中线对齐');
  assert.deepEqual(snapPosition({ x: 900, y: 900, width: 10, height: 10 }, others).guides, []);
});

test('网格装箱保持阅读顺序且互不重叠', () => {
  const rects = Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, x: (6 - i) * 37, y: i * 400, width: 200 + (i % 3) * 40, height: 100 + (i % 2) * 90 }));
  const placed = packGrid(rects, { origin: { x: 50, y: 60 }, gap: 20 });
  assert.deepEqual(placed.map(point => point.id), rects.map(rect => rect.id));
  assert.deepEqual({ x: placed[0]!.x, y: placed[0]!.y }, { x: 50, y: 60 });
  const boxes = placed.map(point => ({ ...rects.find(rect => rect.id === point.id)!, ...point }));
  for (const a of boxes) for (const b of boxes) if (a !== b) assert.equal(overlapping(a, b), false, `${a.id} 与 ${b.id} 重叠`);
});

test('自动整理收紧分组、成员留在组内，关联卡片排在一起', () => {
  const cards = [group('g', 0, 0), note('a', 900, 700, 'g'), note('b', 40, 80, 'g'), note('far', 3000, 40), note('x', 1500, 1500), note('y', 0, 2000)];
  const fitted = fitGroups(cards);
  const tidy = tidyCards(fitted, { links: [{ id: 'l', source: 'far', target: 'y' }], cluster: true });
  const g = tidy.find(card => card.id === 'g')!;
  assert.ok(g.width! < fitted.find(card => card.id === 'g')!.width!, '分组收紧');
  for (const id of ['a', 'b']) {
    const member = cardRect(tidy.find(card => card.id === id)!);
    assert.ok(member.x >= g.x && member.y >= g.y && member.x + member.width <= g.x + g.width! && member.y + member.height <= g.y + g.height!, `${id} 在组内`);
  }
  const roots = tidy.filter(card => !card.groupId).map(card => cardRect(card));
  for (const a of roots) for (const b of roots) if (a !== b) assert.equal(overlapping(a, b), false);
  const far = tidy.find(card => card.id === 'far')!, y = tidy.find(card => card.id === 'y')!, x = tidy.find(card => card.id === 'x')!;
  assert.ok(Math.hypot(far.x - y.x, far.y - y.y) < Math.hypot(far.x - x.x, far.y - x.y) || Math.hypot(far.x - y.x, far.y - y.y) <= 300, '关联卡片相邻');
  assert.deepEqual(tidyCards(cards, { ids: ['x'] }).find(card => card.id === 'far'), cards.find(card => card.id === 'far'), '只整理所选');
});

test('因果分层：因在果上方，同层不重叠，环不会卡死', () => {
  const size = () => ({ width: 200, height: 120 });
  const placed = layeredLayout(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['d', 'a']], size);
  const at = (id: string) => placed.find(point => point.id === id)!;
  assert.ok(at('a').y < at('b').y && at('b').y < at('d').y && at('c').y < at('d').y);
  assert.equal(at('b').y, at('c').y);
  assert.ok(Math.abs(at('b').x - at('c').x) >= 200);
  assert.equal(layeredLayout(['solo'], [], size).length, 1);
});
