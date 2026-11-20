/**
 * "27 blocked on this page ▸ / 9 companies · 14 ads · 13 trackers" (P2-12, UI notes §3): one native button
 * that opens the privacy panel. P3-18: the figure drawn large and the second line as coloured stat tiles
 * (companies, ads, trackers…), each with its glyph; the tiles keep the line's words and its " · " between
 * them (visually hidden), so the button's name reads as before.
 */
import type { JSX } from 'preact';
import { Glyph, type GlyphName } from '../../../ui/Glyph.js';
import type { MatchedView } from './privacyStore.js';
import { PRIVACY_STRINGS } from './strings.js';
import { detailParts, splitCount, type DetailPart } from './summary.js';
import styles from './Privacy.module.css';

const TILE_GLYPHS: Readonly<Partial<Record<DetailPart['kind'], GlyphName>>> = { companies: 'building', ads: 'ad', tracking: 'tracker', popup: 'popup' };

interface CardText {
  readonly headline: string;
  readonly total: number;
  readonly parts: readonly DetailPart[];
  readonly note: string;
}

function textOf(matched: MatchedView): CardText {
  if (matched.kind === 'counts') {
    return matched.total === 0
      ? { headline: PRIVACY_STRINGS.nothing, total: 0, parts: [], note: '' }
      : { headline: PRIVACY_STRINGS.blocked(matched.total), total: matched.total, parts: detailParts(matched), note: '' };
  }
  const loading = matched.kind === 'loading' || matched.kind === 'idle';
  return { headline: PRIVACY_STRINGS.unavailableCard, total: 0, parts: [], note: loading ? PRIVACY_STRINGS.loading : '' };
}

/** The headline with its figure drawn large, in the same run of text (so the button's name reads as before). */
function Headline({ text, total }: { readonly text: string; readonly total: number }): JSX.Element {
  const split = splitCount(text, total);
  if (split === null) return <span class={styles['headline']}>{text}</span>;
  return (
    <span class={styles['headline']}>
      {split[0]}
      <span class={styles['figure']} data-figure="">
        {split[1]}
      </span>
      {split[2]}
    </span>
  );
}

function Tiles({ parts }: { readonly parts: readonly DetailPart[] }): JSX.Element {
  return (
    <span class={styles['tiles']}>
      {parts.map((part, i) => {
        const glyph = TILE_GLYPHS[part.kind] ?? 'shield';
        return (
          <span key={part.kind} class={styles['tileWrap']}>
            {i === 0 ? null : <span class="visually-hidden"> · </span>}
            <span class={styles['tile']} data-tile={part.kind}>
              <Glyph name={glyph} size={14} />
              {part.text}
            </span>
          </span>
        );
      })}
    </span>
  );
}

export interface BlockedCardProps {
  readonly matched: MatchedView;
  readonly onOpen: () => void;
}

export function BlockedCard({ matched, onOpen }: BlockedCardProps): JSX.Element {
  const { headline, total, parts, note } = textOf(matched);
  return (
    <button type="button" class={styles['card']} onClick={onOpen} data-opens="privacy">
      <span class={styles['cardText']}>
        <Headline text={headline} total={total} />
        {parts.length === 0 ? null : <Tiles parts={parts} />}
        {note === '' ? null : <span class={styles['detail']}>{note}</span>}
      </span>
      <Glyph name="chevron" class={`mirror-rtl ${styles['chevron'] ?? ''}`} />
    </button>
  );
}
