/**
 * Loading a panel part as its own chunk (P2-14 breakage flow, P2-60b pop-up row): the panel's JS budget is
 * 30 kB gzip for everything (UI notes §3), so parts that are not needed for the first paint load on demand.
 * `failed` when the chunk cannot be loaded (the caller says so; never a stuck "Loading").
 */
import { useEffect, useState } from 'preact/hooks';

export type Chunk<T> = T | 'failed' | null;

export function useChunk<T>(wanted: boolean, load: () => Promise<T>): Chunk<T> {
  const [chunk, setChunk] = useState<Chunk<T>>(null);
  useEffect(() => {
    if (!wanted || chunk !== null) return;
    load().then(
      (value) => {
        setChunk(() => value);
      },
      () => {
        setChunk('failed');
      },
    );
  }, [wanted, chunk, load]);
  return chunk;
}
