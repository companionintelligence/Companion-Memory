/**
 * Top-level `ci.entities.properties` keys that the appliance itself keeps, and that a general
 * graph write from a tool must neither set, remove, nor drop by replacing the bag.
 *
 * - `planner` holds the owner's settings on their own Person: the autonomy dial
 *   (`planner.trust_mode`, which decides whether sends and deletes ask first), the chat model and
 *   the image and browser-activity preferences. Settings and onboarding write it a leaf at a time
 *   through `PersonService.patchPropertyLeaves`.
 * - `is_self` is the graph's claim that a Person is the account holder. `UserContextService` falls
 *   back on it to find the owner's entity, which is also where the dial is read from.
 * - `emails`, `phones`, `names`, `Phones` and `Faxes` are the identity lists imports index into
 *   `ci.entity_identifiers` and `PersonMergeService` unions across merged duplicates (the
 *   `IDENTITY_LIST_KEYS` re-ingest keeps). A shallow overwrite of one drops the values a merge
 *   brought in, with nothing left to restore them from.
 *
 * Exact keys, matched exactly: jsonb keys are case-sensitive, and every reader above reads these
 * spellings.
 */
export const OWNER_SETTING_PROPERTY_KEYS: readonly string[] = ['planner', 'is_self'];

export const OWNER_MANAGED_PROPERTY_KEYS: readonly string[] = [
  ...OWNER_SETTING_PROPERTY_KEYS,
  'emails',
  'phones',
  'names',
  'Phones',
  'Faxes',
];

const OWNER_MANAGED = new Set(OWNER_MANAGED_PROPERTY_KEYS);
const OWNER_SETTINGS = new Set(OWNER_SETTING_PROPERTY_KEYS);

/** Whether `key` is one of {@link OWNER_MANAGED_PROPERTY_KEYS}. */
export function isOwnerManagedPropertyKey(key: string): boolean {
  return OWNER_MANAGED.has(key);
}

/**
 * Whether `key` is one of {@link OWNER_SETTING_PROPERTY_KEYS}: the owner's settings and the self
 * claim, which no tool write may carry on any row, a brand-new one included. The identity lists
 * are only at risk on a row that already holds them.
 */
export function isOwnerSettingPropertyKey(key: string): boolean {
  return OWNER_SETTINGS.has(key);
}
