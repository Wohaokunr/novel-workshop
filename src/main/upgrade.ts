import { isDeepStrictEqual } from 'node:util';
import type { Change, Command, NarrativeScene, Passage, StateChange, Workspace } from '../shared/types.js';
import type { StyleSample } from '../shared/style-types.js';

/** Format 1 kept a scene's prose on the scene, in one chapter, and a character's state per world event. Version 2 makes scenes stand on
 * their own (prose lives in passages, one per chapter the scene runs through) and records state changes of characters and settings.
 * These conversions read old backups, the operation history and run records; ids are kept, so a scene's prose becomes the passage with
 * the scene's id and story digests, vectors, layouts and style provenance keyed by it stay valid. */
export interface LegacyScene {
  id: string; chapterId: string; order: number; title: string; povId: string | null;
  eventIds: string[]; outline: string; text: string; castIds?: string[]; settingIds?: string[];
}
export interface LegacyCharacterState {
  id: string; characterId: string; eventId: string;
  perspective: string; psychology: string; motivation: string; evidence: string; sceneIds: string[];
}
type LegacySample = StyleSample & { sceneId?: string };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function splitLegacyScene(value: LegacyScene): { scene: NarrativeScene; passage: Passage } {
  const { chapterId, order, text, ...scene } = value;
  return { scene, passage: { id: value.id, sceneId: value.id, chapterId, order, text } };
}

/** A per-event state becomes a change at that event, in the first scene that showed it; a state with nothing in it is dropped. */
export function legacyStateChange(state: LegacyCharacterState): StateChange | undefined {
  const aspects = Object.fromEntries((['psychology', 'perspective', 'motivation'] as const).flatMap(key => typeof state[key] === 'string' && state[key].trim() ? [[key, state[key]]] : []));
  if (!Object.keys(aspects).length) return undefined;
  const sceneId = Array.isArray(state.sceneIds) ? state.sceneIds[0] : undefined;
  return { id: state.id, subjectId: state.characterId, ...(sceneId ? { sceneId } : {}), eventId: state.eventId, aspects,
    ...(typeof state.evidence === 'string' && state.evidence.trim() ? { note: state.evidence } : {}) };
}

function upgradeSamples(samples: unknown): unknown {
  if (!Array.isArray(samples)) return samples;
  return samples.map((sample: LegacySample) => {
    if (!isRecord(sample) || sample.sceneId === undefined) return sample;
    const { sceneId, ...rest } = sample;
    return { ...rest, passageId: sceneId };
  });
}

/** A workspace in format 2; format 1 is converted, format 2 is returned as stored. */
export function upgradeWorkspace<T>(value: T): T | Workspace {
  if (!isRecord(value) || value.schemaVersion !== 1) return value;
  const legacy = value as Record<string, unknown>;
  const parts = (Array.isArray(legacy.scenes) ? legacy.scenes as LegacyScene[] : []).map(splitLegacyScene);
  const { characterStates, ...rest } = legacy;
  const style = isRecord(legacy.style) ? { ...legacy.style, samples: upgradeSamples(legacy.style.samples) } : undefined;
  return { ...rest, schemaVersion: 2, scenes: parts.map(part => part.scene), passages: parts.map(part => part.passage),
    stateChanges: (Array.isArray(characterStates) ? characterStates as LegacyCharacterState[] : []).flatMap(state => legacyStateChange(state) ?? []),
    ...(style ? { style } : {}) } as unknown as Workspace;
}

/** History recorded in format 1, rewritten so undo works on the upgraded book: a scene change splits into its scene and its passage,
 * a character state into a state change; changes that convert to nothing are dropped. */
export function upgradeChanges(changes: Change[]): Change[] {
  const result: Change[] = [];
  const add = (collection: string, key: string, before: unknown, after: unknown) => {
    if (!isDeepStrictEqual(before, after)) result.push({ collection, key, before, after });
  };
  for (const change of changes) {
    if (change.collection === 'scenes' && (isRecord(change.before) && 'chapterId' in change.before || isRecord(change.after) && 'chapterId' in change.after)) {
      const before = isRecord(change.before) ? splitLegacyScene(change.before as unknown as LegacyScene) : undefined;
      const after = isRecord(change.after) ? splitLegacyScene(change.after as unknown as LegacyScene) : undefined;
      add('scenes', change.key, before?.scene, after?.scene);
      add('passages', change.key, before?.passage, after?.passage);
    } else if (change.collection === 'characterStates') {
      const convert = (value: unknown) => isRecord(value) ? legacyStateChange(value as unknown as LegacyCharacterState) : undefined;
      add('stateChanges', change.key, convert(change.before), convert(change.after));
    } else if (change.collection === 'style' && change.key === 'samples') {
      add('style', 'samples', upgradeSamples(change.before), upgradeSamples(change.after));
    } else result.push(change);
  }
  return result;
}

/** Commands in the format 1 shape for character states, as older prompts and stored drafts may still produce them. */
export function upgradeCommand(command: Command): Command {
  const legacy = command as unknown as { type: string; value?: LegacyCharacterState; id?: string };
  if (legacy.type === 'putCharacterState' && isRecord(legacy.value)) {
    const value = legacyStateChange(legacy.value);
    return value ? { type: 'putStateChange', value } : { type: 'deleteStateChange', id: String(legacy.value.id) };
  }
  if (legacy.type === 'deleteCharacterState') return { type: 'deleteStateChange', id: String(legacy.id) };
  return command;
}
