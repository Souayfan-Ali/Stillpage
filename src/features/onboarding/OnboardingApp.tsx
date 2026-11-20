/**
 * The first-run page (P2-33, UI notes §7): three skippable steps, each a full sentence and one decision.
 * A progress list marks the current step (`aria-current="step"`); after every step change focus goes
 * to the step's heading. Native controls only; the demo animation stops under reduced motion.
 */
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { PRODUCT_NAME } from '../../core/brand.js';
import { Button } from '../../ui/Button.js';
import { BrandMark } from '../../ui/BrandMark.js';
import { Glyph, type GlyphName } from '../../ui/Glyph.js';
import { Icon } from '../../ui/Icon.js';
import { Extras } from './Extras.js';
import type { OnboardingStore, Step } from './store.js';
import { ONBOARDING_STRINGS as S } from './strings.js';
import styles from './Onboarding.module.css';

export interface OnboardingAppProps {
  readonly store: OnboardingStore;
  /** URL of the dashboard's Privacy section ("How we can prove it"). */
  readonly privacyUrl: string;
  readonly dashboardUrl: string;
  /** The browser's UI language (the language pack suggestion). */
  readonly language: string;
}

function Progress({ step }: { readonly step: Step }): JSX.Element {
  const at = step === 'done' ? 4 : step;
  return (
    <ol class={styles['steps']} aria-label={S.progress}>
      {S.stepNames.map((name, i) => (
        // D18: the name is shown; "Step N of 3: name" is the label, which contains the visible name.
        <li key={name} aria-label={S.stepLabel(i + 1, name)} aria-current={i + 1 === at ? 'step' : undefined} class={i + 1 < at ? styles['doneStep'] : undefined}>
          {name}
        </li>
      ))}
    </ol>
  );
}

function Protection({ store, privacyUrl }: { readonly store: OnboardingStore; readonly privacyUrl: string }): JSX.Element {
  const data = store.data.value;
  if (data === null) return <p class={styles['text']}>{S.loading}</p>;
  if (data === 'unavailable') return <p class={styles['text']}>{S.unavailable}</p>;
  return (
    <>
      <p class={styles['text']}>{S.protectedText}</p>
      <div class={styles['card']}>
        {data.allSites ? (
          <p class={styles['ok']}>
            <Icon name="on" />
            {S.accessOn}
          </p>
        ) : (
          <p class={styles['text']}>{S.accessOff}</p>
        )}
        <p class={styles['text']}>{S.accessWhy}</p>
        <p class={styles['text']}>
          {S.accessNever}{' '}
          <a class={styles['link']} href={privacyUrl} target="_blank" rel="noopener">
            {S.prove}
          </a>
        </p>
        {data.allSites ? null : (
          <div class={styles['actions']}>
            <Button variant="primary" onClick={() => void store.requestAllSites()}>
              {S.allowAll}
            </Button>
            <Button onClick={() => void store.next()}>{S.keepLight}</Button>
          </div>
        )}
      </div>
    </>
  );
}

function ToolHeading({ glyph, text }: { readonly glyph: GlyphName; readonly text: string }): JSX.Element {
  return (
    <h2 class={styles['toolHeading']}>
      <span class={styles['toolIcon']}>
        <Glyph name={glyph} size={20} />
      </span>
      {text}
    </h2>
  );
}

function Tools(): JSX.Element {
  return (
    <ul class={styles['list']}>
      <li class={styles['card']}>
        <ToolHeading glyph="list" text={S.pinHeading} />
        <p class={styles['text']}>{S.pinText}</p>
      </li>
      <li class={styles['card']}>
        <ToolHeading glyph="eyeOff" text={S.hideHeading} />
        <p class={styles['text']}>{S.hideText}</p>
        <div class={styles['demo']} aria-hidden="true">
          <span />
          <span class={styles['gone']} />
          <span />
        </div>
      </li>
      <li class={styles['card']}>
        <ToolHeading glyph="wrench" text={S.breakHeading} />
        <p class={styles['text']}>{S.breakText}</p>
      </li>
    </ul>
  );
}

const HEADINGS: Readonly<Record<Step, string>> = { 1: S.protectedHeading, 2: S.extrasHeading, 3: S.toolsHeading, done: S.doneHeading };

function Navigation({ store }: { readonly store: OnboardingStore }): JSX.Element {
  const step = store.step.value;
  const busy = store.busy.value;
  return (
    <div class={styles['actions']}>
      <Button variant="quiet" disabled={busy} onClick={() => void store.complete()}>
        {S.skip}
      </Button>
      {step === 1 ? null : (
        <Button
          disabled={busy}
          onClick={() => {
            store.back();
          }}
        >
          {S.back}
        </Button>
      )}
      {step === 3 ? (
        <Button variant="primary" disabled={busy} onClick={() => void store.complete()}>
          {S.finish}
        </Button>
      ) : (
        <Button variant="primary" disabled={busy} onClick={() => void store.next()}>
          {S.next}
        </Button>
      )}
    </div>
  );
}

function Body({ store, privacyUrl, dashboardUrl, language }: OnboardingAppProps): JSX.Element {
  const step = store.step.value;
  if (step === 1) return <Protection store={store} privacyUrl={privacyUrl} />;
  if (step === 2) return <Extras store={store} language={language} />;
  if (step === 3) return <Tools />;
  return (
    <>
      <p class={styles['text']}>{S.doneText}</p>
      <p class={styles['text']}>
        <a class={`${styles['link'] ?? ''} ${styles['soloLink'] ?? ''}`} href={dashboardUrl}>
          {S.dashboard}
        </a>
      </p>
    </>
  );
}

export function OnboardingApp(props: OnboardingAppProps): JSX.Element {
  const { store } = props;
  const step = store.step.value;
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const busy = store.busy.value;
  // A busy step disables its buttons; if the focused one went away, focus returns to the heading (review M5).
  useEffect(() => {
    if (!busy && (document.activeElement === null || document.activeElement === document.body)) heading.current?.focus();
  }, [busy]);
  useEffect(() => {
    document.title = S.title;
    if (first.current) first.current = false;
    else heading.current?.focus();
  }, [step]);
  return (
    <main class={styles['page']}>
      <div class={styles['hero']}>
        <span class={styles['markTile']}>
          <BrandMark size={44} />
        </span>
        <p class={styles['brand']}>{PRODUCT_NAME}</p>
      </div>
      <Progress step={step} />
      <h1 class={styles['heading']} tabIndex={-1} ref={heading}>
        {HEADINGS[step]}
      </h1>
      <Body {...props} />
      {step === 'done' ? null : <Navigation store={store} />}
      <p class={styles['status']} role="status" aria-live="polite">
        {store.status.value}
      </p>
    </main>
  );
}
