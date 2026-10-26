import { z } from 'zod/v3';

/**
 * The shortest password a new or changed one may be: signup, `PATCH /account/password` and the
 * `make userpw` script all apply it. Existing shorter passwords keep working until they are next
 * changed; nobody is locked out by the rule moving.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** A password someone is choosing now. */
export const newPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
