/**
 * The in-page notice's words (P2-59) are messages of `_locales` (P2-40): `notice_*`, read through the
 * `say` function the entry script passes in (content code touches no `chrome.*`), when a notice is drawn.
 * A line and a host are joined by concatenation, so these messages carry their own spaces and `·`.
 * Measured against the sentinel's byte gate (ADR-018, ≤ 5,000 B gzip): 4,754 B gzip, the English constants 4,769 B (P2-59).
 */
import type catalog from '../../../_locales/en/messages.json';

export type NoticeKey = Extract<keyof typeof catalog, `notice_${string}`>;
export type Say = (key: NoticeKey) => string;
