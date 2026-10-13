import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Change, NarrativeScene, NovelObject, RunRequest, Workspace } from '../shared/types.js';
import type { RollupDigest, SceneDigest } from '../shared/story-types.js';
import type { CompanionThread } from '../shared/companion-types.js';
import { applyCommands, createWorkspace, DomainValidationError } from './domain.js';
import { buildWriterContext, WRITER_CONTEXT_CHARS } from './context.js';
import { collectContext, compactChanges, MAX_CONTEXT_CHARS, searchContext } from './agent/memory.js';
import { specialistDefinition } from './agent/specialists.js';
import { companionContext } from './agent/companion.js';
import { sceneMentions, storyIndex, textHash, textSketch } from './agent/story-index.js';
import { ledgerForDigest, openThreads, StoryView, THREAD_EXPIRY_CHAPTERS } from './agent/story-view.js';
import { DemoStoryTransport, DIGEST_BATCH_CHARS, digestBatch, LONG_SCENE_CHARS, rollupBatch, splitParts, stableThreads, StoryMemoryService } from './agent/story-memory.js';
import { NovelStore } from './store.js';
import { ModelServiceError, OutputLimitError, type ModelRequest, type ResponseTransport } from './responses.js';

const CHAPTERS = 300, SCENES = 4;
const pool = ['雾从港口漫上石阶，灯笼一盏接一盏地熄灭。', '他把手按在冰冷的栏杆上，数着远处的钟声。', '码头的工人低声议论着昨夜的船只。',
  '风里有盐和铁锈的味道，像一封迟到的信。', '她没有回头，只把斗篷的帽檐压得更低。', '巷口的猫跳上屋檐，惊落了一片碎瓦。',
  '账房先生翻过一页，又停下来看了看窗外。', '潮水退去后，礁石上留下一串湿漉漉的脚印。'];
const sid = (chapter: number, scene: number) => `c${chapter}-s${scene}`;

/** ~1,000,000 characters: 300 chapters × 4 scenes × ~850 characters, with a few distinctive long-range details. */
function millionWords(): Workspace {
  const workspace = createWorkspace('雾港长卷', 'long-book');
  const people: NovelObject[] = [
    { id: 'lin', typeId: 'character', name: '林舟', fields: { selfKnowledge: '我是修钟学徒。' } },
    { id: 'shen', typeId: 'character', name: '沈卿', fields: {} },
    { id: 'egret', typeId: 'character', name: '白鹭', fields: { description: '只在第三章出场的哨兵' } },
  ];
  workspace.objects.push(...people);
  workspace.chapters = Array.from({ length: CHAPTERS }, (_, index) => ({ id: `c${index}`, title: `第${index + 1}章`, order: index }));
  workspace.scenes = workspace.chapters.flatMap((chapter, c) => Array.from({ length: SCENES }, (_, s): NarrativeScene => {
    let text = `第${c + 1}章第${s + 1}场。林舟走进雾里。`;
    for (let index = 0; text.length < 850; index++) text += pool[(c * 7 + s * 3 + index) % pool.length]!;
    if (c === 2 && s === 1) text = `白鹭把银哨交给林舟，说吹响它就会有人来。${text}`;
    if (c === 150 && s === 2) text = `${text}沈卿在旧灯塔下找到一枚刻着潮汐纹的铜钥匙。`;
    return { id: sid(c, s), chapterId: chapter.id, order: s, title: `场景${c + 1}-${s + 1}`, povId: 'lin', eventIds: [], outline: `作者大纲秘密${c + 1}-${s + 1}`, text };
  }));
  return workspace;
}

