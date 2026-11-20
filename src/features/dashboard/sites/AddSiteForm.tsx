/**
 * "Add a site" (P2-35): a labelled hostname field and a level select; the address is checked with the
 * worker's own `parseHostname` and the 1,000-sites cap before anything is sent, and the error is tied
 * to the field (`aria-describedby`, `aria-invalid`).
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { LEVELS, type Level, type Settings } from '../../../core/state/types.js';
import { Button } from '../../../ui/Button.js';
import type { DashboardStore } from '../store.js';
import { checkNewSite, type AddProblem } from './rows.js';
import { LEVEL_LABELS, SITE_STRINGS } from './strings.js';
import styles from '../Dashboard.module.css';

export function AddSiteForm({ store, settings }: { readonly store: DashboardStore; readonly settings: Settings }): JSX.Element {
  const [text, setText] = useState('');
  const [level, setLevel] = useState<Level>('off');
  const [problem, setProblem] = useState<AddProblem | null>(null);
  const add = (): void => {
    const checked = checkNewSite(settings, text, level);
    if (!checked.ok) {
      setProblem(checked.problem);
      return;
    }
    setProblem(null);
    void store.run('c/setSiteLevel', { hostname: checked.host, level }).then((ok) => {
      if (ok) setText('');
    });
  };
  const describedBy = problem === null ? 'site-hint' : 'site-hint site-error'; // i18n-exempt: element ids
  return (
    <section class={styles['block']} aria-labelledby="add-site-heading">
      <h2 class={styles['heading']} id="add-site-heading">
        {SITE_STRINGS.addHeading}
      </h2>
      {/* Enter in the address field submits (one text field: implicit submission). */}
      <form
        class={styles['row']}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <div class={styles['field']}>
          <label for="site-host">{SITE_STRINGS.hostname}</label>
          <input
            id="site-host"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellcheck={false}
            value={text}
            aria-invalid={problem === null ? undefined : true}
            aria-describedby={describedBy}
            onInput={(event) => {
              setText(event.currentTarget.value);
              setProblem(null);
            }}
          />
        </div>
        <div class={styles['field']}>
          <label for="site-level">{SITE_STRINGS.levelFor}</label>
          <select
            id="site-level"
            value={level}
            onChange={(event) => {
              setLevel(event.currentTarget.value as Level);
            }}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {LEVEL_LABELS[l]}
              </option>
            ))}
          </select>
        </div>
        <Button variant="primary" onClick={add}>
          {SITE_STRINGS.add}
        </Button>
      </form>
      <p class={styles['muted']} id="site-hint">
        {SITE_STRINGS.hostnameHint}
      </p>
      {problem === null ? null : (
        <p class={styles['error']} id="site-error" role="alert">
          {problem === 'invalid' ? SITE_STRINGS.invalid : SITE_STRINGS.full}
        </p>
      )}
    </section>
  );
}
