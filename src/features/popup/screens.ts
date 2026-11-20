/**
 * The toolbar panel's views (P2-12, P2-14, P2-22b): the main view and its sub-views. Opening a sub-view moves
 * focus to its heading (the view does that); going back returns focus to the control that opened it
 * (WCAG 2.4.3). The main view is re-mounted on the way back, so that control is found again by its
 * `data-opens="<screen>"` marker.
 */
import { useEffect, useRef, useState } from 'preact/hooks';

type Screen = 'main' | 'privacy' | 'breakage' | 'hidden';

export interface Screens {
  readonly screen: Screen;
  open(next: Exclude<Screen, 'main'>): void;
  back(): void;
}

export function useScreens(): Screens {
  const [screen, setScreen] = useState<Screen>('main');
  const returnTo = useRef<Screen | null>(null);
  useEffect(() => {
    const from = returnTo.current;
    if (screen !== 'main' || from === null) return;
    returnTo.current = null;
    document.querySelector<HTMLElement>(`[data-opens="${from}"]`)?.focus();
  }, [screen]);
  return {
    screen,
    open: setScreen,
    back: () => {
      returnTo.current = screen;
      setScreen('main');
    },
  };
}