/** Stored digests as the background service would have produced them, with one open and one closed thread. */
function digestsFor(workspace: Workspace, chapters = CHAPTERS): Array<SceneDigest | RollupDigest> {
  const at = '2026-10-12T00:00:00Z';
  const scenes: SceneDigest[] = workspace.scenes.filter(scene => Number(scene.chapterId.slice(1)) < chapters).map(scene => ({
    kind: 'scene', sceneId: scene.id, textHash: textHash(scene.text), chars: scene.text.length, sketch: textSketch(scene.text),
    summary: `摘要${scene.id}：林舟在雾中前行。`, events: [], changes: [], facts: [], model: 'test', updatedAt: at,
    threadsOpened: scene.id === sid(4, 0) ? [{ id: 't:silver', title: '银哨的来历' }] : scene.id === sid(10, 0) ? [{ id: 't:door', title: '灯塔的门为何锁着' }] : [],
    threadsClosed: scene.id === sid(20, 0) ? ['t:door'] : [] }));
  const view = new StoryView(workspace, scenes);
  const rollups: RollupDigest[] = workspace.chapters.slice(0, chapters).map(chapter => ({ kind: 'chapter', targetId: chapter.id, inputHash: view.chapterInput(chapter.id)!.hash,
    title: chapter.title, summary: `章摘要${chapter.id}`, model: 'test', updatedAt: at }));
  return [...scenes, ...rollups];
}

test('百万字：后期场景的写作上下文有界，包含紧邻原文、本章摘要、远距人物召回与未回收伏笔', t => {
  const workspace = millionWords();
  workspace.scenes.find(scene => scene.id === sid(279, 2))!.text = '';
  const total = workspace.scenes.reduce((sum, scene) => sum + scene.text.length, 0);
  assert.ok(total >= 990_000, `生成 ${total} 字`);
  const coldStart = performance.now();
  storyIndex({ ...workspace, id: 'cold-index' });
  const cold = performance.now() - coldStart;
  const digests = digestsFor(workspace);
  const started = performance.now();
  const story = new StoryView(workspace, digests);
  const target = sid(279, 2), previous = workspace.scenes.find(scene => scene.id === sid(279, 1))!;
  const writer = specialistDefinition({ role: 'writer', story, project: workspace,
    node: { id: 'w', role: 'writer', objective: '写下一场', dependsOn: [], acceptance: '完成', status: 'pending', sceneId: target },
    request: { projectId: workspace.id, stage: 'chapter', objective: '写下一场', sceneId: target, references: [{ kind: 'object', id: 'egret' }] } });
  const elapsed = performance.now() - started;
  const serialized = JSON.stringify(writer.context);
  t.diagnostic(`全书 ${total} 字；写作上下文 ${serialized.length} 字符；索引冷启动 ${cold.toFixed(0)}ms，热装配 ${elapsed.toFixed(0)}ms`);
  // The previous implementation listed every earlier scene's outline before truncation: this is what the model used to be offered.
  const naive = JSON.stringify(workspace.scenes.slice(0, 279 * SCENES + 2).map(scene => ({ id: scene.id, title: scene.title, outline: scene.outline }))).length + 12_000;
  t.diagnostic(`旧方案在截断前的前文材料约 ${naive} 字符`);
  assert.ok(serialized.length <= WRITER_CONTEXT_CHARS + 600, `上下文 ${serialized.length}`);
  assert.ok(elapsed < 500, `热装配 ${elapsed}ms`);
  const context = writer.context as Record<string, any>;
  assert.ok(context.recentText.at(-1).text.endsWith(previous.text.slice(-200)), '紧邻上一场的末尾原文必须保留');
  assert.equal(context.recentText.at(-1).sceneId, previous.id);
  assert.deepEqual(context.storySoFar.thisChapterEarlierScenes.map((item: any) => item.summary), [], '本章前两场已在原文窗口内');
  assert.ok(context.storySoFar.recentChapters.some((item: any) => item.summary === '章摘要c278'));
  assert.deepEqual(context.openThreads, ['银哨的来历'], '已回收的伏笔不再出现');
  const recall = context.entityRecall.find((item: any) => item.name === '白鹭');
  assert.ok(recall, '只在第三章出场的人物需要召回');
  assert.match(recall.excerpt, /银哨/);
  assert.equal(recall.lastSeen.sceneId, sid(2, 1));
  assert.doesNotMatch(serialized, /作者大纲秘密28[1-9]|摘要c28[0-9]-|第281章第/, '不含后文');
});

