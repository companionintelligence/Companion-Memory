/**
 * Sanitizes a free-text token (a CI entity type or property key) into a
 * Turtle-safe local name, so `ci:<name>` abbreviates instead of falling back to
 * a full `<...>` IRI. Non-conforming characters become `_`, a leading run that
 * can't start a PN_LOCAL is stripped, and an empty result falls back to `_`.
 *
 * The mapping is stable for a given input but NOT reversible — it exists to
 * make a valid IRI, not to encode the original string. Relationship types,
 * which must round-trip, use `encodeURIComponent` into a full IRI instead.
 */
export const safeLocalName = (raw: string): string => {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z_]+/, '');

  return cleaned.length > 0 ? cleaned : '_';
};
