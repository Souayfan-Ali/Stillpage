/**
 * Panel footer (P2-10, UI notes §3): the rules date, read from this build's version (P2-03), and the link
 * to the dashboard's "Hidden items" (P2-22, UI notes §5; D-91: the same name everywhere, no count — the count
 * lives in the panel's own row). A real link opened in a new tab: no `chrome.*` call, nothing for the worker to do.
 */
import type { JSX } from 'preact';
import { Glyph } from '../../ui/Glyph.js';
import { formatRulesDate } from '../../ui/rulesVersion.js';
import { STRINGS } from './strings.js';
import styles from './Popup.module.css';

export interface FooterProps {
  readonly version: string;
  /** Whether to draw the "Hidden items" link: only once the tab state is in. */
  readonly hiddenLink?: boolean;
}

export function Footer({ version, hiddenLink = false }: FooterProps): JSX.Element {
  const date = formatRulesDate(version);
  return (
    <footer class={styles['footer']}>
      <p>{date === undefined ? STRINGS.version(version) : STRINGS.rulesFrom(date)}</p>
      {hiddenLink ? (
        <a class={styles['footerLink']} href="/dashboard.html#hidden" target="_blank" rel="noopener">
          {STRINGS.hiddenItems}
          <Glyph name="chevron" size={12} class="mirror-rtl" />
        </a>
      ) : null}
    </footer>
  );
}
