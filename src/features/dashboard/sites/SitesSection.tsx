/**
 * Sites (P2-35, UI notes §8): a table of per-site levels, pauses and pop-up policies; search; select
 * and remove in bulk (`c/forgetSites`, one write); change a level or resume from the row; add a site
 * by hostname with the same validation as the worker. Every control is native and labelled; errors
 * are tied to their field with `aria-describedby`. D-97: search only from 8 sites; with none, only the empty
 * text (no list heading), which then takes the focus the heading would have had.
 */
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Hostname } from '../../../core/ids.js';
import type { Dashboard } from '../../../core/messaging/dashboard.js';
import { Button } from '../../../ui/Button.js';
import type { DashboardStore } from '../store.js';
import { AddSiteForm } from './AddSiteForm.js';
import { siteRows } from './rows.js';
import { SiteRowView } from './SiteRowView.js';
import { POPUP_STRINGS } from '../sections/popupStrings.js';
import { SITE_STRINGS } from './strings.js';
import styles from '../Dashboard.module.css';
import sites from './Sites.module.css';

export interface SitesSectionProps {
  readonly store: DashboardStore;
  readonly data: Dashboard;
  readonly now: () => number;
}

/** Fewer sites than this fit on one screen: no search box (D-97). */
const SEARCH_FROM = 8;

function without(selected: ReadonlySet<Hostname>, hosts: readonly Hostname[]): ReadonlySet<Hostname> {
  const drop = new Set(hosts);
  return new Set([...selected].filter((h) => !drop.has(h)));
}

function Search({ value, onChange }: { readonly value: string; readonly onChange: (value: string) => void }): JSX.Element {
  return (
    <div class={styles['field']}>
      <label for="site-search">{SITE_STRINGS.search}</label>
      <input
        id="site-search"
        type="search"
        value={value}
        onInput={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
    </div>
  );
}

interface SiteTableProps {
  readonly rows: ReturnType<typeof siteRows>;
  readonly selected: ReadonlySet<Hostname>;
  readonly setSelected: (update: (current: ReadonlySet<Hostname>) => ReadonlySet<Hostname>) => void;
  readonly store: DashboardStore;
  readonly forget: (hosts: readonly Hostname[]) => void;
}

function SiteTable({ rows, selected, setSelected, store, forget }: SiteTableProps): JSX.Element {
  return (
    <table class={`${styles['table'] ?? ''} ${sites['cards'] ?? ''}`}>
      <caption class="visually-hidden">{SITE_STRINGS.caption}</caption>
      <thead>
        <tr>
          <th scope="col">
            <span class="visually-hidden">{SITE_STRINGS.selectColumn}</span>
          </th>
          <th scope="col">{SITE_STRINGS.site}</th>
          <th scope="col">{SITE_STRINGS.level}</th>
          <th scope="col">{SITE_STRINGS.popups}</th>
          <th scope="col">
            <span class="visually-hidden">{SITE_STRINGS.actions}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <SiteRowView
            key={row.host}
            row={row}
            selected={selected.has(row.host)}
            onSelect={(on) => {
              setSelected((current) => (on ? new Set([...current, row.host]) : without(current, [row.host])));
            }}
            store={store}
            onRemove={() => {
              forget([row.host]);
            }}
          />
        ))}
      </tbody>
    </table>
  );
}

export function SitesSection({ store, data, now }: SitesSectionProps): JSX.Element {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<Hostname>>(new Set());
  const total = siteRows(data.settings, now()).length;
  const searchable = total >= SEARCH_FROM;
  // The box is gone below SEARCH_FROM: its text goes with it, so it does not come back prefilled (D-120).
  useEffect(() => {
    if (!searchable) setSearch('');
  }, [searchable]);
  const rows = siteRows(data.settings, now(), searchable ? search : '');
  const chosen = rows.filter((r) => selected.has(r.host)).map((r) => r.host);
  const heading = useRef<HTMLHeadingElement>(null);
  const forget = (hosts: readonly Hostname[]): void => {
    void store.run('c/forgetSites', { hostnames: [...hosts] }).then((ok) => {
      if (!ok) return;
      setSelected((current) => without(current, hosts));
      // The removed row held focus; the list's heading takes it (review M6).
      heading.current?.focus();
    });
  };
  if (total === 0) {
    return (
      <div class={styles['section']}>
        <AddSiteForm store={store} settings={data.settings} />
        <p class={styles['muted']} id="sites-heading" tabIndex={-1} ref={heading}>
          {SITE_STRINGS.empty}
        </p>
      </div>
    );
  }
  return (
    <div class={styles['section']}>
      <AddSiteForm store={store} settings={data.settings} />
      <section class={styles['block']} aria-labelledby="sites-heading">
        <h2 class={styles['heading']} id="sites-heading" tabIndex={-1} ref={heading}>
          {SITE_STRINGS.listHeading}
        </h2>
        {searchable ? <Search value={search} onChange={setSearch} /> : null}
        {rows.length === 0 ? (
          <p class={styles['muted']}>{SITE_STRINGS.noMatch}</p>
        ) : (
          <SiteTable rows={rows} selected={selected} setSelected={setSelected} store={store} forget={forget} />
        )}
        {rows.length === 0 ? null : (
          <p class={styles['muted']} id="site-popups-note">
            {data.popupGuard ? SITE_STRINGS.popupsNote : `${SITE_STRINGS.popupsNote} ${POPUP_STRINGS.siteNotActive}`}
          </p>
        )}
        {chosen.length === 0 ? null : (
          <div>
            <Button
              onClick={() => {
                forget(chosen);
              }}
            >
              {SITE_STRINGS.removeSelected(chosen.length)}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
