import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';

import { normalizeEmail, normalizeName, normalizePhone } from '@ci/domains/graph';

import { databaseAvailability, resolveConnection } from '../../__tests__/harness/pipelineHarness';
import { PipelineStateService } from '../../services/PipelineStateService';
import type { StageResult } from '../../types';
import {
  adjudicate,
  classifyIdentifier,
  dedupeObservations,
  ENRICH_EVENT_PERSON_LINK_STAGE_ID,
  ENRICH_PERSON_LINK_STAGE_ID,
  EVENT_PERSON_LINK_SOURCE,
  EventPersonLinkStage,
  IDENTIFIER_RULE_GENERATION,
  MATCH_CONFIDENCE,
  PERSON_LINK_SOURCE,
  PERSON_LINK_VERSION,
  PERSON_MATCH_RULE_GENERATION,
  PERSON_MATCH_SPEC_VERSION,
  PERSON_PROJECTION_RULE_GENERATION,
  PHONE_COUNTRY_CONFLICT,
  PersonLinkStage,
  personLinkStageVersion,
  readCommunicationObservations,
  readEventObservations,
} from '../enrich/PersonLinkStage';

/**
 * `enrich.person_link` / `enrich.event_person_link` — the three participant
 * backfills, on the ledger, with their evidence kept.
 *
 * Four parts, and the split mirrors what can actually go wrong:
 *
 *  1. **The rules, as pure functions.** Normalisation must stay byte-identical
 *     to `domains/graph`'s (it is a cross-repo join key), the widenings must
 *     actually widen, and the confidences must be ORDERED — an email match
 *     outranking a display-name match is the whole reason `confidence` is
 *     graded rather than constant.
 *  2. **Selection**, driven through `PipelineStateService.selectStale` with the
 *     stages' REAL sources. This is where the regression lives: all three
 *     services share `(from_entity_id IS NULL OR to_entity_ids IS NULL OR
 *     cardinality(to_entity_ids) = 0)`, which declares a row finished the moment
 *     ONE recipient resolves. A message to five people where one had a contact
 *     can never link the other four — not by re-running, not by importing more
 *     contacts, not ever.
 *  3. **Decision.** Every id gets exactly one answer, no non-`done` answer is
 *     anonymous, an identifier that resolved to NOBODY is still written as
 *     evidence, and nothing here merges two people.
 *  4. **Against real Postgres**, because a fake agrees with whatever SQL it is
 *     handed. The migration is applied INSIDE the test transaction and rolled
 *     back with it, so the block exercises the real DDL, the real `unnest`
 *     upsert and the real projection without leaving a row behind.
 */

/* ===================================================================== *
 * Fixtures
 * ===================================================================== */

const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';
const COMMUNICATION = 'communication';

/**
 * Ordered uuids. Canonical lowercase hex uuids compare byte-wise in Postgres
 * and lexically in JS in the SAME order, so the fake's keyset comparison is a
 * faithful stand-in for `s."id" > $5::uuid`.
 */
