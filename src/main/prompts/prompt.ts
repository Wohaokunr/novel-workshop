import { createHash } from 'node:crypto';

/** A model instruction with a version derived from its text: editing the text changes the version, nothing to bump by hand. */
export interface Prompt { id: string; text: string; version: string }

export function promptVersion(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12); }
export function prompt(id: string, text: string): Prompt { return { id, text, version: promptVersion(text) }; }
/** A family of prompts keyed by name; ids are `${family}.${key}`. */
export function prompts<K extends string>(family: string, texts: Record<K, string>): Record<K, Prompt> {
  return Object.fromEntries(Object.entries<string>(texts).map(([key, text]) => [key, prompt(`${family}.${key}`, text)])) as Record<K, Prompt>;
}
