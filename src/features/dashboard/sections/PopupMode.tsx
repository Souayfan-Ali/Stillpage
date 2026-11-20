/**
 * Pop-up blocking mode in Protection (P2-60 dashboard part, UI notes §6a, §8): Smart / Strict / Off as a
 * native radio group under the section's own heading (D-96), the one line on what Smart cannot catch (only while
 * Smart is chosen), and, while this build has no guard
 * scripts (P2-57/58), an honest note that the choice is saved but not active yet (design review 2026-11-14).
 */
import type { JSX } from 'preact';
import type { Dashboard } from '../../../core/messaging/dashboard.js';
import type { PopupMode as Mode } from '../../../core/state/types.js';
import { RadioGroup } from '../../../ui/RadioGroup.js';
import type { DashboardStore } from '../store.js';
import { MODE_NAMES, POPUP_STRINGS as S } from './popupStrings.js';
import styles from '../Dashboard.module.css';

const OPTIONS = [
  { value: 'smart', label: MODE_NAMES.smart },
  { value: 'strict', label: MODE_NAMES.strict },
  { value: 'off', label: MODE_NAMES.off },
] as const;

export function PopupMode({ store, data }: { readonly store: DashboardStore; readonly data: Dashboard }): JSX.Element {
  const mode = data.settings.popups.mode;
  return (
    <section class={`${styles['block'] ?? ''} ${styles['headed'] ?? ''}`} aria-labelledby="popups-heading">
      <h2 class={styles['heading']} id="popups-heading">
        {S.legend}
      </h2>
      <RadioGroup<Mode>
        name="popup-mode"
        legend={S.legend}
        options={OPTIONS}
        value={mode}
        description={mode === 'smart' ? `${S.modes[mode]} ${S.limits}` : S.modes[mode]}
        {...(data.popupGuard ? {} : { note: S.notActive })}
        onChange={(next) => {
          void store.run('c/setPopupMode', { mode: next });
        }}
      />
      {/* P2-60b: the in-page notice toggle (UI notes §6a); the notice itself honours it (P2-59). */}
      <label class={styles['check']}>
        <input
          type="checkbox"
          class="switch"
          checked={data.settings.popups.notice}
          aria-describedby="popup-notice-hint"
          onChange={(event) => {
            void store.run('c/setPopupNotice', { enabled: event.currentTarget.checked });
          }}
        />
        {S.notice}
      </label>
      <p id="popup-notice-hint" class={styles['muted']}>
        {S.noticeHint}
      </p>
    </section>
  );
}
