import { useCallback, useEffect, useSyncExternalStore, type RefObject } from 'react';

export function useMediaQuery(query: string) {
  const subscribe = useCallback((notify: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener('change', notify);
    return () => media.removeEventListener('change', notify);
  }, [query]);
  const snapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, snapshot);
}

export const motionDuration = (duration: number) => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : duration;

export function useModalFocus(panel: RefObject<HTMLElement | null>, active: boolean, opener: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = panel.current;
    if (!active || !element) return;
    const background = [...(element.parentElement?.children || [])]
      .filter((child): child is HTMLElement => child instanceof HTMLElement && child !== element && child.matches('.sidebar, .main, .inspector-panel, .context-panel'));
    const previous = background.map(child => child.inert);
    background.forEach(child => { child.inert = true; });
    element.focus({ preventScroll: true });
    const focusable = () => [...element.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], summary, [tabindex]')]
      .filter(child => child.tabIndex >= 0 && !child.matches(':disabled') && !child.closest('[inert]') && child.getClientRects().length > 0);
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || document.querySelector('dialog[open]')) return;
      const items = focusable(), first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); element.focus(); return; }
      const outside = !element.contains(document.activeElement) || document.activeElement === element;
      if (event.shiftKey && (document.activeElement === first || outside)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || outside)) {
        event.preventDefault(); first.focus();
      }
    };
    const focusin = (event: FocusEvent) => {
      if (!element.contains(event.target as Node) && !document.querySelector('dialog[open]')) element.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('focusin', focusin);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', focusin);
      background.forEach((child, index) => { child.inert = previous[index]; });
      if (!element.isConnected && opener.current?.isConnected && !document.querySelector('dialog[open]')) opener.current.focus({ preventScroll: true });
    };
  }, [active, panel, opener]);
}
