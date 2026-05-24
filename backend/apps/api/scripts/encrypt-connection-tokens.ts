/**
 * One-time migration script to encrypt existing plaintext connection tokens.
 *
 * Run after deploying the column transformer changes:
 *   yarn tsx scripts/encrypt-connection-tokens.ts
 *
 * This script:
 * 1. Reads all connections with non-null access_token or refresh_token
 * 2. Skips any already-encrypted values (idempotent / safe to re-run)
 * 3. Encrypts plaintext values with AES-256-GCM using AUTH_FIELD_ENCRYPTION_KEY
 * 4. Updates each row directly (bypasses TypeORM transformer to avoid double-encrypt)
 */

import { DataSource } from 'typeorm';

import { encrypt, isEncrypted } from '@ci/common/crypto';
import config from '@ci/configuration';

const ENCRYPTION_KEY = config.auth.encryption.fieldKey;

(async () => {
  const db = new DataSource({
    type: config.db.type,
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    username: config.db.username,
    password: config.db.password,
    synchronize: false,
    logging: ['error'],
  });

  await db.initialize();

  console.log('Encrypting existing connection tokens...\n');

  // Raw query to bypass TypeORM transformer — we need the actual DB values
  const rows: { id: string; access_token: string | null; refresh_token: string | null }[] = await db.query(`
      SELECT id, access_token, refresh_token
      FROM ci.connections
      WHERE access_token IS NOT NULL OR refresh_token IS NOT NULL
    `);

  let encrypted = 0;
  let skipped = 0;

  for (const row of rows) {
    const updates: Record<string, string> = {};

    if (row.access_token && !isEncrypted(row.access_token)) {
      updates.access_token = encrypt(row.access_token, ENCRYPTION_KEY);
    }

    if (row.refresh_token && !isEncrypted(row.refresh_token)) {
      updates.refresh_token = encrypt(row.refresh_token, ENCRYPTION_KEY);
    }

    if (Object.keys(updates).length === 0) {
      skipped++;
      continue;
    }

    const setClauses = Object.entries(updates)
      .map(([col], i) => `${col} = $${i + 2}`)
      .join(', ');

    const params = [row.id, ...Object.values(updates)];

    await db.query(`UPDATE ci.connections SET ${setClauses} WHERE id = $1`, params);
    encrypted++;

    const fields = Object.keys(updates).join(', ');
    console.log(`  ✓ ${row.id} — encrypted ${fields}`);
  }

  console.log(`\nDone. Encrypted: ${encrypted}, Already encrypted: ${skipped}, Total: ${rows.length}`);

  await db.destroy();
  process.exit(0);
})();
