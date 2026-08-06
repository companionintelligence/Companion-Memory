import { createHash, randomBytes } from 'crypto';

import bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import config from '@ci/configuration';
import { ApiKeyEntity } from '@ci/domains/auth/entities/ApiKeyEntity';
import { UserEntity } from '@ci/domains/user';

/**
 * Provision a user and an API key in one step, for pointing an external client
 * (CI-Import-Tools, a script, a REST client) at a local stack.
 *
 * Unlike the other scripts in this directory this one takes no prompts, so it can run
 * unattended in a test harness. Everything is overridable by environment variable:
 *
 *   TEST_USER_EMAIL     [test@example.com]
 *   TEST_USER_NAME      [Test User]
 *   TEST_USER_PASSWORD  [generated and printed]
 *   TEST_KEY_NAME       [test-client]
 *   TEST_KEY_SCOPES     [""]  comma-separated; "" means full user authority
 *
 * The scope default is empty on purpose, and it is not the lazy choice. Scope
 * enforcement is deny-by-default (see RequireScopes): a key with a NON-EMPTY scope
 * array may only reach routes that declare `@RequireScopes` listing those scopes, and
 * only `/memory/*`, `/api/intents` and `/mcp` declare any. So a `memory`-scoped key is
 * refused by the ingest routes (`/v1/events`, `/v1/contents`, …) with a 403 — which is
 * exactly what an import client needs. Narrow it via TEST_KEY_SCOPES when testing the
 * agent surfaces specifically.
 *
 * Re-running is safe. An existing user is reused rather than duplicated, and its
 * password is left alone unless TEST_USER_PASSWORD says otherwise — so a second run
 * does not invalidate credentials already pasted into a client config. The key is
 * always reminted (see below).
 *
 * NOT for staging or production: it writes a login whose password is printed to a
 * terminal, and mints a key that bypasses the consent flow.
 */

/**
 * Mirrors ApiKeyService.create. That service cannot be reused here without standing up
 * the Nest container, and its length/hash constants are module-private, so the shape is
 * duplicated — as change-password.ts duplicates the bcrypt hashing.
 *
 * These four lines are a contract with ApiKeyService.hash: sha256 of the raw key, and a
 * raw key matching the `^[0-9a-f]{64}$` gate ApiKeyStrategy applies before any DB
 * lookup. If that service changes how keys are derived, this mints dead keys that
 * authenticate nowhere — change both together.
 */
const API_KEY_BYTE_LENGTH = 32;
const PREFIX_LENGTH = 5;

function mintKey() {
  const rawKey = randomBytes(API_KEY_BYTE_LENGTH).toString('hex');

  return {
    rawKey,
    prefix: rawKey.substring(0, PREFIX_LENGTH),
    hashedKey: createHash('sha256').update(rawKey).digest('hex'),
  };
}

(async () => {
  const email = process.env.TEST_USER_EMAIL ?? 'test@example.com';
  const name = process.env.TEST_USER_NAME ?? 'Test User';
  const keyName = process.env.TEST_KEY_NAME ?? 'test-client';

  // Empty is both the default and a meaningful value — the grandfathered "full user
  // authority" key. See the scope note in the header before narrowing this.
  const rawScopes = process.env.TEST_KEY_SCOPES ?? '';
  const scopes = rawScopes
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);

  // A generated password beats a default one: nothing secret ends up committed, and a
  // stack provisioned by this script has no password an attacker could guess from the
  // source. Printed once, below.
  const suppliedPassword = process.env.TEST_USER_PASSWORD;
  const password = suppliedPassword ?? randomBytes(12).toString('base64url');

  const db = new DataSource({
    type: config.db.type,
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    username: config.db.username,
    password: config.db.password,
    entities: [UserEntity, ApiKeyEntity],
    synchronize: false,
    logging: ['error'],
  });

  await db.initialize();

  const users = db.getRepository(UserEntity);
  const apiKeys = db.getRepository(ApiKeyEntity);

  let exitCode = 0;

  try {
    let user = await users.findOneBy({ email });
    const isNewUser = user == null;

    if (user == null) {
      user = await users.save(
        users.create({
          id: uuidv7(),
          name,
          email,
          password: await bcrypt.hash(password, config.auth.local.saltRounds),
          // Skip the FTUE wizard: a client authenticating with an API key never walks
          // it, and an un-onboarded user trips guards on some surfaces.
          onboarded: true,
        }),
      );
    } else if (suppliedPassword != null) {
      user.password = await bcrypt.hash(suppliedPassword, config.auth.local.saltRounds);
      await users.save(user);
    }

    // Raw keys are stored hashed and revealed only at creation, so a re-run cannot
    // reprint the previous secret. Drop the old row and mint a fresh one instead of
    // accumulating dead keys under the same name — the same trade ApiKeyService's
    // createOrRotate makes.
    await apiKeys.delete({ user_id: user.id, name: keyName });

    const { rawKey, prefix, hashedKey } = mintKey();

    await apiKeys.save(
      apiKeys.create({
        id: uuidv7(),
        name: keyName,
        prefix,
        hashed_key: hashedKey,
        scopes,
        user_id: user.id,
        // Left null: this key is the user's own, not minted by the connect flow.
        managed_by: null,
      }),
    );

    const passwordLine =
      suppliedPassword == null && !isNewUser
        ? '(unchanged — set TEST_USER_PASSWORD to reset it)'
        : password;

    console.log(`
User      ${email} ${isNewUser ? '(created)' : '(existing)'}
Password  ${passwordLine}
User id   ${user.id}

API key   ${rawKey}
  name    ${keyName}
  scopes  ${scopes.length > 0 ? scopes.join(', ') : '(none — full user authority)'}

The key is shown once. For CI-Import-Tools, put it in backend/.env:

  CI_SERVER_URL=http://localhost:3030
  CI_SERVER_TOKEN=${rawKey}
`);
  } catch (err) {
    console.error('\nFailed to provision test user', (err as Error).message);
    exitCode = 1;
  }

  await db.destroy();

  process.exit(exitCode);
})();
