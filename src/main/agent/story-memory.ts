import { randomUUID } from 'node:crypto';
import type { ResponseOutputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { AgentEvent, Passage, ProviderSecret, TokenUsage, Workspace } from '../../shared/types.js';
import type { PassageDigest, RollupDigest, StoryDigest, StoryMemoryStatus, StoryThread } from '../../shared/story-types.js';
import { NovelStore } from '../store.js';
import { addUsage, checkCancelled, emptyUsage, ModelOutputError, objectSchema, runAgent, ToolValidationError, type EmbeddingTransport, type JsonSchema, type ModelRequest, type ModelResponse, type ResponseTransport } from '../responses.js';
import { indexVectors, vectorCoverage } from './semantic.js';
import { extractSummary, passageHash, textHash, textSketch } from './story-index.js';
import { ledgerForDigest, StoryView, threadOverlap } from './story-view.js';
import { digestPrompt, mergePrompt, rollupPrompts } from '../prompts/story-memory.js';

export const DIGEST_BATCH_CHARS = 12_000;
const DIGEST_BATCH_PASSAGES = 8;
/** Longer passages are digested in parts of about PASSAGE_PART_CHARS, then merged, instead of losing their middle. */
export const LONG_PASSAGE_CHARS = 16_000;
const PASSAGE_PART_CHARS = 10_000;
const ROLLUP_BATCH_CHARS = 10_000;
/** Open threads shown to the digest model: major, picked up by the prose, then recent (see ledgerForDigest). */
const LEDGER_LIMIT = 60;
const IDLE_MS = { live: 90_000, mock: 1_000 } as const;
/** A larger backlog (e.g. importing a finished book) waits for the author's explicit "整理" instead of spending silently. */
export const AUTO_LIMIT_CHARS = 60_000;

const string: JsonSchema = { type: 'string' }, strings: JsonSchema = { type: 'array', items: string };
export const digestSchema = objectSchema({ passages: { type: 'array', items: objectSchema({
  passageId: string, summary: string, events: strings, changes: { type: 'array', items: objectSchema({ who: string, change: string }) },
  threadsOpened: { type: 'array', items: objectSchema({ title: string, major: { type: 'boolean' } }) }, threadsClosed: strings, facts: strings,
}) } });
export const rollupSchema = objectSchema({ items: { type: 'array', items: objectSchema({ id: string, summary: string }) } });


function stamp() { return new Date().toISOString(); }

/** Background digests: passages in reading order, then chapter → volume → book rollups. Never touches the workspace. */
export class StoryMemoryService {
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Map<string, AbortController>();
  private again = new Set<string>();
  private errors = new Map<string, string>();
  private usage = new Map<string, TokenUsage>();

  constructor(private store: NovelStore, private getProvider: () => ProviderSecret | Promise<ProviderSecret>,
    private onEvent: (event: AgentEvent) => void, private transportFactory: (provider: ProviderSecret) => ResponseTransport,
    private embedderFactory?: (provider: ProviderSecret & { embeddingModel: string }) => EmbeddingTransport) {}

  /** Summary model when configured; the reasoning parameter and output limit belong to the main model only. */
  static summaryProvider(provider: ProviderSecret): ProviderSecret {
    const model = provider.summaryModel?.trim();
    if (!model) return provider;
    const { reasoningEffort: _effort, maxOutputTokens: _limit, ...rest } = provider;
    return { ...rest, model };
  }

  async status(projectId: string): Promise<StoryMemoryStatus> {
    const project = this.store.getProject(projectId);
    const provider = await this.getProvider();
    const coverage = new StoryView(project, this.store.getStoryDigests(projectId)).coverage();
    const auto = provider.storyMemory !== 'manual';
    const embeddingModel = provider.embeddingModel;
    return { projectId, ...coverage, running: this.running.has(projectId), auto,
      ...(embeddingModel && this.embedderFactory ? { vectors: { model: embeddingModel, ...vectorCoverage(this.store, project, embeddingModel) } } : {}),
      awaitingConfirmation: auto && provider.mode === 'live' && coverage.pendingChars > AUTO_LIMIT_CHARS,
      ...(this.errors.has(projectId) ? { lastError: this.errors.get(projectId) } : {}), usage: this.usage.get(projectId) ?? emptyUsage(), updatedAt: stamp() };
  }
  private async emit(projectId: string) {
    try { this.onEvent({ type: 'storyMemory', projectId, runId: `story:${projectId}`, story: await this.status(projectId) }); } catch { /* A removed project or closed window is not an error here. */ }
  }

  /** Called after any project change. Auto mode digests once the author has been idle for a while. */
  touch(projectId: string) {
    void (async () => {
      const provider = await this.getProvider();
      if (provider.storyMemory === 'manual') { await this.emit(projectId); return; }
      if (this.running.has(projectId)) { this.again.add(projectId); return; }
      clearTimeout(this.timers.get(projectId));
      const timer = setTimeout(() => {
        this.timers.delete(projectId);
        void this.status(projectId).then(status => status.awaitingConfirmation ? this.emit(projectId) : this.run(projectId)).catch(() => {});
      }, IDLE_MS[provider.mode]);
      timer.unref?.();
      this.timers.set(projectId, timer);
    })().catch(() => { /* Settings unreadable: the next explicit run reports it. */ });
  }

  stop(projectId: string) {
    clearTimeout(this.timers.get(projectId)); this.timers.delete(projectId);
    this.again.delete(projectId); this.running.get(projectId)?.abort();
  }
  shutdown() { for (const projectId of [...this.timers.keys(), ...this.running.keys()]) this.stop(projectId); }

  /** Digest every pending passage, then refresh stale rollups. Safe to call repeatedly; progress is saved per batch. */
  async run(projectId: string): Promise<void> {
    if (this.running.has(projectId)) { this.again.add(projectId); return; }
    const controller = new AbortController();
    this.running.set(projectId, controller);
    this.errors.delete(projectId);
    await this.emit(projectId);
    let provider: ProviderSecret | undefined;
    try {
      provider = await this.getProvider();
      if (provider.mode === 'live' && !provider.apiKey) throw new Error('请先在模型设置中填写 API Key');
      const summary = StoryMemoryService.summaryProvider(provider), transport = this.transportFactory(summary);
      // Each target is attempted once per run; edits made meanwhile are picked up by the follow-up run.
      const attempted = new Set<string>();
      // An answer that does not fit one batch skips only that batch, which stays pending for the next run;
      // a service or connection error stops the run, since every later batch would hit it too.
      let skipped = 0, lastSkip = '', omitted = 0;
      const attempt = async (work: () => Promise<unknown>) => {
        try { await work(); } catch (failure) {
          if (controller.signal.aborted || !(failure instanceof ModelOutputError || failure instanceof ToolValidationError || failure instanceof SyntaxError)) throw failure;
          skipped++; lastSkip = failure.message;
        }
      };
      while (!controller.signal.aborted) {
        const project = this.store.getProject(projectId);
        const view = new StoryView(project, this.store.getStoryDigests(projectId));
        const batch = digestBatch(view, attempted);
        if (!batch.length) break;
        for (const passage of batch) attempted.add(passage.id);
        await attempt(async () => { omitted += await this.digestPassages(project, view, batch, transport, summary.model, controller.signal); });
        await this.emit(projectId);
      }
      for (const kind of ['chapter', 'volume', 'book'] as const) {
        while (!controller.signal.aborted) {
          const project = this.store.getProject(projectId);
          const work = rollupBatch(new StoryView(project, this.store.getStoryDigests(projectId)), kind, attempted);
          if (!work.length) break;
          for (const item of work) attempted.add(`${kind}:${item.id}`);
          await attempt(() => this.rollup(project, kind, work, transport, summary.model, controller.signal));
        }
      }
      const problems = [skipped ? `${skipped} 批内容整理失败：${lastSkip}` : '', omitted ? `${omitted} 段被模型漏掉` : ''].filter(Boolean);
      if (problems.length && !controller.signal.aborted) this.errors.set(projectId, `${problems.join('；')}。这些场景段下次整理时重试`);
      // The semantic index embeds the prose itself, so it does not wait for digests.
      const embeddingModel = provider.embeddingModel;
      if (embeddingModel && this.embedderFactory && !controller.signal.aborted) {
        await indexVectors(this.store, projectId, this.embedderFactory({ ...provider, embeddingModel }), embeddingModel, controller.signal,
          tokens => this.track(projectId, { ...emptyUsage(), input: tokens, total: tokens, provided: tokens > 0 }));
      }
      if (!controller.signal.aborted) {
        const project = this.store.getProject(projectId), view = new StoryView(project);
        this.store.pruneStoryDigests(projectId, { passage: new Set(project.passages.map(passage => passage.id)), chapter: new Set(project.chapters.map(chapter => chapter.id)),
          volume: new Set(view.volumes().map(volume => volume.id)), book: new Set([project.id]) });
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        const message = failure instanceof Error ? failure.message : String(failure);
        this.errors.set(projectId, provider?.apiKey ? message.replaceAll(provider.apiKey, '[API Key 已隐藏]') : message);
      }
    } finally {
      this.running.delete(projectId);
      await this.emit(projectId);
      if (this.again.delete(projectId) && !controller.signal.aborted) this.touch(projectId);
    }
  }

  private track(projectId: string, usage: TokenUsage) {
    const total = this.usage.get(projectId) ?? emptyUsage();
    addUsage(total, usage); this.usage.set(projectId, total);
  }

  /** Returns how many passages the model left out: they keep no digest and stay pending, so the next run digests them again. */
  private async digestPassages(project: Workspace, view: StoryView, batch: Passage[], transport: ResponseTransport, model: string, signal: AbortSignal): Promise<number> {
    if (batch.length === 1 && batch[0]!.text.length > LONG_PASSAGE_CHARS) return this.digestLongPassage(project, view, batch[0]!, transport, model, signal);
    const open = view.ledgerBefore(batch[0]!.id), known = new Set(open.map(thread => thread.id));
    const context = {
      openThreads: threadList(ledgerForDigest(open, batch.map(passage => passage.text).join('\n'), LEDGER_LIMIT)),
      previousSummary: previousSummary(view, batch[0]!.id),
      passages: batch.map(passage => ({ passageId: passage.id, chapter: chapterTitle(view, passage), scene: view.label(passage.id), text: passage.text })),
    };
    const result = await this.digestCall(project.id, transport, context, signal);
    const at = stamp(), digests: PassageDigest[] = [];
    for (const passage of batch) {
      const item = result.passages.find(value => value.passageId === passage.id);
      if (!item) continue;
      const digest = passageDigest(view, passage, { ...item, threadsOpened: stableThreads(passage.id, item.threadsOpened.slice(0, 3), view.storedDigest(passage.id)?.threadsOpened) }, known, model, at);
      digests.push(digest);
      for (const thread of digest.threadsOpened) known.add(thread.id);
    }
    if (!signal.aborted) this.store.putStoryDigests(project.id, digests);
    return batch.length - digests.length;
  }

  /** A passage too long for one request is digested part by part, each part seeing the threads earlier parts opened, then its
   * summaries are merged into one. Nothing is stored unless every part was digested. */
  private async digestLongPassage(project: Workspace, view: StoryView, passage: Passage, transport: ResponseTransport, model: string, signal: AbortSignal): Promise<number> {
    const parts = splitParts(passage.text, PASSAGE_PART_CHARS), open = view.ledgerBefore(passage.id), known = new Set(open.map(thread => thread.id));
    const chapter = chapterTitle(view, passage), scene = view.label(passage.id), previousThreads = view.storedDigest(passage.id)?.threadsOpened ?? [];
    const digested: Array<DigestItem & { threads: StoryThread[] }> = [], openedHere: StoryThread[] = [];
    let previous = previousSummary(view, passage.id);
    for (const [index, part] of parts.entries()) {
      const partId = `${passage.id}#${index + 1}/${parts.length}`;
      const result = await this.digestCall(project.id, transport, { openThreads: [...threadList(ledgerForDigest(open, part, LEDGER_LIMIT)), ...threadList(openedHere)],
        previousSummary: previous, passages: [{ passageId: partId, chapter, scene, text: part }] }, signal);
      const item = result.passages.find(value => value.passageId === partId) ?? (result.passages.length === 1 ? result.passages[0] : undefined);
      if (!item) return 1;
      const threads = stableThreads(passage.id, item.threadsOpened.slice(0, 3), previousThreads.filter(thread => !openedHere.some(other => other.id === thread.id)));
      digested.push({ ...item, threads }); openedHere.push(...threads); previous = item.summary;
      for (const thread of threads) known.add(thread.id);
    }
    const step = await runAgent({ id: 'story:merge', label: '故事记忆 · 长段合并', instructions: mergePrompt.text, outputSchema: rollupSchema },
      { transport, context: { items: [{ id: passage.id, title: scene, parts: digested.map(item => ({ summary: item.summary, events: item.events })) }] }, objective: '合并为这一段的摘要。', signal, contextSources: [] });
    this.track(project.id, step.usage);
    const merged = (step.structured as { items: Array<{ id: string; summary: string }> }).items.find(item => item.id === passage.id)?.summary;
    // A thread opened and answered inside the same long passage was never open after it.
    const closed = new Set(digested.flatMap(item => item.threadsClosed));
    const digest = passageDigest(view, passage, {
      passageId: passage.id, summary: merged ?? digested.map(item => item.summary).join(' '),
      events: spread(digested.flatMap(item => item.events), 5), changes: spread(digested.flatMap(item => item.changes), 8), facts: spread(digested.flatMap(item => item.facts), 4),
      threadsOpened: openedHere.filter(thread => !closed.has(thread.id)).slice(0, 6), threadsClosed: [...closed].filter(id => !openedHere.some(thread => thread.id === id)),
    }, known, model, stamp());
    if (!signal.aborted) this.store.putStoryDigests(project.id, [digest]);
    return 0;
  }

  private async digestCall(projectId: string, transport: ResponseTransport, context: unknown, signal: AbortSignal): Promise<{ passages: DigestItem[] }> {
    const step = await runAgent({ id: 'story:digest', label: '故事记忆 · 场景段摘要', instructions: digestPrompt.text, outputSchema: digestSchema },
      { transport, context, objective: '为这些场景段建立故事记忆。', signal, contextSources: [] });
    this.track(projectId, step.usage);
    return step.structured as { passages: DigestItem[] };
  }

  private async rollup(project: Workspace, kind: RollupDigest['kind'], work: RollupWork[], transport: ResponseTransport, model: string, signal: AbortSignal) {
    const step = await runAgent({ id: `story:rollup:${kind}`, label: '故事记忆 · 汇总', instructions: rollupPrompts[kind].text, outputSchema: rollupSchema },
      { transport, context: { level: kind, items: work.map(item => ({ id: item.id, title: item.title, parts: item.parts })) }, objective: '生成汇总摘要。', signal, contextSources: [] });
    this.track(project.id, step.usage);
    const items = (step.structured as { items: Array<{ id: string; summary: string }> }).items, at = stamp();
    const digests: RollupDigest[] = work.map(item => ({ kind, targetId: item.id, inputHash: item.hash, title: item.title, model, updatedAt: at,
      summary: (items.find(value => value.id === item.id)?.summary ?? item.parts.map(part => part.summary).join(' ')).slice(0, kind === 'book' ? 1000 : 500) }));
    if (!signal.aborted) this.store.putStoryDigests(project.id, digests);
  }
}

interface DigestItem { passageId: string; summary: string; events: string[]; changes: PassageDigest['changes']; threadsOpened: Array<{ title: string; major: boolean }>; threadsClosed: string[]; facts: string[] }

function chapterTitle(view: StoryView, passage: Passage): string { return view.chapters[view.chapterIndex(passage.chapterId)]?.title ?? ''; }
function previousSummary(view: StoryView, passageId: string): string {
  const before = view.order[view.positionOf(passageId) - 1];
  return before ? view.digest(before.id)?.summary ?? extractSummary(before.text).closing : '';
}
function threadList(threads: StoryThread[]) { return threads.map(thread => ({ id: thread.id, title: thread.title, ...(thread.major ? { major: true } : {}) })); }

/** Thread ids come from the opening passage and the wording. A re-digest of that passage keeps the id of a similarly worded thread it
 * opened before, so closures recorded in later passages still point at the same thread. */
export function stableThreads(passageId: string, opened: Array<{ title: string; major: boolean }>, previous: StoryThread[] = []): StoryThread[] {
  const used = new Set<string>();
  return opened.map(thread => {
    const title = thread.title.trim().slice(0, 120);
    const reuse = previous.filter(old => !used.has(old.id)).map(old => ({ old, score: threadOverlap(old.title, title) }))
      .filter(item => item.score >= 0.6).sort((a, b) => b.score - a.score)[0]?.old;
    let id = reuse?.id ?? `t:${passageId}:${textHash(title).slice(0, 10)}`;
    if (used.has(id)) id = `${id}:${used.size}`;
    used.add(id);
    return { id, title, ...(thread.major ? { major: true } : {}) };
  });
}

function passageDigest(view: StoryView, passage: Passage, item: Omit<DigestItem, 'threadsOpened'> & { threadsOpened: StoryThread[] }, known: Set<string>, model: string, at: string): PassageDigest {
  return { kind: 'passage', passageId: passage.id, textHash: passageHash(view.index, passage.id)!, chars: passage.text.length, sketch: textSketch(passage.text),
    summary: item.summary.slice(0, 400), events: item.events.slice(0, 5).map(value => value.slice(0, 200)),
    changes: item.changes.slice(0, 8).map(value => ({ who: value.who.slice(0, 40), change: value.change.slice(0, 200) })),
    threadsOpened: item.threadsOpened, threadsClosed: item.threadsClosed.filter(id => known.has(id)),
    facts: item.facts.slice(0, 4).map(value => value.slice(0, 200)), model, updatedAt: at };
}

/** Up to `count` items spread evenly over the list, in order. */
function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * items.length / count)]!);
}

