/**
 * A state message with its reason and next step (P1-39, UI notes §1 item 2): icon + text, never colour
 * alone; actions are native buttons. Not a live region itself: the caller decides what is announced.
 */
import type { ComponentChildren, JSX } from 'preact';
import { Icon, type IconName } from './Icon.js';
import styles from './Banner.module.css';

export type BannerTone = 'neutral' | 'info' | 'warning' | 'error';

export interface BannerProps {
  readonly tone: BannerTone;
  readonly icon: IconName;
  readonly text: string;
  /** Optional id for the text, so actions can be described by it. */
  readonly textId?: string;
  /** `status`: the text alone is a polite live region (never the actions around it). */
  readonly textRole?: 'status';
  /** Action buttons. */
  readonly children?: ComponentChildren;
}

export function Banner({ tone, icon, text, textId, textRole, children }: BannerProps): JSX.Element {
  return (
    <div class={`${styles['banner'] ?? ''} ${styles[tone] ?? ''}`} data-tone={tone}>
      <Icon name={icon} class={styles['icon']} />
      <div class={styles['body']}>
        <p class={styles['text']} id={textId} role={textRole}>
          {text}
        </p>
        {children === undefined ? null : <div class={styles['actions']}>{children}</div>}
      </div>
    </div>
  );
}
