/** Small DOM helpers for the panel entry (P1-40). */
import type { TabState } from '../../core/messaging/tabState.js';

const TAB_ID = /^(0|[1-9][0-9]{0,9})$/;

/** `?tabId=<n>` (performance notes §3: tests open the panel as a tab for a given tab), else `null`. */
export function tabIdFromSearch(search: string): number | null {
  const raw = new URLSearchParams(search).get('tabId');
  if (raw === null || !TAB_ID.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/** Sets or clears the manual theme override on the root element (tokens.css reads `data-theme`). */
export function applyTheme(root: HTMLElement, theme: TabState['theme']): void {
  if (theme === 'system') delete root.dataset['theme'];
  else root.dataset['theme'] = theme;
}
