/** Permissions, `storage.session` and alarms adapters (P1-10). */
import type { AlarmsApi, PermissionsApi, StorageAreaApi } from './chromeApi.js';
import type { AlarmsPort, PermissionsPort, SessionStorePort } from './ports.js';

const ALL_URLS = '<all_urls>';

/**
 * `<all_urls>` is reported exactly when `permissions.contains` says it is granted (P1-06 follow-up),
 * so an equivalent grant form (every scheme and host listed separately) still counts as all sites.
 */
export function createPermissionsPort(api: PermissionsApi): PermissionsPort {
  return {
    getGrants: async () => {
      const [all, granted] = await Promise.all([api.contains({ origins: [ALL_URLS] }), api.getAll()]);
      const others = (granted.origins ?? []).filter((origin) => origin !== ALL_URLS);
      return { origins: all ? [ALL_URLS, ...others] : others };
    },
  };
}

export function createSessionStorePort(area: StorageAreaApi): SessionStorePort {
  return {
    get: async (key) => (await area.get(key))[key],
    set: (key, value) => area.set({ [key]: value }),
    remove: (key) => area.remove(key),
  };
}

export function createAlarmsPort(api: AlarmsApi): AlarmsPort {
  return {
    setAt: (name, when) => api.create(name, { when }),
    clear: async (name) => {
      await api.clear(name);
    },
  };
}
