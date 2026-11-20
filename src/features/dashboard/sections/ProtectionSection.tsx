/**
 * Protection (P2-34, UI notes §8; D-96): default level, the pop-up mode (P2-60), then the packs split into
 * "Core protection" and "Extras" (with the Thorough offer), languages and the rule capacity meter. GPC and
 * tracking parameters live in Privacy (UI notes §8).
 */
import type { JSX } from 'preact';
import type { Dashboard, PackRow } from '../../../core/messaging/dashboard.js';
import type { DefaultLevel } from '../../../core/state/types.js';
import { Banner } from '../../../ui/Banner.js';
import { Button } from '../../../ui/Button.js';
import { t } from '../../../ui/i18n.js';
import { RadioGroup } from '../../../ui/RadioGroup.js';
import type { DashboardStore } from '../store.js';
import { CORE_PACKS, isRegional, STRINGS } from '../strings.js';
import { CapacityMeter } from './CapacityMeter.js';
import { PackItem } from './PackItem.js';
import { PopupMode } from './PopupMode.js';
import styles from '../Dashboard.module.css';

/** Shown in Privacy instead (UI notes §8). */
const PRIVACY_PACKS: ReadonlySet<string> = new Set(['gpc', 'params']);

const LEVEL_OPTIONS = [
  { value: 'light', label: t('level_light'), glyph: 'light', hue: 'light' },
  { value: 'standard', label: t('level_standard'), glyph: 'standard', hue: 'standard' },
  { value: 'thorough', label: t('level_thorough'), glyph: 'thorough', hue: 'thorough' },
] as const;

/** One-line outcome and cost of each level (UI notes §2). */
const LEVEL_NOTES: Readonly<Record<DefaultLevel, string>> = {
  light: t('level_light_note'),
  standard: t('level_standard_note'),
  thorough: t('level_thorough_note'),
};

function PackList({ store, packs, label }: { readonly store: DashboardStore; readonly packs: readonly PackRow[]; readonly label: string }): JSX.Element {
  const problem = store.packProblem.value;
  return (
    <ul class={`${styles['list'] ?? ''} ${styles['packs'] ?? ''}`} aria-label={label}>
      {packs.map((pack) => (
        <PackItem
          key={pack.id}
          pack={pack}
          problem={problem?.pack === pack.id ? problem.text : null}
          onToggle={(enabled) => {
            void store.setPack(pack.id, enabled);
          }}
        />
      ))}
    </ul>
  );
}

function PackSection({ id, title, children }: { readonly id: string; readonly title: string; readonly children: JSX.Element | readonly JSX.Element[] }): JSX.Element {
  return (
    <section class={styles['block']} aria-labelledby={id}>
      <h2 class={styles['heading']} id={id}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ThoroughOffer({ store }: { readonly store: DashboardStore }): JSX.Element | null {
  if (!store.thoroughOffer.value) return null;
  return (
    <Banner tone="info" icon="on" text={STRINGS.offer} textRole="status">
      <Button
        variant="primary"
        onClick={() => {
          void store.acceptThorough();
        }}
      >
        {STRINGS.useThorough}
      </Button>
      <Button
        variant="secondary"
        onClick={() => {
          store.dismissOffer();
        }}
      >
        {STRINGS.notNow}
      </Button>
    </Banner>
  );
}

export function ProtectionSection({ store, data }: { readonly store: DashboardStore; readonly data: Dashboard }): JSX.Element {
  const shown = data.packs.filter((p) => !PRIVACY_PACKS.has(p.id));
  const extras = shown.filter((p) => !isRegional(p.id) && !CORE_PACKS.has(p.id));
  const level = data.settings.defaultLevel;
  return (
    <div class={styles['section']}>
      <section class={styles['block']}>
        <RadioGroup<DefaultLevel>
          name="default-level"
          legend={STRINGS.defaultLevel}
          options={LEVEL_OPTIONS}
          value={level}
          description={`${LEVEL_NOTES[level]} ${STRINGS.defaultLevelNote}`}
          onChange={(next) => {
            void store.run('c/setDefaultLevel', { level: next });
          }}
        />
      </section>
      <PopupMode store={store} data={data} />
      <PackSection id="core-heading" title={STRINGS.core}>
        <PackList store={store} packs={shown.filter((p) => CORE_PACKS.has(p.id))} label={STRINGS.core} />
      </PackSection>
      <PackSection id="extras-heading" title={STRINGS.extras}>
        <ThoroughOffer store={store} />
        <PackList store={store} packs={extras} label={STRINGS.extras} />
      </PackSection>
      <PackSection id="languages-heading" title={STRINGS.languages}>
        <PackList store={store} packs={shown.filter((p) => isRegional(p.id))} label={STRINGS.languages} />
      </PackSection>
      <CapacityMeter capacity={data.capacity} />
    </div>
  );
}
