import type { Act, CanvasCard, CanvasLink, Chapter, Command, NarrativeScene, NovelObject, Workspace } from './types.js';
import type { CompanionAnchor, CompanionIdea, CompanionMode, CompanionNovelField, CompanionOp, CompanionProposal, CompanionResponse } from './companion-types.js';
import { cardRect, createdGroup, placeCards } from './canvas.js';
import { companionNovelFields, ideaKindNames } from './companion-types.js';
import { personNames, STYLE_LIMITS, STYLE_SCALES, styleProfile, type StyleScale, type StylePerson, type StyleScaleId } from './style-types.js';
import { isSettingLike } from './story-elements.js';

export interface CompanionSelection { ideas: CompanionIdea[]; ops: Array<{ proposal: CompanionProposal; op: CompanionOp }> }
export interface CompanionPlacement {
  mode: CompanionMode; anchor: CompanionAnchor; target?: 'canvas' | 'sceneOutline';
  placement?: { x: number; y: number }; group?: boolean; groupTitle?: string;
  /** Turn selected character / setting ideas into real characters or settings instead of canvas notes. */
  ideasAs?: 'character' | 'setting';
  /** Entities created by earlier adoptions of the same turn, keyed `${proposalId}:${ref}`. */
  knownRefs?: Record<string, string>;
  newId?: () => string;
}

/** Resolve item ids into ideas and proposal ops. Selecting an op also selects the ops that create what it refers to. */
export function selectCompanionItems(response: CompanionResponse, itemIds: readonly string[]): CompanionSelection & { unknown: string[] } {
  const wanted = new Set(itemIds), unknown: string[] = [];
  const ideas = response.ideas.filter(idea => wanted.has(idea.id));
  const ops: CompanionSelection['ops'] = [];
  for (const id of itemIds) {
    if (ideas.some(idea => idea.id === id)) continue;
    const [proposalId, opId] = id.split('#');
    const proposal = response.proposals.find(item => item.id === proposalId);
    if (!proposal || (opId && !proposal.ops.some(op => op.id === opId))) unknown.push(id);
  }
  for (const proposal of response.proposals) {
    const whole = wanted.has(proposal.id);
    const chosen = new Set(proposal.ops.filter(op => whole || wanted.has(`${proposal.id}#${op.id}`)).map(op => op.id));
    // Pull in ancestors so a selected chapter never loses its newly proposed act, nor a link its new character.
    let grew = true;
    while (grew) {
      grew = false;
      for (const op of proposal.ops) if (chosen.has(op.id)) {
        for (const handle of [op.parentRef, op.targetId, op.povName, ...op.causes, ...op.people, ...(op.places ?? []), ...(op.events ?? [])]) {
          const parent = handle ? proposal.ops.find(item => item.ref === handle && item.id !== op.id) : undefined;
          if (parent && !chosen.has(parent.id)) { chosen.add(parent.id); grew = true; }
        }
      }
    }
    for (const op of proposal.ops) if (chosen.has(op.id)) ops.push({ proposal, op });
  }
  return { ideas, ops, unknown };
}

function defaultId(): string { return globalThis.crypto.randomUUID(); }
const clean = (value: string | null | undefined) => (value ?? '').trim();
/** Midpoint insertion keeps sibling orders unique without renumbering unrelated items. */
function orderAt(sortedOrders: number[], position: number | null): number {
  if (!sortedOrders.length) return 1;
  const index = position === null || !Number.isFinite(position) ? sortedOrders.length : Math.max(0, Math.min(sortedOrders.length, Math.round(position) - 1));
  if (index >= sortedOrders.length) return sortedOrders.at(-1)! + 1;
  if (index === 0) return sortedOrders[0]! - 1;
  return (sortedOrders[index - 1]! + sortedOrders[index]!) / 2;
}

/** Character and setting ideas are titled 「名字：一句话」; fall back to the whole title. */
export function entityNameOf(title: string, fallback = '新人物'): string {
  const match = title.match(/^\s*([^：:｜|，,。]{1,12})[：:]/);
  return (match?.[1] ?? title).trim().slice(0, 40) || fallback;
}
export const characterNameOf = (title: string) => entityNameOf(title);
/** A handle the model wrote as a chapter name (「第五章 雨夜」) rather than an id or ref. */
const titleLike = (value: string) => /\p{Script=Han}/u.test(value) && Array.from(value).length <= 30;

