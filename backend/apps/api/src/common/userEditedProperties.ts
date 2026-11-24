/** The property holding the keys a person explicitly set or cleared by hand. */
export const USER_EDITED_KEYS = 'user_edited_keys';

/** Read the string keys a stored property bag records as set by hand. */
export function userEditedKeys(properties: Record<string, unknown> | null | undefined): string[] {
  const listed = isObject(properties) ? properties[USER_EDITED_KEYS] : undefined;

  return Array.isArray(listed) ? listed.filter((key): key is string => typeof key === 'string') : [];
}

/** The stored list as a SQL jsonb array; missing and malformed values read as `[]`. */
export function userEditedListSql(properties: string): string {
  return (
    `(CASE WHEN jsonb_typeof(${properties} -> '${USER_EDITED_KEYS}') = 'array' ` +
    `THEN ${properties} -> '${USER_EDITED_KEYS}' ELSE '[]'::jsonb END)`
  );
}

/** SQL predicate for whether a property bag records `key` as set by hand. */
export function userEditedSql(properties: string, key: string): string {
  return `(${userEditedListSql(properties)} @> jsonb_build_array(${key}))`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
