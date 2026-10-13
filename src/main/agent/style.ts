import type { NarrativeScene, Workspace } from '../../shared/types.js';
import { styleProfile, type StyleSample } from '../../shared/style-types.js';
import { objectNames } from '../../shared/story-elements.js';
import { AI_CLICHES, styleBaseline, styleDirectives } from '../../shared/style-metrics.js';

/** Exemplars are the strongest voice signal, but they compete with story context for the writer budget. */
export const STYLE_SAMPLE_CHARS = 3600;
export const STYLE_SAMPLE_COUNT = 3;
const SAMPLE_PART = 1600;

export const REFERENCE_NOTICE = '参考范文来自其他作家，只模仿其节奏、句法与描写方式；不得复用其中的人物、情节、设定与句子。';

/** Pinned first, then the author's own, then samples that mention the people on stage; references last. */
export function pickSamples(workspace: Workspace, names: string[], limit = STYLE_SAMPLE_CHARS, count = STYLE_SAMPLE_COUNT): StyleSample[] {
  const profile = styleProfile(workspace);
  const score = (sample: StyleSample) => (sample.pinned ? 100 : 0) + (sample.source === 'own' ? 30 : 0)
    + names.filter(name => name && sample.text.includes(name)).length * 6 + Math.min(sample.text.length, 1200) / 400;
  const picked: StyleSample[] = [];
  let remaining = limit;
  for (const sample of [...profile.samples].sort((a, b) => score(b) - score(a))) {
    if (picked.length >= count || remaining < 200) break;
    const text = sample.text.length > Math.min(SAMPLE_PART, remaining) ? `${sample.text.slice(0, Math.min(SAMPLE_PART, remaining))}……` : sample.text;
    picked.push({ ...sample, text }); remaining -= text.length;
  }
  return picked;
}

function present(workspace: Workspace, scene: NarrativeScene): Array<{ id: string; name: string }> {
  const ids = new Set<string>([...(scene.povId ? [scene.povId] : []),
    ...scene.eventIds.flatMap(id => workspace.objects.find(object => object.id === id)?.event?.participants ?? [])]);
  const characters = workspace.objects.filter(object => object.typeId === 'character');
  // Characters named in the outline or prose are on stage too, even without an event binding.
  for (const character of characters) if (objectNames(character).some(name => scene.outline.includes(name) || scene.text.includes(name))) ids.add(character.id);
  return characters.filter(character => ids.has(character.id)).map(character => ({ id: character.id, name: character.name }));
}

/** What the writer must sound like: the author's profile as directives, word lists, voices and a few exemplars. */
export function writerStyle(workspace: Workspace, scene: NarrativeScene) {
  const profile = styleProfile(workspace), people = present(workspace, scene);
  const samples = pickSamples(workspace, people.map(person => person.name));
  const voices = profile.voices.filter(voice => people.some(person => person.id === voice.characterId) && voice.voice.trim())
    .map(voice => ({ name: people.find(person => person.id === voice.characterId)!.name, voice: voice.voice }));
  const avoid = [...profile.avoidWords, ...(profile.blockAiCliches ? AI_CLICHES.filter(item => item.tier === 'strong' && !profile.preferWords.includes(item.phrase)).map(item => item.phrase) : [])];
  const empty = !profile.summary.trim() && !samples.length && !profile.rules.length && !avoid.length && !voices.length && !styleDirectives(profile, null).length;
  return {
    notice: empty ? '作者尚未设定文风：沿用 recentText 的语气与节奏，避免空泛的套话与 AI 腔。'
      : '这是作者的文风，是语言层面的最高约束。先读 samples 体会句子长短、段落呼吸与描写方式，再动笔；模仿笔法而不是内容。',
    summary: profile.summary, directives: styleDirectives(profile, styleBaseline(profile)),
    do: profile.rules.filter(rule => rule.kind === 'do').map(rule => rule.content),
    avoid: profile.rules.filter(rule => rule.kind === 'avoid').map(rule => rule.content),
    avoidWords: [...new Set(avoid)], preferWords: profile.preferWords, voices,
    samples: samples.map(sample => ({ label: sample.label, source: sample.source, ...(sample.author ? { author: sample.author } : {}), text: sample.text })),
    ...(samples.some(sample => sample.source === 'reference') ? { referenceNotice: REFERENCE_NOTICE } : {}),
  };
}
export type WriterStyle = ReturnType<typeof writerStyle>;
