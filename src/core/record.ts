/**
 * Own-property lookup for records keyed by untrusted strings. `constructor` and `tostring` are
 * valid hostnames and pack ids, so `record[key]` would return `Object.prototype` members
 * (review HIGH, P1-06). Every lookup by a user, list or catalog key goes through `own`.
 */
export function own<K extends string, V>(record: Readonly<Record<K, V>>, key: K): V | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
