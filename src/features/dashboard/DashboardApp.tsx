/**
 * The dashboard shell (P2-34, UI notes §8, design review 2026-11-14): real links in a labelled `<nav>` with
 * `aria-current`, one section shown at a time, focus moved to the section's heading after navigation,
 * and the page title per section. The notices sit above every section; one `role="status"` line
 * reports the result of the last action.
 */
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { PRODUCT_NAME } from '../../core/brand.js';
import { t } from '../../ui/i18n.js';
import type { Dashboard } from '../../core/messaging/dashboard.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { BrandMark } from '../../ui/BrandMark.js';
import { Glyph, type GlyphName } from '../../ui/Glyph.js';
import type { DashboardStore } from './store.js';
import { SECTION_TITLES, SECTIONS, STRINGS, type SectionId } from './strings.js';
import styles from './Dashboard.module.css';
import shell from './Shell.module.css';

/** Each section's glyph, in the nav and beside its title (P3-18). */
const SECTION_GLYPHS: Readonly<Record<SectionId, GlyphName>> = {
  protection: 'shield',
  sites: 'globe',
  hidden: 'eyeOff',
  privacy: 'lock',
  backup: 'archive',
  about: 'info',
};

export interface DashboardAppProps {
  readonly store: DashboardStore;
  readonly section: SectionId;
  /** True after a hash change (not on first load): focus then moves to the section heading. */
  readonly navigated: boolean;
  /** Draws the current section once the snapshot is in. */
  readonly renderSection: (section: SectionId, data: Dashboard) => ComponentChildren;
}

function Notices({ store, data }: { readonly store: DashboardStore; readonly data: Dashboard }): JSX.Element {
  return (
    <>
      {data.settingsReset ? (
        <Banner tone="warning" icon="warning" text={STRINGS.reset}>
          <a class={styles['link']} href="#backup">
            {STRINGS.restore}
          </a>
        </Banner>
      ) : null}
      {data.lastRun === 'failed' ? <Banner tone="warning" icon="warning" text={STRINGS.lastRunFailed} /> : null}
      {data.allSites ? null : (
        <Banner tone="info" icon="reduced" text={STRINGS.noAccess}>
          <Button
            variant="primary"
            onClick={() => {
              void store.requestAllSites();
            }}
          >
            {STRINGS.allowAll}
          </Button>
        </Banner>
      )}
    </>
  );
}

/** The first-run page (P2-33): "Finish setup" until it was finished or skipped, then "Run setup again". */
function SetupLink({ store }: { readonly store: DashboardStore }): JSX.Element | null {
  const snapshot = store.snapshot.value;
  if (snapshot.kind !== 'ready') return null;
  return (
    <a class={shell['setupLink']} href="/onboarding.html">
      <Glyph name="settings" />
      {snapshot.data.settings.onboarding.completedAt === null ? STRINGS.finishSetup : STRINGS.setupAgain}
    </a>
  );
}

function Nav({ section, store }: { readonly section: SectionId; readonly store: DashboardStore }): JSX.Element {
  return (
    <nav class={shell['nav']} aria-label={STRINGS.navLabel}>
      <ul>
        {SECTIONS.map((id) => (
          <li key={id}>
            <a href={`#${id}`} aria-current={id === section ? 'page' : undefined}>
              <Glyph name={SECTION_GLYPHS[id]} size={18} />
              {SECTION_TITLES[id]}
            </a>
          </li>
        ))}
      </ul>
      <p class={shell['setup']}>
        <SetupLink store={store} />
      </p>
    </nav>
  );
}

function Body({ store, section, renderSection }: Omit<DashboardAppProps, 'navigated'>): JSX.Element | null {
  const snapshot = store.snapshot.value;
  if (snapshot.kind === 'loading') return <p>{STRINGS.loading}</p>;
  if (snapshot.kind === 'unavailable') return <Banner tone="error" icon="unavailable" text={STRINGS.unavailable} />;
  return (
    <>
      <Notices store={store} data={snapshot.data} />
      {renderSection(section, snapshot.data)}
    </>
  );
}

export function DashboardApp({ store, section, navigated, renderSection }: DashboardAppProps): JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = t('dash_document_title', SECTION_TITLES[section], PRODUCT_NAME);
    if (navigated) heading.current?.focus();
  }, [section, navigated]);
  return (
    <div class={shell['page']}>
      <header class={shell['header']}>
        <p class={shell['brand']}>
          <span class={shell['markTile']}>
            <BrandMark size={26} />
          </span>
          {PRODUCT_NAME}
        </p>
        <Nav section={section} store={store} />
      </header>
      <main class={shell['main']}>
        <div class={shell['titleRow']}>
          <span class={shell['titleIcon']}>
            <Glyph name={SECTION_GLYPHS[section]} size={22} />
          </span>
          <h1 class={shell['title']} tabIndex={-1} ref={heading}>
            {SECTION_TITLES[section]}
          </h1>
        </div>
        <Body store={store} section={section} renderSection={renderSection} />
        <p class={styles['status']} role="status" aria-live="polite">
          {store.status.value}
        </p>
      </main>
    </div>
  );
}
