import { useSyncExternalStore } from 'react';

export type ThemeMode = 'light' | 'dark' | 'onedark' | 'system';
export type Theme = Exclude<ThemeMode, 'system'>;
export type AccentName = 'indigo' | 'teal' | 'green' | 'amber' | 'rose' | 'violet' | 'graphite';
/** darkStyle：跟随系统或侧栏切换进入深色时，用「深色」还是「One Dark」。 */
export interface Appearance { mode: ThemeMode; accent: AccentName; darkStyle: 'dark' | 'onedark' }

/** swatch 为浅色 / 深色下的主色，onedark 为 One Dark 主题下取用的语法高亮色（与 styles.css 保持一致）。 */
export const accents: Array<{ id: AccentName; label: string; swatch: string; onedark: string }> = [
  { id: 'indigo', label: '靛青', swatch: '#4f5bd5', onedark: '#61afef' },
  { id: 'teal', label: '松石', swatch: '#0e8174', onedark: '#56b6c2' },
  { id: 'green', label: '竹青', swatch: '#2f7d46', onedark: '#98c379' },
  { id: 'amber', label: '琥珀', swatch: '#b05f12', onedark: '#d19a66' },
  { id: 'rose', label: '胭脂', swatch: '#c03a64', onedark: '#e06c75' },
  { id: 'violet', label: '紫藤', swatch: '#8b4fb3', onedark: '#c678dd' },
  { id: 'graphite', label: '墨灰', swatch: '#52525b', onedark: '#abb2bf' },
];
export const modes: Array<{ id: ThemeMode; label: string }> = [{ id: 'light', label: '浅色' }, { id: 'dark', label: '深色' }, { id: 'onedark', label: 'One Dark' }, { id: 'system', label: '跟随系统' }];

const storageKey = 'novel.appearance';
const systemDark = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const listeners = new Set<() => void>();

function read(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}') as Partial<Appearance>;
    return {
      mode: modes.some(mode => mode.id === saved.mode) ? saved.mode! : 'light',
      accent: accents.some(accent => accent.id === saved.accent) ? saved.accent! : 'indigo',
      darkStyle: saved.darkStyle === 'onedark' ? 'onedark' : 'dark',
    };
  } catch { return { mode: 'light', accent: 'indigo', darkStyle: 'dark' }; }
}

let current = read();

export function resolvedTheme(appearance = current): Theme {
  return appearance.mode === 'system' ? (systemDark?.matches ? appearance.darkStyle : 'light') : appearance.mode;
}

/** 把外观写到 <html> 上；在首次渲染前调用，避免浅色闪一下。 */
export function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme();
  if (current.accent === 'indigo') delete root.dataset.accent; else root.dataset.accent = current.accent;
}

export function setAppearance(patch: Partial<Appearance>) {
  current = { ...current, ...patch };
  if (current.mode === 'dark' || current.mode === 'onedark') current.darkStyle = current.mode;
  try { localStorage.setItem(storageKey, JSON.stringify(current)); } catch { /* preference only */ }
  applyAppearance();
  listeners.forEach(listener => listener());
}

/** 在浅色与上次用的深色风格之间切换；从「跟随系统」切出时以当前实际效果为准。 */
export function toggleTheme() { setAppearance({ mode: resolvedTheme() === 'light' ? current.darkStyle : 'light' }); }

systemDark?.addEventListener('change', () => { if (current.mode === 'system') { applyAppearance(); listeners.forEach(listener => listener()); } });

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
let snapshot = { ...current, theme: resolvedTheme() };
export function useAppearance() {
  return useSyncExternalStore(subscribe, () => {
    const theme = resolvedTheme();
    if (snapshot.mode !== current.mode || snapshot.accent !== current.accent || snapshot.darkStyle !== current.darkStyle || snapshot.theme !== theme) snapshot = { ...current, theme };
    return snapshot;
  });
}
