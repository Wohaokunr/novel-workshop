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
  assert.equal(storyGaps(cast).unlinkedNotes, 1);
  assert.equal(nextStage(cast)?.id, 'ideas', '便笺都没有连线时灵感步骤未完成');
  assert.equal(storyFlow(cast).length, 8);
});