test('百万字：协调者与创作伙伴目录以目标为中心，连续性审阅看得到被修改的第 900 场', () => {
  const workspace = millionWords(), story = new StoryView(workspace, digestsFor(workspace));
  const request: RunRequest = { projectId: workspace.id, stage: 'agent', objective: '检查', sceneId: sid(260, 0) };
  const overview = collectContext(workspace, request, [], story) as Record<string, any>;
  assert.ok(JSON.stringify(overview).length <= MAX_CONTEXT_CHARS);
  assert.ok(overview.catalog.chapters.some((chapter: any) => chapter.id === 'c260'));
  assert.ok(overview.catalog.chapters.some((chapter: any) => chapter.id === 'c255'));
  assert.ok(overview.catalog.chapterSkeleton.length > 0);
  assert.equal(overview.catalog.objects[0].id, 'lin', '目标场景相关、出场最多的人物排在前面');
  assert.ok(overview.storyMemory.openThreads.includes('银哨的来历'));

  const thread: CompanionThread = { id: 't', projectId: workspace.id, mode: 'beat', anchor: { surface: 'writer', references: [], sceneId: sid(270, 1) },
    title: '卡文', turns: [], status: 'idle', createdAt: '', updatedAt: '' };
  const partner = companionContext(workspace, thread, [], {}, story) as Record<string, any>;
  assert.ok(JSON.stringify(partner).length <= 24_000 + 600);
  assert.ok(partner.catalog.chapters.some((chapter: any) => chapter.id === 'c270'));
  assert.ok(partner.catalog.scenes.some((scene: any) => scene.id === sid(270, 1)));

  const nine = workspace.scenes[900]!;
  const review = specialistDefinition({ role: 'continuity', story, project: workspace, focusSceneIds: [nine.id],
    node: { id: 'r', role: 'continuity', objective: '审阅', dependsOn: [], acceptance: '给出结论', status: 'running' }, request: { projectId: workspace.id, stage: 'agent', objective: '审阅' } });
  const reviewed = review.context as Record<string, any>;
  assert.deepEqual(reviewed.targetScenes.map((scene: any) => scene.id), [nine.id]);
  assert.equal(reviewed.precedingScenes.length, 3);
});

test('百万字：读者只拿到已读章节的摘要，没有大纲、卷/全书汇总或后文', () => {
  const workspace = millionWords(), story = new StoryView(workspace, digestsFor(workspace));
  const reader = specialistDefinition({ role: 'reader', story, project: workspace,
    node: { id: 'r', role: 'reader', objective: '读', dependsOn: [], acceptance: '审阅', status: 'running', sceneId: sid(100, 1), chapterId: 'c100' },
    request: { projectId: workspace.id, stage: 'agent', objective: '读' } });
  const context = reader.context as Record<string, any>, serialized = JSON.stringify(context);
  assert.ok(context.earlierStory.length > 0 && context.earlierStory.length <= 20);
  assert.equal(context.text.length, 12_000);
  assert.doesNotMatch(serialized, /作者大纲秘密|场景\d+-\d+|摘要c10[1-9]|章摘要c1[1-9]\d|第102章/);
  assert.ok(serialized.length <= MAX_CONTEXT_CHARS);
});

