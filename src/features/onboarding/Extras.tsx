/**
 * Step 2 (P2-33, UI notes §7): the extras as native checkboxes with one line of cost each, all off
 * except the suggested language pack. Nothing is sent until "Next" (design review, D-46); a refused pack gets
 * its message beside it (`role="alert"`, tied to the checkbox).
 */
import type { JSX } from 'preact';
import { packName } from '../dashboard/strings.js';
import { EXTRAS, packsOf, type ExtraId } from './extras.js';
import type { OnboardingStore } from './store.js';
import { ONBOARDING_STRINGS as S } from './strings.js';
import styles from './Onboarding.module.css';

function labelOf(extra: ExtraId, languagePack: string | undefined): string {
  if (extra === 'language' && languagePack !== undefined) return S.languageNamed(packName(languagePack));
  return S.extras[extra][0];
}

export function Extras({ store, language }: { readonly store: OnboardingStore; readonly language: string }): JSX.Element {
  const data = store.data.value;
  if (data === null || data === 'unavailable') return <p class={styles['text']}>{data === null ? S.loading : S.unavailable}</p>;
  const packs = packsOf(data, language);
  const choices = store.choices.value;
  const problems = store.problems.value;
  return (
    <>
      <p class={styles['text']}>{S.extrasText}</p>
      <ul class={styles['list']}>
        {EXTRAS.filter((extra) => choices[extra] !== undefined).map((extra) => {
          const problem = problems[extra];
          const described = problem === undefined ? `extra-${extra}-note` : `extra-${extra}-note extra-${extra}-problem`; // i18n-exempt: element ids
          return (
            <li key={extra}>
              <label class={styles['check']}>
                <input
                  type="checkbox"
                  class="switch"
                  checked={choices[extra] === true}
                  disabled={store.busy.value}
                  aria-describedby={described}
                  onChange={(event) => {
                    store.choose(extra, event.currentTarget.checked);
                  }}
                />
                {labelOf(extra, packs.language[0])}
              </label>
              <p class={styles['muted']} id={`extra-${extra}-note`}>
                {S.extras[extra][1]}
              </p>
              {problem === undefined ? null : (
                <p class={styles['error']} id={`extra-${extra}-problem`} role="alert">
                  {problem}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
