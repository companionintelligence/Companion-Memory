import { randomUUID } from 'node:crypto';

import {
  EntityIdentifierEntity,
  EntityIdentifierService,
  GraphIngestService,
  NodeEntity,
  RelationshipEntity,
} from '@ci/domains/graph';
import { GraphDeltaWriter } from '@ci/domains/memory';

import type { Entity } from '../datasources/timeline';
import { TRUNCATED_PHONE_REKEY_SOURCE } from '../push/truncatedPhoneKeys';
import { PushStage } from '../stages/PushStage';
import { entityIdentityKey, legacyEntityIdentityKey } from '../staging/identity';
import type { StageRunContext } from '../types';

import { createStagingHarness, importDatabase, type StagingHarness } from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CONTACT THE OLD PHONE RULE KEYED ON A TRUNCATION IS MOVED, NOT DUPLICATED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The old join key kept the last ten digits of line + extension, so the Apple
 * Contacts line `(212) 555-0147;229` keyed its card as `contact:5550147229`.
 * Migration 20260930020117 could not prove that for Apple Contacts or CSV rows
 * (they kept nothing but the truncation), so they still sit there — and the
 * fixed parser keys the same card elsewhere. These specs seed rows exactly as
 * the pre-fix parser left them, through the real `GraphIngestService`, stage
 * the card the fixed parser produces, and run the real entity push.
 *
 * Every number is invented (555-01XX); the truncations are the old rule's
 * output for them.
 */

const describeWithDatabase = importDatabase.available ? describe : describe.skip;

if (!importDatabase.available) {
  console.warn(`[import/truncatedPhoneRekey.integration] SKIPPED — ${importDatabase.reason}`);
}

jest.setTimeout(60_000);

type EntityPusher = {
  pushEntities(
    context: StageRunContext,
    trustMode: string,
    selfEntityId: string | null,
  ): Promise<{ resolved: number; skipped: number; unresolved: number; failed: number }>;
};

interface EntityRow {
  entity_id: string;
  linked_id: string;
  name: string | null;
  properties: Record<string, unknown>;
  merged_into_entity_id: string | null;
}

