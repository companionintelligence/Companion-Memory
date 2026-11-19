import { createPublicKey, sign, verify } from 'node:crypto';

import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { LoggerService } from '@ci/common/logging';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import { didKeyPublicJwk } from '../didKeyId';
import { PeerIdentityKeyEntity } from '../entities/PeerIdentityKeyEntity';
import { PeerIdentityService } from '../services/PeerIdentityService';

/**
 * Each person's peer key, against real Postgres: made once, one per person even
 * when two first uses race, and never stored in the clear.
 *
 * Opt-in like the other peers suites: `PEERS_TEST_DATABASE_URL`, or the
 * `DATABASE_*` settings `yarn test` reads from the repo-root `.env`.
 */
const availability = databaseAvailability({ urlEnvVar: 'PEERS_TEST_DATABASE_URL' });
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[peers/PeerIdentityKeys.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`per-person peer keys — against real Postgres (${availability.target})`, () => {
  const alice = uuidv7();
  const carol = uuidv7();

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as LoggerService;

  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: PeerIdentityService;

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'PEERS_TEST_DATABASE_URL' });

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
      entities: [UserEntity, PeerIdentityKeyEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'peer identity keys');

    for (const [id, label] of [
      [alice, 'PeerKeysAlice'],
      [carol, 'PeerKeysCarol'],
    ] as const) {
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, password, onboarded)
         VALUES ($1, $2, $3, 'x', true)
         ON CONFLICT (id) DO NOTHING`,
        [id, label, `peer.keys.${id}@example.test`],
      );
    }

    service = new PeerIdentityService(dataSource.getRepository(PeerIdentityKeyEntity), noopLogger);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // ON DELETE CASCADE takes the keys.
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [[alice, carol]]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('makes a key the first time and returns the same one after', async () => {
    const first = await service.identityFor(alice);
    const again = await service.identityFor(alice);

    expect(first.didKey).toMatch(/^did:key:z6Mk/);
    expect(again.didKey).toBe(first.didKey);
    expect(await service.existingDidKeyFor(alice)).toBe(first.didKey);
  });

  it('signs with the key its did:key names', async () => {
    const identity = await service.identityFor(alice);
    const message = Buffer.from('hello');
    const signature = sign(null, message, identity.signer.key);
    const publicKey = createPublicKey({ key: didKeyPublicJwk(identity.didKey) as never, format: 'jwk' });

    expect(verify(null, message, publicKey, signature)).toBe(true);
    expect(identity.signer.keyid).toBe(identity.didKey);
  });

  it('gives two people two different keys', async () => {
    const a = await service.identityFor(alice);
    const c = await service.identityFor(carol);

    expect(c.didKey).not.toBe(a.didKey);
    expect((await service.findActiveByDidKey(c.didKey))?.userId).toBe(carol);
    expect((await service.findActiveByDidKey(a.didKey))?.userId).toBe(alice);
  });

  it('keeps ONE key per person when first uses race', async () => {
    const racer = uuidv7();
    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded) VALUES ($1, 'PeerKeysRacer', $2, 'x', true)`,
      [racer, `peer.keys.${racer}@example.test`],
    );

    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => service.identityFor(racer)));
      const rows = await dataSource.query(
        `SELECT did_key FROM ci.peer_identity_keys WHERE user_id = $1 AND status = 'active'`,
        [racer],
      );

      expect(rows).toHaveLength(1);
      expect(new Set(results.map((result) => result.didKey))).toEqual(new Set([rows[0].did_key]));
    } finally {
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [racer]);
    }
  });

  it('never stores the private key in the clear', async () => {
    const identity = await service.identityFor(alice);
    const [row] = await dataSource.query(
      `SELECT private_jwk, public_jwk FROM ci.peer_identity_keys WHERE did_key = $1`,
      [identity.didKey],
    );

    expect(row.private_jwk).toMatch(/^enc:v1:/);
    expect(row.private_jwk).not.toContain('"d"');
    expect(Object.keys(row.public_jwk).sort()).toEqual(['crv', 'kty', 'x']);
  });

  it('answers nothing for a did:key nobody here holds, or a non-did:key', async () => {
    expect(
      await service.findActiveByDidKey('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'),
    ).toBeNull();
    expect(await service.findActiveByDidKey('https://example.test')).toBeNull();
  });
});
