import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommands, createWorkspace } from './domain.js';
import { nextStage, storyFlow, storyGaps } from '../shared/story-flow.js';

test('创作流程：空作品从简述开始且信息稀少，逐步推进下一步', () => {
  const blank = createWorkspace('空白');
  const gaps = storyGaps(blank);
  assert.equal(gaps.sparse, true);
  assert.deepEqual(gaps.emptyFields, ['立意', '一句话梗概', '创作简述', '题材', '目标读者']);
  assert.equal(nextStage(blank)?.id, 'profile');
  const briefed = applyCommands(blank, [{ type: 'updateNovel', patch: { brief: '学徒发现钟楼多响的一声来自三十年前的失踪案，而师父一直在隐瞒真相。', theme: '信任的代价' } }]);
  assert.equal(storyGaps(briefed).sparse, false);
  assert.equal(nextStage(briefed)?.id, 'cast');
  assert.equal(nextStage(briefed)?.assist?.focus, 'cast');
  const cast = applyCommands(briefed, [
    { type: 'putObject', value: { id: 'lin', typeId: 'character', name: '林舟', fields: {} } },
    { type: 'putCard', value: { id: 'n1', kind: 'note', title: '第十三声', content: '', x: 0, y: 0 } },
  ]);
  assert.equal(nextStage(cast)?.id, 'setting', '有人物还没有环境时先搭建环境');
  assert.equal(nextStage(cast)?.assist?.focus, 'setting');
  const placed = applyCommands(cast, [{ type: 'putObject', value: { id: 'tower', typeId: 'setting', name: '钟楼', fields: {} } }]);
  assert.equal(storyGaps(placed).unlinkedNotes, 1);
  assert.equal(nextStage(placed)?.id, 'ideas', '便笺都没有连线时灵感步骤未完成');
  assert.equal(storyFlow(placed).length, 9);
});

test('三要素缺口：场景缺人物、情节或环境都会被统计，并出现在叙述顺序一步的提示里', () => {
  const base = createWorkspace('三要素');
  const chapterId = base.chapters[0]!.id;
  const workspace = applyCommands(base, [
    { type: 'putObject', value: { id: 'lin', typeId: 'character', name: '林舟', fields: {} } },
    { type: 'putObject', value: { id: 'tower', typeId: 'setting', name: '钟楼', fields: {} } },
    { type: 'putScene', value: { id: 'full', title: '齐全', povId: 'lin', eventIds: [], outline: '捡到铜片', settingIds: ['tower'] } },
    { type: 'putScene', value: { id: 'empty', title: '空白', povId: null, eventIds: [], outline: '' } },
    { type: 'putScene', value: { id: 'cast', title: '只有出场人物', povId: null, castIds: ['lin'], eventIds: [], outline: '对峙' } },
    ...['full', 'empty', 'cast'].map((id, order) => ({ type: 'putPassage' as const, value: { id, sceneId: id, chapterId, order, text: '' } })),
  ]);
  assert.deepEqual(storyGaps(workspace).sceneElementGaps, { noPeople: 1, noPlace: 2, noPlot: 1 });
  assert.match(storyFlow(workspace).find(stage => stage.id === 'order')!.hint, /2 个场景/);
});