describeWithDatabase(`moving contacts off truncated phone keys (${importDatabase.target})`, () => {
  let harness: StagingHarness;
  let teardown: () => Promise<void>;
  let graph: GraphIngestService;
  let stage: EntityPusher;
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  beforeAll(async () => {
    ({ harness, teardown } = await createStagingHarness());

    graph = new GraphIngestService(
      harness.dataSource.getRepository(NodeEntity),
      harness.dataSource.getRepository(RelationshipEntity),
      new EntityIdentifierService(harness.dataSource.getRepository(EntityIdentifierEntity), logger as never),
      logger as never,
      new GraphDeltaWriter(harness.dataSource, logger as never),
    );

    // The entity lane only reads staging, writes the ledger, and ingests; every
    // other destination is inert here.
    const inert = {} as never;
    stage = new PushStage(
      harness.dataSource,
      inert,
      inert,
      inert,
      inert,
      inert,
      inert,
      inert,
      inert,
      inert,
      inert,
      graph,
      inert,
      logger as never,
    ) as unknown as EntityPusher;
  });

  afterAll(async () => {
    const { dataSource, userId } = harness;

    // What the harness teardown does not reach: edges outlive their owner
    // (ON DELETE SET NULL), and the search index and ledger have no owner key.
    await dataSource.query(`DELETE FROM ci.relationships WHERE owner_user_id = $1::uuid`, [userId]);
    await dataSource.query(
      `DELETE FROM ci_search.vectors WHERE entity_id IN (SELECT entity_id FROM ci.entities WHERE owner_user_id = $1::uuid)`,
      [userId],
    );
    await dataSource.query(
      `DELETE FROM ci_search.index_skips WHERE entity_id IN (SELECT entity_id FROM ci.entities WHERE owner_user_id = $1::uuid)`,
      [userId],
    );
    await dataSource.query(`DELETE FROM ci.pipeline_state WHERE user_id = $1::uuid`, [userId]);
    await dataSource.query(`DELETE FROM ci.identifier_claims WHERE owner_user_id = $1::uuid`, [userId]);
    await teardown();
  });

  function contextFor(runId: string): StageRunContext {
    return {
      userId: harness.userId,
      runId,
      stageId: '44444444-4444-4444-8444-444444444444',
      scratchDir: '/var/tmp/ci-import/test',
      progress: async () => undefined,
    };
  }

  /** A row exactly as the pre-fix parser pushed it: keyed, named and phoned by the truncation. */
  async function seedOldRow(
    truncation: string,
    name: string | null,
    source = 'apple_contacts',
  ): Promise<string> {
    const result = await graph.ingest(
      { userId: harness.userId },
      {
        entities: [
          {
            key: `contact:${truncation}`,
            entityType: 'Person',
            name: name ?? truncation,
            sourceSystem: source,
            properties: {
              Source: 'AppleContacts',
              DB: 'AddressBook-v22.abcddb',
              phone: truncation,
              phones: [truncation],
              ...(name ? { names: [name] } : {}),
            },
          },
        ],
        relationships: [],
      },
    );

    return result.entities[0].entityId;
  }

  /**
   * The card the FIXED parser stages: its typed handles, the key the current
   * rule gives it, and the legacy key the row was minted under — both computed
   * from the card's attributes exactly as `StagedWriter` computes them. The
   * fixture states the current key it expects, so a fixture that means one
   * thing and stages another fails here rather than downstream.
   */
  async function stageCard(
    runId: string,
    card: {
      name: string | null;
      identityKey: string | null;
      phones?: string[];
      emails?: string[];
      source?: string;
    },
  ): Promise<string> {
    const entity: Entity = {
      ...(card.name ? { name: card.name } : {}),
      type: 'contact',
      attributes: [
        ...(card.phones ?? []).map((value) => ({ name: 'phone', value, identity: true })),
        ...(card.emails ?? []).map((value) => ({ name: 'email', value, identity: true })),
      ],
    };
    const identityKey = entityIdentityKey(entity);
    const legacy = legacyEntityIdentityKey(entity);

    expect(identityKey).toBe(card.identityKey);

    const metadata = {
      Source: 'AppleContacts',
      ...(card.name ? { Names: [card.name] } : {}),
      ...(card.phones?.length ? { Phones: card.phones } : {}),
      ...(card.emails?.length ? { Emails: card.emails } : {}),
    };
    const [row] = await harness.dataSource.query<Array<{ id: string }>>(
      `INSERT INTO ci_import.staged_entities
              (run_id, user_id, type, name, metadata, identity_key, data_source, legacy_identity_key)
            VALUES ($1::uuid, $2::uuid, 'contact', $3, $4::jsonb, $5, $6, $7)
         RETURNING id`,
      [
        runId,
        harness.userId,
        card.name,
        JSON.stringify(metadata),
        identityKey,
        card.source ?? 'apple_contacts',
        legacy !== identityKey ? legacy : null,
      ],
    );

    return row.id;
  }

  async function entity(entityId: string): Promise<EntityRow> {
    const [row] = await harness.dataSource.query<EntityRow[]>(
      `SELECT entity_id, linked_id, name, properties, merged_into_entity_id FROM ci.entities WHERE entity_id = $1::uuid`,
      [entityId],
    );

    return row;
  }

  async function identifiersOf(entityId: string): Promise<string[]> {
    const rows = await harness.dataSource.query<Array<{ kind: string; value_normalized: string }>>(
      `SELECT kind, value_normalized FROM ci.entity_identifiers
        WHERE owner_user_id = $1::uuid AND entity_id = $2::uuid ORDER BY kind, value_normalized`,
      [harness.userId, entityId],
    );

    return rows.map((row) => `${row.kind}:${row.value_normalized}`);
  }

  async function holderOf(
    kind: string,
    value: string,
  ): Promise<{ entity_id: string; source: string | null } | null> {
    const [row] = await harness.dataSource.query<Array<{ entity_id: string; source: string | null }>>(
      `SELECT entity_id, source FROM ci.entity_identifiers
        WHERE owner_user_id = $1::uuid AND kind = $2 AND value_normalized = $3`,
      [harness.userId, kind, value],
    );

    return row ?? null;
  }

  async function mappedEntity(stagedEntityId: string): Promise<string | null> {
    const [row] = await harness.dataSource.query<Array<{ server_entity_id: string }>>(
      `SELECT server_entity_id FROM ci_import.entity_mappings WHERE staged_entity_id = $1::uuid`,
      [stagedEntityId],
    );

    return row?.server_entity_id ?? null;
  }

  async function personsKeyedUnder(linkedTable: string, names: string[]): Promise<string[]> {
    const rows = await harness.dataSource.query<Array<{ entity_id: string }>>(
      `SELECT entity_id FROM ci.entities
        WHERE owner_user_id = $1::uuid AND entity_type = 'Person' AND linked_table = $2 AND name = ANY($3::text[])
        ORDER BY created_at`,
      [harness.userId, linkedTable, names],
    );

    return rows.map((row) => row.entity_id);
  }

  async function count(sql: string, params: unknown[]): Promise<number> {
    const [row] = await harness.dataSource.query<Array<{ n: number }>>(sql, params);

    return Number(row.n);
  }

  it('moves the row, drops what the truncation reached, and lets ingest refresh it', async () => {
    const truncation = '5550147229'; // (212) 555-0147;229
    const { dataSource, userId } = harness;
    const dana = await seedOldRow(truncation, 'Dana Quill');

    // A person who REALLY has those ten digits — from another source, so the
    // coordinate is not theirs — and could never index them while Dana's
    // truncation held the identifier.
    const [caller] = await dataSource.query<Array<{ entity_id: string }>>(
      `INSERT INTO ci.entities (entity_type, owner_user_id, name, properties, linked_table, linked_id)
            VALUES ('Person', $1::uuid, '(555) 014-7229', $2::jsonb, 'import:google_voice', $3::uuid)
         RETURNING entity_id`,
      [userId, JSON.stringify({ phones: [truncation] }), randomUUID()],
    );

    // What the truncation reached: that caller's call, linked to Dana at 0.85,
    // with the edge the promote leg projected; Dana's own self claim; her
    // search index and ledger.
    const call = randomUUID();
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1::uuid, 'Communication', $2::uuid, 'call')`,
      [call, userId],
    );
    await dataSource.query(
      `INSERT INTO ci.communications (id, time, user_id, communication_type, direction, content, from_entity_id, entity_type)
            VALUES ($1::uuid, now(), $2::uuid, 'call', 'inbound', '', $3::uuid, 'Communication')`,
      [call, userId, dana],
    );
    await dataSource.query(
      `INSERT INTO ci.identifier_claims
         (owner_user_id, subject_type, subject_id, role, kind, value_normalized, raw_value, entity_id, confidence, method)
       VALUES ($1::uuid, 'communication', $2::uuid, 'from', 'phone', $3, '(555) 014-7229', $4::uuid, 0.85, 'phone_last10'),
              ($1::uuid, 'person', $4::uuid, 'self', 'phone', $3, NULL, $4::uuid, 1, 'self')`,
      [userId, call, truncation, dana],
    );
    await dataSource.query(
      `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id, properties, from_entity_type, to_entity_type)
            VALUES ($1::uuid, $2::uuid, 'SENT', $3::uuid, '{"rule":"communication.sent"}'::jsonb, 'Person', 'Communication')`,
      [dana, call, userId],
    );
    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
            VALUES ($1::uuid, 'Person', $2::uuid, to_tsvector('simple', 'dana quill 5550147229'), $3::uuid)`,
      [randomUUID(), dana, userId],
    );
    await dataSource.query(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, user_id)
            VALUES ('Person', $1::uuid, 'index.person', 'done', $2::uuid)`,
      [dana, userId],
    );

    const runId = await harness.startRun();
    const staged = await stageCard(runId, {
      name: 'Dana Quill',
      identityKey: 'dana.quill@example.com',
      phones: ['(212) 555-0147;229'],
      emails: ['dana.quill@example.com'],
    });

    const outcome = await stage.pushEntities(contextFor(runId), 'balanced', null);

    expect(outcome).toMatchObject({ resolved: 1, failed: 0 });

    // One row, the old one, at the coordinate the fixed parser computes — and
    // refreshed by the ingest that followed, so it now carries the typed line.
    expect(await personsKeyedUnder('import:apple_contacts', ['Dana Quill'])).toEqual([dana]);
    expect(await mappedEntity(staged)).toBe(dana);

    const moved = await entity(dana);
    expect(moved.linked_id).toBe(GraphIngestService.linkedIdFor('contact:dana.quill@example.com'));
    expect(moved.properties).toMatchObject({
      Phones: ['(212) 555-0147;229'],
      email: 'dana.quill@example.com',
    });
    expect(moved.properties).not.toHaveProperty('phones');

    // The fabricated number is off Dana and on the person who has it.
    expect(await identifiersOf(dana)).toEqual(expect.arrayContaining(['email:dana.quill@example.com']));
    expect(await identifiersOf(dana)).not.toContain(`phone:${truncation}`);
    expect(await holderOf('phone', truncation)).toEqual({
      entity_id: caller.entity_id,
      source: TRUNCATED_PHONE_REKEY_SOURCE,
    });

    // The link it made, its edge and its claim's resolution are withdrawn; the
    // self claim is gone.
    const [communication] = await dataSource.query<Array<{ from_entity_id: string | null }>>(
      `SELECT from_entity_id FROM ci.communications WHERE id = $1::uuid`,
      [call],
    );
    expect(communication.from_entity_id).toBeNull();
    expect(
      await count(`SELECT count(*)::int AS n FROM ci.relationships WHERE from_entity_id = $1::uuid`, [dana]),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM ci.identifier_claims WHERE owner_user_id = $1::uuid AND entity_id = $2::uuid`,
        [userId, dana],
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM ci.identifier_claims
          WHERE owner_user_id = $1::uuid AND subject_type = 'communication' AND subject_id = $2::uuid AND entity_id IS NULL`,
        [userId, call],
      ),
    ).toBe(1);

    // Index and ledger reset, so every entity-keyed stage revisits the row.
    expect(
      await count(`SELECT count(*)::int AS n FROM ci_search.vectors WHERE entity_id = $1::uuid`, [dana]),
    ).toBe(0);
    expect(
      await count(`SELECT count(*)::int AS n FROM ci.pipeline_state WHERE entity_id = $1::uuid`, [dana]),
    ).toBe(0);

    // Idempotent: pushed again, the card finds its row where it now sits.
    await dataSource.query(
      `UPDATE ci_import.staged_entities SET push_status = 'pending' WHERE id = $1::uuid`,
      [staged],
    );
    const again = await stage.pushEntities(contextFor(runId), 'balanced', null);

    expect(again).toMatchObject({ resolved: 1, failed: 0 });
    expect(await personsKeyedUnder('import:apple_contacts', ['Dana Quill'])).toEqual([dana]);
    expect(await mappedEntity(staged)).toBe(dana);
  });

  it('lets a merge tombstone be moved, and leaves its record and its survivor alone', async () => {
    const truncation = '5550148311'; // (212) 555-0148;311
    const { dataSource, userId } = harness;
    const tombstone = await seedOldRow(truncation, 'Rae Holt');
    const survivor = await seedOldRow('2025550142', 'Rae Holt', 'vcard');

    // A human merged the Apple Contacts card into the vCard one: the merge
    // re-points identifiers to the survivor and unions its phones.
    await dataSource.query(
      `UPDATE ci.entities SET merged_into_entity_id = $2::uuid, is_active = false WHERE entity_id = $1::uuid`,
      [tombstone, survivor],
    );
    await dataSource.query(
      `UPDATE ci.entity_identifiers SET entity_id = $2::uuid WHERE entity_id = $1::uuid AND owner_user_id = $3::uuid`,
      [tombstone, survivor, userId],
    );

    const runId = await harness.startRun();
    const staged = await stageCard(runId, {
      name: 'Rae Holt',
      identityKey: 'rae.holt@example.com',
      phones: ['(212) 555-0148;311'],
      emails: ['rae.holt@example.com'],
    });

    await stage.pushEntities(contextFor(runId), 'balanced', null);

    // The merge decision survives the re-import: the card resolves THROUGH the
    // re-keyed tombstone to the person a human chose.
    expect(await mappedEntity(staged)).toBe(survivor);
    expect(await personsKeyedUnder('import:apple_contacts', ['Rae Holt'])).toEqual([tombstone]);

    const moved = await entity(tombstone);
    expect(moved.linked_id).toBe(GraphIngestService.linkedIdFor('contact:rae.holt@example.com'));
    expect(moved.merged_into_entity_id).toBe(survivor);

    // Outside the rule migration 20260930020117 and 20260930022046 agree on:
    // only live Persons, and never a survivor, whose digits may be a merged-in
    // record's real number. The tombstone's record stays as the merge left it.
    expect(moved.properties).toMatchObject({ phone: truncation, phones: [truncation] });
    expect(await identifiersOf(survivor)).toContain(`phone:${truncation}`);
  });

  it('re-keys a merge survivor but leaves its identifiers alone', async () => {
    const truncation = '5550149412'; // (212) 555-0149;412
    const { dataSource } = harness;
    const survivor = await seedOldRow(truncation, 'Sam Ivers');
    const mergedIn = await seedOldRow('2025550143', 'Sam Ivers', 'google_voice');

    await dataSource.query(
      `UPDATE ci.entities SET merged_into_entity_id = $2::uuid, is_active = false WHERE entity_id = $1::uuid`,
      [mergedIn, survivor],
    );

    const runId = await harness.startRun();
    await stageCard(runId, {
      name: 'Sam Ivers',
      identityKey: 'sam.ivers@example.com',
      phones: ['(212) 555-0149;412'],
      emails: ['sam.ivers@example.com'],
    });

    await stage.pushEntities(contextFor(runId), 'balanced', null);

    expect(await personsKeyedUnder('import:apple_contacts', ['Sam Ivers'])).toEqual([survivor]);
    expect((await entity(survivor)).linked_id).toBe(
      GraphIngestService.linkedIdFor('contact:sam.ivers@example.com'),
    );
    expect(await identifiersOf(survivor)).toContain(`phone:${truncation}`);
  });

  describe('leaves the old row where it is — and mints, as before — when it cannot prove the row is this card', () => {
    it('when a row already sits at the new coordinate', async () => {
      const truncation = '5550150513'; // (212) 555-0150;513
      const old = await seedOldRow(truncation, 'Noel Park');
      // An earlier import on the fixed parser already minted the card's new row.
      const current = (
        await graph.ingest(
          { userId: harness.userId },
          {
            entities: [
              {
                key: 'contact:noel.park@example.com',
                entityType: 'Person',
                name: 'Noel Park',
                sourceSystem: 'apple_contacts',
                properties: { email: 'noel.park@example.com', emails: ['noel.park@example.com'] },
              },
            ],
            relationships: [],
          },
        )
      ).entities[0].entityId;

      const runId = await harness.startRun();
      const staged = await stageCard(runId, {
        name: 'Noel Park',
        identityKey: 'noel.park@example.com',
        phones: ['(212) 555-0150;513'],
        emails: ['noel.park@example.com'],
      });

      await stage.pushEntities(contextFor(runId), 'balanced', null);

      expect(await mappedEntity(staged)).toBe(current);
      expect((await entity(old)).linked_id).toBe(GraphIngestService.linkedIdFor(`contact:${truncation}`));
      // Joining the two is a merge, which this does not do.
      expect(await identifiersOf(old)).toContain(`phone:${truncation}`);
    });

    it('when a card in this run still keys onto the old coordinate for real', async () => {
      const truncation = '5550151614'; // (212) 555-0151;614
      const old = await seedOldRow(truncation, 'Ezra Vale');

      const runId = await harness.startRun();
      // Somebody whose actual number spells those ten digits keys there under
      // the fixed rule too; the row is theirs as much as anyone's.
      const claimant = await stageCard(runId, {
        name: 'Ezra Vale',
        identityKey: truncation,
        phones: ['555-015-1614'],
      });
      const card = await stageCard(runId, {
        name: 'Ezra Vale',
        identityKey: 'ezra.vale@example.com',
        phones: ['(212) 555-0151;614'],
        emails: ['ezra.vale@example.com'],
      });

      await stage.pushEntities(contextFor(runId), 'balanced', null);

      expect(await mappedEntity(claimant)).toBe(old);
      expect((await entity(old)).linked_id).toBe(GraphIngestService.linkedIdFor(`contact:${truncation}`));
      expect(await mappedEntity(card)).not.toBe(old);
    });

    it("when the row's own name reads as somebody else", async () => {
      const truncation = '5550152715'; // (212) 555-0152;715
      const other = await seedOldRow(truncation, 'Ivy Chen');

      const runId = await harness.startRun();
      const card = await stageCard(runId, {
        name: 'Lena Moss',
        identityKey: 'lena.moss@example.com',
        phones: ['(212) 555-0152;715'],
        emails: ['lena.moss@example.com'],
      });

      await stage.pushEntities(contextFor(runId), 'balanced', null);

      expect((await entity(other)).linked_id).toBe(GraphIngestService.linkedIdFor(`contact:${truncation}`));
      expect(await identifiersOf(other)).toContain(`phone:${truncation}`);
      expect(await mappedEntity(card)).not.toBe(other);
    });
  });

  it('gives a row two cards claim to one of them, and undoes the truncation on it', async () => {
    // Under the old rule both copies keyed on the same truncation, so they were
    // ONE row; `planLegacyKeyMoves` hands it to one claimant, and the other copy
    // is minted fresh.
    const truncation = '5550153816'; // (212) 555-0153;816
    const old = await seedOldRow(truncation, 'Kai Rowe');

    const runId = await harness.startRun();
    const first = await stageCard(runId, {
      name: 'Kai Rowe',
      identityKey: 'kai.rowe@example.com',
      phones: ['(212) 555-0153;816'],
      emails: ['kai.rowe@example.com'],
    });
    const second = await stageCard(runId, {
      name: 'Kai Rowe',
      identityKey: 'k.rowe@example.org',
      phones: ['(212) 555-0153;816'],
      emails: ['k.rowe@example.org'],
    });

    await stage.pushEntities(contextFor(runId), 'balanced', null);

    // Which one inherits is staging order — row ids, which two inserts in one
    // millisecond may take in either order — so the test asks only that ONE did.
    const mapped = [await mappedEntity(first), await mappedEntity(second)];
    const heirKey = mapped[0] === old ? 'contact:kai.rowe@example.com' : 'contact:k.rowe@example.org';

    expect(mapped.filter((id) => id === old)).toHaveLength(1);
    expect((await entity(old)).linked_id).toBe(GraphIngestService.linkedIdFor(heirKey));
    expect(await identifiersOf(old)).not.toContain(`phone:${truncation}`);
  });

  it('finishes the job on a later push when the row was moved but not yet repaired', async () => {
    // A push that died between the legacy-key move and the repair: the row is
    // already under the card's key, still carrying the truncation. The next
    // push finds nothing to move, and repairs the row where it sits.
    const truncation = '5550155018'; // (212) 555-0155;018
    const old = await seedOldRow(truncation, 'Zoe Lind');

    await harness.dataSource.query(`UPDATE ci.entities SET linked_id = $2::uuid WHERE entity_id = $1::uuid`, [
      old,
      GraphIngestService.linkedIdFor('contact:zoe.lind@example.com'),
    ]);

    const runId = await harness.startRun();
    const staged = await stageCard(runId, {
      name: 'Zoe Lind',
      identityKey: 'zoe.lind@example.com',
      phones: ['(212) 555-0155;018'],
      emails: ['zoe.lind@example.com'],
    });

    await stage.pushEntities(contextFor(runId), 'balanced', null);

    expect(await mappedEntity(staged)).toBe(old);
    expect(await identifiersOf(old)).not.toContain(`phone:${truncation}`);
    expect((await entity(old)).properties).not.toHaveProperty('phones');
  });

  it('repairs nothing when a card in this run keys those ten digits for real', async () => {
    // The row under the card's key carries the digits, but this run also holds
    // a card whose actual number they are: what they reached may be real.
    const truncation = '5550156119'; // (212) 555-0156;119
    const old = await seedOldRow(truncation, 'Ari Moss');

    await harness.dataSource.query(`UPDATE ci.entities SET linked_id = $2::uuid WHERE entity_id = $1::uuid`, [
      old,
      GraphIngestService.linkedIdFor('contact:ari.moss@example.com'),
    ]);

    const runId = await harness.startRun();
    await stageCard(runId, { name: 'Ari Moss', identityKey: truncation, phones: ['555-015-6119'] });
    await stageCard(runId, {
      name: 'Ari Moss',
      identityKey: 'ari.moss@example.com',
      phones: ['(212) 555-0156;119'],
      emails: ['ari.moss@example.com'],
    });

    await stage.pushEntities(contextFor(runId), 'balanced', null);

    expect(await identifiersOf(old)).toContain(`phone:${truncation}`);
  });

  it('keeps an identifier a person typed, and the links it made', async () => {
    // A row with a raw value was typed by somebody — here a plain number that
    // happens to be the same ten digits. The agreed rule deletes only the rows
    // whose stored string WAS the key (raw_value NULL), and withdraws a link
    // only for a key the person no longer holds.
    const truncation = '5550157120'; // (212) 555-0157;120
    const { dataSource, userId } = harness;
    const old = await seedOldRow(truncation, 'Ivo Brandt');

    await dataSource.query(
      `UPDATE ci.entity_identifiers SET raw_value = '(555) 015-7120', source = 'user'
        WHERE owner_user_id = $1::uuid AND entity_id = $2::uuid AND kind = 'phone' AND value_normalized = $3`,
      [userId, old, truncation],
    );

    const call = randomUUID();
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1::uuid, 'Communication', $2::uuid, 'call')`,
      [call, userId],
    );
    await dataSource.query(
      `INSERT INTO ci.communications (id, time, user_id, communication_type, direction, content, from_entity_id, entity_type)
            VALUES ($1::uuid, now(), $2::uuid, 'call', 'inbound', '', $3::uuid, 'Communication')`,
      [call, userId, old],
    );
    await dataSource.query(
      `INSERT INTO ci.identifier_claims
         (owner_user_id, subject_type, subject_id, role, kind, value_normalized, raw_value, entity_id, confidence, method)
       VALUES ($1::uuid, 'communication', $2::uuid, 'from', 'phone', $3, '(555) 015-7120', $4::uuid, 0.85, 'phone_last10')`,
      [userId, call, truncation, old],
    );

    const runId = await harness.startRun();
    await stageCard(runId, {
      name: 'Ivo Brandt',
      identityKey: 'ivo.brandt@example.com',
      phones: ['(212) 555-0157;120'],
      emails: ['ivo.brandt@example.com'],
    });

    await stage.pushEntities(contextFor(runId), 'balanced', null);

    expect((await entity(old)).linked_id).toBe(
      GraphIngestService.linkedIdFor('contact:ivo.brandt@example.com'),
    );
    expect(await identifiersOf(old)).toContain(`phone:${truncation}`);

    const [communication] = await dataSource.query<Array<{ from_entity_id: string | null }>>(
      `SELECT from_entity_id FROM ci.communications WHERE id = $1::uuid`,
      [call],
    );
    expect(communication.from_entity_id).toBe(old);
  });

  it('moves a card with no other handle onto its name key', async () => {
    const truncation = '5550154917'; // (212) 555-0154;917
    const old = await seedOldRow(truncation, 'Uma Brandt');

    const runId = await harness.startRun();
    const staged = await stageCard(runId, {
      name: 'Uma Brandt',
      identityKey: null,
      phones: ['(212) 555-0154;917'],
    });

    await stage.pushEntities(contextFor(runId), 'balanced', null);

    expect(await mappedEntity(staged)).toBe(old);
    expect((await entity(old)).linked_id).toBe(GraphIngestService.linkedIdFor('contact:uma brandt'));
    expect(await identifiersOf(old)).not.toContain(`phone:${truncation}`);
  });
});
