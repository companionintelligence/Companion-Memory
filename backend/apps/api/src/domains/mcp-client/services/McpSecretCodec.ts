import { Injectable } from '@nestjs/common';

import { decrypt, encrypt, isEncrypted } from '@ci/common/crypto';
import config from '@ci/configuration';

import type { McpAuthConfig, McpSecretEntry } from '../types';

/**
 * Per-FIELD AES-256-GCM encryption for the `env`/`auth` JSONB columns on `ci.mcp_server_configs`.
 *
 * Deliberately not whole-column encryption (unlike, say, a single encrypted token column):
 * `env[]` and `auth.fields[]` each mix secret values (an API token, a DB password) with plain ones
 * (a flag, a header name, `ALLOWED_PATH`) in the same array, and encrypting the whole JSONB blob
 * would force every plain field through a decrypt just to read a value that was never sensitive.
 *
 * Encrypted values use the same `encrypt`/`decrypt` (AES-256-GCM, `enc:v1:` prefix) as every other
 * encrypted column in this codebase (see `common/crypto/field-encryption.ts`), keyed off the same
 * `AUTH_FIELD_ENCRYPTION_KEY`. Decrypted values are handled ONLY in-process, ONLY by
 * `McpClientManagerService` at the moment it needs the real value to spawn a stdio process or set
 * an HTTP auth header — never logged, never returned from an API response.
 */
@Injectable()
export class McpSecretCodec {
  /** Encrypt every `secret: true` entry's plaintext `value` before it is written to the DB. */
  encryptEntries(entries: McpSecretEntry[]): McpSecretEntry[] {
    return entries.map((entry) => {
      if (!entry.secret || entry.value == null) {
        return entry;
      }

      // Idempotent: an entry already carrying ciphertext (e.g. re-saved unchanged by a caller
      // that round-tripped a decrypted value it should not have) is not double-encrypted.
      if (isEncrypted(entry.value)) {
        return entry;
      }

      return { ...entry, value: this.encryptValue(entry.value) };
    });
  }

  /** Decrypt every `secret: true` entry's `value` back to plaintext, for in-process use only. */
  decryptEntries(entries: McpSecretEntry[]): McpSecretEntry[] {
    return entries.map((entry) => {
      if (!entry.secret || entry.value == null) {
        return entry;
      }

      return { ...entry, value: this.decryptValue(entry.value) };
    });
  }

  encryptAuth(auth: McpAuthConfig | null | undefined): McpAuthConfig | null {
    if (!auth) {
      return null;
    }

    return { type: auth.type, fields: this.encryptEntries(auth.fields ?? []) };
  }

  decryptAuth(auth: McpAuthConfig | null | undefined): McpAuthConfig | null {
    if (!auth) {
      return null;
    }

    return { type: auth.type, fields: this.decryptEntries(auth.fields ?? []) };
  }

  /**
   * Merge a client-submitted `env`/`auth.fields` update against the currently-stored (still
   * encrypted) entries: for any `secret: true` field the client submitted with `value: null`, keep
   * the stored ciphertext as-is ("leave unchanged"); any other submitted value — including an
   * empty string — is treated as a rotation and re-encrypted by the caller via
   * {@link encryptEntries}.
   *
   * This is what makes the egress contract in `McpServerConfigEntity.toEgressType` round-trip
   * safely: the client only ever sees `value: null` for a set secret, so an update handler that
   * echoes the object it just fetched must not accidentally blank the secret out.
   */
  mergeEntriesForUpdate(stored: McpSecretEntry[], submitted: McpSecretEntry[]): McpSecretEntry[] {
    const storedByKey = new Map(stored.map((entry) => [entry.key, entry]));

    return submitted.map((entry) => {
      if (entry.secret && entry.value == null) {
        const existing = storedByKey.get(entry.key);

        return existing ?? entry;
      }

      return entry;
    });
  }

  private encryptValue(plaintext: string): string {
    return encrypt(plaintext, config.auth.encryption.fieldKey);
  }

  private decryptValue(value: string): string {
    if (!isEncrypted(value)) {
      // Tolerate a plaintext value the same way `encryptedColumnTransformer` does — defensive
      // against a row written before encryption was wired up, not an expected steady state.
      return value;
    }

    return decrypt(value, config.auth.encryption.fieldKey);
  }
}
