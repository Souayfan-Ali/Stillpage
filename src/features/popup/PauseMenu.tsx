/**
 * "Pause on this site ▾" (P2-10, UI notes §3): a disclosure button that reveals three native buttons,
 * not an ARIA menu (design review, P2-10). `aria-expanded` / `aria-controls` on the trigger; Escape closes the
 * list and returns focus to the trigger; choosing closes it too.
 */
import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { Glyph } from '../../ui/Glyph.js';
import type { PauseChoice } from './store.js';
import { STRINGS } from './strings.js';
import styles from './Popup.module.css';

const CHOICES: readonly { readonly choice: PauseChoice; readonly label: string }[] = [
  { choice: 30, label: STRINGS.pause.thirty },
  { choice: 60, label: STRINGS.pause.hour },
  { choice: null, label: STRINGS.pause.untilOn },
];
const LIST_ID = 'pause-choices';

export interface PauseMenuProps {
  readonly onChoose: (choice: PauseChoice) => void;
}

export function PauseMenu({ onChoose }: PauseMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div class={styles['disclosure']}>
      <button
        type="button"
        ref={trigger}
        class={styles['trigger']}
        aria-expanded={open}
        aria-controls={LIST_ID}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Glyph name="pause" />
        {STRINGS.pause.open}
        <Glyph name="chevronDown" class={styles['caret']} />
      </button>
      <ul
        id={LIST_ID}
        class={styles['choices']}
        hidden={!open}
        aria-label={STRINGS.pause.label}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
      >
        {CHOICES.map(({ choice, label }) => (
          <li key={label}>
            <button
              type="button"
              class={styles['choice']}
              onClick={() => {
                close();
                onChoose(choice);
              }}
            >
              {label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
