import { randomBytes, randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { SYSTEM_USER } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { SavedSearchEntity } from '@ci/domains/files/entities/SavedSearchEntity';
import { SavedSearchService } from '@ci/domains/files/services/SavedSearchService';
import { PeerLinkEntity } from '@ci/domains/peers/entities/PeerLinkEntity';
import { PeerLinkService } from '@ci/domains/peers/services/PeerLinkService';
import { AccountPurgeService, LastAdminDeletionRefused, UserEntity, UserService } from '@ci/domains/user';

import {
  resolveAdminConnection,
  ScratchDatabase,
  scratchDatabaseAvailability,
} from '../../../__tests__/support/scratchDatabase';
import { DataDeletionAuditEntity } from '../../entities/DataDeletionAuditEntity';
import { DataDeletionService } from '../DataDeletionService';

/**
 * `POST /users/me/delete`, against the real schema: every migration, in a
 * database of its own (see `scratchDatabase.ts`), with the real `UserService`
 * and `AccountPurgeService` behind it.
 *
 * What only a real Postgres can show: that ending the account is all or nothing
 * (the successor's promotion included), that the purge keeps what it did when it
 * is interrupted and the hourly run finishes it, that a sign-up is not held
 * while an account's rows are being deleted, that a row written for the account
 * during its purge does not undo the delete, and that the failure path cannot
 * hang on the pool.
 *
 * Skips (loudly) when there is no administrative connection.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[DataDeletionService.integration] SKIPPED — ${availability.reason}`);
}

/**
 * One past TimescaleDB's default cap on the tuples one transaction may
 * decompress (`timescaledb.max_tuples_decompressed_per_dml_transaction`).
 */
const COMPRESSED_POSITION_ROWS = 100_001;

jest.setTimeout(600_000);

describeWithDatabase(`immediate account delete, against the real schema (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let dataSource: DataSource;
  let userService: UserService;
  let purgeService: AccountPurgeService;
  let service: DataDeletionService;
  let deletedObjects: Array<{ bucket: string; keys: string[] }>;

  const OWN = (userId: string) => ({ userId });

  const query = async <T>(sql: string, parameters?: unknown[]): Promise<T[]> =>
    (await dataSource.query(sql, parameters)) as T[];

  const count = async (table: string, where: string, parameters: unknown[]): Promise<number> => {
    const [row] = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
      [...parameters],
    );

    return Number(row.count);
  };

  const audits = async (userId: string) =>
    query<{
      status: string;
      total_deleted: number;
      deleted_counts: Record<string, number>;
      error: string | null;
    }>(
      `SELECT status, total_deleted, deleted_counts, error FROM ci.data_deletion_audit
        WHERE subject_user_id = $1 ORDER BY created_at, status DESC`,
      [userId],
    );

  const addUser = async (
    name: string,
    extra: { role?: string; createdBy?: string } = {},
  ): Promise<string> => {
    const id = randomUUID();
    await query(`INSERT INTO ci.users (id, email, name, role, created_by) VALUES ($1, $2, $3, $4, $5)`, [
      id,
      `${name.toLowerCase()}-${id}@example.test`,
      name,
      extra.role ?? 'user',
      extra.createdBy ?? null,
    ]);

    return id;
  };

  const makeService = (source: DataSource) => {
    const users = new UserService(source.getRepository(UserEntity), { send: async () => undefined } as never);
    const purge = new AccountPurgeService(source, new LoggerService(), {
      deleteObjects: async (bucket: string, keys: string[]) => {
        deletedObjects.push({ bucket, keys });
      },
    });

    return {
      users,
      purge,
      deletion: new DataDeletionService(
        source,
        // No connections to revoke: the revocations are not what this suite is about.
        { find: async () => [] } as never,
        source.getRepository(DataDeletionAuditEntity),
        {} as never,
        { cleanOrphans: async () => ({ results: [], totalDeleted: 0, dryRun: false }) } as never,
        {} as never,
        {} as never,
        new LoggerService(),
        users,
        purge,
      ),
    };
  };

  const openDataSource = async (max: number) => {
    const admin = resolveAdminConnection()!;
    const source = new DataSource({
      type: 'postgres',
      host: admin.host,
      port: admin.port,
      username: admin.username,
      password: admin.password,
      database: scratch.name,
      entities: [DataDeletionAuditEntity, UserEntity, SavedSearchEntity, PeerLinkEntity],
      synchronize: false,
      logging: false,
      extra: { max },
    });

    return source.initialize();
  };

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'DataDeletionService.integration.spec' });
    await scratch.assertOwn();

    dataSource = await openDataSource(6);
    deletedObjects = [];
    ({ users: userService, purge: purgeService, deletion: service } = makeService(dataSource));
  }, 300_000);

  afterAll(async () => {
    await dataSource?.destroy();
    await scratch?.drop();
  }, 60_000);

  describe('a whole account, with every kind of row', () => {
    let victim: string;
    let bystander: string;
    let other: string;
    const victimEntities = [randomUUID(), randomUUID(), randomUUID()];
    const objectKey = randomUUID();
    const audit = {
      asked: randomUUID(),
      answered: randomUUID(),
      toPeer: randomUUID(),
      fromPeer: randomUUID(),
      unrelated: randomUUID(),
    };

    /** Everything of the victim's the delete must take, counted. */
    const victimFootprint = async () => ({
      user: await count('ci.users', 'id = $1', [victim]),
      entities: await count('ci.entities', 'owner_user_id = $1', [victim]),
      notes: await count('ci.notes', 'user_id = $1', [victim]),
      savedSearches: await count('ci.saved_searches', 'user_id = $1', [victim]),
      files: await count('ci.files', 'user_id = $1', [victim]),
      positions: await count('ci.position', 'user_id = $1', [victim]),
      sessions: await count('ci.sessions', 'user_id = $1', [victim]),
      apiKeys: await count('ci.api_keys', 'user_id = $1', [victim]),
      askAudit: await count('ci.ask_audit', 'asker_user_id = $1 OR responder_user_id = $1', [victim]),
      createdBy: await count('ci.users', 'created_by = $1', [victim]),
    });

    beforeAll(async () => {
      victim = await addUser('Victim');
      bystander = await addUser('Bystander', { createdBy: victim });
      other = await addUser('Other');

      for (const entity of victimEntities) {
        await query(
          `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1, 'Person', $2, 'seed')`,
          [entity, victim],
        );
      }

      await query(`UPDATE ci.users SET entity_id = $2 WHERE id = $1`, [victim, victimEntities[0]]);

      for (const owner of [victim, bystander]) {
        await query(`INSERT INTO ci.notes (id, user_id, content) VALUES ($1, $2, 'seed note')`, [
          randomUUID(),
          owner,
        ]);
      }

      for (let index = 0; index < 2; index += 1) {
        await query(`INSERT INTO ci.saved_searches (id, user_id) VALUES ($1, $2)`, [randomUUID(), victim]);
      }

      await query(
        `INSERT INTO ci.files (id, user_id, content_type, bucket, key, filename)
         VALUES ($1, $2, 'image/png', 'companion', $3, 'seed.png')`,
        [randomUUID(), victim, objectKey],
      );

      await query(
        `INSERT INTO ci.sessions (id, user_id, token, expires_at) VALUES ($1, $2, 'seed', now() + interval '1 day')`,
        [randomUUID(), victim],
      );
      await query(
        `INSERT INTO ci.api_keys (id, name, prefix, hashed_key, scopes, user_id, capability, created_at, updated_at)
         VALUES ($1, 'seed', 'ci_seed', 'hash', '{}', $2, 'full', now(), now())`,
        [randomUUID(), victim],
      );

      // A compressed ci.position chunk holding more than the cap.
      await query(
        `INSERT INTO ci.position (time, user_id, source, location)
         SELECT TIMESTAMPTZ '2026-06-01 00:00:00+00' + g * INTERVAL '1 second', $1, 'gps',
                ST_SetSRID(ST_MakePoint(0, 0), 4326)
           FROM generate_series(0, $2::int - 1) g`,
        [victim, COMPRESSED_POSITION_ROWS],
      );
      const compressed = await query(
        `SELECT compress_chunk(c) FROM show_chunks('ci.position') c
          WHERE c IN (SELECT format('%I.%I', chunk_schema, chunk_name)::regclass
                        FROM timescaledb_information.chunks
                       WHERE hypertable_schema = 'ci' AND hypertable_name = 'position'
                         AND range_end <= '2026-07-01' AND range_start >= '2026-05-01')`,
      );
      expect(compressed).toHaveLength(1);

      const insertAudit = (
        id: string,
        asker: string | null,
        responder: string | null,
        prompt: string,
        disclosed: string[],
      ) =>
        query(
          `INSERT INTO ci.ask_audit
             (id, asker_user_id, responder_user_id, peer_link_id, query, consent_basis, outcome,
              disclosed_entities, backing_entities, disclosed_count)
           VALUES ($1, $2, $3, $4, $5, $6, 'answered', $7, $7, $8)`,
          [
            id,
            asker,
            responder,
            asker == null || responder == null ? randomUUID() : null,
            JSON.stringify({
              queryType: 'retrieval',
              dataClass: 'calendar',
              prompt,
              filters: { who: 'Alice' },
              actor: { kind: 'person' },
            }),
            responder == null ? null : randomUUID(),
            JSON.stringify(disclosed),
            disclosed.length,
          ],
        );

      await insertAudit(audit.asked, victim, bystander, 'where was Alice on Tuesday?', ['bystander-entity']);
      await insertAudit(audit.answered, bystander, victim, 'are you free Friday?', [victimEntities[1]]);
      await insertAudit(audit.toPeer, victim, null, 'hello peer', []);
      await insertAudit(audit.fromPeer, null, victim, 'hello from a peer', [victimEntities[2]]);
      await insertAudit(audit.unrelated, bystander, other, 'unrelated', ['other-entity']);
    }, 300_000);

    it('deletes every row of it, the bytes first, and records started then completed', async () => {
      expect(await victimFootprint()).toEqual({
        user: 1,
        entities: 3,
        notes: 1,
        savedSearches: 2,
        files: 1,
        positions: COMPRESSED_POSITION_ROWS,
        sessions: 1,
        apiKeys: 1,
        askAudit: 4,
        createdBy: 1,
      });

      const result = await service.deleteAccount(OWN(victim));

      expect(result.status).toBe('deleted');
      expect(result.userDeleted).toBe(true);
      expect(result.deletedCounts).toMatchObject({
        'ci.users': 1,
        'ci.entities': 3,
        'ci.notes': 1,
        'ci.saved_searches': 2,
        'ci.position': COMPRESSED_POSITION_ROWS,
        'ci.ask_audit': 2,
      });
      // ci.users: the bystander's created_by, and the victim's own pointer to its "You" person.
      expect(result.detachedCounts).toMatchObject({ 'ci.ask_audit': 2, 'ci.users': 2 });
      expect(result.deletedObjects).toBe(1);
      expect(deletedObjects).toEqual([{ bucket: 'companion', keys: [objectKey] }]);

      expect(await victimFootprint()).toEqual({
        user: 0,
        entities: 0,
        notes: 0,
        savedSearches: 0,
        files: 0,
        positions: 0,
        sessions: 0,
        apiKeys: 0,
        askAudit: 0,
        createdBy: 0,
      });

      const record = await audits(victim);
      expect(record.map((row) => row.status)).toEqual(['started', 'completed']);
      expect(record[1].deleted_counts).toEqual(result.deletedCounts);
      expect(record[1].total_deleted).toBe(result.totalDeleted);
    });

    it('leaves the account it created alive, with nothing naming the victim', async () => {
      const [row] = await query<{ created_by: string | null }>(
        `SELECT created_by FROM ci.users WHERE id = $1`,
        [bystander],
      );
      expect(row).toEqual({ created_by: null });
      expect(await count('ci.notes', 'user_id = $1', [bystander])).toBe(1);
    });

    it("keeps the other party's ask records, without the victim in them, and deletes the victim's own", async () => {
      const rows = await query<{
        id: string;
        asker_user_id: string | null;
        responder_user_id: string | null;
        query: Record<string, unknown>;
        consent_basis: string | null;
        disclosed_entities: string[];
        backing_entities: string[];
        disclosed_count: number;
      }>(
        `SELECT id, asker_user_id, responder_user_id, query, consent_basis, disclosed_entities,
                backing_entities, disclosed_count
           FROM ci.ask_audit`,
      );
      const byId = new Map(rows.map((row) => [row.id, row]));

      expect(byId.has(audit.toPeer)).toBe(false);
      expect(byId.has(audit.fromPeer)).toBe(false);
      expect(byId.get(audit.asked)).toMatchObject({
        asker_user_id: null,
        responder_user_id: bystander,
        query: { queryType: 'retrieval', dataClass: 'calendar', prompt: '' },
        disclosed_entities: ['bystander-entity'],
        disclosed_count: 1,
      });
      expect(byId.get(audit.answered)).toMatchObject({
        asker_user_id: bystander,
        responder_user_id: null,
        query: { prompt: 'are you free Friday?' },
        consent_basis: null,
        disclosed_entities: [],
        backing_entities: [],
      });
      expect(byId.get(audit.unrelated)).toMatchObject({ asker_user_id: bystander, responder_user_id: other });
    });
  });

  describe('ending the account is all or nothing', () => {
    it('takes the successor promotion back with a failure, records it as failed, and works when asked again', async () => {
      const admin = await addUser('Admin', { role: 'admin' });
      const member = await addUser('Member');
      await query(`INSERT INTO ci.notes (id, user_id, content) VALUES ($1, $2, 'kept')`, [
        randomUUID(),
        admin,
      ]);
      await query(
        `INSERT INTO ci.sessions (id, user_id, token, expires_at) VALUES ($1, $2, 'seed', now() + interval '1 day')`,
        [randomUUID(), admin],
      );

      // Refuse the `started` row, the last write of the transaction that ends the account.
      await query(`
        CREATE OR REPLACE FUNCTION refuse_started_audit_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.status = 'started' AND NEW.subject_user_id = '${admin}'::uuid THEN
            RAISE EXCEPTION 'started audit refused for the test';
          END IF;
          RETURN NEW;
        END $$`);
      await query(
        `CREATE TRIGGER refuse_started_audit BEFORE INSERT ON ci.data_deletion_audit
           FOR EACH ROW EXECUTE FUNCTION refuse_started_audit_for_test()`,
      );

      try {
        await expect(
          service.deleteAccount(OWN(admin), { successorEmail: `member-${member}@example.test` }),
        ).rejects.toThrow('started audit refused for the test');
      } finally {
        await query(`DROP TRIGGER refuse_started_audit ON ci.data_deletion_audit`);
      }

      const roles = await query<{ id: string; role: string; deleted_at: Date | null }>(
        `SELECT id, role, deleted_at FROM ci.users WHERE id = ANY ($1) ORDER BY role`,
        [[admin, member]],
      );
      expect(roles).toEqual([
        { id: admin, role: 'admin', deleted_at: null },
        { id: member, role: 'user', deleted_at: null },
      ]);
      expect(await count('ci.sessions', 'user_id = $1', [admin])).toBe(1);
      expect(await count('ci.notes', 'user_id = $1', [admin])).toBe(1);
      expect((await audits(admin)).map((row) => [row.status, row.error])).toEqual([
        ['failed', expect.stringContaining('started audit refused')],
      ]);

      // Refused without a successor: nothing written, not even a failed row.
      await expect(service.deleteAccount(OWN(admin))).rejects.toBeInstanceOf(LastAdminDeletionRefused);
      expect(await audits(admin)).toHaveLength(1);

      const result = await service.deleteAccount(OWN(admin), {
        successorEmail: `member-${member}@example.test`,
      });

      expect(result.status).toBe('deleted');
      expect(await count('ci.users', 'id = $1', [admin])).toBe(0);
      expect(await query(`SELECT role FROM ci.users WHERE id = $1`, [member])).toEqual([{ role: 'admin' }]);
      expect((await audits(admin)).map((row) => row.status)).toEqual(['failed', 'started', 'completed']);
    });
  });

  describe('a purge that is interrupted', () => {
    it('keeps what it removed, leaves the account ended, and the hourly purge finishes it', async () => {
      const victim = await addUser('Interrupted');
      // ci.agent_memories is purged before ci.notes.
      await query(`INSERT INTO ci.agent_memories (id, user_id, content) VALUES ($1, $2, 'seed')`, [
        randomUUID(),
        victim,
      ]);
      await query(`INSERT INTO ci.notes (id, user_id, content) VALUES ($1, $2, 'seed')`, [
        randomUUID(),
        victim,
      ]);
      await query(
        `INSERT INTO ci.files (id, user_id, content_type, bucket, key, filename)
         VALUES ($1, $2, 'image/png', 'companion', $3, 'seed.png')`,
        [randomUUID(), victim, randomUUID()],
      );

      // The purge dies on ci.notes, every time, until the trigger goes: a crash, a deploy, a
      // statement timeout, all look like this to what has already committed.
      await query(`
        CREATE OR REPLACE FUNCTION refuse_note_delete_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.user_id = '${victim}'::uuid THEN
            RAISE EXCEPTION 'note delete refused for the test';
          END IF;
          RETURN OLD;
        END $$`);
      await query(
        `CREATE TRIGGER refuse_note_delete BEFORE DELETE ON ci.notes
           FOR EACH ROW EXECUTE FUNCTION refuse_note_delete_for_test()`,
      );

      const objectsBefore = deletedObjects.length;
      let result;
      try {
        result = await service.deleteAccount(OWN(victim));
      } finally {
        await query(`DROP TRIGGER refuse_note_delete ON ci.notes`);
      }

      expect(result.status).toBe('deleting');
      expect(result.userDeleted).toBe(false);

      // Ended: nobody can sign in to it, whatever is left of it.
      expect(await userService.findById({ userId: SYSTEM_USER }, victim)).toBeNull();
      // What the purge did before it stopped stays done: the bytes, and the tables before ci.notes.
      expect(deletedObjects.length).toBe(objectsBefore + 1);
      expect(await count('ci.files', 'user_id = $1', [victim])).toBe(0);
      expect(await count('ci.agent_memories', 'user_id = $1', [victim])).toBe(0);
      expect(await count('ci.notes', 'user_id = $1', [victim])).toBe(1);
      const [purge] = await query<{ attempts: number; last_error: string; completed_at: Date | null }>(
        `SELECT attempts, last_error, completed_at FROM ci.account_purges WHERE user_id = $1`,
        [victim],
      );
      expect(purge).toMatchObject({ attempts: 2, completed_at: null });
      expect(purge.last_error).toContain('note delete refused');
      expect((await audits(victim)).map((row) => row.status)).toEqual(['started']);

      // The hourly purge, once the backoff has passed.
      const summary = await purgeService.purgeDueAccounts(new Date(Date.now() + 2 * 60 * 60 * 1000));

      expect(summary.outcomes.find((outcome) => outcome.userId === victim)?.status).toBe('purged');
      expect(await count('ci.users', 'id = $1', [victim])).toBe(0);
      expect(await count('ci.notes', 'user_id = $1', [victim])).toBe(0);
      const record = await audits(victim);
      expect(record.map((row) => row.status)).toEqual(['started', 'completed']);
      expect(record[1].deleted_counts).toMatchObject({ 'ci.notes': 1, 'ci.users': 1 });
    });
  });

  describe('what other people can read through the account', () => {
    // A share link runs the saved search as its owner from the token alone, and an inbound peer
    // ask is answered as the owner of the live peer link that matches the peer. Neither resolves
    // the owner through the hidden user row, so both kept serving the account's memory until the
    // purge reached their tables: hours into an immediate delete of a large account, and the whole
    // grace period of `DELETE /account`. The purge is held off here (switched off, or not yet due)
    // so that what is checked is the end of the account and not the purge.
    const shared = async () => {
      const owner = await addUser('Sharer');
      const reader = await addUser('Reader');
      const searchId = randomUUID();
      const token = randomBytes(16).toString('hex');
      const issuer = 'https://portal.example.test';
      const subject = `peer-${randomUUID()}`;
      const thumbprint = randomBytes(32).toString('base64url');

      await query(
        `INSERT INTO ci.saved_searches (id, user_id, name, entity_types, is_public, share_token)
         VALUES ($1, $2, 'Trips', '{}', true, $3)`,
        [searchId, owner, token],
      );
      await query(
        `INSERT INTO ci.ask_grants (owner_user_id, grantee_user_id, query_type, mode, resource_type, resource_id)
         VALUES ($1, $2, 'saved_search', 'auto', 'saved_search', $3)`,
        [owner, reader, searchId],
      );
      await query(
        `INSERT INTO ci.peer_links
           (owner_user_id, peer_handle, memory_endpoint, peer_issuer, peer_subject, peer_key_jwk, peer_key_thumbprint)
         VALUES ($1, 'friend', 'https://friend.example.test', $2, $3, '{"kty":"OKP"}', $4)`,
        [owner, issuer, subject, thumbprint],
      );

      const searches = new SavedSearchService(dataSource.getRepository(SavedSearchEntity), {} as never);
      const links = new PeerLinkService(
        dataSource.getRepository(PeerLinkEntity),
        new LoggerService(),
        {} as never,
      );

      const reachable = async () => ({
        shareLink: (await searches.findByShareToken(token)) != null,
        peerByIdentity: (await links.findActiveByPeerIdentity(issuer, subject)).length,
        peerByKey: (await links.findActiveByKeyThumbprint(thumbprint)).length,
        liveGrants: await count('ci.ask_grants', 'owner_user_id = $1 AND revoked_at IS NULL', [owner]),
      });

      // Reachable before, or the checks below would prove nothing.
      expect(await reachable()).toEqual({ shareLink: true, peerByIdentity: 1, peerByKey: 1, liveGrants: 1 });

      return { owner, reachable };
    };

    const closed = { shareLink: false, peerByIdentity: 0, peerByKey: 0, liveGrants: 0 };

    it('closes them when the immediate delete ends the account, before the purge reaches them', async () => {
      const { owner, reachable } = await shared();
      const enabled = config.accountDeletion.purge.enabled;
      config.accountDeletion.purge.enabled = false;

      try {
        const result = await service.deleteAccount(OWN(owner));

        expect(result.status).toBe('deleting');
      } finally {
        config.accountDeletion.purge.enabled = enabled;
      }

      expect(await reachable()).toEqual(closed);
      // The rows are still there: it is the end of the account that closed them, not the purge.
      expect(await count('ci.saved_searches', 'user_id = $1', [owner])).toBe(1);
      expect(await count('ci.peer_links', 'owner_user_id = $1', [owner])).toBe(1);

      expect((await purgeService.purgeAccount(owner, new Date(), new Date())).status).toBe('purged');
    });

    it('closes them when DELETE /account ends the account, for the whole grace period', async () => {
      const { owner, reachable } = await shared();

      expect(await userService.requestDeletion(OWN(owner), owner)).toBe(true);

      expect(await reachable()).toEqual(closed);
      expect(await count('ci.saved_searches', 'user_id = $1', [owner])).toBe(1);

      expect((await purgeService.purgeAccount(owner, new Date(), new Date())).status).toBe('purged');
    });
  });

  describe('what runs alongside a delete', () => {
    it('does not hold a sign-up while the rows are being deleted', async () => {
      const victim = await addUser('Slow');
      await query(`INSERT INTO ci.notes (id, user_id, content) VALUES ($1, $2, 'seed')`, [
        randomUUID(),
        victim,
      ]);

      // Holds the purge on ci.notes for a few seconds, as a large table would.
      await query(`
        CREATE OR REPLACE FUNCTION slow_note_delete_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_sleep(4);
          RETURN NULL;
        END $$`);
      await query(
        `CREATE TRIGGER slow_note_delete AFTER DELETE ON ci.notes
           FOR EACH STATEMENT EXECUTE FUNCTION slow_note_delete_for_test()`,
      );

      try {
        const deletion = service.deleteAccount(OWN(victim));

        // Wait until the account is ended and its purge is running.
        for (let tries = 0; tries < 100; tries += 1) {
          const [row] = await query<{ started: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM ci.account_purges WHERE user_id = $1) AS started`,
            [victim],
          );
          if (row.started) {
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const started = Date.now();
        const newcomer = await userService.create(
          { userId: SYSTEM_USER },
          {
            name: 'Newcomer',
            email: `newcomer-${randomUUID()}@example.test`,
            password: 'correct horse battery staple',
          },
        );
        const signUpMs = Date.now() - started;

        expect(newcomer.id).toBeDefined();
        // The purge is still asleep on ci.notes, and the sign-up did not wait for it.
        expect(await count('ci.users', 'id = $1', [victim])).toBe(1);
        expect(signUpMs).toBeLessThan(3_000);

        expect((await deletion).status).toBe('deleted');
      } finally {
        await query(`DROP TRIGGER IF EXISTS slow_note_delete ON ci.notes`);
      }
    });

    it('finishes when a row is written for the account after its table was purged', async () => {
      const victim = await addUser('Ingesting');
      await query(`INSERT INTO ci.notes (id, user_id, content) VALUES ($1, $2, 'seed')`, [
        randomUUID(),
        victim,
      ]);
      await query(`INSERT INTO ci.saved_searches (id, user_id) VALUES ($1, $2)`, [randomUUID(), victim]);
      await query(`CREATE TABLE IF NOT EXISTS late_note_written_for_test (done boolean)`);

      // ci.saved_searches is purged after ci.notes: a job still running for the account writes a
      // note in between, once, and the user row's NO ACTION key then refuses the first pass.
      await query(`
        CREATE OR REPLACE FUNCTION late_note_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM late_note_written_for_test) THEN
            INSERT INTO late_note_written_for_test VALUES (true);
            INSERT INTO ci.notes (id, user_id, content) VALUES (gen_random_uuid(), '${victim}'::uuid, 'late');
          END IF;
          RETURN NULL;
        END $$`);
      await query(
        `CREATE TRIGGER late_note AFTER DELETE ON ci.saved_searches
           FOR EACH STATEMENT EXECUTE FUNCTION late_note_for_test()`,
      );

      try {
        const result = await service.deleteAccount(OWN(victim));

        expect(result.status).toBe('deleted');
        expect(result.deletedCounts['ci.notes']).toBe(2);
        expect(await count('ci.users', 'id = $1', [victim])).toBe(0);
        const [purge] = await query<{ attempts: number }>(
          `SELECT attempts FROM ci.account_purges WHERE user_id = $1`,
          [victim],
        );
        expect(purge.attempts).toBe(2);
      } finally {
        await query(`DROP TRIGGER IF EXISTS late_note ON ci.saved_searches`);
        await query(`DROP TABLE IF EXISTS late_note_written_for_test`);
      }
    });

    it('does not hang on a full pool when ending the account fails while a sign-up waits on it', async () => {
      // Two connections: the transaction that ends the account, and a sign-up queued behind its lock.
      const tight = await openDataSource(2);
      try {
        const { users, deletion } = makeService(tight);
        const victim = await addUser('Pooled');

        // Fails the transaction a second after it took the lock, long enough for the sign-up to
        // take the pool's other connection and queue behind it.
        await query(`
          CREATE OR REPLACE FUNCTION slow_refused_audit_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.status = 'started' AND NEW.subject_user_id = '${victim}'::uuid THEN
              PERFORM pg_sleep(1);
              RAISE EXCEPTION 'started audit refused for the test';
            END IF;
            RETURN NEW;
          END $$`);
        await query(
          `CREATE TRIGGER slow_refused_audit BEFORE INSERT ON ci.data_deletion_audit
             FOR EACH ROW EXECUTE FUNCTION slow_refused_audit_for_test()`,
        );

        try {
          const attempt = deletion.deleteAccount(OWN(victim)).catch((error: unknown) => error);
          await new Promise((resolve) => setTimeout(resolve, 300));
          const signUp = users.create(
            { userId: SYSTEM_USER },
            {
              name: 'Queued',
              email: `queued-${randomUUID()}@example.test`,
              password: 'correct horse battery staple',
            },
          );

          const outcome = await Promise.race([
            Promise.all([attempt, signUp]),
            new Promise((resolve) => setTimeout(() => resolve('hung'), 20_000)),
          ]);

          expect(outcome).not.toBe('hung');
          const [failure, newcomer] = outcome as [Error, { id: string }];
          expect(failure.message).toContain('started audit refused');
          expect(newcomer.id).toBeDefined();
          expect((await audits(victim)).map((row) => row.status)).toEqual(['failed']);
          expect(await count('ci.users', 'id = $1 AND deleted_at IS NULL', [victim])).toBe(1);
        } finally {
          await query(`DROP TRIGGER IF EXISTS slow_refused_audit ON ci.data_deletion_audit`);
        }
      } finally {
        await tight.destroy();
      }
    });
  });
});
