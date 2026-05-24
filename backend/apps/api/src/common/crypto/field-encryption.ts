import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { ValueTransformer } from 'typeorm';

import config from '@ci/configuration';

/**
 * AES-256-GCM field-level encryption for sensitive database columns.
 *
 * Ciphertext format: `enc:v1:<iv-hex>:<authTag-hex>:<ciphertext-hex>`
 *
 * - 12-byte random IV per encryption (NIST recommended for GCM)
 * - 16-byte authentication tag (tamper detection)
 * - The `enc:v1:` prefix allows detection of already-encrypted values
 *   and enables future versioning of the encryption scheme.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PREFIX = 'enc:v1:';

let _keyBuffer: Buffer | null = null;

function getKeyBuffer(hexKey: string): Buffer {
  if (!_keyBuffer) {
    if (!/^[0-9A-Fa-f]{64}$/.test(hexKey)) {
      throw new Error('AUTH_FIELD_ENCRYPTION_KEY must be a 64-character hex string (256 bits)');
    }

    _keyBuffer = Buffer.from(hexKey, 'hex');
  }

  return _keyBuffer;
}

export function encrypt(plaintext: string, hexKey: string): string {
  const key = getKeyBuffer(hexKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(ciphertext: string, hexKey: string): string {
  if (!ciphertext.startsWith(PREFIX)) {
    throw new Error('Invalid ciphertext: missing version prefix');
  }

  const payload = ciphertext.slice(PREFIX.length);
  const parts = payload.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext: expected iv:authTag:data');
  }

  const [ivHex, authTagHex, dataHex] = parts;
  const key = getKeyBuffer(hexKey);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

  return decrypted.toString('utf8');
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * TypeORM value transformer that encrypts values with AES-256-GCM before
 * writing to the database and decrypts them when reading. Handles nullable
 * columns and gracefully decrypts legacy plaintext values during the
 * migration window.
 */
export const encryptedColumnTransformer: ValueTransformer = {
  to(value: string | null): string | null {
    if (value == null) {
      return null;
    }

    return encrypt(value, config.auth.encryption.fieldKey);
  },
  from(value: string | null): string | null {
    if (value == null) {
      return null;
    }

    // Gracefully handle legacy plaintext values (pre-migration rows)
    if (!isEncrypted(value)) {
      return value;
    }

    return decrypt(value, config.auth.encryption.fieldKey);
  },
};
