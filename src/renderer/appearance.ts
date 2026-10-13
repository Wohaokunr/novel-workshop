import { useSyncExternalStore } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type AccentName = 'indigo' | 'teal' | 'green' | 'amber' | 'rose' | 'graphite';
export interface Appearance { mode: ThemeMode; accent: AccentName }

export const accents: Array<{ id: AccentName; label: string; swatch: string }> = [
  { id: 'indigo', label: '靛青', swatch: '#4f5bd5' },
  { id: 'teal', label: '松石', swatch: '#0e8174' },
  { id: 'green', label: '竹青', swatch: '#2f7d46' },
  { id: 'amber', label: '琥珀', swatch: '#b05f12' },
  { id: 'rose', label: '胭脂', swatch: '#c03a64' },
  { id: 'graphite', label: '墨灰', swatch: '#52525b' },
];
export const modes: Array<{ id: ThemeMode; label: string }> = [{ id: 'light', label: '浅色' }, { id: 'dark', label: '深色' }, { id: 'system', label: '跟随系统' }];

const storageKey = 'novel.appearance';
const systemDark = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const listeners = new Set<() => void>();

function read(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}') as Partial<Appearance>;
    return {
      mode: modes.some(mode => mode.id === saved.mode) ? saved.mode! : 'light',
      accent: accents.some(accent => accent.id === saved.accent) ? saved.accent! : 'indigo',
    };
  } catch { return { mode: 'light', accent: 'indigo' }; }
}

let current = read();

export function resolvedTheme(appearance = current): 'light' | 'dark' {
  return appearance.mode === 'system' ? (systemDark?.matches ? 'dark' : 'light') : appearance.mode;
}

/** 把外观写到 <html> 上；在首次渲染前调用，避免浅色闪一下。 */
export function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme();
  if (current.accent === 'indigo') delete root.dataset.accent; else root.dataset.accent = current.accent;
}

export function setAppearance(patch: Partial<Appearance>) {
  current = { ...current, ...patch };
  try { localStorage.setItem(storageKey, JSON.stringify(current)); } catch { /* preference only */ }
  applyAppearance();
  listeners.forEach(listener => listener());
}

/** 在浅色与深色之间切换；从「跟随系统」切出时以当前实际效果为准。 */
export function toggleTheme() { setAppearance({ mode: resolvedTheme() === 'dark' ? 'light' : 'dark' }); }

systemDark?.addEventListener('change', () => { if (current.mode === 'system') { applyAppearance(); listeners.forEach(listener => listener()); } });

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
let snapshot = { ...current, theme: resolvedTheme() };
export function useAppearance() {
  return useSyncExternalStore(subscribe, () => {
    const theme = resolvedTheme();
    if (snapshot.mode !== current.mode || snapshot.accent !== current.accent || snapshot.theme !== theme) snapshot = { ...current, theme };
    return snapshot;
  });
}
