import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { PersonRemovedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import {
  BARE_FOOTPRINT,
  emptyFootprint,
  insertNode,
  readFootprint,
  seedBareFootprint,
  wipeGraphEntities,
} from '../../../__tests__/support/graphEntityFootprint';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { PersonEntity } from '../../entities/PersonEntity';
import { PersonService } from '../PersonService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PURGED PERSON LEAVES NOTHING BEHIND, AND DOES NOT COME BACK. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `memory.forget`'s `archive_and_delete` deleted a `Person` node by deleting its
 * `ci.entities` row and its edges, and nothing else. The identifiers that
 * resolved to the person stayed, and with them the unique index over (owner,
 * kind, value) that kept their address claimed for a node that no longer
 * existed. So did the claims that resolved to it, the merge history, and nine
 * more tables that name a node with no foreign key. And the pointers to it in
 * `ci.communications` and `ci.events`.
 *
 * `PersonService.purge` is the teardown that replaces it for `memory.forget`.
 * Each case here seeds a doomed person and a CONTROL one with a row in every
 * table the purge is meant to clean, asserts every one is non-zero before the
 * purge, and checks that the doomed person reads zero everywhere afterwards and
 * the control person has not moved.
 *
 * Deleting the identifiers is also what stops the people-minting paths
 * recognising the address, and they would then create the person again from
 * the mail that still names them. That is pinned by
 * `ForgottenPersonStaysForgotten.integration.test.ts`, with the real minting
 * services; here it is the record the purge leaves for them.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/PersonService.purge.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

/**
 * Polls until `probe` finds something. For waiting on Postgres to show a state, where a fixed sleep is
 * either too short under load or a slow test everywhere else.
 */
async function until<T>(probe: () => Promise<T | null>, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const found = await probe();

    if (found !== null) {
      return found;
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** One person, and the identifiers they were known by. */
interface Aggregate {
  personId: string;
  email: string;
  phone: string;
  handle: string;
  /** The message that names them, and the event they organise. */
  messageId: string;
  eventId: string;
  /** The other recipient of that message and that event, who is not being forgotten. */
  bystanderId: string;
  peerLinkId: string;
}

/** What is particular to a person, on top of what every graph entity is named by. */
const PERSON_FOOTPRINT: ReadonlyArray<readonly [label: string, sql: string]> = [
  ...BARE_FOOTPRINT,
  [
    'ci.identifier_claims (it as the subject)',
    `SELECT count(*) FROM ci.identifier_claims WHERE subject_type = 'person' AND subject_id = $1`,
  ],
  ['ci.communications.from_entity_id', `SELECT count(*) FROM ci.communications WHERE from_entity_id = $1`],
  [
    'ci.communications.to_entity_ids',
    `SELECT count(*) FROM ci.communications WHERE to_entity_ids @> ARRAY[$1]::uuid[]`,
  ],
  ['ci.events.organizer_entity_id', `SELECT count(*) FROM ci.events WHERE organizer_entity_id = $1`],
  [
    'ci.events.participant_entity_ids',
    `SELECT count(*) FROM ci.events WHERE participant_entity_ids @> ARRAY[$1]::uuid[]`,
  ],
  ['ci.peer_links.person_entity_id', `SELECT count(*) FROM ci.peer_links WHERE person_entity_id = $1`],
];

describeWithDb(`PersonService.purge against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let people: PersonService;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;
  const stranger = { userId: strangerId } as UserServiceContext;

  const published: Array<{ name: string; payload: unknown }> = [];

  /** Every id a case seeded, for the tables that carry no owner to wipe by. */
  let seeded: string[] = [];
  /** A phone number per person, from a sequence, so two people never collide on the unique index. */
  let phoneSequence = 5_550_100_000;

  const signalling = {
    send: jest.fn(async (name: string, payload: unknown) => {
      published.push({ name, payload });

      return [];
    }),
  } as unknown as EventService;

  const announced = (): string[] =>
    published
      .filter((event) => event.name === PersonRemovedEvent)
      .map((event) => (event.payload as { personId: string }).personId)
      .sort();

  const query = (sql: string, params?: unknown[]) => dataSource.query(sql, params);
  const track = (id: string) => seeded.push(id);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [BaseEntity, UserEntity, PersonEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/PersonService.purge');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'PersonPurge', userId);
    }

    people = new PersonService(dataSource.getRepository(PersonEntity), logger(), signalling);
  });

  async function wipe(): Promise<void> {
    const users = [ownerId, strangerId];

    await dataSource.query('DELETE FROM ci.peer_links WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await wipeGraphEntities(query, users, seeded);
    // The base rows take the detail rows of the messages and events with them.
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.entities WHERE entity_id = ANY($1::uuid[])', [seeded]);
    seeded = [];
  }

  beforeEach(() => {
    published.length = 0;
  });

  afterEach(wipe);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[ownerId, strangerId]]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────

  /**
   * A person the way an import and the pipeline leave one: the node, the address, number and handle they are
   * known by, a message from them and an event they organise (each with another person on it who stays), a
   * claim about that message that resolved to them, their own claim of the address, a peer link that says
   * this peer is them, and everything every graph entity is named by.
   */
  async function dana(
    name: string,
    forUser = ownerId,
    extra: { mergedInto?: string; entityType?: string; email?: string } = {},
  ): Promise<Aggregate> {
    const personId = await insertNode(
      query,
      track,
      { entityType: extra.entityType ?? 'Person', name, ownerId: forUser },
      extra.mergedInto === undefined ? {} : { mergedInto: extra.mergedInto },
    );

    await seedBareFootprint(query, track, {
      entityId: personId,
      entityType: extra.entityType ?? 'Person',
      searchType: 'person',
      name,
      ownerId: forUser,
    });

    // A tombstone also has the audit row of the merge that folded IT away: it is the source, and the row keeps a
    // snapshot of the tombstone's own data. It names the survivor as its target, so a survivor's purge finds it by
    // the survivor, and a purge of the tombstone alone can only find it by the tombstone.
    if (extra.mergedInto !== undefined) {
      await query(
        `INSERT INTO ci.entity_merges (owner_user_id, source_entity_id, target_entity_id, entity_type, details)
         VALUES ($1, $2, $3, $4, jsonb_build_object('source', jsonb_build_object('name', $5::text)))`,
        [forUser, personId, extra.mergedInto, extra.entityType ?? 'Person', name],
      );
    }

    const email = extra.email ?? `${personId}@example.invalid`;
    const phone = String(phoneSequence++);
    const handle = `x:@${personId}`;
    const identifiers: Array<[kind: string, value: string]> = [
      ['email', email],
      ['phone', phone],
      ['handle', handle],
    ];

    for (const [kind, value] of identifiers) {
      await query(
        `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized, raw_value)
         VALUES ($1, $2, $3, $4, $4)`,
        [personId, forUser, kind, value],
      );
    }

    const bystanderId = await insertNode(query, track, {
      entityType: 'Person',
      name: `${name} (bystander)`,
      ownerId: forUser,
    });

    // The message from them: its base row, then the detail row that names them as sender and as a recipient.
    const messageId = uuidv7();

    track(messageId);
    await query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Communication', $2, '{}'::jsonb, $3)`,
      [messageId, `message from ${name}`, forUser],
    );
    await query(
      `INSERT INTO ci.communications
         (id, time, user_id, communication_type, direction, content, participants_metadata, from_entity_id, to_entity_ids)
       VALUES ($1, now(), $2, 'email', 'inbound', 'hello', $3::jsonb, $4, $5)`,
      [
        messageId,
        forUser,
        JSON.stringify({ from: email, to: [`bystander-${personId}@example.invalid`] }),
        personId,
        [bystanderId, personId],
      ],
    );

    // The event they organise.
    const eventId = uuidv7();

    track(eventId);
    await query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Event', $2, '{}'::jsonb, $3)`,
      [eventId, `lunch with ${name}`, forUser],
    );
    await query(
      `INSERT INTO ci.events (event_id, user_id, start_time, organizer_entity_id, participant_entity_ids)
       VALUES ($1, $2, now(), $3, $4)`,
      [eventId, forUser, personId, [bystanderId, personId]],
    );

    // A claim that THEY asserted about themselves, the shape the self-claim stage writes, and a claim about
    // the message that resolved to them by their address.
    await query(
      `INSERT INTO ci.identifier_claims
         (owner_user_id, subject_type, subject_id, role, kind, value_normalized, entity_id, confidence, method,
          spec_version, observed_at)
       VALUES ($1, 'person', $2, 'self', 'email', $3, $2, 1, 'self', 1, now())`,
      [forUser, personId, email],
    );
    await query(
      `INSERT INTO ci.identifier_claims
         (owner_user_id, subject_type, subject_id, role, kind, value_normalized, raw_value, entity_id, confidence,
          method, spec_version, observed_at)
       VALUES ($1, 'communication', $2, 'from', 'email', $3, $4, $5, 1, 'email_exact', 2, now())`,
      [forUser, messageId, email, `${name} <${email}>`, personId],
    );

    // The peer link that says this peer is this person.
    const [{ id: peerLinkId }] = await query(
      `INSERT INTO ci.peer_links (owner_user_id, peer_handle, memory_endpoint, person_entity_id)
       VALUES ($1, $2, 'https://peer.example.invalid', $3) RETURNING id`,
      [forUser, `peer-${personId}`, personId],
    );

    return { personId, email, phone, handle, messageId, eventId, bystanderId, peerLinkId };
  }

  // ── Probes ────────────────────────────────────────────────────────────────

  const footprint = (aggregate: Aggregate) => readFootprint(query, PERSON_FOOTPRINT, aggregate.personId);

  /** What `footprint` reads when every row is gone. */
  const EMPTY = emptyFootprint(PERSON_FOOTPRINT);

  function expectEveryTableTouched(counts: Record<string, number>): void {
    for (const [label, count] of Object.entries(counts)) {
      // A fixture that wrote nothing here would let the purge "clean" an empty table.
      expect({ label, count: count > 0 }).toEqual({ label, count: true });
    }
  }

  async function nodeExists(id: string): Promise<boolean> {
    const [{ count }] = await dataSource.query('SELECT count(*) FROM ci.entities WHERE entity_id = $1', [id]);

    return Number(count) > 0;
  }

  /** What `ci.forgotten_identifiers` holds for the owner: the kind of each row and whether it is the digest of `of`. */
  async function forgotten(forUser = ownerId): Promise<Array<{ kind: string; digest: string }>> {
    return dataSource.query(
      `SELECT kind, encode(identifier_digest, 'hex') AS digest
         FROM ci.forgotten_identifiers WHERE owner_user_id = $1 ORDER BY kind, digest`,
      [forUser],
    );
  }

  async function digestOf(forUser: string, kind: string, value: string): Promise<string> {
    const [{ digest }] = await dataSource.query(
      `SELECT encode(ci.forgotten_identifier_digest($1::uuid, $2, $3), 'hex') AS digest`,
      [forUser, kind, value],
    );

    return digest;
  }

  // ── Cases ─────────────────────────────────────────────────────────────────

  it('removes the person, their node and every row that points at them, and nothing else', async () => {
    const doomed = await dana('Dana Quill');
    const control = await dana('Sam Rowe');

    const doomedBefore = await footprint(doomed);
    const controlBefore = await footprint(control);

    expectEveryTableTouched(doomedBefore);
    expectEveryTableTouched(controlBefore);

    const purged = await people.purge(owner, [doomed.personId]);

    expect(purged).toEqual({ personIds: [doomed.personId], duplicateIds: [], blockedIdentifiers: 3 });
    expect(await footprint(doomed)).toEqual(EMPTY);
    // The control person is exactly as they were, row for row.
    expect(await footprint(control)).toEqual(controlBefore);
  });

  it('frees the address, the number and the handle they were known by, which their identifiers kept holding', async () => {
    const doomed = await dana('Dana Quill');
    const claim = (kind: string, value: string) =>
      dataSource.query(
        `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized) VALUES ($1, $2, $3, $4)`,
        [uuidv7(), ownerId, kind, value],
      );

    // The unique index is over (owner, kind, value) and not over the person: while the row stands, nobody else can
    // take the address.
    await expect(claim('email', doomed.email)).rejects.toThrow(/entity_identifiers_owner_kind_value_uniq/);
    await expect(claim('phone', doomed.phone)).rejects.toThrow(/entity_identifiers_owner_kind_value_uniq/);

    await people.purge(owner, [doomed.personId]);

    await expect(claim('email', doomed.email)).resolves.toBeDefined();
    await expect(claim('phone', doomed.phone)).resolves.toBeDefined();
    await expect(claim('handle', doomed.handle)).resolves.toBeDefined();
  });

  it('turns the claims that resolved to them back into unresolved observations, and takes the human’s verdict with the resolution', async () => {
    const doomed = await dana('Dana Quill');
    const control = await dana('Sam Rowe');

    // A human ruled on the claim about the message: it was REJECTED, "this is not them".
    await dataSource.query(
      `UPDATE ci.identifier_claims SET disposition = 'rejected', disposed_at = now()
        WHERE subject_id = $1 AND subject_type = 'communication'`,
      [doomed.messageId],
    );

    await people.purge(owner, [doomed.personId]);

    // The observation is the MESSAGE's, and the message stays: the address is still on it. What is gone is who it
    // resolved to, and a verdict about that.
    const [claim] = await dataSource.query(
      `SELECT kind, value_normalized, raw_value, entity_id, confidence, method, disposition, disposed_at
         FROM ci.identifier_claims WHERE subject_id = $1 AND subject_type = 'communication' AND role = 'from'`,
      [doomed.messageId],
    );

    expect(claim).toEqual({
      kind: 'email',
      value_normalized: doomed.email,
      raw_value: `Dana Quill <${doomed.email}>`,
      entity_id: null,
      confidence: null,
      method: null,
      disposition: null,
      disposed_at: null,
    });

    // The control person's claims are untouched, verdict included.
    const [kept] = await dataSource.query(
      `SELECT entity_id, confidence, method FROM ci.identifier_claims
        WHERE subject_id = $1 AND subject_type = 'communication' AND role = 'from'`,
      [control.messageId],
    );

    expect(kept).toEqual({ entity_id: control.personId, confidence: 1, method: 'email_exact' });
  });

  it('keeps their messages, their events and the peer link, and takes only the person out of them', async () => {
    const doomed = await dana('Dana Quill');

    await people.purge(owner, [doomed.personId]);

    // Forgetting a person does not forget what they wrote. The message stays, with the bystander it also named.
    expect(
      await dataSource.query('SELECT from_entity_id, to_entity_ids FROM ci.communications WHERE id = $1', [
        doomed.messageId,
      ]),
    ).toEqual([{ from_entity_id: null, to_entity_ids: [doomed.bystanderId] }]);
    expect(
      await dataSource.query(
        'SELECT organizer_entity_id, participant_entity_ids FROM ci.events WHERE event_id = $1',
        [doomed.eventId],
      ),
    ).toEqual([{ organizer_entity_id: null, participant_entity_ids: [doomed.bystanderId] }]);
    // Still on the message itself, where it is the message's own record.
    expect(
      (
        await dataSource.query('SELECT participants_metadata FROM ci.communications WHERE id = $1', [
          doomed.messageId,
        ])
      )[0].participants_metadata.from,
    ).toBe(doomed.email);
    // The link is a federation trust relationship. It works without a person, so it is kept, unpointed.
    expect(
      await dataSource.query('SELECT person_entity_id, status FROM ci.peer_links WHERE id = $1', [
        doomed.peerLinkId,
      ]),
    ).toEqual([{ person_entity_id: null, status: 'active' }]);
    // The bystander is a person in their own right.
    expect(await nodeExists(doomed.bystanderId)).toBe(true);
  });

  describe('what it remembers so they do not come back', () => {
    it('records their email address, phone number and handle, and not the name they were known by', async () => {
      const doomed = await dana('Dana Quill');

      expect(await forgotten()).toEqual([]);

      const purged = await people.purge(owner, [doomed.personId]);

      // Three identifiers of a kind that identifies one person. The display-name identifier is not one of them:
      // a name is shared by many people, and listing it would stop the next Dana from existing.
      expect(purged.blockedIdentifiers).toBe(3);
      expect(await forgotten()).toEqual(
        [
          { kind: 'email', digest: await digestOf(ownerId, 'email', doomed.email) },
          { kind: 'handle', digest: await digestOf(ownerId, 'handle', doomed.handle) },
          { kind: 'phone', digest: await digestOf(ownerId, 'phone', doomed.phone) },
        ].sort((a, b) => a.kind.localeCompare(b.kind) || a.digest.localeCompare(b.digest)),
      );
    });

    it('keeps digests and not the addresses, so the list is not a readable list of who was forgotten', async () => {
      const doomed = await dana('Dana Quill');

      await people.purge(owner, [doomed.personId]);

      const rows = await dataSource.query(
        `SELECT kind, identifier_digest::text AS raw, encode(identifier_digest, 'escape') AS escaped
           FROM ci.forgotten_identifiers WHERE owner_user_id = $1`,
        [ownerId],
      );

      expect(rows).toHaveLength(3);

      for (const row of rows) {
        for (const secret of [doomed.email, doomed.phone, doomed.handle, doomed.personId]) {
          expect(row.raw).not.toContain(secret);
          expect(row.escaped).not.toContain(secret);
        }
      }
    });

    it('records nothing for a person who is not being forgotten, nor for somebody else’s person', async () => {
      const doomed = await dana('Dana Quill');
      const control = await dana('Sam Rowe');
      const theirs = await dana('Their Dana', strangerId);

      await people.purge(owner, [doomed.personId]);

      expect(await forgotten()).toHaveLength(3);
      expect(await forgotten(strangerId)).toEqual([]);
      expect(await digestOf(ownerId, 'email', control.email)).not.toEqual(
        (await forgotten()).find((row) => row.kind === 'email')?.digest,
      );
      expect(await nodeExists(theirs.personId)).toBe(true);
    });

    it('counts the identifiers it records even when they were already on the list', async () => {
      const doomed = await dana('Dana Quill');

      await people.purge(owner, [doomed.personId]);
      expect(await forgotten()).toHaveLength(3);

      // The same address comes back (an import, a typed contact: the list stops only the paths that mint a
      // person from a message) and the new person is forgotten in their turn.
      const again = await dana('Dana Quill (again)', ownerId, { email: doomed.email });

      const purged = await people.purge(owner, [again.personId]);

      // All three are identifiers it recorded as forgotten, though one was on the list already. Two new rows.
      expect(purged.blockedIdentifiers).toBe(3);
      expect(await forgotten()).toHaveLength(5);
    });

    it('records nothing, and keeps nothing, when the purge is refused', async () => {
      const doomed = await dana('Dana Quill');
      const doomedBefore = await footprint(doomed);

      // The user's own person is the one `ci.users.entity_id` points at, and it has no ON DELETE action.
      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [doomed.personId, ownerId]);

      await expect(people.purge(owner, [doomed.personId])).rejects.toThrow(/users_entity_id_fkey/);

      // The digests were written in the same transaction as the delete that was refused, so they went with it.
      expect(await forgotten()).toEqual([]);
      expect(await footprint(doomed)).toEqual(doomedBefore);
    });
  });

  describe('the user’s own person', () => {
    it('is refused, by the database, and nothing changes', async () => {
      const self = await dana('Liam');
      const selfBefore = await footprint(self);

      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [self.personId, ownerId]);
      published.length = 0;

      await expect(people.purge(owner, [self.personId])).rejects.toThrow(/users_entity_id_fkey/);

      // Every statement that ran before the delete was rolled back with it: identifiers, claims, pointers.
      expect(await footprint(self)).toEqual(selfBefore);
      expect(
        await dataSource.query('SELECT from_entity_id FROM ci.communications WHERE id = $1', [
          self.messageId,
        ]),
      ).toEqual([{ from_entity_id: self.personId }]);
      expect(published).toEqual([]);
    });

    it('is refused when it is only one of several named, and none of them goes', async () => {
      const self = await dana('Liam');
      const other = await dana('Dana Quill');
      const otherBefore = await footprint(other);

      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [self.personId, ownerId]);

      await expect(people.purge(owner, [other.personId, self.personId])).rejects.toThrow(
        /users_entity_id_fkey/,
      );

      expect(await footprint(other)).toEqual(otherBefore);
      expect(await forgotten()).toEqual([]);
    });
  });

  describe('the duplicates that were merged into a person', () => {
    /** A survivor and two tombstones folded into it, each with the rows a merge and the pipeline leave. */
    async function mergedFamily() {
      const survivor = await dana('Dana Quill');
      const first = await dana('D. Quill (duplicate)', ownerId, { mergedInto: survivor.personId });
      const second = await dana('Dana Q (another)', ownerId, { mergedInto: survivor.personId });

      return { survivor, first, second };
    }

    it('go with them, in the same transaction, with everything that names them', async () => {
      const { survivor, first, second } = await mergedFamily();
      const control = await mergedFamily();
      const controlBefore = await Promise.all(
        [control.survivor, control.first, control.second].map((aggregate) => footprint(aggregate)),
      );

      for (const aggregate of [survivor, first, second]) {
        expectEveryTableTouched(await footprint(aggregate));
      }

      const purged = await people.purge(owner, [survivor.personId]);

      // The one that was asked for, and the two that nobody saw.
      expect(purged.personIds).toEqual([survivor.personId]);
      expect(purged.duplicateIds.sort()).toEqual([first.personId, second.personId].sort());

      for (const aggregate of [survivor, first, second]) {
        expect(await footprint(aggregate)).toEqual(EMPTY);
      }

      // Another survivor's family is untouched, row for row.
      expect(
        await Promise.all(
          [control.survivor, control.first, control.second].map((aggregate) => footprint(aggregate)),
        ),
      ).toEqual(controlBefore);
    });

    it('would otherwise come back as archived people, which is what deleting the survivor alone does', async () => {
      // The control for the case above: the same family, deleted the way the generic path deletes a node.
      const { survivor, first } = await mergedFamily();

      await dataSource.query(`DELETE FROM ci.entities WHERE entity_id = $1`, [survivor.personId]);

      // The tombstone survives, with its name and its identifiers, and `ON DELETE SET NULL` has un-pointed it:
      // an inactive person, with nothing to say it was ever a duplicate.
      expect(
        await dataSource.query(
          'SELECT name, is_active, merged_into_entity_id FROM ci.entities WHERE entity_id = $1',
          [first.personId],
        ),
      ).toEqual([{ name: 'D. Quill (duplicate)', is_active: false, merged_into_entity_id: null }]);
    });

    it('go with a survivor however long the chain of merges that led to it', async () => {
      // A legacy chain: the second tombstone points at the first, which points at the survivor.
      const survivor = await insertNode(query, track, { entityType: 'Person', name: 'Survivor', ownerId });
      const middle = await insertNode(
        query,
        track,
        { entityType: 'Person', name: 'Middle', ownerId },
        { mergedInto: survivor },
      );
      const last = await insertNode(
        query,
        track,
        { entityType: 'Person', name: 'Last', ownerId },
        { mergedInto: middle },
      );

      const purged = await people.purge(owner, [survivor]);

      expect(purged.duplicateIds.sort()).toEqual([middle, last].sort());
      expect(await nodeExists(last)).toBe(false);
    });

    it('does not take the survivor when a duplicate is asked for by name, which goes alone', async () => {
      const { survivor, first, second } = await mergedFamily();
      const survivorBefore = await footprint(survivor);

      const purged = await people.purge(owner, [first.personId]);

      expect(purged).toEqual({ personIds: [first.personId], duplicateIds: [], blockedIdentifiers: 3 });
      expect(await footprint(first)).toEqual(EMPTY);
      expect(await nodeExists(second.personId)).toBe(true);
      expect(await nodeExists(survivor.personId)).toBe(true);

      // The survivor's own rows are as they were, except the one audit row that was about the duplicate that went:
      // it names the survivor as its target and the duplicate as its source, and keeps the duplicate's own data, so
      // it goes with the duplicate and with nothing else.
      expect(await footprint(survivor)).toEqual({
        ...survivorBefore,
        'ci.entity_merges': survivorBefore['ci.entity_merges'] - 1,
      });
    });

    it('do not include a node of somebody else’s that happens to name the survivor', async () => {
      const survivor = await dana('Dana Quill');
      // It should not exist: a merge only ever folds one account's people together. But nothing in the schema stops
      // the pointer, and a node that is not the caller's is not theirs to destroy.
      const foreign = await insertNode(
        query,
        track,
        { entityType: 'Person', name: 'Their duplicate', ownerId: strangerId },
        { mergedInto: survivor.personId },
      );

      const purged = await people.purge(owner, [survivor.personId]);

      expect(purged.duplicateIds).toEqual([]);
      expect(await nodeExists(foreign)).toBe(true);
    });

    it('are not reported as unasked-for when they were asked for with their survivor', async () => {
      const { survivor, first, second } = await mergedFamily();

      const purged = await people.purge(owner, [survivor.personId, first.personId]);

      // The duplicate that was named is a person that was asked for. Only the one nobody named is a duplicate.
      expect(purged.personIds.sort()).toEqual([survivor.personId, first.personId].sort());
      expect(purged.duplicateIds).toEqual([second.personId]);
    });

    it('have their identifiers recorded too, since they are the same person folded in', async () => {
      const { survivor } = await mergedFamily();

      const purged = await people.purge(owner, [survivor.personId]);

      // Three each for the survivor and the two duplicates.
      expect(purged.blockedIdentifiers).toBe(9);
      expect(await forgotten()).toHaveLength(9);
    });
  });

  it('announces each removal, the duplicates too, after it has committed, and nothing for the ids it did not take', async () => {
    const survivor = await dana('Dana Quill');
    const duplicate = await dana('D. Quill (duplicate)', ownerId, { mergedInto: survivor.personId });
    const missing = uuidv7();

    published.length = 0;

    await people.purge(owner, [survivor.personId, missing]);

    expect(announced()).toEqual([survivor.personId, duplicate.personId].sort());
  });

  it('announces a removal only once it has committed, so a listener that looks finds the row gone', async () => {
    const doomed = await dana('Dana Quill');
    const found: number[] = [];

    (signalling.send as jest.Mock).mockImplementationOnce(async (name: string, payload: unknown) => {
      // A listener reads on its own connection. Were the delete not committed yet, it would still find the row.
      const [{ count }] = await dataSource.query('SELECT count(*) FROM ci.entities WHERE entity_id = $1', [
        doomed.personId,
      ]);

      found.push(Number(count));
      published.push({ name, payload });

      return [];
    });

    await people.purge(owner, [doomed.personId]);

    // Precondition: the listener was asked, and asked once.
    expect(announced()).toEqual([doomed.personId]);
    expect(found).toEqual([0]);
  });

  it('takes a person under every spelling the graph holds one in, and archived or not', async () => {
    const contact = await dana('A Contact', ownerId, { entityType: 'Contact' });
    const archived = await dana('An archived person');

    await dataSource.query('UPDATE ci.entities SET is_active = false WHERE entity_id = $1', [
      archived.personId,
    ]);

    const purged = await people.purge(owner, [contact.personId, archived.personId]);

    expect(purged.personIds.sort()).toEqual([contact.personId, archived.personId].sort());
    expect(await footprint(contact)).toEqual(EMPTY);
    expect(await footprint(archived)).toEqual(EMPTY);
  });

  it('leaves a node of another kind alone, whatever id it is asked for under', async () => {
    const place = await insertNode(query, track, { entityType: 'Location', name: 'The office', ownerId });
    const concept = await insertNode(query, track, { entityType: 'Concept', name: 'Pottery', ownerId });

    published.length = 0;

    expect(await people.purge(owner, [place, concept])).toEqual({
      personIds: [],
      duplicateIds: [],
      blockedIdentifiers: 0,
    });
    expect(await nodeExists(place)).toBe(true);
    expect(await nodeExists(concept)).toBe(true);
    expect(published).toEqual([]);
  });

  it('leaves somebody else’s person alone, and ignores ids that do not exist', async () => {
    const theirs = await dana('Their Dana', strangerId);
    const theirsBefore = await footprint(theirs);

    published.length = 0;

    const purged = await people.purge(owner, [theirs.personId, uuidv7()]);

    expect(purged).toEqual({ personIds: [], duplicateIds: [], blockedIdentifiers: 0 });
    expect(await footprint(theirs)).toEqual(theirsBefore);
    expect(await forgotten()).toEqual([]);
    expect(await forgotten(strangerId)).toEqual([]);
    expect(published).toEqual([]);

    // And in the other direction: the stranger can purge their own, and the digests are theirs.
    expect((await people.purge(stranger, [theirs.personId])).personIds).toEqual([theirs.personId]);
    expect(await footprint(theirs)).toEqual(EMPTY);
    expect(await forgotten(strangerId)).toHaveLength(3);
    expect(await forgotten()).toEqual([]);
  });

  it('leaves a message, an event and a peer link of somebody else’s alone, though they name the person', async () => {
    const doomed = await dana('Dana Quill');

    // Rows that should not exist, for the same reason: they are another account's and name this account's person.
    const theirMessage = uuidv7();
    const theirEvent = uuidv7();

    for (const [id, type] of [
      [theirMessage, 'Communication'],
      [theirEvent, 'Event'],
    ]) {
      track(id);
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
         VALUES ($1, $2, 'theirs', '{}'::jsonb, $3)`,
        [id, type, strangerId],
      );
    }

    await dataSource.query(
      `INSERT INTO ci.communications (id, time, user_id, communication_type, direction, content, from_entity_id, to_entity_ids)
       VALUES ($1, now(), $2, 'email', 'inbound', 'hello', $3, $4)`,
      [theirMessage, strangerId, doomed.personId, [doomed.personId]],
    );
    await dataSource.query(
      `INSERT INTO ci.events (event_id, user_id, start_time, organizer_entity_id, participant_entity_ids)
       VALUES ($1, $2, now(), $3, $4)`,
      [theirEvent, strangerId, doomed.personId, [doomed.personId]],
    );
    await dataSource.query(
      `INSERT INTO ci.peer_links (owner_user_id, peer_handle, memory_endpoint, person_entity_id)
       VALUES ($1, 'their-peer', 'https://peer.example.invalid', $2)`,
      [strangerId, doomed.personId],
    );

    await people.purge(owner, [doomed.personId]);

    // Theirs, so as they were, down to the dangling id.
    expect(
      await dataSource.query('SELECT from_entity_id, to_entity_ids FROM ci.communications WHERE id = $1', [
        theirMessage,
      ]),
    ).toEqual([{ from_entity_id: doomed.personId, to_entity_ids: [doomed.personId] }]);
    expect(
      await dataSource.query(
        'SELECT organizer_entity_id, participant_entity_ids FROM ci.events WHERE event_id = $1',
        [theirEvent],
      ),
    ).toEqual([{ organizer_entity_id: doomed.personId, participant_entity_ids: [doomed.personId] }]);
    expect(
      await dataSource.query('SELECT person_entity_id FROM ci.peer_links WHERE owner_user_id = $1', [
        strangerId,
      ]),
    ).toEqual([{ person_entity_id: doomed.personId }]);
  });

  it('does nothing for an empty request', async () => {
    expect(await people.purge(owner, [])).toEqual({ personIds: [], duplicateIds: [], blockedIdentifiers: 0 });
    expect(published).toEqual([]);
  });

  it('purges several in one call, once each, and leaves the rest', async () => {
    const first = await dana('Dana Quill');
    const second = await dana('Moe Lester');
    const control = await dana('Sam Rowe');
    const controlBefore = await footprint(control);

    const purged = await people.purge(owner, [first.personId, second.personId, first.personId]);

    expect(purged.personIds.sort()).toEqual([first.personId, second.personId].sort());
    expect(purged.blockedIdentifiers).toBe(6);
    expect(await footprint(first)).toEqual(EMPTY);
    expect(await footprint(second)).toEqual(EMPTY);
    expect(await footprint(control)).toEqual(controlBefore);
  });

  it('waits for a merge that is folding another person into it, and takes that duplicate too', async () => {
    const survivor = await dana('Dana Quill');
    const latecomer = await dana('D. Quill (about to be merged)');
    const merge = dataSource.createQueryRunner();

    await merge.connect();
    await merge.startTransaction();

    let purging: Promise<unknown> | undefined;

    try {
      const [{ pid }] = await merge.query('SELECT pg_backend_pid() AS pid');

      // What `PersonMergeService` does: lock the target and the source, then tombstone the source. Uncommitted,
      // so the purge cannot see the new tombstone until the merge commits.
      await merge.query(
        'SELECT entity_id FROM ci.entities WHERE entity_id = ANY($1::uuid[]) ORDER BY entity_id FOR UPDATE',
        [[survivor.personId, latecomer.personId]],
      );
      await merge.query(
        `UPDATE ci.entities SET merged_into_entity_id = $2, is_active = false WHERE entity_id = $1`,
        [latecomer.personId, survivor.personId],
      );

      purging = people.purge(owner, [survivor.personId]);

      // Ask Postgres who is waiting on that connection, rather than sleeping, and WHERE: the purge has to be
      // held at the statement that locks the person, before it has looked for duplicates or deleted anything.
      // Held at the delete instead, it would have missed the tombstone this merge is about to commit, and
      // deleting the survivor would have turned it back into an archived person.
      const blocked = await until(async () => {
        const rows: Array<{ query: string }> = await dataSource.query(
          'SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
          [pid],
        );

        return rows.length > 0 ? rows : null;
      }, 'the purge to block on the merge connection');

      expect(blocked).toHaveLength(1);
      expect(blocked[0].query).toMatch(/\bFOR UPDATE\b/);

      await merge.commitTransaction();
    } catch (error) {
      await merge.rollbackTransaction().catch(() => undefined);
      // Let a purge that was released by the rollback finish, so it cannot run into the next test's clean-up.
      await purging?.catch(() => undefined);

      throw error;
    } finally {
      await merge.release();
    }

    // Having waited, the purge saw the duplicate the merge committed, and took it.
    expect(await purging).toMatchObject({
      personIds: [survivor.personId],
      duplicateIds: [latecomer.personId],
    });
    expect(await footprint(latecomer)).toEqual(EMPTY);
    expect(await footprint(survivor)).toEqual(EMPTY);
  });
});