/** Parts of about `size` characters, cut at a paragraph or sentence end. */
export function splitParts(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const paragraph = text.lastIndexOf('\n', end);
      const sentence = Math.max(...['。', '！', '？', '!', '?'].map(mark => text.lastIndexOf(mark, end - 1)));
      if (paragraph > start + size / 2) end = paragraph + 1;
      else if (sentence > start + size / 2) end = sentence + 1;
    }
    parts.push(text.slice(start, end)); start = end;
  }
  return parts;
}

/** Consecutive pending passages in reading order, bounded by DIGEST_BATCH_CHARS. A single long passage goes alone. */
export function digestBatch(view: StoryView, skip: Set<string> = new Set()): Passage[] {
  const pending = view.pending().filter(passage => !skip.has(passage.id));
  const batch: Passage[] = [];
  let chars = 0;
  for (const passage of pending) {
    const size = Math.min(passage.text.length, LONG_PASSAGE_CHARS);
    if (batch.length && (chars + size > DIGEST_BATCH_CHARS || batch.length >= DIGEST_BATCH_PASSAGES
      || view.positionOf(passage.id) !== view.positionOf(batch.at(-1)!.id) + 1)) break;
    batch.push(passage); chars += size;
  }
  return batch;
}

export interface RollupWork { id: string; title: string; hash: string; parts: Array<{ title?: string; summary: string; events?: string[] }> }
/** Rollups whose inputs changed since they were written, bounded by ROLLUP_BATCH_CHARS. */
export function rollupBatch(view: StoryView, kind: RollupDigest['kind'], skip: Set<string> = new Set()): RollupWork[] {
  const candidates: RollupWork[] = [];
  if (kind === 'chapter') for (const chapter of view.chapters) {
    const input = view.chapterInput(chapter.id);
    if (input && view.rollup('chapter', chapter.id)?.inputHash !== input.hash) candidates.push({ id: chapter.id, title: chapter.title, hash: input.hash, parts: input.passages });
  }
  if (kind === 'volume') for (const volume of view.volumes()) {
    const input = view.volumeInput(volume.id);
    if (input && view.rollup('volume', volume.id)?.inputHash !== input.hash) candidates.push({ id: volume.id, title: volume.title, hash: input.hash, parts: input.chapters });
  }
  if (kind === 'book') {
    const input = view.bookInput();
    if (input && view.rollup('book', view.workspace.id)?.inputHash !== input.hash) candidates.push({ id: view.workspace.id, title: view.workspace.title, hash: input.hash, parts: input.volumes });
  }
  const batch: RollupWork[] = [];
  let chars = 0;
  for (const item of candidates) {
    if (skip.has(`${kind}:${item.id}`)) continue;
    const size = JSON.stringify(item.parts).length;
    if (batch.length && chars + size > ROLLUP_BATCH_CHARS) break;
    batch.push(item); chars += size;
  }
  return batch;
}

