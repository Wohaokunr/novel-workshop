import type { Workspace } from './types.js';
import type { CompanionFocus, CompanionMode } from './companion-types.js';
import { companionNovelFields, novelFieldNames } from './companion-types.js';
import { isSettingLike, sceneElements } from './story-elements.js';

/** Zero-token summary of what the author has and what is still missing; shared by the UI and the partner's context. */
export interface StoryGaps {
  emptyFields: string[];
  characters: number; settings: number; events: number; acts: number;
  scenes: number; outlinedScenes: number; writtenChars: number;
  notes: number; unlinkedNotes: number;
  /** Scenes still missing one of the three elements: no people on stage, no place, or nothing happening. */
  sceneElementGaps: { noPeople: number; noPlace: number; noPlot: number };
  /** Too little to infer from: the partner should ask before drafting. */
  sparse: boolean;
}

const chars = (text: string | undefined) => (text ?? '').replace(/\s/g, '').length;

export function storyGaps(workspace: Workspace): StoryGaps {
  const linked = new Set(workspace.canvasLinks.flatMap(link => [link.source, link.target]));
  const notes = workspace.cards.filter(card => card.kind === 'note');
  const characters = workspace.objects.filter(object => object.typeId === 'character').length;
  const brief = chars(workspace.brief);
  const sceneElementGaps = { noPeople: 0, noPlace: 0, noPlot: 0 };
  for (const scene of workspace.scenes) for (const missing of sceneElements(workspace, scene).missing) {
    if (missing === 'people') sceneElementGaps.noPeople++; else if (missing === 'place') sceneElementGaps.noPlace++; else sceneElementGaps.noPlot++;
  }
  return {
    emptyFields: companionNovelFields.filter(field => !chars(workspace[field])).map(field => novelFieldNames[field]),
    characters,
    settings: workspace.objects.filter(isSettingLike).length,
    events: workspace.objects.filter(object => object.event).length,
    acts: workspace.acts?.length ?? 0,
    scenes: workspace.scenes.length,
    outlinedScenes: workspace.scenes.filter(scene => scene.outline.trim()).length,
    writtenChars: workspace.passages.reduce((sum, passage) => sum + chars(passage.text), 0),
    notes: notes.length,
    unlinkedNotes: notes.filter(card => !linked.has(card.id)).length,
    sceneElementGaps,
    sparse: brief < 30 && !characters && !notes.length && !chars(workspace.theme) && !workspace.scenes.some(scene => scene.outline.trim()) && !workspace.passages.some(passage => passage.text.trim()),
  };
}

export type FlowStageId = 'profile' | 'theme' | 'cast' | 'setting' | 'ideas' | 'world' | 'outline' | 'order' | 'write';
/** Pages a stage opens; a subset of the renderer's View. */
export type FlowView = 'home' | 'objects' | 'canvas' | 'world' | 'outline' | 'story' | 'write';
export interface FlowAssist { mode: CompanionMode; focus?: CompanionFocus; label: string; message: string }
export interface FlowStage { id: FlowStageId; label: string; hint: string; done: boolean; view: FlowView; assist: FlowAssist | null }

/** The intended order of work, from a loose idea to prose. Each stage names the partner mode that helps with it. */
export function storyFlow(workspace: Workspace): FlowStage[] {
  const gaps = storyGaps(workspace);
  const incomplete = Math.max(gaps.sceneElementGaps.noPeople, gaps.sceneElementGaps.noPlace, gaps.sceneElementGaps.noPlot);
  return [
    { id: 'profile', label: '写下创作简述', hint: '核心冲突或一个念头', done: !!chars(workspace.brief), view: 'home',
      assist: { mode: 'develop', focus: 'profile', label: 'AI 补全作品信息', message: '根据我已经填写的信息，推断并补全作品信息里还空着的部分。' } },
    { id: 'theme', label: '确立小说立意', hint: '人物的选择与代价', done: !!chars(workspace.theme), view: 'home',
      assist: { mode: 'develop', focus: 'theme', label: 'AI 推断立意', message: workspace.theme?.trim() ? '在现有立意的基础上深化，给我几个不同侧重的版本。' : '根据我已有的信息推断几个立意方向；信息不够就先问我几个选择题。' } },
    { id: 'cast', label: '建立人物阵容', hint: '谁在推动故事', done: gaps.characters > 0, view: 'objects',
      assist: { mode: 'develop', focus: 'cast', label: 'AI 设计人物', message: gaps.characters ? '在现有人物之外补充几个能制造冲突的人物，并理清他们之间的关系。' : '根据作品信息和立意，设计一组主要人物和他们之间的关系。' } },
    { id: 'setting', label: '搭建故事环境', hint: '人物在哪里行动，世界有什么规则', done: gaps.settings > 0, view: 'objects',
      assist: { mode: 'develop', focus: 'setting', label: 'AI 设计环境', message: gaps.settings ? '在现有环境之外补充几个能制造冲突的地点或设定，写清各自的规则与代价。' : '根据作品信息、立意和人物，设计故事发生的几个主要环境，写清各自的氛围与世界规则。' } },
    { id: 'ideas', label: '在画布上发散灵感', hint: '把念头连成网', done: gaps.notes > 0 && gaps.unlinkedNotes < gaps.notes, view: 'canvas',
      assist: { mode: 'diverge', label: 'AI 发散灵感', message: '根据作品信息和人物，往几个截然不同的方向发散。' } },
    { id: 'world', label: '编排世界事件', hint: '真实发生的因果', done: gaps.events > 0, view: 'world',
      assist: { mode: 'causality', label: 'AI 推演事件', message: gaps.events ? '现有事件还缺哪些前因和后果？' : '根据人物和灵感，推演故事里真实发生的几件关键事件及其因果。' } },
    { id: 'outline', label: '搭建大纲', hint: '幕 → 章 → 场景', done: gaps.acts > 0 || gaps.outlinedScenes > 0, view: 'outline',
      assist: { mode: 'outline', label: 'AI 展开大纲', message: '把故事骨架展开成幕/卷。' } },
    { id: 'order', label: '安排叙述顺序', hint: incomplete ? `${incomplete} 个场景的人物、情节或环境还不完整` : '读者看到的顺序', done: gaps.scenes >= 3, view: 'story',
      assist: { mode: 'structure', label: 'AI 诊断结构', message: incomplete ? '诊断现在的叙述顺序和节奏，并指出人物、情节或环境不完整的场景。' : '诊断现在的叙述顺序和节奏。' } },
    { id: 'write', label: '写出正文', hint: '从第一句开始', done: gaps.writtenChars > 0, view: 'write', assist: null },
  ];
}

export function nextStage(workspace: Workspace): FlowStage | undefined {
  return storyFlow(workspace).find(stage => !stage.done);
}