function subjectId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function personId(n: number): string {
  return `00000000-0000-4000-8000-1${String(n).padStart(11, '0')}`;
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/* ===================================================================== *
 * 1. The rules
 * ===================================================================== */

describe('the version is derived, and both ids mirror the same derivation', () => {
  it('derives 1 from three generations at 1', () => {
    expect(PERSON_MATCH_SPEC_VERSION).toBe(IDENTIFIER_RULE_GENERATION + PERSON_MATCH_RULE_GENERATION - 1);
    expect(PERSON_LINK_VERSION).toBe(PERSON_MATCH_SPEC_VERSION + PERSON_PROJECTION_RULE_GENERATION - 1);
    // Never 0: `versions.ts` refuses it, because a row a killed worker left in
    // `status='running'` keeps `stage_version = 0` and is only reclaimable while
    // the live version is above it.
    expect(PERSON_LINK_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('accepts a STAGE_VERSIONS map that agrees', () => {
    expect(
      personLinkStageVersion({
        [ENRICH_PERSON_LINK_STAGE_ID]: PERSON_LINK_VERSION,
        [ENRICH_EVENT_PERSON_LINK_STAGE_ID]: PERSON_LINK_VERSION,
      }),
    ).toBe(PERSON_LINK_VERSION);
  });

  it('throws when EITHER declaration drifts from the derivation', () => {
    // The failure this catches: bump a generation, update one of the two lines
    // in `versions.ts`, and the pair would silently describe different amounts
    // of history — one stage re-linking the corpus and the other not.
    expect(() =>
      personLinkStageVersion({
        [ENRICH_PERSON_LINK_STAGE_ID]: PERSON_LINK_VERSION + 1,
        [ENRICH_EVENT_PERSON_LINK_STAGE_ID]: PERSON_LINK_VERSION,
      }),
    ).toThrow(/declares 2 but the stage derives 1/);

    expect(() =>
      personLinkStageVersion({
        [ENRICH_PERSON_LINK_STAGE_ID]: PERSON_LINK_VERSION,
        [ENRICH_EVENT_PERSON_LINK_STAGE_ID]: PERSON_LINK_VERSION + 5,
      }),
    ).toThrow(new RegExp(ENRICH_EVENT_PERSON_LINK_STAGE_ID.replace('.', '\\.')));
  });

  it('tolerates a map that has not declared them yet', () => {
    // This file, and `stageWiring.spec.ts`, import the stage independently of
    // when the central declarations land.
    expect(personLinkStageVersion({})).toBe(PERSON_LINK_VERSION);
  });
});

describe('classifyIdentifier keeps the shared join key byte-identical', () => {
  it.each([
    ['Dana Q. <Dana@Example.COM>', 'email', 'dana@example.com'],
    ['  ALICE@example.com  ', 'email', 'alice@example.com'],
  ])('%s is an email keyed %s/%s', (raw, kind, value) => {
    const identifier = classifyIdentifier(raw);

    expect(identifier).toMatchObject({ kind, valueNormalized: value });
    // THE contract: `ci.identifier_claims.value_normalized` and
    // `ci.entity_identifiers.value_normalized` are the same key, computed by the
    // same function, in this repo AND in CI-Import-Tools. A stage that
    // normalised by its own rule would write claims nothing can ever join, with
    // no error anywhere.
    expect(identifier?.valueNormalized).toBe(normalizeEmail(raw));
  });

  it('keys a phone on the shared last-ten-digits rule, not on E.164', () => {
    const identifier = classifyIdentifier('+1 (415) 555-0100');

    expect(identifier?.kind).toBe('phone');
    expect(identifier?.valueNormalized).toBe(normalizePhone('+1 (415) 555-0100'));
    expect(identifier?.valueNormalized).toBe('4155550100');
    // The widening rides ALONGSIDE the key, never replaces it.
    expect(identifier?.valueE164).toBe('+14155550100');
  });

  it('keys a display name on the shared NFKD rule', () => {
    const identifier = classifyIdentifier('José  GARCÍA');

    expect(identifier).toMatchObject({ kind: 'name', valueNormalized: 'jose garcia' });
    expect(identifier?.valueNormalized).toBe(normalizeName('José  GARCÍA'));
  });
});

describe('classifyIdentifier — the two widenings', () => {
  it('derives E.164 only when the raw value STATED a country', () => {
    expect(classifyIdentifier('+44 20 7946 0958')?.valueE164).toBe('+442079460958');
    expect(classifyIdentifier('0044 20 7946 0958')?.valueE164).toBe('+442079460958');
    // Eleven digits led by 1 is NANP by construction.
    expect(classifyIdentifier('1 415 555 0100')?.valueE164).toBe('+14155550100');
    // A bare ten-digit number names no country, and guessing one would stamp a
    // fabricated `+1` onto the whole corpus and make it look measured.
    expect(classifyIdentifier('(415) 555-0100')?.valueE164).toBeNull();
  });

  it('routes social handles to kind=handle instead of burying them in names', () => {
    // The defect: `classifyParticipant` sends `@alice` to `kind='name'`, so a
    // platform handle shares a namespace with human display names and two
    // unrelated people who both go by "alex" collide with each other.
    expect(classifyIdentifier('x:@alice')).toMatchObject({ kind: 'handle', valueNormalized: 'x:@alice' });
    expect(classifyIdentifier('Instagram:Bob')).toMatchObject({
      kind: 'handle',
      valueNormalized: 'instagram:@bob',
    });
    expect(classifyIdentifier('@carol')).toMatchObject({ kind: 'handle', valueNormalized: '@carol' });
  });

  it('qualifies a bare handle with the source platform, and never invents one', () => {
    expect(classifyIdentifier('@carol', 'instagram')?.valueNormalized).toBe('instagram:@carol');
    expect(classifyIdentifier('@carol', 'Google-Voice!')?.valueNormalized).toBe('googlevoice:@carol');
    // No platform in the string and none from the source: the handle stays
    // honestly unqualified rather than being merged into a guessed platform.
    expect(classifyIdentifier('@carol', '  ')?.valueNormalized).toBe('@carol');
  });

  it('does not mistake an address for a handle, or a handle for an address', () => {
    expect(classifyIdentifier('mailto:alice@example.com')).toMatchObject({
      kind: 'email',
      valueNormalized: 'alice@example.com',
    });
    // `x:@alice` has an `@` that is not at position 0; without handle detection
    // running first it would be read as an address at the `x:` mailbox.
    expect(classifyIdentifier('x:@alice')?.kind).toBe('handle');
  });

  it('unwraps tel: so a phone is a phone', () => {
    // `classifyParticipant`'s shape test rejects any string containing a
    // letter, so today every `tel:` value in the corpus lands as a display name
    // and matches nothing.
    expect(classifyIdentifier('tel:+15555550100')).toMatchObject({
      kind: 'phone',
      valueNormalized: '5555550100',
      valueE164: '+15555550100',
    });
  });

  it('still refuses to call a digit-bearing handle a phone number', () => {
    // The regression `classifyParticipant`'s own header records: the phone
    // branch used to fire on ANY digit-bearing string, turning "alexmz12" into
    // phone '12' and colliding unrelated handles into one person.
    expect(classifyIdentifier('alexmz12')?.kind).toBe('name');
    expect(classifyIdentifier('42')?.kind).toBe('name');
  });

  it('returns null for anything unusable, so the caller can COUNT it', () => {
    expect(classifyIdentifier(null)).toBeNull();
    expect(classifyIdentifier('   ')).toBeNull();
    expect(classifyIdentifier('mailto:')).toBeNull();
  });
});

describe('confidence is explicit, graded, and ORDERED', () => {
  it('ranks an exact identifier above a display name', () => {
    // The ordering is the point, not the digits. A stage that reported one
    // number for every method would teach promotion to prefer a name collision
    // over a mailbox match — `StageResult.confidence`'s stated failure mode.
    expect(MATCH_CONFIDENCE.email_exact).toBeGreaterThan(MATCH_CONFIDENCE.handle_exact);
    expect(MATCH_CONFIDENCE.handle_exact).toBeGreaterThan(MATCH_CONFIDENCE.phone_last10);
    expect(MATCH_CONFIDENCE.phone_last10).toBeGreaterThan(MATCH_CONFIDENCE.name_exact);
    expect(MATCH_CONFIDENCE.phone_e164).toBeGreaterThan(MATCH_CONFIDENCE.phone_last10);
  });

  it('stays inside the (0, 1] the ledger enforces', () => {
    for (const confidence of Object.values(MATCH_CONFIDENCE)) {
      expect(confidence).toBeGreaterThan(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('adjudicate — what an index hit is worth', () => {
  function index(rows: Array<{ kind: string; value: string; entityId: string; raw?: string | null }>) {
    return new Map(
      rows.map((row) => [
        `${row.kind}:${row.value}`,
        {
          kind: row.kind,
          value_normalized: row.value,
          entity_id: row.entityId,
          raw_value: row.raw ?? null,
        },
      ]),
    );
  }

  it('resolves an exact email at 1.0', () => {
    const identifier = classifyIdentifier('dana@example.com')!;

    expect(
      adjudicate(identifier, index([{ kind: 'email', value: 'dana@example.com', entityId: personId(1) }])),
    ).toEqual({ entityId: personId(1), confidence: 1, method: 'email_exact' });
  });

  it('records an unmatched identifier as EVIDENCE, not as nothing', () => {
    // The row still gets written, with `entity_id IS NULL`. That is the whole
    // difference from the old backfills, which left the column NULL and
    // recorded nothing at all — indistinguishable from never having looked.
    expect(adjudicate(classifyIdentifier('nobody@example.com')!, index([]))).toEqual({
      entityId: null,
      confidence: null,
      method: null,
    });
  });

  it('promotes a phone match to 1.0 when BOTH sides state the same country', () => {
    const identifier = classifyIdentifier('+1 415 555 0100')!;

    expect(
      adjudicate(
        identifier,
        index([{ kind: 'phone', value: '4155550100', entityId: personId(2), raw: '+1 (415) 555-0100' }]),
      ),
    ).toEqual({ entityId: personId(2), confidence: MATCH_CONFIDENCE.phone_e164, method: 'phone_e164' });
  });

  it('REFUSES a phone match when the two countries disagree', () => {
    // The false identity the shared key manufactures: UK +44 20 7946 0958 and
    // US (207) 946-0958 both normalise to `2079460958`. E.164 is what makes the
    // near-miss visible — and the claim is still written, so it is countable
    // rather than being a silent wrong link.
    const identifier = classifyIdentifier('+44 20 7946 0958')!;

    expect(
      adjudicate(
        identifier,
        index([{ kind: 'phone', value: '2079460958', entityId: personId(3), raw: '+1 207 946 0958' }]),
      ),
    ).toEqual({ entityId: null, confidence: null, method: PHONE_COUNTRY_CONFLICT });
  });

  it('falls back to 0.85 when either side never stated a country', () => {
    const identifier = classifyIdentifier('(415) 555-0100')!;

    expect(
      adjudicate(
        identifier,
        index([{ kind: 'phone', value: '4155550100', entityId: personId(4), raw: '+1 415 555 0100' }]),
      ),
    ).toEqual({ entityId: personId(4), confidence: MATCH_CONFIDENCE.phone_last10, method: 'phone_last10' });
  });

  it('grades a handle above, and a display name below, a partial phone', () => {
    const handle = adjudicate(
      classifyIdentifier('x:@alice')!,
      index([{ kind: 'handle', value: 'x:@alice', entityId: personId(5) }]),
    );
    const name = adjudicate(
      classifyIdentifier('Alex Kim')!,
      index([{ kind: 'name', value: 'alex kim', entityId: personId(6) }]),
    );

    expect(handle.method).toBe('handle_exact');
    expect(name.method).toBe('name_exact');
    expect(handle.confidence!).toBeGreaterThan(name.confidence!);
  });
});

describe('reading participants off a row', () => {
  it('collects from/to/cc/bcc off a communication', () => {
    const observations = readCommunicationObservations({
      id: subjectId(1),
      metadata: {
        from: 'Dana <dana@example.com>',
        to: ['alice@example.com', 'bob@example.com'],
        cc: 'carol@example.com',
        bcc: ['dave@example.com'],
      },
      platform: 'gmail',
      is_deleted: false,
    });

    expect(observations.map((o) => [o.role, o.identifier.valueNormalized])).toEqual([
      ['from', 'dana@example.com'],
      ['to', 'alice@example.com'],
      ['to', 'bob@example.com'],
      ['cc', 'carol@example.com'],
      ['bcc', 'dave@example.com'],
    ]);
  });

  it('reads an event organizer and its attendees, in every shape the importer emits', () => {
    const observations = readEventObservations({
      id: subjectId(2),
      metadata: {
        organizerEmail: 'boss@example.com',
        participants: [
          { email: 'alice@example.com', name: 'Alice' },
          // Outlook Graph, defensively handled in case a non-transformer source
          // dumps the raw payload into metadata.
          { emailAddress: { address: 'bob@example.com' } },
          // NEW: an attendee with no address at all. `EventParticipantBackfill
          // Service.classifyEmail` drops anything without an '@', so today a
          // Messenger/Instagram attendee contributes nothing and the row reads
          // as having no participants.
          { name: 'Carol Danvers' },
        ],
      },
      platform: null,
      is_deleted: false,
    });

    expect(observations.map((o) => [o.role, o.identifier.kind, o.identifier.valueNormalized])).toEqual([
      ['organizer', 'email', 'boss@example.com'],
      ['participant', 'email', 'alice@example.com'],
      ['participant', 'email', 'bob@example.com'],
      ['participant', 'name', 'carol danvers'],
    ]);
  });

  it('yields nothing — not a crash — for metadata that names nobody', () => {
    expect(
      readCommunicationObservations({
        id: subjectId(3),
        metadata: { to: [''] },
        platform: null,
        is_deleted: false,
      }),
    ).toEqual([]);
  });
});

describe('dedupeObservations', () => {
  it('collapses the same claim, keeping the first raw value', () => {
    // Required, not an optimisation: `ON CONFLICT` cannot affect one row twice
    // in a single statement, so a duplicate would abort the whole claim upsert
    // instead of being harmlessly idempotent.
    const observations = readCommunicationObservations({
      id: subjectId(1),
      metadata: { to: ['Dana <dana@example.com>', 'dana@example.com', 'DANA@EXAMPLE.COM'] },
      platform: null,
      is_deleted: false,
    });

    expect(observations).toHaveLength(3);

    const deduped = dedupeObservations(observations);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].identifier.rawValue).toBe('Dana <dana@example.com>');
  });

  it('keeps the same address in two different ROLES apart', () => {
    // A calendar organizer is routinely also an attendee, and collapsing the
    // two would lose the fact that makes `organizer_entity_id` projectable.
    const deduped = dedupeObservations(
      readEventObservations({
        id: subjectId(2),
        metadata: { organizerEmail: 'boss@example.com', attendees: ['boss@example.com'] },
        platform: null,
        is_deleted: false,
      }),
    );

    expect(deduped.map((o) => o.role)).toEqual(['organizer', 'participant']);
  });
});

/* ===================================================================== *
 * 2. Selection — THE ONE RULE over the stages' real sources
 * ===================================================================== */

interface SourceRow {
  id: string;
  user_id: string;
  participants_metadata: Record<string, unknown> | null;
  /** The stage's OUTPUT columns. Nothing in selection may ever read these. */
  from_entity_id: string | null;
  to_entity_ids: string[] | null;
}

function commRow(n: number, overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: subjectId(n),
    user_id: USER,
    participants_metadata: { from: 'dana@example.com', to: ['alice@example.com'] },
    from_entity_id: null,
    to_entity_ids: null,
    ...overrides,
  };
}

type LedgerStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'quarantined';

interface LedgerRow {
  stageVersion: number;
  status: LedgerStatus;
  nextAttemptAt: Date | null;
}

/**
 * `PERSON_LINK_SOURCE.predicate`, mirrored in TypeScript.
 *
 * Note what it does NOT consult: `from_entity_id`, `to_entity_ids`. That
 * absence is the entire repair, and the assertions below make it observable
 * rather than taking the mirror's word for it.
 */
function isApplicable(row: SourceRow): boolean {
  return row.participants_metadata != null && Object.keys(row.participants_metadata).length > 0;
}

function evaluateOneRule(
  rows: SourceRow[],
  ledger: Map<string, LedgerRow>,
  params: unknown[],
): Array<{ id: string }> {
  if (params.length !== 6) {
    throw new Error(`THE ONE RULE binds exactly six parameters; got ${params.length}`);
  }

  const [entityType, stageId, userId, version, cursor, limit] = params as [
    string,
    string,
    string,
    number,
    string | null,
    number,
  ];

  const now = Date.now();

  return rows
    .filter((row) => row.user_id === userId)
    .filter(isApplicable)
    .filter((row) => {
      const entry = ledger.get(`${entityType}|${row.id}|${stageId}`);

      if (entry === undefined) {
        return true;
      }

      if (entry.stageVersion < version) {
        return true;
      }

      return entry.status === 'failed' && entry.nextAttemptAt != null && entry.nextAttemptAt.getTime() <= now;
    })
    .filter((row) => cursor == null || row.id > cursor)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit)
    .map((row) => ({ id: row.id }));
}

function makeLedgerHarness(rows: SourceRow[]) {
  const ledger = new Map<string, LedgerRow>();
  const sweeps: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();

    if (/not\s+exists[\s\S]*ci\.pipeline_state/i.test(sql)) {
      sweeps.push({ sql, params: params ?? [] });

      return evaluateOneRule(rows, ledger, params ?? []);
    }

    return [];
  });

  return {
    service: new PipelineStateService({ query } as never, makeLogger() as never),
    sweeps,
    seed: (id: string, row: LedgerRow, stageId: string) =>
      ledger.set(`${COMMUNICATION}|${id}|${stageId}`, row),
  };
}

/** The real stage at a different version — what bumping a generation does to `$4`. */
function atVersion(stage: PersonLinkStage, version: number) {
  return {
    id: stage.id,
    version,
    queue: stage.queue,
    entityTypes: stage.entityTypes,
    source: stage.source,
    run: stage.run.bind(stage),
  };
}

describe('selection asks the ledger, never the link columns', () => {
  const stage = new PersonLinkStage({ query: jest.fn() } as never, makeLogger() as never);

  it('neither source predicate mentions a column the stage writes', () => {
    // A string assertion, and worth its weight: `StageRegistry` rejects a
    // predicate reaching into `ci.pipeline_state` but nothing can enforce this
    // one, and it is the exact mistake all three replaced services made.
    for (const source of [PERSON_LINK_SOURCE, EVENT_PERSON_LINK_SOURCE]) {
      const predicate = source.predicate ?? '';

      expect(predicate).not.toMatch(/from_entity_id|to_entity_ids/);
      expect(predicate).not.toMatch(/organizer_entity_id|participant_entity_ids/);
      expect(predicate).not.toMatch(/cardinality/);
      expect(predicate).not.toMatch(/pipeline_state/);
    }
  });

  it('THE REGRESSION — a partially-linked row is still a candidate', async () => {
    // `(from_entity_id IS NULL OR to_entity_ids IS NULL OR
    // cardinality(to_entity_ids) = 0)` would exclude this row forever: it has a
    // sender and one resolved recipient, so all three services consider it
    // finished — while four of its five recipients are unlinked and always will
    // be. The ledger has never seen it, so it is a candidate.
    const rows = [
      commRow(1, {
        participants_metadata: { from: 'dana@example.com', to: ['a@x.com', 'b@x.com', 'c@x.com'] },
        from_entity_id: personId(1),
        to_entity_ids: [personId(2)],
      }),
    ];

    const harness = makeLedgerHarness(rows);

    await expect(harness.service.selectStale(stage, USER, null, 10)).resolves.toEqual([subjectId(1)]);
  });

  it('excludes a row already done at the current version, and re-admits it on a bump', async () => {
    const rows = [commRow(1), commRow(2)];
    const harness = makeLedgerHarness(rows);

    harness.seed(
      subjectId(1),
      { stageVersion: PERSON_LINK_VERSION, status: 'done', nextAttemptAt: null },
      stage.id,
    );

    await expect(harness.service.selectStale(stage, USER, null, 10)).resolves.toEqual([subjectId(2)]);

    // The bump. One integer in `versions.ts`, and the row whose four unlinked
    // recipients now have contacts comes back.
    await expect(
      harness.service.selectStale(atVersion(stage, PERSON_LINK_VERSION + 1), USER, null, 10),
    ).resolves.toEqual([subjectId(1), subjectId(2)]);
  });

  it('re-admits a row that was skipped because nobody matched', async () => {
    // `skipped: no_identifier_resolved` is the normal answer on a corpus with
    // no contacts yet. It must not be a tombstone — the claims are on disk, and
    // a bump after a contact import links every one of them.
    const rows = [commRow(1)];
    const harness = makeLedgerHarness(rows);

    harness.seed(
      subjectId(1),
      { stageVersion: PERSON_LINK_VERSION, status: 'skipped', nextAttemptAt: null },
      stage.id,
    );

    await expect(harness.service.selectStale(stage, USER, null, 10)).resolves.toEqual([]);
    await expect(
      harness.service.selectStale(atVersion(stage, PERSON_LINK_VERSION + 1), USER, null, 10),
    ).resolves.toEqual([subjectId(1)]);
  });

  it('is user-scoped and excludes rows naming nobody', async () => {
    const rows = [
      commRow(1),
      commRow(2, { participants_metadata: {} }),
      commRow(3, { participants_metadata: null }),
      commRow(4, { user_id: OTHER_USER }),
    ];

    const harness = makeLedgerHarness(rows);

    await expect(harness.service.selectStale(stage, USER, null, 10)).resolves.toEqual([subjectId(1)]);
  });

  it('binds the two stages under different ledger keys', () => {
    const events = new EventPersonLinkStage({ query: jest.fn() } as never, makeLogger() as never);

    expect(stage.id).not.toBe(events.id);
    expect(stage.source.table).toBe('communications');
    expect(events.source.table).toBe('events');
    // Same rule, same version, so a bump moves both corpora together.
    expect(events.version).toBe(stage.version);
  });
});

/* ===================================================================== *
 * 3. Decision — one answer per id, and the evidence written either way
 * ===================================================================== */

interface StoredClaim {
  subjectId: string;
  role: string;
  kind: string;
  valueNormalized: string;
  valueE164: string | null;
  entityId: string | null;
  confidence: number | null;
  method: string | null;
  disposition?: 'confirmed' | 'rejected' | null;
}

interface DecisionHarness {
  stage: PersonLinkStage;
  statements: Array<{ sql: string; params: unknown[] }>;
  claims: StoredClaim[];
  update(): { sql: string; params: unknown[] } | undefined;
}

/**
 * The stage over a fake `DataSource` that models the four statements, INCLUDING
 * a tiny `ci.identifier_claims` so the projection is genuinely read back out of
 * the claims rather than out of the run's own answers.
 */
function makeDecisionHarness(options: {
  rows?: Array<Record<string, unknown>>;
  /** `kind:value` -> the index row it resolves to. */
  index?: Record<string, { entity_id: string; raw_value?: string | null }>;
  /** Claims already on disk — a previous run's, or a human's rejection. */
  seededClaims?: StoredClaim[];
  failOn?: RegExp;
}): DecisionHarness {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const claims: StoredClaim[] = [...(options.seededClaims ?? [])];

  const query = jest.fn(async (raw: string, params: unknown[] = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    statements.push({ sql, params });

    if (options.failOn?.test(sql)) {
      throw new Error('boom');
    }

    if (/FROM ci\.communications/i.test(sql) && /^SELECT/i.test(sql)) {
      const [ids, userId] = params as [string[], string];

      return (options.rows ?? []).filter((row) => ids.includes(row.id as string) && userId === USER);
    }

    if (/FROM ci\.entity_identifiers/i.test(sql)) {
      const [, kinds, values] = params as [string, string[], string[]];

      return kinds
        .map((kind, i) => ({ kind, value_normalized: values[i] }))
        .filter((key) => options.index?.[`${key.kind}:${key.value_normalized}`] != null)
        .map((key) => ({
          ...key,
          entity_id: options.index![`${key.kind}:${key.value_normalized}`].entity_id,
          raw_value: options.index![`${key.kind}:${key.value_normalized}`].raw_value ?? null,
        }));
    }

    if (/INSERT INTO ci\.identifier_claims/i.test(sql)) {
      const [, , , , subjects, roles, kinds, values, e164s, , entityIds, confidences, methods] = params as [
        string,
        string,
        string,
        number,
        string[],
        string[],
        string[],
        string[],
        (string | null)[],
        (string | null)[],
        (string | null)[],
        (number | null)[],
        (string | null)[],
      ];

      subjects.forEach((subject, i) => {
        const existing = claims.find(
          (claim) =>
            claim.subjectId === subject &&
            claim.role === roles[i] &&
            claim.kind === kinds[i] &&
            claim.valueNormalized === values[i],
        );

        const next: StoredClaim = {
          subjectId: subject,
          role: roles[i],
          kind: kinds[i],
          valueNormalized: values[i],
          valueE164: e164s[i],
          entityId: entityIds[i],
          confidence: confidences[i],
          method: methods[i],
          // The human column survives the upsert.
          disposition: existing?.disposition ?? null,
        };

        if (existing == null) {
          claims.push(next);
        } else {
          Object.assign(existing, next);
        }
      });

      return [];
    }

    if (/FROM ci\.identifier_claims/i.test(sql)) {
      const [, , ids, roles] = params as [string, string, string[], string[]];

      return claims
        .filter(
          (claim) =>
            ids.includes(claim.subjectId) &&
            roles.includes(claim.role) &&
            claim.entityId != null &&
            claim.disposition !== 'rejected',
        )
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .map((claim) => ({
          subject_id: claim.subjectId,
          role: claim.role,
          entity_id: claim.entityId,
          confidence: claim.confidence,
        }));
    }

    return [];
  });

  return {
    stage: new PersonLinkStage({ query } as never, makeLogger() as never),
    statements,
    claims,
    update: () => statements.find((statement) => /^UPDATE ci\.communications/i.test(statement.sql)),
  };
}

function commLoaded(n: number, metadata: Record<string, unknown> | null, platform: string | null = null) {
  return { id: subjectId(n), metadata, platform, is_deleted: false };
}

describe('run() answers for every id, and never anonymously', () => {
  async function outcomes(harness: DecisionHarness, ids: string[]): Promise<Map<string, StageResult>> {
    const results = await harness.stage.run({ userId: USER } as never, ids);

    // The contract the worker relies on: an id with no result is recorded
    // `failed: stage_returned_no_result`, so silence is never success.
    expect([...results.keys()].sort()).toEqual([...ids].sort());

    for (const [, result] of results) {
      if (result.outcome !== 'done') {
        expect(result.reason).toEqual(expect.stringMatching(/^[a-z_]+$/));
      }
    }

    return results;
  }

  it('skips a row that vanished between the sweep and the slice', async () => {
    const harness = makeDecisionHarness({ rows: [] });

    expect((await outcomes(harness, [subjectId(1)])).get(subjectId(1))).toEqual({
      outcome: 'skipped',
      reason: 'source_row_missing',
    });
  });

  it('skips metadata that names nobody, and says which kind of nobody', async () => {
    const harness = makeDecisionHarness({
      rows: [commLoaded(1, {}), commLoaded(2, { to: ['', '   '] })],
    });

    const results = await outcomes(harness, [subjectId(1), subjectId(2)]);

    expect(results.get(subjectId(1))?.reason).toBe('no_participants');
    // Metadata naming participants, none of which normalises to anything. The
    // bucket that used to be indistinguishable from "never processed".
    expect(results.get(subjectId(2))?.reason).toBe('no_identifiers_parsed');
  });

  it('WRITES THE CLAIM even when the identifier belongs to nobody', async () => {
    const harness = makeDecisionHarness({
      rows: [commLoaded(1, { from: 'nobody@example.com', to: ['+44 20 7946 0958'] })],
      index: {},
    });

    const results = await outcomes(harness, [subjectId(1)]);

    expect(results.get(subjectId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'no_identifier_resolved',
    });

    // The evidence is the point. The old backfills left the column NULL and
    // recorded nothing at all; here the observations are on disk, keyed, with
    // the E.164 the raw value stated, ready for the version bump that follows a
    // contact import.
    expect(harness.claims).toEqual([
      expect.objectContaining({
        role: 'from',
        kind: 'email',
        valueNormalized: 'nobody@example.com',
        entityId: null,
        confidence: null,
      }),
      expect.objectContaining({
        role: 'to',
        kind: 'phone',
        valueNormalized: '2079460958',
        valueE164: '+442079460958',
        entityId: null,
      }),
    ]);

    // Nothing was projected, so no column was touched.
    expect(harness.update()).toBeUndefined();
  });

  it('projects resolved claims and reports the WEAKEST link as the confidence', async () => {
    const harness = makeDecisionHarness({
      rows: [commLoaded(1, { from: 'dana@example.com', to: ['Alex Kim', 'bob@example.com'] })],
      index: {
        'email:dana@example.com': { entity_id: personId(1) },
        'name:alex kim': { entity_id: personId(2) },
        'email:bob@example.com': { entity_id: personId(3) },
      },
    });

    const results = await outcomes(harness, [subjectId(1)]);

    expect(results.get(subjectId(1))).toMatchObject({
      outcome: 'done',
      // A display-name match at 0.6 drags the row down, and it should: the row
      // is only as trustworthy as its worst-resolved participant.
      confidence: MATCH_CONFIDENCE.name_exact,
    });

    const update = harness.update()!;

    expect(update.params[2]).toEqual([personId(1)]);
    expect(JSON.parse((update.params[3] as string[])[0])).toEqual(
      expect.arrayContaining([personId(2), personId(3)]),
    );
  });

  it('honours a human rejection instead of silently re-deriving the link', async () => {
    // CLEAN proposes; a human disposes. The rejected claim keeps its row — the
    // observation that caused the wrong match is not destroyed by correcting it
    // — and the projection simply stops seeing it.
    const harness = makeDecisionHarness({
      rows: [commLoaded(1, { from: 'dana@example.com' })],
      index: { 'email:dana@example.com': { entity_id: personId(1) } },
      seededClaims: [
        {
          subjectId: subjectId(1),
          role: 'from',
          kind: 'email',
          valueNormalized: 'dana@example.com',
          valueE164: null,
          entityId: personId(1),
          confidence: 1,
          method: 'email_exact',
          disposition: 'rejected',
        },
      ],
    });

    const results = await outcomes(harness, [subjectId(1)]);

    expect(results.get(subjectId(1))?.reason).toBe('all_claims_rejected');
    expect(harness.update()).toBeUndefined();
    expect(harness.claims).toHaveLength(1);
    expect(harness.claims[0].disposition).toBe('rejected');
  });

  it('distinguishes "only a cc matched" from "nobody matched"', async () => {
    const harness = makeDecisionHarness({
      rows: [commLoaded(1, { cc: ['carol@example.com'] })],
      index: { 'email:carol@example.com': { entity_id: personId(9) } },
    });

    const results = await outcomes(harness, [subjectId(1)]);

    // The claim exists and is queryable; no column projects a carbon copy
    // today, which is a projection-generation decision rather than a failure.
    expect(results.get(subjectId(1))?.reason).toBe('no_projectable_role_resolved');
  });

  it('NEVER merges two people, and touches no graph table', async () => {
    // The decision this stage is built around: two entities claiming one
    // identifier is a merge CANDIDATE and never a merge. The only writes are
    // the claim upsert and the link projection.
    const harness = makeDecisionHarness({
      rows: [commLoaded(1, { from: 'dana@example.com', to: ['dana@example.com'] })],
      index: { 'email:dana@example.com': { entity_id: personId(1) } },
    });

    await outcomes(harness, [subjectId(1)]);

    const writes = harness.statements.filter((statement) => !/^SELECT/i.test(statement.sql));

    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write.sql).not.toMatch(/ci\.entities|ci\.entity_merges|ci\.entity_identifiers/i);
    }
  });

  it('fails every id in the slice with a reason when the claim write does not commit', async () => {
    const harness = makeDecisionHarness({
      rows: [commLoaded(1, { from: 'dana@example.com' })],
      failOn: /INSERT INTO ci\.identifier_claims/i,
    });

    expect((await outcomes(harness, [subjectId(1)])).get(subjectId(1))).toMatchObject({
      outcome: 'failed',
      reason: 'claim_write_failed',
    });
  });

  it('fails when the projection write does not commit', async () => {
    const harness = makeDecisionHarness({
      rows: [commLoaded(1, { from: 'dana@example.com' })],
      index: { 'email:dana@example.com': { entity_id: personId(1) } },
      failOn: /^UPDATE ci\.communications/i,
    });

    expect((await outcomes(harness, [subjectId(1)])).get(subjectId(1))).toMatchObject({
      outcome: 'failed',
      reason: 'link_write_failed',
    });
  });

  it('is idempotent: a second run over the same ids writes the same claims', async () => {
    const harness = makeDecisionHarness({
      rows: [commLoaded(1, { from: 'dana@example.com', to: ['bob@example.com'] })],
      index: { 'email:dana@example.com': { entity_id: personId(1) } },
    });

    await harness.stage.run({ userId: USER } as never, [subjectId(1)]);
    const afterFirst = harness.claims.length;
    await harness.stage.run({ userId: USER } as never, [subjectId(1)]);

    expect(harness.claims).toHaveLength(afterFirst);
  });

  it("qualifies a bare handle with the row's own source system", async () => {
    const harness = makeDecisionHarness({
      rows: [commLoaded(1, { from: '@alice' }, 'instagram')],
    });

    await harness.stage.run({ userId: USER } as never, [subjectId(1)]);

    expect(harness.claims[0]).toMatchObject({ kind: 'handle', valueNormalized: 'instagram:@alice' });
  });
});

/* ===================================================================== *
 * 4. Against real Postgres
 * ===================================================================== */

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[PersonLinkStage.spec] SKIPPED (database half) — ${availability.reason}`);
}

jest.setTimeout(60_000);

/** The migration's `-- migrate:up` half, applied inside the test transaction. */
function migrationUp(): string {
  const file = path.resolve(
    __dirname,
    '../../../../../db/postgres/migrations/20260809183010_identifier_claims.sql',
  );

  const sql = readFileSync(file, 'utf8');
  const start = sql.indexOf('-- migrate:up');
  const end = sql.indexOf('-- migrate:down');

  if (start < 0 || end < 0) {
    throw new Error(`${file} has no migrate:up / migrate:down markers.`);
  }

  return sql.slice(start + '-- migrate:up'.length, end);
}

describeWithDatabase(`enrich.person_link against real Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let ownerUserId: string;

  const entityId = randomUUID();
  const commId = randomUUID();

  /**
   * A typed read through the transaction's runner.
   *
   * `QueryRunner.query` is not generic in TypeORM 0.3.30 (it resolves to
   * `QueryResult<any>`), so the assertion lives here once instead of at every
   * call site. The cast is safe for exactly the reason it is ugly: these are
   * hand-written SELECTs whose column list is three lines above the type.
   */
  function q<T>(text: string, params?: unknown[]): Promise<T> {
    return runner.query(text, params) as Promise<T>;
  }

  /** The stage, bound to the transaction so nothing escapes the rollback. */
  function transactionalStage(): PersonLinkStage {
    return new PersonLinkStage(
      { query: (sql: string, params?: unknown[]) => runner.query(sql, params) } as never,
      makeLogger() as never,
    );
  }

  beforeAll(async () => {
    const connection = resolveConnection();

    if (connection == null) {
      throw new Error('PersonLinkStage.spec ran with no database configured; the gate broke.');
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
      entities: [],
      synchronize: false,
      logging: false,
      extra: { max: 2 },
    });

    await dataSource.initialize();

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    // The migration is applied HERE, inside the transaction that is always
    // rolled back, rather than against the database. Two things follow: the
    // block runs on an appliance where `yarn migrate` has not been run yet, and
    // the DDL under test is the real file rather than a copy of it that could
    // drift. Every statement in the up half is `IF NOT EXISTS`/`IF EXISTS`
    // guarded, so it is equally correct once the migration HAS been applied.
    await runner.query(migrationUp());

    const users = await q<Array<{ id: string }>>(`SELECT id FROM ci.users LIMIT 1`);

    if (users.length === 0) {
      throw new Error('No ci.users row to attach the fixtures to.');
    }

    ownerUserId = users[0].id;

    // A communication is a CTI aggregate too: the base row in ci.entities owns
    // the display name and the FK makes it mandatory. Seeded base-first.
    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties,
                                owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Communication', 'body', '{}'::jsonb, $2, 'communications', $1)`,
      [commId, ownerUserId],
    );
    await runner.query(
      `INSERT INTO ci.communications (id, time, user_id, communication_type, direction, content,
                                      participants_metadata, source_system)
       VALUES ($1, now(), $2, 'email', 'inbound', 'body',
               $3::jsonb, 'gmail')`,
      [
        commId,
        ownerUserId,
        JSON.stringify({
          from: 'Dana Q. <Dana@Example.com>',
          to: ['bob@example.com', 'nobody@example.com'],
        }),
      ],
    );

    await runner.query(
      `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized, raw_value)
       VALUES ($1, $2, 'email', 'dana@example.com', NULL),
              ($1, $2, 'email', 'bob@example.com', NULL)`,
      [entityId, ownerUserId],
    );
  });

  afterAll(async () => {
    if (runner != null) {
      // ALWAYS. The fixtures, the claims, the projected links and the migration
      // itself all disappear with this line.
      await runner.rollbackTransaction();
      await runner.release();
    }

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('writes a claim for every identifier — including the one that matched nobody', async () => {
    const results = await transactionalStage().run({ userId: ownerUserId } as never, [commId]);

    expect(results.get(commId)?.outcome).toBe('done');

    const claims = await q<
      Array<{ role: string; value_normalized: string; entity_id: string | null; method: string | null }>
    >(
      `SELECT role, value_normalized, entity_id, method
         FROM ci.identifier_claims
        WHERE subject_id = $1
        ORDER BY role, value_normalized`,
      [commId],
    );

    expect(claims).toEqual([
      { role: 'from', value_normalized: 'dana@example.com', entity_id: entityId, method: 'email_exact' },
      { role: 'to', value_normalized: 'bob@example.com', entity_id: entityId, method: 'email_exact' },
      // The row the old backfills produced no trace of whatsoever.
      { role: 'to', value_normalized: 'nobody@example.com', entity_id: null, method: null },
    ]);
  });

  it('keeps the display name the source supplied, on the real column', async () => {
    const [claim] = await q<Array<{ raw_value: string | null; spec_version: number }>>(
      `SELECT raw_value, spec_version FROM ci.identifier_claims
        WHERE subject_id = $1 AND role = 'from'`,
      [commId],
    );

    expect(claim.raw_value).toBe('Dana Q. <Dana@Example.com>');
    expect(claim.spec_version).toBe(PERSON_MATCH_SPEC_VERSION);
  });

  it('projects the resolved ids onto the link columns', async () => {
    const [row] = await q<Array<{ from_entity_id: string | null; to_entity_ids: string[] | null }>>(
      `SELECT from_entity_id, to_entity_ids FROM ci.communications WHERE id = $1`,
      [commId],
    );

    expect(row.from_entity_id).toBe(entityId);
    expect(row.to_entity_ids).toEqual([entityId]);
  });

  it('is idempotent — a second run adds no claim and changes no link', async () => {
    const before = await q<Array<{ count: string }>>(
      `SELECT count(*) AS count FROM ci.identifier_claims WHERE subject_id = $1`,
      [commId],
    );

    await transactionalStage().run({ userId: ownerUserId } as never, [commId]);

    const after = await q<Array<{ count: string }>>(
      `SELECT count(*) AS count FROM ci.identifier_claims WHERE subject_id = $1`,
      [commId],
    );

    expect(after[0].count).toBe(before[0].count);
  });

  it('REPLACES a partially-linked array instead of freezing it — the ratchet fix', async () => {
    // The scenario the fill-only-NULL guard makes permanent: the row already
    // carries one resolved recipient, so `cardinality(to_entity_ids) = 0` is
    // false and all three services consider it done forever. Here a second
    // recipient becomes resolvable and the next run picks it up.
    const secondPerson = randomUUID();

    await runner.query(
      `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized)
       VALUES ($1, $2, 'email', 'nobody@example.com')`,
      [secondPerson, ownerUserId],
    );

    await transactionalStage().run({ userId: ownerUserId } as never, [commId]);

    const [row] = await q<Array<{ to_entity_ids: string[] }>>(
      `SELECT to_entity_ids FROM ci.communications WHERE id = $1`,
      [commId],
    );

    expect(row.to_entity_ids).toHaveLength(2);
    expect(row.to_entity_ids).toEqual(expect.arrayContaining([entityId, secondPerson]));

    // And the claim that was evidence-only is now resolved, in place — the same
    // row, not a second one.
    const [claim] = await q<Array<{ entity_id: string; confidence: number }>>(
      `SELECT entity_id, confidence FROM ci.identifier_claims
        WHERE subject_id = $1 AND value_normalized = 'nobody@example.com'`,
      [commId],
    );

    expect(claim.entity_id).toBe(secondPerson);
    expect(claim.confidence).toBe(MATCH_CONFIDENCE.email_exact);
  });

  it('never blanks a link it cannot resolve', async () => {
    // A row with no resolvable participant must leave whatever a previous
    // writer managed alone: the projection can only ever add or improve.
    const orphan = randomUUID();

    await runner.query(
      `WITH base AS (
         INSERT INTO ci.entities (entity_id, entity_type, name, properties,
                                  owner_user_id, linked_table, linked_id)
         VALUES ($1, 'Communication', 'body', '{}'::jsonb, $2, 'communications', $1)
       )
       INSERT INTO ci.communications (id, time, user_id, communication_type, direction, content,
                                      participants_metadata, from_entity_id)
       VALUES ($1, now(), $2, 'sms', 'inbound', 'body', $3::jsonb, $4)`,
      [orphan, ownerUserId, JSON.stringify({ from: 'stranger@example.com' }), entityId],
    );

    const results = await transactionalStage().run({ userId: ownerUserId } as never, [orphan]);

    expect(results.get(orphan)).toMatchObject({ outcome: 'skipped', reason: 'no_identifier_resolved' });

    const [row] = await q<Array<{ from_entity_id: string | null }>>(
      `SELECT from_entity_id FROM ci.communications WHERE id = $1`,
      [orphan],
    );

    expect(row.from_entity_id).toBe(entityId);
  });

  it('refuses to link two phone numbers that share ten digits but not a country', async () => {
    const ukPerson = randomUUID();
    const collide = randomUUID();

    await runner.query(
      `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized, raw_value)
       VALUES ($1, $2, 'phone', '2079460958', '+1 207 946 0958')`,
      [ukPerson, ownerUserId],
    );

    await runner.query(
      `WITH base AS (
         INSERT INTO ci.entities (entity_id, entity_type, name, properties,
                                  owner_user_id, linked_table, linked_id)
         VALUES ($1, 'Communication', 'body', '{}'::jsonb, $2, 'communications', $1)
       )
       INSERT INTO ci.communications (id, time, user_id, communication_type, direction, content,
                                      participants_metadata)
       VALUES ($1, now(), $2, 'sms', 'inbound', 'body', $3::jsonb)`,
      [collide, ownerUserId, JSON.stringify({ from: '+44 20 7946 0958' })],
    );

    await transactionalStage().run({ userId: ownerUserId } as never, [collide]);

    const [claim] = await q<Array<{ entity_id: string | null; method: string; value_e164: string }>>(
      `SELECT entity_id, method, value_e164 FROM ci.identifier_claims WHERE subject_id = $1`,
      [collide],
    );

    expect(claim).toEqual({
      entity_id: null,
      method: PHONE_COUNTRY_CONFLICT,
      value_e164: '+442079460958',
    });
  });

  it('links an event organizer and its attendees through the same rules', async () => {
    const eventId = randomUUID();

    // An event is a CTI aggregate: the base row in ci.entities owns the title
    // and the FK makes it mandatory. Seeded base-first.
    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties,
                                owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', 'Standup', '{}'::jsonb, $2, 'events', $1)`,
      [eventId, ownerUserId],
    );
    await runner.query(
      `INSERT INTO ci.events (event_id, user_id, start_time, metadata)
       VALUES ($1, $2, now(), $3::jsonb)`,
      [
        eventId,
        ownerUserId,
        JSON.stringify({
          organizerEmail: 'dana@example.com',
          participants: [{ email: 'bob@example.com' }, { name: 'Carol Danvers' }],
        }),
      ],
    );

    const stage = new EventPersonLinkStage(
      { query: (sql: string, params?: unknown[]) => runner.query(sql, params) } as never,
      makeLogger() as never,
    );

    const results = await stage.run({ userId: ownerUserId } as never, [eventId]);

    expect(results.get(eventId)?.outcome).toBe('done');

    const [row] = await q<Array<{ organizer_entity_id: string; participant_entity_ids: string[] }>>(
      `SELECT organizer_entity_id, participant_entity_ids FROM ci.events WHERE event_id = $1`,
      [eventId],
    );

    expect(row.organizer_entity_id).toBe(entityId);
    expect(row.participant_entity_ids).toEqual([entityId]);

    // The display-name attendee is claimed even though nobody answers to it —
    // `EventParticipantBackfillService` drops anything without an '@' before it
    // gets this far, so this row is invisible to it.
    const [claim] = await q<Array<{ kind: string; entity_id: string | null }>>(
      `SELECT kind, entity_id FROM ci.identifier_claims
        WHERE subject_id = $1 AND value_normalized = 'carol danvers'`,
      [eventId],
    );

    expect(claim).toEqual({ kind: 'name', entity_id: null });
  });

  it('records the claim under the same subject_type the ledger uses', async () => {
    // Not cosmetic: `ci.identifier_claims.subject_type` and
    // `ci.pipeline_state.entity_type` share a vocabulary so a claim and the
    // ledger row that produced it join without a translation table.
    const rows = await q<Array<{ subject_type: string }>>(
      `SELECT DISTINCT subject_type FROM ci.identifier_claims WHERE subject_id = $1`,
      [commId],
    );

    expect(rows).toEqual([{ subject_type: COMMUNICATION }]);
    expect(new PersonLinkStage({ query: jest.fn() } as never, makeLogger() as never).entityTypes).toEqual([
      COMMUNICATION,
    ]);
  });
});
