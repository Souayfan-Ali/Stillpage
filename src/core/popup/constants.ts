/**
 * Named constants of the pop-up guard (pop-up notes §7.3). `GESTURE_WINDOW_MS` is used by `judge`; the
 * others are read by the sentinel's DOM signals (P2-57) and live here so both share one source.
 */

/** Chrome's transient activation, measured by S-20 at 5,003 ms. */
export const GESTURE_WINDOW_MS = 5_000;
/** A target whose box covers this share of the viewport or more is not "interactive". */
export const LARGE_TARGET_RATIO = 0.5;
/** Hijack overlay: its box reaches every viewport edge within this share of the viewport. */
export const OVERLAY_EDGE_TOLERANCE = 1 / 16;
/** Hijack overlay: opacity or background alpha at most this. */
export const OVERLAY_MAX_ALPHA = 0.05;
/** Tab-under rule: a cross-site script navigation this soon after opening a context is cancelled. */
export const TAB_UNDER_WINDOW_MS = 2_000;
/** The notice's buttons arm after this delay. */
export const NOTICE_ARM_DELAY_MS = 600;
/** The notice must have been visible and unoccluded this long (IntersectionObserver v2) before a button acts; as the picker panel. */
export const NOTICE_VISIBLE_FOR_MS = 400;
/** Link-click check answer timeout. */
export const LINK_CHECK_TIMEOUT_MS = 50;
