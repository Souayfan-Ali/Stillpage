/**
 * `navigator.globalPrivacyControl` (P2-31, the GPC spec's DOM signal) for the MAIN-world `gpc`
 * registration, registered only while GPC is on. A getter on `Navigator.prototype`, as the spec defines
 * it; a native or earlier definition is left alone. No data, no messages, nothing at module top level.
 */
export function defineGpc(proto: object | undefined): void {
  if (proto === undefined || Object.getOwnPropertyDescriptor(proto, 'globalPrivacyControl') !== undefined) return;
  Object.defineProperty(proto, 'globalPrivacyControl', { get: () => true, configurable: true, enumerable: true });
}
