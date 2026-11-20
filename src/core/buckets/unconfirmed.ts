/**
 * Company buckets whose name the panel does not show yet (D-34, P2-12): the entities map was written
 * from memory (P1-20), and an entry that could not be confirmed against a first-party source shows
 * as "Other advertising / Other tracking" until the owner confirms it. `lists/` is not edited here;
 * the list of entries and why each is held back is in the P2-12 notes.
 */
export const UNCONFIRMED_BUCKETS: ReadonlySet<string> = new Set<string>([]);
