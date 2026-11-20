/**
 * "Something wrong with this page?" (P2-14, UI notes §6): pick a complaint, try each rung, say "Fixed"
 * or "Still broken", report at any point. Every control is a native button; the result of each step is
 * announced in one `role="status"` line. Loaded as its own chunk (design review, P2-14: popup budget).
 */
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { offeredRemedies } from '../../../core/breakage/machine.js';
import type { Complaint, FlowState } from '../../../core/breakage/types.js';
import { Button } from '../../../ui/Button.js';
import type { FlowStore } from './flowStore.js';
import { stepOf } from './steps.js';
import { COMPLAINTS, FLOW_STRINGS, REMEDIES, SKIPPED } from './strings.js';
import styles from './Breakage.module.css';

const COMPLAINT_ORDER: readonly Complaint[] = ['broken', 'adThrough', 'popupOpened', 'antiAdblock'];

function Choose({ flow }: { readonly flow: FlowStore }): JSX.Element {
  return (
    <fieldset class={styles['choices']}>
      <legend class={styles['legend']}>{FLOW_STRINGS.question}</legend>
      {COMPLAINT_ORDER.map((complaint) => (
        <button
          key={complaint}
          type="button"
          class={styles['choice']}
          onClick={() => {
            void flow.start(complaint);
          }}
        >
          {COMPLAINTS[complaint]}
        </button>
      ))}
    </fieldset>
  );
}

function Skipped({ state }: { readonly state: FlowState }): JSX.Element | null {
  const skipped = state.outcomes.filter((o) => o.result === 'skipped');
  if (skipped.length === 0) return null;
  return (
    <ul class={styles['skipped']}>
      {skipped.map((o) => (
        <li key={o.remedy}>{FLOW_STRINGS.skipped(REMEDIES[o.remedy].title, o.reason === undefined ? '' : SKIPPED[o.reason])}</li>
      ))}
    </ul>
  );
}

function Offer({ flow, state }: { readonly flow: FlowStore; readonly state: FlowState }): JSX.Element {
  return (
    <>
      {offeredRemedies(state).map((remedy) => (
        <div key={remedy} class={styles['rung']}>
          <h4 class={styles['rungTitle']}>{REMEDIES[remedy].title}</h4>
          <p class={styles['detail']}>{REMEDIES[remedy].detail}</p>
          <Button
            variant="primary"
            onClick={() => {
              void flow.tryIt(remedy);
            }}
          >
            {REMEDIES[remedy].action}
          </Button>
        </div>
      ))}
    </>
  );
}

function Await({ flow, state }: { readonly flow: FlowStore; readonly state: FlowState }): JSX.Element | null {
  if (state.trial === null) return null;
  return (
    <div class={styles['rung']}>
      <h4 class={styles['rungTitle']}>{REMEDIES[state.trial.remedy].title}</h4>
      <p class={styles['detail']}>{FLOW_STRINGS.after(state.trial.remedy)}</p>
      <div class={styles['row']}>
        <Button variant="primary" onClick={() => void flow.fixed()}>
          {FLOW_STRINGS.fixed}
        </Button>
        <Button onClick={() => void flow.stillBroken()}>{FLOW_STRINGS.stillBroken}</Button>
      </div>
    </div>
  );
}

function Active({ flow, state, report }: { readonly flow: FlowStore; readonly state: FlowState; readonly report: (state: FlowState) => ComponentChildren }): JSX.Element {
  const { n, of } = stepOf(state);
  return (
    <section class={styles['active']} aria-labelledby="flow-step">
      <h3 id="flow-step" class={styles['step']}>
        {FLOW_STRINGS.step(n, of)}
        <span class={styles['complaint']}> — {COMPLAINTS[state.complaint]}</span>
      </h3>
      <Skipped state={state} />
      {state.phase === 'offer' ? <Offer flow={flow} state={state} /> : null}
      {state.phase === 'await' ? <Await flow={flow} state={state} /> : null}
      {state.phase === 'report' ? (
        <>
          <p>{FLOW_STRINGS.reportStep}</p>
          {report(state)}
        </>
      ) : (
        <Button variant="quiet" onClick={() => void flow.report()}>
          {FLOW_STRINGS.report}
        </Button>
      )}
      <Button variant="quiet" onClick={() => void flow.cancel()}>
        {FLOW_STRINGS.cancel}
      </Button>
    </section>
  );
}

function Body({ flow, report }: { readonly flow: FlowStore; readonly report: (state: FlowState) => ComponentChildren }): JSX.Element | null {
  const view = flow.view.value;
  switch (view.kind) {
    case 'loading':
      return null;
    case 'choose':
      return <Choose flow={flow} />;
    case 'active':
      return <Active flow={flow} state={view.state} report={report} />;
    case 'fixed':
      return <p>{FLOW_STRINGS.done(view.remedy === null ? null : REMEDIES[view.remedy].title)}</p>;
    case 'orphan':
      return (
        <div class={styles['rung']}>
          <p>{FLOW_STRINGS.orphan(REMEDIES[view.trial.remedy].title)}</p>
          <div class={styles['row']}>
            <Button onClick={() => void flow.keepOrphan()}>{FLOW_STRINGS.keep}</Button>
            <Button onClick={() => void flow.undoOrphan()}>{FLOW_STRINGS.undo}</Button>
          </div>
        </div>
      );
  }
}

export interface BreakageViewProps {
  readonly flow: FlowStore;
  readonly onBack: () => void;
  /** The report builder for the report step (P2-15). */
  readonly report: (state: FlowState) => ComponentChildren;
}

export function BreakageView({ flow, onBack, report }: BreakageViewProps): JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    void flow.load();
  }, [flow]);
  return (
    <section class={styles['view']} aria-labelledby="flow-title">
      <div class={styles['bar']}>
        <Button variant="quiet" onClick={onBack}>
          <span class="mirror-rtl" aria-hidden="true">←</span>{' '}
          {FLOW_STRINGS.back}
        </Button>
        <h2 id="flow-title" class={styles['title']} tabIndex={-1} ref={heading}>
          {FLOW_STRINGS.title}
        </h2>
      </div>
      <Body flow={flow} report={report} />
      <p class={styles['status']} role="status">
        {flow.status.value}
      </p>
    </section>
  );
}
