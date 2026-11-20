/** Entry of the breakage chunk (P2-14): one flow store per open for the panel's tab and host. */
import type { JSX } from 'preact';
import { useMemo } from 'preact/hooks';
import type { Hostname } from '../../../core/ids.js';
import { BreakageView } from './BreakageView.js';
import { createFlowStore, type FlowDeps } from './flowStore.js';
import { ReportBuilder, type ReportDeps } from './ReportBuilder.js';

/** What the panel hands the chunk; the tab and host come from the panel's own state. */
export type BreakageDeps = Omit<FlowDeps, 'tabId' | 'host'> & { readonly report: ReportDeps };

export interface BreakageScreenProps {
  readonly deps: BreakageDeps;
  readonly tabId: number;
  readonly host: Hostname;
  readonly onBack: () => void;
}

export function BreakageScreen({ deps, tabId, host, onBack }: BreakageScreenProps): JSX.Element {
  const flow = useMemo(
    () => createFlowStore({ ...deps, tabId, host, ...(deps.report.popupLog === undefined ? {} : { popupLog: () => deps.report.popupLog?.(tabId) ?? Promise.resolve(null) }) }),
    [deps, tabId, host],
  );
  return <BreakageView flow={flow} onBack={onBack} report={(state) => <ReportBuilder deps={deps.report} state={state} />} />;
}
