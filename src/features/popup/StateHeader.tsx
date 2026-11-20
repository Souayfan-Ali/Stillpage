/**
 * The header state line and its actions (P1-40, UI notes §3), drawn inside the state hero (P3-18): the text
 * (a polite live region on its own) and the state's buttons. The hero around it carries the icon and colour.
 */
import type { JSX } from 'preact';
import { Button } from '../../ui/Button.js';
import type { Header, HeaderAction } from './header.js';
import { STRINGS } from './strings.js';
import styles from './Hero.module.css';

/** Actions that have no working command yet are not drawn ("Restore a backup" arrives with backups, P2-37). */
const DRAWN_ACTIONS: ReadonlySet<HeaderAction> = new Set(['turnOn', 'resume', 'allowSite', 'allowAll', 'dismiss']);
const PRIMARY: ReadonlySet<HeaderAction> = new Set(['turnOn', 'resume', 'allowAll']);

export interface StateHeaderProps {
  readonly header: Header;
  readonly onAction: (action: HeaderAction) => void;
}

export function StateHeader({ header, onAction }: StateHeaderProps): JSX.Element {
  const actions = header.actions.filter((a) => DRAWN_ACTIONS.has(a));
  return (
    <div class={styles['state']} data-state={header.kind}>
      <p class={styles['stateText']}>
        <span role="status">{header.text}</span>
      </p>
      {actions.length === 0 ? null : (
        <div class={styles['actions']}>
          {actions.map((action) => (
            <Button
              key={action}
              variant={PRIMARY.has(action) ? 'primary' : 'secondary'}
              onClick={() => {
                onAction(action);
              }}
            >
              {STRINGS.actions[action]}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
