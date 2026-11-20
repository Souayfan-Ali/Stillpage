/**
 * Rule capacity (P2-34, filter-pipeline notes §8, design review 2026-11-14): the rule ceilings of the enabled rulesets against
 * Chrome's guaranteed 30,000, as a native `<progress>` with its text beside it; behind "Details" (D-96) the
 * share drawn from Chrome's pool and Chrome's own "room left" figure: the number a refused pack is measured against.
 */
import type { JSX } from 'preact';
import type { Dashboard } from '../../../core/messaging/dashboard.js';
import { STRINGS } from '../strings.js';
import styles from '../Dashboard.module.css';

export function CapacityMeter({ capacity }: { readonly capacity: Dashboard['capacity'] }): JSX.Element {
  const { guaranteed, usedCeiling, available } = capacity;
  const shown = Math.min(usedCeiling, guaranteed);
  const text = STRINGS.capacityUsed(shown, guaranteed);
  return (
    <section class={styles['block']} aria-labelledby="capacity-heading">
      <h2 class={styles['heading']} id="capacity-heading">
        {STRINGS.capacity}
      </h2>
      <progress class={styles['meter']} max={guaranteed} value={shown} aria-labelledby="capacity-heading" aria-describedby="capacity-text" />
      <p id="capacity-text">{text}</p>
      <details class={styles['details']}>
        <summary aria-label={STRINGS.details(STRINGS.capacity)}>{STRINGS.detailsSummary}</summary>
        {usedCeiling > guaranteed ? <p class={styles['muted']}>{STRINGS.capacityOver(usedCeiling - guaranteed)}</p> : null}
        <p class={styles['muted']}>{available === null ? STRINGS.capacityUnknown : STRINGS.capacityLeft(available)}</p>
      </details>
    </section>
  );
}
