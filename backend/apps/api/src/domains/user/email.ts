/**
 * The one spelling of an email address this appliance stores and compares: trimmed and
 * lower-cased. `ci.users` has a unique index on `lower(email)`, so two spellings of one address
 * can no longer be two accounts, and every lookup that folds case finds at most one.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