test('摘要按正文 hash 判断新鲜度：小改为 drifted 仍可用，大改退回抽取式；分批与汇总只处理变化', () => {
  const workspace = millionWords(), digests = digestsFor(workspace, 3);
  const edited = structuredClone(workspace);
  const light = edited.scenes.find(scene => scene.id === sid(0, 0))!, heavy = edited.scenes.find(scene => scene.id === sid(0, 1))!;
  light.text = light.text.replace('林舟走进雾里', '林舟慢慢走进雾里');
  heavy.text = '完全重写的一场：沈卿独自坐在船舱里，听着海浪敲打船身，想起母亲留下的旧怀表。'.repeat(10);
  const view = new StoryView(edited, digests);
  assert.equal(view.freshness(sid(0, 0)), 'drifted');
  assert.equal(view.sceneMemory(sid(0, 0)).summary, `摘要${sid(0, 0)}：林舟在雾中前行。`);
  assert.equal(view.freshness(sid(0, 1)), 'extract');
  assert.match(view.sceneMemory(sid(0, 1)).summary, /完全重写/);
  assert.equal(view.freshness(sid(0, 2)), 'fresh');
  const batch = digestBatch(view);
  assert.deepEqual(batch.map(scene => scene.id), [sid(0, 0), sid(0, 1)], '分批只取连续的待整理场景');
  const big = digestBatch(new StoryView(workspace, []));
  assert.ok(big.reduce((sum, scene) => sum + scene.text.length, 0) <= DIGEST_BATCH_CHARS && big.length > 1);
  const fresh = new StoryView(workspace, digests);
  assert.deepEqual(rollupBatch(fresh, 'chapter').map(item => item.id), [], '输入未变化的章节不重算');
  assert.deepEqual(rollupBatch(new StoryView(edited, digests), 'chapter').map(item => item.id), [], '有场景待整理的章节暂不汇总');
  light.text = light.text.replace('慢慢', '缓缓');
  heavy.text = workspace.scenes.find(scene => scene.id === sid(0, 1))!.text;
  assert.deepEqual(rollupBatch(new StoryView(edited, digests), 'chapter').map(item => item.id), [], '小改沿用 drifted 摘要，章节输入不变，不重算');
  const whole = new StoryView(workspace, digestsFor(workspace));
  assert.deepEqual(whole.ledgerBefore(sid(15, 0)).map(thread => thread.title), ['银哨的来历', '灯塔的门为何锁着']);
  assert.deepEqual(whole.ledgerBefore(sid(21, 0)).map(thread => thread.title), ['银哨的来历']);
});

test('段落索引按 BM25 召回后半部场景的多个片段，角色过滤先于匹配', () => {
  const workspace = millionWords();
  storyIndex(workspace);
  const hits = searchContext(workspace, '潮汐纹的铜钥匙', 6);
  assert.equal(hits[0]!.source.id, sid(150, 2));
  assert.ok(hits[0]!.text.includes('铜钥匙') && hits[0]!.text.length <= 1200);
  assert.ok(searchContext(workspace, '雾', 12).length <= 12);
  const scoped = searchContext(workspace, '银哨', 6, 'coordinator', {}, { entityId: 'egret' });
  assert.ok(scoped.length && scoped.every(chunk => chunk.source.id === sid(2, 1) || chunk.source.kind === 'scene:outline'));
  assert.deepEqual(searchContext(workspace, '潮汐纹的铜钥匙', 6, 'reader', { sceneId: sid(100, 0) }), [], '读者检索不到未读后文');
  const perScene = new Map<string, number>();
  for (const chunk of searchContext(workspace, '林舟走进雾里', 12)) perScene.set(chunk.source.id, (perScene.get(chunk.source.id) ?? 0) + 1);
  assert.ok([...perScene.values()].every(count => count <= 2));
});

test('工具结果中的修改按字段摘要，远小于完整前后正文', () => {
  const workspace = millionWords(), scene = workspace.scenes[0]!;
  const longText = scene.text.repeat(10), after = { ...scene, text: longText.replace('林舟走进雾里', '林舟停在雾外') };
  const changes: Change[] = [{ collection: 'scenes', key: scene.id, before: { ...scene, text: longText }, after }, { collection: 'metadata', key: 'theme', before: '', after: '信任' }];
  const compact = JSON.stringify(compactChanges(changes));
  assert.ok(compact.length < JSON.stringify(changes).length / 5, `${compact.length}`);
  assert.match(compact, /\[-走进-\]|\{\+停在\+\}/);
  assert.match(compact, /"after":"信任"/);
});

