import test from 'node:test';
import assert from 'node:assert/strict';
import { assignedCards, canResizeGroup, cardRect, containingGroup, createdGroup, dissolvedGroup, fitGroups, movedCards, orderedCards, visibleCardId, visibleLinks } from '../shared/canvas.js';
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
