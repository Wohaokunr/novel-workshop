import test from 'node:test';
import assert from 'node:assert/strict';
import { diffStats, diffText, sentences, type DiffPart } from '../shared/text-diff.js';

const join = (parts: DiffPart[], keep: 'del' | 'add') => parts.filter(part => part.kind === 'same' || part.kind === keep).map(part => part.text).join('');

test('句子切分保留全部原文与标点', () => {
  const text = '钟楼响了。“谁在那里？”她问；\n没有人回答……\n\n雾更浓了';
  assert.equal(sentences(text).join(''), text);
  assert.ok(sentences(text).length >= 5);
});

test('差异可以还原修改前后文本，未修改句子保持相同', () => {
  const before = '林舟拾起信。信上没有署名。钟楼响了十三声。';
  const after = '林舟拾起那封信。信上没有署名。钟楼只响了十二声，然后沉默。';
  const parts = diffText(before, after);
  assert.equal(join(parts, 'del'), before);
  assert.equal(join(parts, 'add'), after);
  assert.ok(parts.some(part => part.kind === 'same' && part.text.includes('信上没有署名。')));
  assert.ok(parts.some(part => part.kind === 'add' && part.text.includes('那封')));
});

test('相同、空白与完全新增的文本', () => {
  assert.deepEqual(diffText('不变', '不变'), [{ kind: 'same', text: '不变' }]);
  assert.deepEqual(diffText('', '新的一幕。'), [{ kind: 'add', text: '新的一幕。' }]);
  assert.deepEqual(diffText('旧的一幕。', ''), [{ kind: 'del', text: '旧的一幕。' }]);
  assert.deepEqual(diffStats(diffText('甲乙', '甲丙丁')), { added: 2, removed: 1 });
});

test('长文本在表格上限内退化为整段替换而不是卡住', () => {
  const before = '雾'.repeat(3000), after = '霜'.repeat(3000);
  const parts = diffText(before, after);
  assert.equal(join(parts, 'del'), before);
  assert.equal(join(parts, 'add'), after);
});