test('后台故事记忆：演示传输完成场景摘要与章/卷/全书汇总，摘要不进入作品修订', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'story-memory-'));
  const store = new NovelStore(join(directory, 'test.sqlite'));
  try {
    const project = store.createProject('短篇');
    const chapterId = project.chapters[0]!.id;
    const saved = store.execute({ projectId: project.id, actor: 'human', commands: [
      { type: 'putChapter', value: { id: 'second', title: '第二章', order: 5 } },
      ...[0, 1, 2].map(index => ({ type: 'putScene' as const, value: { id: `s${index}`, chapterId: index < 2 ? chapterId : 'second', order: index, title: `场景${index}`, povId: null, eventIds: [],
        outline: '', text: `第${index}场。她不知道门后是什么？雾里传来第十三声钟响。` } })),
    ] });
    const events: string[] = [];
    const service = new StoryMemoryService(store, () => ({ name: 'demo', baseURL: '', model: 'demo', mode: 'mock', apiKey: '' }), event => events.push(event.type), () => new DemoStoryTransport());
    await service.run(project.id);
    const status = await service.status(project.id);
    assert.equal(status.fresh, 3); assert.equal(status.pending, 0); assert.equal(status.running, false); assert.equal(status.lastError, undefined);
    const digests = store.getStoryDigests(project.id);
    assert.deepEqual(digests.filter(item => item.kind === 'chapter').map(item => (item as RollupDigest).targetId).sort(), [chapterId, 'second'].sort());
    assert.ok(digests.some(item => item.kind === 'volume') && digests.some(item => item.kind === 'book'));
    const view = new StoryView(store.getProject(project.id), digests);
    assert.equal(view.ledgerBefore().length, 1, '三场提出的是同一个疑问，合并为一条未回收伏笔');
    assert.equal(store.getProject(project.id).revision, saved.revision, '摘要不修改作品');
    assert.ok(events.includes('storyMemory'));
    const calls = digests.length;
    await service.run(project.id);
    assert.equal(store.getStoryDigests(project.id).length, calls, '没有变化时不重复整理');
    assert.equal(StoryMemoryService.summaryProvider({ name: '', baseURL: '', model: 'main', reasoningEffort: 'high', summaryModel: 'mini', mode: 'live', apiKey: 'k' }).model, 'mini');
    assert.equal(StoryMemoryService.summaryProvider({ name: '', baseURL: '', model: 'main', reasoningEffort: 'high', summaryModel: 'mini', mode: 'live', apiKey: 'k' }).reasoningEffort, undefined);
    assert.equal(StoryMemoryService.summaryProvider({ name: '', baseURL: '', model: 'main', maxOutputTokens: 64_000, summaryModel: 'mini', mode: 'live', apiKey: 'k' }).maxOutputTokens, undefined);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('小作品写作上下文与原有边界一致：无摘要时用大纲与首尾句兜底', () => {
  const workspace = createWorkspace('小'), chapterId = workspace.chapters[0]!.id;
  workspace.scenes.push({ id: 'a', chapterId, order: 0, title: '甲', povId: null, eventIds: [], outline: '甲的大纲', text: '' },
    { id: 'b', chapterId, order: 1, title: '乙', povId: null, eventIds: [], outline: '', text: '' });
  const context = buildWriterContext(workspace, 'b');
  assert.deepEqual(context.recentText, []);
  assert.match(context.storySoFar.thisChapterEarlierScenes[0]!.summary, /甲的大纲/);
  assert.equal(context.storySoFar.thisChapterEarlierScenes[0]!.freshness, 'extract');
});

test('后台故事记忆：一批内容无法整理时只跳过这一批并说明；服务出错则停止整理', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'story-skip-'));
  const store = new NovelStore(join(directory, 'test.sqlite'));
  try {
    const project = store.createProject('跳过');
    const chapterId = project.chapters[0]!.id, long = '雾从港口漫上石阶，灯笼一盏接一盏地熄灭。'.repeat(700);
    store.execute({ projectId: project.id, actor: 'human', commands: [0, 1, 2].map(index => ({ type: 'putScene' as const,
      value: { id: `s${index}`, chapterId, order: index, title: `场景${index}`, povId: null, eventIds: [], outline: '', text: `${index}${long}` } })) });
    const demo = new DemoStoryTransport();
    let failure: Error | undefined, requests = 0;
    const transport: ResponseTransport = { stream(request: ModelRequest, signal: AbortSignal) {
      requests++;
      const first = request.agentId === 'story:digest' && String((request.input[0] as { content: string }).content).includes('"sceneId":"s0"');
      if (failure && first) throw failure;
      return demo.stream(request, signal);
    } };
    const service = new StoryMemoryService(store, () => ({ name: 'demo', baseURL: '', model: 'demo', mode: 'mock', apiKey: '' }), () => {}, () => transport);
    failure = new ModelServiceError('模型服务出错：401 Incorrect API key', 401);
    await service.run(project.id);
    assert.equal((await service.status(project.id)).lastError, '模型服务出错：401 Incorrect API key');
    assert.equal(requests, 1, 'a service error stops the run');
    failure = new OutputLimitError('模型输出达到单次上限被截断');
    await service.run(project.id);
    const status = await service.status(project.id);
    assert.equal(status.fresh, 2); assert.equal(status.pending, 1);
    assert.equal(status.lastError, '1 批内容整理失败：模型输出达到单次上限被截断。这些场景下次整理时重试');
    failure = undefined;
    await service.run(project.id);
    assert.equal((await service.status(project.id)).pending, 0);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

/** A book of `chapters` one-scene chapters with stored digests built by `digest(index)`. */
function threadBook(chapters: number, digest: (index: number) => Partial<SceneDigest>) {
  const workspace = createWorkspace('伏笔', 'threads');
  workspace.chapters = Array.from({ length: chapters }, (_, index) => ({ id: `c${index}`, title: `第${index + 1}章`, order: index }));
  workspace.scenes = workspace.chapters.map((chapter, index) => ({ id: `s${index}`, chapterId: chapter.id, order: 0, title: `场景${index}`, povId: null, eventIds: [], outline: '', text: `第${index}场正文。` }));
  const digests: SceneDigest[] = workspace.scenes.map((scene, index) => ({ kind: 'scene', sceneId: scene.id, textHash: textHash(scene.text), chars: scene.text.length, sketch: textSketch(scene.text),
    summary: '平静的一天。', events: [], changes: [], facts: [], threadsOpened: [], threadsClosed: [], model: 'test', updatedAt: '', ...digest(index) }));
  return new StoryView(workspace, digests);
}

test('伏笔账本：措辞相近的重复伏笔合并，回收任一条即回收；主线伏笔排前，久未提及的次要伏笔排在最后', () => {
  const view = threadBook(80, index => index === 0 ? { threadsOpened: [{ id: 't:mystery', title: '钟楼为何敲响第十三声', major: true }] }
    : index === 1 ? { threadsOpened: [{ id: 't:old', title: '码头仓库里藏着什么' }] }
    : index === 5 ? { threadsOpened: [{ id: 't:dup', title: '钟楼为什么敲响第十三声' }] }
    : index === 40 ? { threadsOpened: [{ id: 't:active', title: '账房先生的旧账本' }] }
    : index === 60 ? { summary: '他又翻开账房先生的旧账本。' }
    : index === 70 ? { threadsOpened: Array.from({ length: 3 }, (_, n) => ({ id: `t:new${n}`, title: `新的疑问${'甲乙丙'[n]}` })) } : {});
  const ledger = view.ledgerBefore();
  assert.deepEqual(ledger.map(thread => thread.id), ['t:mystery', 't:old', 't:active', 't:new0', 't:new1', 't:new2'], '重复的伏笔并入最早的一条');
  assert.equal(ledger.find(thread => thread.id === 't:active')!.lastChapterIndex, 60, '后文摘要提到即视为仍在推进');
  const listed = openThreads(view, undefined, [], 5).map(thread => thread.title);
  assert.equal(listed[0], '钟楼为何敲响第十三声');
  assert.ok(!listed.includes('码头仓库里藏着什么'), `超过 ${THREAD_EXPIRY_CHAPTERS} 章没被提起的次要伏笔在拥挤时让位`);
  assert.deepEqual(openThreads(view, undefined, [], 10).at(-1), { id: 't:old', title: '码头仓库里藏着什么' }, '不拥挤时仍然列出');
  const closedByDuplicate = threadBook(10, index => index === 0 ? { threadsOpened: [{ id: 't:a', title: '钟楼为何敲响第十三声' }] }
    : index === 2 ? { threadsOpened: [{ id: 't:b', title: '钟楼为什么敲响第十三声' }] } : index === 4 ? { threadsClosed: ['t:b'] } : {});
  assert.deepEqual(closedByDuplicate.ledgerBefore(), []);
});

test('交给摘要模型的伏笔：主线与本批正文提到的早期伏笔优先于最近的伏笔', () => {
  const view = threadBook(200, index => index === 3 ? { threadsOpened: [{ id: 't:early', title: '银哨的来历' }] }
    : index > 3 ? { threadsOpened: [{ id: `t:${index}`, title: `线索${String.fromCharCode(0x4e00 + index * 3)}${String.fromCharCode(0x5000 + index * 5)}` }] } : {});
  const picked = ledgerForDigest(view.ledgerBefore(), '白鹭终于说出了银哨的来历。', 20);
  assert.equal(picked.length, 20);
  assert.ok(picked.some(thread => thread.id === 't:early'), '正文提到的早期伏笔可以被回收');
  assert.ok(picked.some(thread => thread.id === 't:199'));
});

test('伏笔编号来自开启场景与措辞：重新整理该场时沿用相近伏笔的编号，后文的回收仍指向同一条', () => {
  const first = stableThreads('s1', [{ title: '门后是谁', major: false }, { title: '钥匙去了哪里', major: true }]);
  assert.match(first[0]!.id, /^t:s1:[0-9a-f]{10}$/); assert.equal(first[1]!.major, true);
  const again = stableThreads('s1', [{ title: '钥匙到底去了哪里', major: true }, { title: '门后究竟是谁', major: false }], first);
  assert.deepEqual(again.map(thread => thread.id), [first[1]!.id, first[0]!.id]);
  const same = stableThreads('s2', [{ title: '同一句', major: false }, { title: '同一句', major: false }]);
  assert.notEqual(same[0]!.id, same[1]!.id);
});

test('后台故事记忆：模型漏掉的场景不存兜底摘要，保持待整理并在下次重试', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'story-omit-'));
  const store = new NovelStore(join(directory, 'test.sqlite'));
  try {
    const project = store.createProject('漏报'), chapterId = project.chapters[0]!.id;
    store.execute({ projectId: project.id, actor: 'human', commands: [0, 1].map(index => ({ type: 'putScene' as const,
      value: { id: `s${index}`, chapterId, order: index, title: `场景${index}`, povId: null, eventIds: [], outline: '', text: `第${index}场。雾里传来钟声。` } })) });
    const demo = new DemoStoryTransport();
    let drop = true;
    const transport: ResponseTransport = { stream(request: ModelRequest, signal: AbortSignal) {
      if (!drop || request.agentId !== 'story:digest') return demo.stream(request, signal);
      const [user] = request.input as Array<{ content: string }>;
      const parsed = JSON.parse(user!.content);
      parsed.context.scenes = parsed.context.scenes.filter((scene: { sceneId: string }) => scene.sceneId !== 's1');
      return demo.stream({ ...request, input: [{ role: 'user', content: JSON.stringify(parsed) }] }, signal);
    } };
    const service = new StoryMemoryService(store, () => ({ name: 'demo', baseURL: '', model: 'demo', mode: 'mock', apiKey: '' }), () => {}, () => transport);
    await service.run(project.id);
    let status = await service.status(project.id);
    assert.equal(status.fresh, 1); assert.equal(status.pending, 1);
    assert.equal(status.lastError, '1 场被模型漏掉。这些场景下次整理时重试');
    assert.ok(!store.getStoryDigests(project.id).some(digest => digest.kind === 'scene' && digest.sceneId === 's1'));
    drop = false;
    await service.run(project.id);
    status = await service.status(project.id);
    assert.equal(status.pending, 0); assert.equal(status.lastError, undefined);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('后台故事记忆：超长场景分段整理再合并，不再省略中段；段内开启又回收的伏笔不留在账本里', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'story-long-'));
  const store = new NovelStore(join(directory, 'test.sqlite'));
  try {
    const project = store.createProject('长场景'), chapterId = project.chapters[0]!.id;
    const filler = '潮水一遍遍漫上石阶，又退回去。\n'.repeat(700);
    const text = `她不知道门后是谁？\n${filler}中段：守钟人把铜钥匙藏进了钟摆。\n${filler}门开了，原来门后是守钟人。\n${filler}`;
    assert.ok(text.length > LONG_SCENE_CHARS * 2);
    store.execute({ projectId: project.id, actor: 'human', commands: [{ type: 'putScene', value: { id: 'long', chapterId, order: 0, title: '长夜', povId: null, eventIds: [], outline: '', text } }] });
    const demo = new DemoStoryTransport(), requests: ModelRequest[] = [];
    const transport: ResponseTransport = { stream(request: ModelRequest, signal: AbortSignal) {
      requests.push(request);
      if (request.agentId === 'story:digest') {
        const { context } = JSON.parse((request.input[0] as { content: string }).content);
        const part = context.scenes[0];
        if (part.text.includes('门开了')) {
          const opened = context.openThreads.find((thread: { title: string }) => thread.title.includes('门后'));
          return stream(JSON.stringify({ scenes: [{ sceneId: part.sceneId, summary: '门开了。', events: ['门开了'], changes: [], threadsOpened: [], threadsClosed: [opened.id], facts: [] }] }));
        }
      }
      return demo.stream(request, signal);
    } };
    const stream = (text: string) => ({ events: (async function* () {})(), finalResponse: async () => ({ id: 'fixture', status: 'completed', output: [{ type: 'message' as const, id: 'm', role: 'assistant' as const, status: 'completed' as const, content: [{ type: 'output_text' as const, text, annotations: [] }] }], usage: null }) });
    const service = new StoryMemoryService(store, () => ({ name: 'demo', baseURL: '', model: 'demo', mode: 'mock', apiKey: '' }), () => {}, () => transport);
    await service.run(project.id);
    const parts = splitParts(text, 10_000);
    const digestRequests = requests.filter(request => request.agentId === 'story:digest');
    assert.equal(digestRequests.length, parts.length);
    assert.ok(digestRequests.some(request => JSON.stringify(request.input).includes('守钟人把铜钥匙藏进了钟摆')), '中段也被整理');
    assert.ok(digestRequests.every(request => JSON.stringify(request.input).includes(`long#`)), '各段标明是同一场景的第几部分');
    assert.equal(requests.filter(request => request.agentId === 'story:merge').length, 1);
    assert.equal(parts.join(''), text);
    const digest = store.getStoryDigests(project.id).find(item => item.kind === 'scene') as SceneDigest;
    assert.equal(digest.sceneId, 'long'); assert.equal(digest.textHash, textHash(text));
    assert.deepEqual(digest.threadsOpened, [], '「门后是谁」在同一场里已经揭晓');
    assert.equal((await service.status(project.id)).pending, 0);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('人物别名：按别名找到出场，最长名字优先避免「李明」误配「李明月」；别名需要有效', () => {
  const workspace = createWorkspace('别名', 'aliases');
  workspace.objects.push({ id: 'li', typeId: 'character', name: '李明', fields: {}, aliases: ['阿明', '李先生'] },
    { id: 'yue', typeId: 'character', name: '李明月', fields: {} });
  workspace.chapters = [{ id: 'c', title: '一', order: 0 }];
  workspace.scenes = [{ id: 's', chapterId: 'c', order: 0, title: '一', povId: null, eventIds: [], outline: '', text: '李明月推门进来。阿明抬头，李先生，她喊。李明月笑了。' }];
  const mentions = sceneMentions(storyIndex(workspace), 's');
  assert.equal(mentions.get('yue')?.count, 2);
  assert.equal(mentions.get('li')?.count, 2, '两个别名各一次，「李明月」里的「李明」不算');
  assert.throws(() => applyCommands(workspace, [{ type: 'putObject', value: { ...workspace.objects[0]!, aliases: [''] } }]), DomainValidationError);
  const renamed = applyCommands(workspace, [{ type: 'putObject', value: { ...workspace.objects[1]!, aliases: ['小月'] } }]);
  assert.deepEqual(renamed.objects.find(object => object.id === 'yue')!.aliases, ['小月']);
});