/**
 * Convert persisted companion suggestions into domain commands.
 * Guards: never deletes, never touches written scene text, new scenes start empty, unknown targets are skipped and reported;
 * a scene whose chapter does not exist yet gets a new chapter instead of being dropped.
 */
export function companionCommands(workspace: Workspace, selection: CompanionSelection, options: CompanionPlacement): { commands: Command[]; skipped: string[]; refs: Record<string, string> } {
  const newId = options.newId ?? defaultId;
  const skipped: string[] = [];
  const acts: Act[] = structuredClone(workspace.acts ?? []);
  const chapters: Chapter[] = structuredClone(workspace.chapters);
  const scenes: NarrativeScene[] = structuredClone(workspace.scenes);
  const objects: NovelObject[] = structuredClone(workspace.objects);
  let cards: CanvasCard[] = structuredClone(workspace.cards);
  const links: CanvasLink[] = [];
  const novel: Partial<Record<CompanionNovelField, string>> = {};
  // A copy: styleProfile shares the workspace's arrays, and rules are pushed onto this one.
  const style = structuredClone(styleProfile(workspace)), styleBefore = JSON.stringify(style);
  const styleOrigin = options.anchor.focus === 'blindtest' ? 'blindtest' as const : 'samples' as const;
  const fieldsOf = (typeId: string, values: Record<string, string>) => {
    const allowed = new Set(workspace.objectTypes.find(type => type.id === typeId)?.fields.map(field => field.id));
    return Object.fromEntries(Object.entries(values).filter(([key, value]) => allowed.has(key) && value));
  };
  const isCharacter = (id: string | undefined) => !!id && objects.some(object => object.id === id && object.typeId === 'character');

  // A brand-new project starts with one empty "第一章"; let the first proposed chapter take it over.
  let placeholder = chapters.length === 1 && !scenes.length && !chapters[0]!.summary && !chapters[0]!.actId ? chapters[0] : undefined;

  const refs = new Map<string, string>(Object.entries(options.knownRefs ?? {}));
  const known = new Set(refs.keys());
  const scope = (proposal: CompanionProposal, ref: string) => `${proposal.id}:${ref}`;
  const resolve = (proposal: CompanionProposal, ref: string | null, id: string | null) => {
    if (clean(ref)) { const value = refs.get(scope(proposal, clean(ref))); if (value) return value; }
    return clean(id) || undefined;
  };
  /** A handle may be a ref created earlier in the same proposal or a real id. */
  const handle = (proposal: CompanionProposal, value: string | null) => resolve(proposal, value, value);
  /** Character by proposal ref, id or exact name; characters adopted in this batch count too. */
  const personId = (proposal: CompanionProposal, name: string | null) => {
    const value = clean(name);
    if (!value) return null;
    const byRef = refs.get(scope(proposal, value));
    if (isCharacter(byRef)) return byRef!;
    return objects.find(object => object.typeId === 'character' && (object.name === value || object.id === value))?.id ?? null;
  };
  /** Setting or event by proposal ref, id or exact name, like personId. */
  const entityId = (proposal: CompanionProposal, name: string | null, accept: (object: NovelObject) => boolean) => {
    const value = clean(name);
    if (!value) return null;
    const byRef = refs.get(scope(proposal, value));
    if (byRef && objects.some(object => object.id === byRef && accept(object))) return byRef;
    return objects.find(object => accept(object) && object.id === value)?.id ?? objects.find(object => accept(object) && object.name === value)?.id ?? null;
  };
  const placeId = (proposal: CompanionProposal, value: string | null) => entityId(proposal, value, isSettingLike);
  const eventRef = (proposal: CompanionProposal, value: string | null) => entityId(proposal, value, object => !!object.event);
  /** Resolve a scene's people / places / events; names that match nothing are collected so the author hears about them. */
  const resolveAll = (proposal: CompanionProposal, values: readonly string[] | undefined, find: (proposal: CompanionProposal, value: string | null) => string | null, missing: string[]) =>
    [...new Set((values ?? []).flatMap(value => { const id = find(proposal, value); if (!id && clean(value)) missing.push(clean(value)); return id ? [id] : []; }))];

  /** Reading order for a chapter placed right after `afterId`, or after the last chapter. */
  const orderAfter = (afterId: string | undefined) => {
    const sorted = [...chapters].sort((a, b) => a.order - b.order), index = afterId ? sorted.findIndex(chapter => chapter.id === afterId) : -1;
    if (index < 0) return (sorted.at(-1)?.order ?? 0) + 1;
    const next = sorted[index + 1];
    return next ? (sorted[index]!.order + next.order) / 2 : sorted[index]!.order + 1;
  };
  /** A chapter by proposal ref, real id, or an existing chapter's exact title (models often write the title). */
  const chapterOf = (proposal: CompanionProposal, ...values: Array<string | null>) => {
    for (const value of values.map(clean)) {
      if (!value) continue;
      const byRef = refs.get(scope(proposal, value));
      if (byRef && chapters.some(chapter => chapter.id === byRef)) return byRef;
      const found = chapters.find(chapter => chapter.id === value) ?? chapters.find(chapter => chapter.title.trim() === value);
      if (found) return found.id;
    }
    return undefined;
  };
  /** An act a scene op pointed at by mistake; the chapter opened for the scene then joins that act. */
  const actOf = (proposal: CompanionProposal, op: CompanionOp) => {
    const id = resolve(proposal, op.parentRef, op.parentId);
    return id && acts.some(act => act.id === id) ? id : undefined;
  };
  // A scene proposed where no chapter exists yet gets a new chapter, right after the chapter the author pointed at.
  const anchorScene = options.anchor.sceneId ?? options.anchor.references.flatMap(reference => reference.kind === 'scene' ? [reference.id]
    : reference.kind === 'card' ? cards.filter(card => card.id === reference.id && card.kind === 'scene' && card.refId).map(card => card.refId!) : [])[0];
  let autoAfter = scenes.find(scene => scene.id === anchorScene)?.chapterId;
  const autoChapters = new Map<string, string>();
  /** One chapter per unresolved handle; a scene without any handle gets a chapter named after itself. */
  const autoChapter = (proposal: CompanionProposal, handleText: string, sceneTitle: string, actId?: string) => {
    const known = handleText ? autoChapters.get(handleText) : undefined;
    if (known) return known;
    const title = titleLike(handleText) ? handleText : sceneTitle;
    let chapter: Chapter;
    if (placeholder) { chapter = placeholder; placeholder = undefined; Object.assign(chapter, { title, ...(actId ? { actId } : {}) }); }
    else {
      const sorted = [...chapters].sort((a, b) => a.order - b.order);
      const after = actId ? sorted.filter(item => item.actId === actId).at(-1) : chapters.find(item => item.id === autoAfter);
      const inAct = actId ?? after?.actId;
      chapter = { id: newId(), title, order: orderAfter(after?.id), ...(inAct ? { actId: inAct } : {}) };
      chapters.push(chapter);
    }
    // Consecutive new chapters keep the order they were proposed in.
    autoAfter = chapter.id;
    if (handleText) {
      autoChapters.set(handleText, chapter.id);
      // Later partial adoptions of the same turn that name this handle reuse the chapter.
      refs.set(scope(proposal, handleText), chapter.id);
    }
    return chapter.id;
  };

  const anchorCards = options.anchor.references.flatMap(reference => {
    const card = reference.kind === 'card' ? cards.find(item => item.id === reference.id)
      : cards.find(item => item.kind === reference.kind && item.refId === reference.id);
    return card ? [card] : [];
  });
  const anchor = anchorCards[0];
  const center = (() => {
    if (options.placement) return options.placement;
    if (options.anchor.point) return options.anchor.point;
    if (anchor) { const rect = cardRect(anchor); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; }
    const right = Math.max(0, ...cards.map(card => cardRect(card).x + cardRect(card).width));
    return { x: right + 320, y: 240 };
  })();
  /** Cards new in this batch; those in `spokes` also get a link from the anchor card. */
  const newCards: CanvasCard[] = [];
  const spokes = new Set<string>();
  const placeCard = (title: string, content: string) => {
    const card: CanvasCard = { id: newId(), kind: 'note', title: title || '新的灵感', content, x: 0, y: 0 };
    newCards.push(card); spokes.add(card.id); return card;
  };
  /** The canvas card standing for an id: the card itself, an existing reference card, or a new one. */
  const cardFor = (id: string, spoke = false): CanvasCard | undefined => {
    const card = cards.find(item => item.id === id) ?? newCards.find(item => item.id === id)
      ?? [...cards, ...newCards].find(item => (item.kind === 'object' || item.kind === 'scene') && item.refId === id);
    if (card) return card;
    const object = objects.find(item => item.id === id), scene = scenes.find(item => item.id === id);
    if (!object && !scene) return undefined;
    const created: CanvasCard = { id: newId(), kind: object ? 'object' : 'scene', refId: id, title: object?.name ?? scene!.title, content: '', x: 0, y: 0 };
    newCards.push(created); if (spoke) spokes.add(created.id);
    return created;
  };
  const connect = (source: string, target: string) => {
    if (source === target) return false;
    const exists = [...workspace.canvasLinks, ...links].some(link => (link.source === source && link.target === target) || (link.source === target && link.target === source));
    if (!exists) links.push({ id: newId(), source, target });
    return true;
  };
  const onCanvas = options.anchor.surface === 'canvas';
  const addCharacter = (name: string, description: string, goal: string) => {
    const existing = objects.find(object => object.typeId === 'character' && object.name === name);
    if (existing) return { id: existing.id, created: false };
    const id = newId();
    objects.push({ id, typeId: 'character', name, fields: fieldsOf('character', { description, goal }) });
    // Characters are the core material of the canvas: always give them a card there.
    cardFor(id, true);
    return { id, created: true };
  };
  /** Settings mirror characters; on the canvas they get a reference card like events do. */
  const addSetting = (name: string, description: string, rules: string) => {
    const existing = objects.find(object => isSettingLike(object) && object.name === name);
    if (existing) return { id: existing.id, created: false };
    const id = newId();
    objects.push({ id, typeId: 'setting', name, fields: fieldsOf('setting', { description, rules }) });
    if (onCanvas) cardFor(id, true);
    return { id, created: true };
  };

  for (const idea of selection.ideas) {
    const body = [idea.content, idea.hook && `钩子：${idea.hook}`].filter(Boolean).join('\n');
    if (options.ideasAs === 'character' && idea.kind === 'character') {
      if (!addCharacter(characterNameOf(idea.title), body, '').created) skipped.push(`${idea.title}：同名人物已存在`);
      continue;
    }
    if (options.ideasAs === 'setting' && idea.kind === 'setting') {
      if (!addSetting(entityNameOf(idea.title, '新的环境'), body, '').created) skipped.push(`${idea.title}：同名环境已存在`);
      continue;
    }
    if (options.target === 'sceneOutline') {
      const scene = scenes.find(item => item.id === options.anchor.sceneId);
      if (!scene) { skipped.push(`${idea.title}：目标场景不存在`); continue; }
      const line = `· ${idea.title}：${body.replace(/\n/g, ' ')}`;
      if (!scene.outline.includes(line)) scene.outline = scene.outline.trim() ? `${scene.outline.trimEnd()}\n${line}` : line;
      continue;
    }
    placeCard(`${ideaKindNames[idea.kind] ?? ''}｜${idea.title}`.replace(/^｜/, ''), body);
  }

  for (const { proposal, op } of selection.ops) {
    const label = clean(op.title) || op.op;
    const skip = (reason: string) => skipped.push(`${label}：${reason}`);
    switch (op.op) {
      case 'addAct': {
        const id = newId();
        acts.push({ id, title: label, order: orderAt(acts.map(act => act.order).sort((a, b) => a - b), op.order), purpose: clean(op.purpose), summary: clean(op.content) });
        if (op.ref) refs.set(scope(proposal, op.ref), id);
        break;
      }
      case 'updateAct': {
        const act = acts.find(item => item.id === op.targetId);
        if (!act) { skip('幕/卷不存在'); break; }
        if (clean(op.title)) act.title = clean(op.title);
        if (clean(op.purpose)) act.purpose = clean(op.purpose);
        if (clean(op.content)) act.summary = clean(op.content);
        break;
      }
      case 'addChapter': {
        const actId = resolve(proposal, op.parentRef, op.parentId);
        if (actId && !acts.some(act => act.id === actId)) { skip('所属幕/卷不存在'); break; }
        const sorted = [...chapters].sort((a, b) => a.order - b.order);
        // targetId names the chapter this one follows, so a restructure can open a chapter between two existing ones.
        const afterId = clean(op.targetId) ? chapterOf(proposal, op.targetId) : undefined;
        let chapter: Chapter;
        if (afterId) {
          if (placeholder?.id === afterId) placeholder = undefined;
          const inAct = actId ?? chapters.find(item => item.id === afterId)!.actId;
          chapter = { id: newId(), title: label, order: orderAfter(afterId), summary: clean(op.content), ...(inAct ? { actId: inAct } : {}) };
          chapters.push(chapter);
        } else if (placeholder) {
          chapter = placeholder; placeholder = undefined;
          Object.assign(chapter, { title: label, summary: clean(op.content), ...(actId ? { actId } : {}) });
        } else {
          // Within an act, position counts among that act's chapters; the new chapter follows the act's last chapter.
          const siblings = actId ? sorted.filter(item => item.actId === actId) : sorted;
          let order: number;
          if (actId && op.order === null && siblings.length) {
            const last = siblings.at(-1)!, next = sorted[sorted.indexOf(last) + 1];
            order = next ? (last.order + next.order) / 2 : last.order + 1;
          } else if (actId && !siblings.length) {
            const actOrder = acts.find(act => act.id === actId)!.order;
            const before = sorted.filter(item => item.actId && (acts.find(act => act.id === item.actId)?.order ?? -Infinity) < actOrder).at(-1);
            const next = before ? sorted[sorted.indexOf(before) + 1] : sorted.find(item => item.actId);
            order = before ? (next ? (before.order + next.order) / 2 : before.order + 1) : next ? next.order - 1 : orderAt(sorted.map(item => item.order), null);
          } else {
            const index = op.order === null ? siblings.length : Math.max(0, Math.min(siblings.length, Math.round(op.order) - 1));
            const at = siblings[index], previous = siblings[index - 1];
            const all = sorted.map(item => item.order);
            order = at ? orderAt(all, sorted.indexOf(at) + 1) : previous ? orderAt(all, sorted.indexOf(previous) + 2) : orderAt(all, null);
          }
          chapter = { id: newId(), title: label, order, summary: clean(op.content), ...(actId ? { actId } : {}) };
          chapters.push(chapter);
        }
        if (op.ref) refs.set(scope(proposal, op.ref), chapter.id);
        break;
      }
      case 'updateChapter': {
        const chapter = chapters.find(item => item.id === op.targetId);
        if (!chapter) { skip('章节不存在'); break; }
        if (clean(op.title)) chapter.title = clean(op.title);
        if (clean(op.content)) chapter.summary = clean(op.content);
        const actId = resolve(proposal, op.parentRef, op.parentId);
        if (actId) { if (acts.some(act => act.id === actId)) chapter.actId = actId; else skip('所属幕/卷不存在'); }
        break;
      }
      case 'addScene': {
        // A scene always lands in a chapter: the named one, the anchor scene's, or a new chapter opened for it.
        const named = clean(op.parentRef) || clean(op.parentId);
        const chapterId = chapterOf(proposal, op.parentRef, op.parentId)
          ?? (!named && options.anchor.sceneId ? scenes.find(item => item.id === options.anchor.sceneId)?.chapterId : undefined)
          ?? autoChapter(proposal, named, label, actOf(proposal, op));
        const missing: string[] = [];
        const povId = personId(proposal, op.povName);
        const castIds = resolveAll(proposal, op.people, personId, missing).filter(id => id !== povId);
        const settingIds = resolveAll(proposal, op.places, placeId, missing);
        const siblings = scenes.filter(item => item.chapterId === chapterId).map(item => item.order).sort((a, b) => a - b);
        const scene: NarrativeScene = { id: newId(), chapterId, order: orderAt(siblings, op.order), title: label, povId, eventIds: resolveAll(proposal, op.events, eventRef, missing),
          outline: clean(op.content), text: '', ...(castIds.length ? { castIds } : {}), ...(settingIds.length ? { settingIds } : {}) };
        if (missing.length) skip(`${missing.map(value => `「${value}」`).join('、')}不在作品中，未关联`);
        scenes.push(scene);
        if (op.ref) refs.set(scope(proposal, op.ref), scene.id);
        if (onCanvas) cardFor(scene.id, true);
        break;
      }
      case 'updateScene': {
        const scene = scenes.find(item => item.id === op.targetId);
        if (!scene) { skip('场景不存在'); break; }
        if (clean(op.title)) scene.title = clean(op.title);
        if (clean(op.content)) scene.outline = clean(op.content);
        if (clean(op.povName)) { const pov = personId(proposal, op.povName); if (pov) scene.povId = pov; else if (/全知|外部/.test(clean(op.povName))) scene.povId = null; }
        // Elements are filled in, never taken away: an update only adds people, places and events.
        const missing: string[] = [];
        const cast = resolveAll(proposal, op.people, personId, missing), places = resolveAll(proposal, op.places, placeId, missing), presented = resolveAll(proposal, op.events, eventRef, missing);
        if (cast.length) scene.castIds = [...new Set([...(scene.castIds ?? []), ...cast])].filter(id => id !== scene.povId);
        if (places.length) scene.settingIds = [...new Set([...(scene.settingIds ?? []), ...places])];
        if (presented.length) scene.eventIds = [...new Set([...scene.eventIds, ...presented])];
        if (missing.length) skip(`${missing.map(value => `「${value}」`).join('、')}不在作品中，未关联`);
        break;
      }
      case 'moveScene': {
        const scene = scenes.find(item => item.id === op.targetId);
        if (!scene) { skip('场景不存在'); break; }
        const named = clean(op.parentRef) || clean(op.parentId);
        const chapterId = chapterOf(proposal, op.parentRef, op.parentId) ?? (named ? autoChapter(proposal, named, scene.title, actOf(proposal, op)) : scene.chapterId);
        const siblings = scenes.filter(item => item.chapterId === chapterId && item.id !== scene.id).map(item => item.order).sort((a, b) => a - b);
        scene.chapterId = chapterId; scene.order = orderAt(siblings, op.order);
        break;
      }
      case 'addEvent': {
        const events = objects.filter(object => object.event);
        const causes = op.causes.map(item => handle(proposal, item)).filter((id): id is string => !!id && events.some(event => event.id === id));
        const effectId = handle(proposal, op.targetId);
        const effect = effectId ? events.find(event => event.id === effectId) : undefined;
        if (op.targetId && !effect) { skip('被引发的事件不存在'); break; }
        const lower = causes.length ? Math.max(...causes.map(id => events.find(event => event.id === id)!.event!.worldOrder)) : undefined;
        const upper = effect?.event!.worldOrder;
        if (lower !== undefined && upper !== undefined && lower >= upper) { skip('前因必须早于结果'); break; }
        const worldOrder = lower !== undefined && upper !== undefined ? (lower + upper) / 2 : lower !== undefined ? lower + 1 : upper !== undefined ? upper - 1
          : Math.max(0, ...events.map(event => event.event!.worldOrder)) + 1;
        const thread = (effect ?? events.find(event => causes.includes(event.id)))?.event!.thread ?? '主线';
        const participants = [...new Set(op.people.map(person => personId(proposal, person)).filter((id): id is string => !!id))];
        const id = newId();
        objects.push({ id, typeId: 'event', name: label, fields: fieldsOf('event', { description: clean(op.content), purpose: clean(op.purpose) }),
          event: { worldOrder, timeLabel: '', thread, participants, causes, critical: false, observations: {} } });
        if (effect && !effect.event!.causes.includes(id)) effect.event!.causes.push(id);
        if (op.ref) refs.set(scope(proposal, op.ref), id);
        if (onCanvas) cardFor(id, true);
        break;
      }
      case 'addCause': {
        const effect = objects.find(object => object.event && object.id === handle(proposal, op.targetId));
        if (!effect) { skip('结果事件不存在'); break; }
        if (!op.causes.length) { skip('没有指定前因'); break; }
        for (const item of op.causes) {
          const cause = objects.find(object => object.event && object.id === handle(proposal, item));
          if (!cause || cause.id === effect.id) { skip('前因事件不存在'); continue; }
          if (cause.event!.worldOrder >= effect.event!.worldOrder) { skip(`「${cause.name}」不早于「${effect.name}」`); continue; }
          if (!effect.event!.causes.includes(cause.id)) effect.event!.causes.push(cause.id);
        }
        break;
      }
      case 'addCard': {
        const card = placeCard(label, [clean(op.content), clean(op.purpose)].filter(Boolean).join('\n'));
        if (op.ref) refs.set(scope(proposal, op.ref), card.id);
        break;
      }
      case 'addCharacter': {
        const name = clean(op.title);
        if (!name) { skip('缺少人物名'); break; }
        const result = addCharacter(name, clean(op.content), clean(op.purpose));
        if (!result.created) skip('同名人物已存在，沿用原人物');
        if (op.ref) refs.set(scope(proposal, op.ref), result.id);
        break;
      }
      case 'addSetting': {
        const name = clean(op.title);
        if (!name) { skip('缺少环境名称'); break; }
        const result = addSetting(name, clean(op.content), clean(op.purpose));
        if (!result.created) skip('同名环境已存在，沿用原环境');
        if (op.ref) refs.set(scope(proposal, op.ref), result.id);
        break;
      }
      case 'updateSetting': {
        const setting = objects.find(object => isSettingLike(object) && object.id === placeId(proposal, op.targetId));
        if (!setting) { skip('环境不存在'); break; }
        const name = clean(op.title);
        if (name && name !== setting.name && !objects.some(object => isSettingLike(object) && object.name === name)) setting.name = name;
        setting.fields = { ...setting.fields, ...fieldsOf(setting.typeId, { description: clean(op.content), rules: clean(op.purpose) }) };
        break;
      }
      case 'updateCharacter': {
        const character = objects.find(object => object.typeId === 'character' && object.id === handle(proposal, op.targetId));
        if (!character) { skip('人物不存在'); break; }
        const name = clean(op.title);
        if (name && name !== character.name && !objects.some(object => object.typeId === 'character' && object.name === name)) character.name = name;
        character.fields = { ...character.fields, ...fieldsOf('character', { description: clean(op.content), goal: clean(op.purpose) }) };
        break;
      }
      case 'updateNovel': {
        const field = clean(op.field ?? op.purpose) as CompanionNovelField;
        if (!companionNovelFields.includes(field)) { skip('不支持修改这个作品字段'); break; }
        if (!clean(op.content)) { skip('内容为空'); break; }
        novel[field] = clean(op.content);
        break;
      }
      case 'updateStyle': {
        const field = clean(op.field), content = clean(op.content);
        if (!content) { skip('内容为空'); break; }
        if (field === 'summary') { style.summary = content.slice(0, STYLE_LIMITS.summary); break; }
        if (field.startsWith('dial:')) {
          const dial = field.slice(5);
          if (dial === 'person') {
            const person = (Object.keys(personNames) as StylePerson[]).find(key => key === content || personNames[key] === content);
            if (person) style.dials.person = person; else skip('叙述人称无效');
          } else if ((STYLE_SCALES as readonly string[]).includes(dial)) {
            const value = Number(content.match(/[1-5]/)?.[0]);
            if (value) style.dials[dial as StyleScaleId] = value as StyleScale; else skip('笔调旋钮需要 1–5');
          } else skip('未知笔调旋钮');
          break;
        }
        if (field === 'rule:do' || field === 'rule:avoid') {
          const kind = field === 'rule:do' ? 'do' as const : 'avoid' as const;
          if (style.rules.some(rule => rule.content === content)) { skip('规则已存在'); break; }
          if (style.rules.length >= STYLE_LIMITS.rules) { skip('文风规则已满'); break; }
          style.rules.push({ id: newId(), kind, content, origin: styleOrigin });
          break;
        }
        if (field === 'preferWords' || field === 'avoidWords') {
          const words = content.split(/[、，,；;\s]+/).map(word => word.trim()).filter(word => word && word.length <= 40);
          style[field] = [...new Set([...style[field], ...words])].slice(0, STYLE_LIMITS.words);
          break;
        }
        if (field === 'voice') {
          const characterId = isCharacter(handle(proposal, op.targetId)) ? handle(proposal, op.targetId)! : personId(proposal, op.povName ?? op.title);
          if (!characterId) { skip('人物不存在'); break; }
          style.voices = [...style.voices.filter(voice => voice.characterId !== characterId), { characterId, voice: content.slice(0, STYLE_LIMITS.voice) }];
          break;
        }
        skip('不支持修改这个文风字段');
        break;
      }
      case 'link': {
        const from = resolve(proposal, op.parentRef, op.parentId), to = handle(proposal, op.targetId);
        const source = from ? cardFor(from) : undefined, target = to ? cardFor(to) : undefined;
        if (!source || !target) { skip('连线的一端不存在'); break; }
        if (!connect(source.id, target.id)) skip('不能连向自己');
        break;
      }
      default: skip('不支持的操作');
    }
  }

  if (newCards.length) {
    const grouped = !!options.group && [...spokes].length > 1;
    placeCards(cards, newCards, { anchor, center, radial: !!anchor && !grouped });
    if (anchor) for (const card of newCards) if (spokes.has(card.id)) connect(anchor.id, card.id);
    cards.push(...newCards);
    if (grouped) {
      cards = createdGroup(cards, newCards.map(card => card.id), newId());
      const group = cards.at(-1)!;
      group.title = options.groupTitle?.trim() || (anchor ? `「${anchor.title}」的延伸` : '创作伙伴的灵感');
    }
  }

  const commands: Command[] = [];
  if (Object.keys(novel).length) commands.push({ type: 'updateNovel', patch: novel });
  if (JSON.stringify(style) !== styleBefore) {
    const before = styleProfile(workspace);
    commands.push({ type: 'updateStyle', patch: Object.fromEntries((['summary', 'dials', 'rules', 'preferWords', 'avoidWords', 'voices'] as const)
      .filter(key => JSON.stringify(style[key]) !== JSON.stringify(before[key])).map(key => [key, style[key]])) });
  }
  const changed = <T extends { id: string }>(before: readonly T[], after: readonly T[]) =>
    after.filter(item => JSON.stringify(item) !== JSON.stringify(before.find(old => old.id === item.id)));
  for (const value of changed(workspace.acts ?? [], acts)) commands.push({ type: 'putAct', value });
  // Characters before events, so new participants are readable in order.
  for (const value of changed(workspace.objects, objects).sort((a, b) => Number(!!a.event) - Number(!!b.event))) commands.push({ type: 'putObject', value });
  for (const value of changed(workspace.chapters, chapters)) commands.push({ type: 'putChapter', value });
  for (const value of changed(workspace.scenes, scenes)) {
    const original = workspace.scenes.find(item => item.id === value.id);
    if ((original && original.text !== value.text) || (!original && value.text)) throw new Error('创作伙伴不能修改正文');
    commands.push({ type: 'putScene', value });
  }
  // Groups must exist before members reference them; validation runs on the whole batch, but keep the order readable.
  const changedCards = changed(workspace.cards, cards).sort((a, b) => Number(b.kind === 'group') - Number(a.kind === 'group'));
  for (const value of changedCards) commands.push({ type: 'putCard', value });
  for (const value of links) commands.push({ type: 'putCanvasLink', value });
  return { commands, skipped, refs: Object.fromEntries([...refs].filter(([key]) => !known.has(key))) };
}
