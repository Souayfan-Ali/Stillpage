/**
 * About and Credits (P2-38, UI notes §8): version, rules date, licence, credits (lists with authors,
 * licences and homepages; shipped third-party code), and where the source and changelog live. Links
 * leave the extension only when clicked and open in a new tab without a referrer. D-99: no "Rules from" row
 * without a date; the filter lists behind "Filter lists (N)"; the shipped code stays open.
 */
import type { ComponentChildren, JSX } from 'preact';
import { PRODUCT_NAME } from '../../../core/brand.js';
import { formatRulesDate } from '../../../ui/rulesVersion.js';
import { t } from '../../../ui/i18n.js';
import { LISTS } from '../packLists.js';
import { LIST_AUTHORS, SHIPPED_CODE } from './credits.js';
import { ABOUT_STRINGS as S } from './strings.js';
import styles from '../Dashboard.module.css';

function External({ href, children }: { readonly href: string; readonly children: ComponentChildren }): JSX.Element {
  return (
    <a class={styles['link']} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function Credits(): JSX.Element {
  return (
    <section class={[styles['block'], styles['prose']].join(' ')} aria-labelledby="credits-heading">
      <h2 class={styles['heading']} id="credits-heading">
        {S.credits}
      </h2>
      <p>{S.creditsIntro}</p>
      <details>
        <summary>{S.listsHeading(Object.keys(LISTS).length)}</summary>
        <ul>
          {Object.entries(LISTS).map(([id, list]) => (
            <li key={id}>
              <External href={list.homepage}><span translate={false}>{list.title}</span></External> — {LIST_AUTHORS[id] === undefined ? S.unknownAuthors : <span translate={false}>{LIST_AUTHORS[id]}</span>} · <span translate={false}>{list.licence}</span>
            </li>
          ))}
        </ul>
      </details>
      <h3>{S.codeHeading}</h3>
      <ul>
        {SHIPPED_CODE.map((code) => (
          <li key={code.name}>
            <External href={code.homepage}><span translate={false}>{code.name}</span></External> — {t(code.what)} · <span translate={false}>{code.licence}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AboutSection({ version }: { readonly version: string }): JSX.Element {
  const rulesDate = formatRulesDate(version);
  return (
    <div class={styles['section']}>
      <section class={styles['block']} aria-labelledby="version-heading">
        <h2 class={styles['heading']} id="version-heading">
          {PRODUCT_NAME}
        </h2>
        <dl class={styles['facts']}>
          <dt>{S.version}</dt>
          <dd>{version}</dd>
          {rulesDate === undefined ? null : (
            <>
              <dt>{S.rulesDate}</dt>
              <dd>{rulesDate}</dd>
            </>
          )}
          <dt>{S.licence}</dt>
          <dd>{S.licenceText}</dd>
        </dl>
        <p>{S.source}</p>
      </section>
      <Credits />
    </div>
  );
}
