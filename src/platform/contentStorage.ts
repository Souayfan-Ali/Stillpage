/**
 * The one storage read a content script makes (P2-20): `storage.local.get(keys)` for the `uf:*`
 * mirror. The values are untrusted (content scripts can write `storage.local` too); the caller guards them.
 * `onStorageChanged` (D-80) hands over the changed key names only, never their values: the caller re-reads.
 */
import { extensionApi } from './contentApi.js';

export function readLocal(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>> {
  return extensionApi().storage.local.get([...keys]);
}

/** `storage.onChanged`, as key names and area. Added when called (inside the script's run), never at load. */
export function onStorageChanged(listener: (keys: readonly string[], area: string) => void): void {
  extensionApi().storage.onChanged.addListener((changes, area) => {
    listener(Object.keys(changes), area);
  });
}