/** Offline digests derived mechanically from the prose; exercises the real pipeline without model judgment. */
export class DemoStoryTransport implements ResponseTransport {
  stream(request: ModelRequest, signal: AbortSignal) {
    checkCancelled(signal);
    const first = request.input.find(item => 'role' in item && item.role === 'user') as { content?: string } | undefined;
    const { context } = JSON.parse(String(first?.content ?? '{}')) as { context: any };
    const sentence = (text: string) => (String(text).match(/[^。！？!?\n]+[。！？!?]?/g) ?? []).map(value => value.trim()).filter(Boolean);
    const result = request.agentId === 'story:digest' ? { passages: (context.passages ?? []).map((passage: { passageId: string; text: string }) => {
      const lines = sentence(passage.text);
      return { passageId: passage.passageId, summary: lines.slice(0, 2).join('').slice(0, 150), events: lines.slice(-1), changes: [],
        threadsOpened: lines.filter(line => /[？?]|不知道/.test(line)).slice(0, 1).map(title => ({ title, major: false })), threadsClosed: [], facts: [] };
    }) } : { items: (context.items ?? []).map((item: RollupWork) => ({ id: item.id, summary: item.parts.map(part => part.summary).join(' ').slice(0, 250) })) };
    const text = JSON.stringify(result);
    const output: ResponseOutputItem[] = [{ type: 'message', id: randomUUID(), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }];
    const response: ModelResponse = { id: `demo-story-${randomUUID()}`, status: 'completed', output, output_text: text, usage: null };
    return {
      events: (async function* (): AsyncGenerator<ResponseStreamEvent> {
        checkCancelled(signal);
        yield { type: 'response.output_text.delta', delta: text, output_index: 0, content_index: 0, item_id: output[0]!.id, sequence_number: 0 } as ResponseStreamEvent;
      })(),
      finalResponse: async () => { checkCancelled(signal); return response; },
    };
  }
}
