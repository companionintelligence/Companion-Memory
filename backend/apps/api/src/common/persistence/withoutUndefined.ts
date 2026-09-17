/**
 * An absent key in an update DTO means "leave alone"; an explicit `null` means
 * "clear this field". A resolver that builds its DTO as an object literal with
 * every field present (rather than spreading only the fields the caller set)
 * sends an untouched field as `key: undefined` rather than an absent key, and
 * `Object.assign` cannot tell that apart from a real value — it clobbers the
 * fetched entity's current value with `undefined`. TypeORM's `save()` skips
 * `undefined` columns when building SQL, so the database write is unaffected,
 * but the in-memory entity `save()` returns keeps the clobbered `undefined`,
 * which can then trip a GraphQL non-null check on read-back (see #2703).
 * Filtering once before `Object.assign` protects every caller of `update()`.
 */
export function withoutUndefined<T extends object>(data: T): Partial<T> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) as Partial<T>;
}
