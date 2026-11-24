import config from '@ci/configuration';

import { EMBEDDING_DIMENSION } from '../index/embedVersion';
import {
  BrowserActivityEmbedStage,
  CommunicationEmbedStage,
  EventEmbedStage,
  FileEmbedStage,
  INDEX_EMBED_BROWSER_ACTIVITY_SOURCE,
  INDEX_EMBED_COMMUNICATION_SOURCE,
  INDEX_EMBED_EVENT_SOURCE,
  INDEX_EMBED_FILE_SOURCE,
  INDEX_EMBED_ITEM_SOURCE,
  INDEX_EMBED_PERSON_SOURCE,
  ItemEmbedStage,
  PersonEmbedStage,
} from '../index/entityEmbedStages';
import { loadEventRows } from '../index/entityRows';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The six per-entity-type dense-embed stages, individually.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `EmbedStage.spec.ts` exhaustively covers `DenseEmbedStageBase`'s mechanics
 * (version derivation, the ledger contract, batching, failure classification)
 * through the one stage that shipped first — `content`. This file does not
 * repeat any of that; it exists for the thing `EmbedStage.spec.ts` cannot
 * prove by construction: that each of the OTHER six subclasses wires its own
 * `loadDocuments` to the matching `<type>SearchDocument` builder, and declares
 * the correct `skipHeuristics` for its type.
 *
 * `skipHeuristics` is the sharp edge: communication, event and browser-activity
 * are `true` (their documents are message-like prose, where "too-short" /
 * "trivial" / "url-only" are real signal); item, person and file are `false`
 * (a bare short name — "Al", a two-letter file title — is a LEGITIMATE
 * document for those types, not noise). Swap which group a type belongs to —
 * a one-character copy-paste slip between two adjacent class bodies — and the
 * failure is silent: no error, no dead letter, just a type whose short-but-real
 * rows quietly stop being embeddable, forever, with nothing in the ledger or
 * the coverage numbers to say why. Every `describe` block below embeds one row
 * short enough to trigger the heuristics and asserts the OUTCOME the type's
 * declared `skipHeuristics` should produce — which is what actually catches
 * the swap, unlike reading the boolean off the instance.
 */

const USER = '00000000-0000-4000-8000-0000000000aa';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/** A 768-float vector, the shape `ci_search.embeddings.embedding` accepts. */
function vector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => (seed + i) / 1000);
}

interface RecordedQuery {
  sql: string;
  params: unknown[] | undefined;
}

/**
 * Same fake `DataSource` shape `EmbedStage.spec.ts` uses: the load query
 * returns whatever rows the test seeded, the upsert is recorded rather than
 * persisted, and both are told apart by matching the SQL rather than by call
 * order — a stage that changed its statement order would otherwise pass here
 * for the wrong reason.
 */
function makeHarness(rows: Array<Record<string, unknown>>) {
  const loads: RecordedQuery[] = [];
  const upserts: RecordedQuery[] = [];

  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    if (/insert\s+into\s+ci_search\.embeddings/i.test(sql)) {
      upserts.push({ sql, params });

      return [];
    }

    loads.push({ sql, params });

    return rows;
  });

  const generateEmbeddings = jest.fn(async (inputs: string[]) => inputs.map((_, i) => vector(i)));

  return {
    dataSource: { query },
    embeddingGenerationService: { generateEmbeddings },
    logger: makeLogger(),
    query,
    loads,
    upserts,
    generateEmbeddings,
  };
}

const ctx = { userId: USER };

/* ===================================================================== *
 * CommunicationEmbedStage — skipHeuristics: true, honorsEmbedAllowlist: true
 * ===================================================================== */

describe('CommunicationEmbedStage', () => {
  function makeStage(rows: Array<Record<string, unknown>>) {
    const h = makeHarness(rows);
    const stage = new CommunicationEmbedStage(
      h.dataSource as never,
      h.embeddingGenerationService as never,
      h.logger as never,
    );

    return { stage, ...h };
  }

  it('loads ci.communications, scoped to the user, and embeds subject + preview + content', async () => {
    const h = makeStage([
      {
        id: 'comm-1',
        subject: 'Dinner Friday?',
        preview: 'Want to grab dinner this Friday',
        content: 'Want to grab dinner this Friday evening, maybe that new ramen place?',
      },
    ]);

    const results = await h.stage.run(ctx, ['comm-1']);

    expect(h.loads[0].sql).toContain('ci.communications');
    expect(h.loads[0].params).toEqual([['comm-1'], USER]);

    expect(h.generateEmbeddings).toHaveBeenCalledTimes(1);
    const doc = h.generateEmbeddings.mock.calls[0][0][0] as string;
    expect(doc).toContain('Dinner Friday?');
    expect(doc).toContain('ramen place');

    expect(results.get('comm-1')).toEqual({ outcome: 'done' });
    expect((h.upserts[0].params as unknown[])[0]).toBe('communication');
  });

  it('applies the message heuristics: a short, non-trivial line is skipped as too-short — not embedded as if it were a name', async () => {
    // Two characters, below config.embedding.minTextLength (3), and not one of
    // the exact trivial phrases — the case skipHeuristics exists to catch.
    const h = makeStage([{ id: 'comm-1', subject: null, preview: null, content: 'Hi' }]);

    const results = await h.stage.run(ctx, ['comm-1']);

    expect(results.get('comm-1')).toEqual({ outcome: 'skipped', reason: 'too-short' });
    expect(h.generateEmbeddings).not.toHaveBeenCalled();
  });

  it('skips a wholly empty row as "empty", independent of the heuristics flag', async () => {
    const h = makeStage([{ id: 'comm-1', subject: null, preview: null, content: null }]);

    const results = await h.stage.run(ctx, ['comm-1']);

    expect(results.get('comm-1')).toEqual({ outcome: 'skipped', reason: 'empty' });
  });

  it('declares the communications source', () => {
    expect(INDEX_EMBED_COMMUNICATION_SOURCE.table).toBe('communications');
  });
});

/* ===================================================================== *
 * EventEmbedStage — skipHeuristics: true, honorsEmbedAllowlist: true
 * ===================================================================== */

describe('EventEmbedStage', () => {
  function makeStage(rows: Array<Record<string, unknown>>) {
    const h = makeHarness(rows);
    const stage = new EventEmbedStage(
      h.dataSource as never,
      h.embeddingGenerationService as never,
      h.logger as never,
    );

    return { stage, ...h };
  }

  it('loads ci.events, scoped to the user, and embeds an authored title + description + category', async () => {
    const h = makeStage([
      {
        id: 'event-1',
        title: 'Team offsite planning',
        description: 'Discuss Q3 roadmap and hiring plan',
        category: 'work',
        eventType: 'meeting',
        locationName: null,
        startTime: null,
        sourceSystem: null,
        metadata: null,
      },
    ]);

    const results = await h.stage.run(ctx, ['event-1']);

    expect(h.loads[0].sql).toContain('ci.events');
    expect(h.loads[0].params).toEqual([['event-1'], USER]);

    const doc = h.generateEmbeddings.mock.calls[0][0][0] as string;
    expect(doc).toContain('Team offsite planning');
    expect(doc).toContain('Q3 roadmap');
    expect(doc).toContain('work');

    expect(results.get('event-1')).toEqual({ outcome: 'done' });
    expect((h.upserts[0].params as unknown[])[0]).toBe('event');
  });

  it('applies the message heuristics: a short authored title is skipped as too-short', async () => {
    const h = makeStage([
      {
        id: 'event-1',
        title: 'Al',
        description: null,
        category: null,
        eventType: null,
        locationName: null,
        startTime: null,
        sourceSystem: null,
        metadata: null,
      },
    ]);

    const results = await h.stage.run(ctx, ['event-1']);

    expect(results.get('event-1')).toEqual({ outcome: 'skipped', reason: 'too-short' });
    expect(h.generateEmbeddings).not.toHaveBeenCalled();
  });

  it('skips a wholly empty row as "empty"', async () => {
    const h = makeStage([
      {
        id: 'event-1',
        title: null,
        description: null,
        category: null,
        eventType: null,
        locationName: null,
        startTime: null,
        sourceSystem: null,
        metadata: null,
      },
    ]);

    const results = await h.stage.run(ctx, ['event-1']);

    expect(results.get('event-1')).toEqual({ outcome: 'skipped', reason: 'empty' });
  });

  it('excludes planned blocks at the source, so autoplan does not feed the embed ledger', () => {
    // Guardrail #2 in planning-roadmap.md. The listener refused these; this
    // path did not, and embedded every block an autoplan run moved.
    expect(INDEX_EMBED_EVENT_SOURCE.predicate).toContain("event_type <> 'planned_block'");
  });

  it('re-checks planned_block when loading rows, not only at the source', async () => {
    // Same reasoning as the loader re-checking is_deleted: a row that reached
    // the loader by any other route must still not embed.
    const query = jest.fn().mockResolvedValue([]);

    await loadEventRows({ query } as never, 'user-1', ['00000000-0000-7000-8000-000000000001']);

    expect(query.mock.calls[0]?.[0]).toContain("event_type <> 'planned_block'");
  });

  it('excludes soft-deleted events at the source', () => {
    expect(INDEX_EMBED_EVENT_SOURCE.predicate).toContain('is_deleted IS NOT TRUE');
  });
});

/* ===================================================================== *
 * ItemEmbedStage — skipHeuristics: false, honorsEmbedAllowlist: false
 * ===================================================================== */

describe('ItemEmbedStage', () => {
  function makeStage(rows: Array<Record<string, unknown>>) {
    const h = makeHarness(rows);
    const stage = new ItemEmbedStage(
      h.dataSource as never,
      h.embeddingGenerationService as never,
      h.logger as never,
    );

    return { stage, ...h };
  }

  it('loads ci.objects, scoped to the user, and embeds name + brand + last-seen place', async () => {
    const h = makeStage([
      {
        id: 'item-1',
        name: 'Cordless drill',
        description: null,
        category: 'tools',
        subcategory: null,
        brand: 'DeWalt',
        model: null,
        maintenanceNotes: null,
        colors: null,
        materials: null,
        lastSeenPlaceName: 'Garage',
      },
    ]);

    const results = await h.stage.run(ctx, ['item-1']);

    expect(h.loads[0].sql).toContain('ci.objects');
    expect(h.loads[0].params).toEqual([['item-1'], USER]);

    const doc = h.generateEmbeddings.mock.calls[0][0][0] as string;
    expect(doc).toContain('Cordless drill');
    expect(doc).toContain('DeWalt');
    expect(doc).toContain('Garage');

    expect(results.get('item-1')).toEqual({ outcome: 'done' });
    expect((h.upserts[0].params as unknown[])[0]).toBe('item');
  });

  it('does NOT apply the message heuristics: a bare two-letter name embeds instead of being rejected as too-short', async () => {
    // This is the case the type comment calls out explicitly — "item ...
    // legitimately embed a bare short name". If ItemEmbedStage's
    // skipHeuristics were accidentally `true` (the copy-paste this test
    // exists to catch), this row would come back skipped:too-short instead of
    // done, and a real short item name would silently stop being searchable.
    const h = makeStage([
      {
        id: 'item-1',
        name: 'Al',
        description: null,
        category: null,
        subcategory: null,
        brand: null,
        model: null,
        maintenanceNotes: null,
        colors: null,
        materials: null,
        lastSeenPlaceName: null,
      },
    ]);

    const results = await h.stage.run(ctx, ['item-1']);

    expect(results.get('item-1')).toEqual({ outcome: 'done' });
    expect(h.generateEmbeddings).toHaveBeenCalledTimes(1);
    expect(h.generateEmbeddings.mock.calls[0][0][0]).toBe('Al');
  });

  it('skips a wholly empty row as "empty" even though heuristics are off', async () => {
    const h = makeStage([
      {
        id: 'item-1',
        name: null,
        description: null,
        category: null,
        subcategory: null,
        brand: null,
        model: null,
        maintenanceNotes: null,
        colors: null,
        materials: null,
        lastSeenPlaceName: null,
      },
    ]);

    const results = await h.stage.run(ctx, ['item-1']);

    expect(results.get('item-1')).toEqual({ outcome: 'skipped', reason: 'empty' });
    expect(h.generateEmbeddings).not.toHaveBeenCalled();
  });

  it('declares the objects source', () => {
    expect(INDEX_EMBED_ITEM_SOURCE.table).toBe('objects');
  });
});

/* ===================================================================== *
 * PersonEmbedStage — skipHeuristics: false, honorsEmbedAllowlist: false
 * ===================================================================== */

describe('PersonEmbedStage', () => {
  function makeStage(rows: Array<Record<string, unknown>>) {
    const h = makeHarness(rows);
    const stage = new PersonEmbedStage(
      h.dataSource as never,
      h.embeddingGenerationService as never,
      h.logger as never,
    );

    return { stage, ...h };
  }

  it('loads ci.entities (Person, unmerged), scoped to the user, and embeds name + email + job title', async () => {
    const h = makeStage([
      {
        id: 'person-1',
        name: 'Jane Doe',
        description: null,
        properties: {},
        firstName: null,
        middleName: null,
        lastName: null,
        birthDate: null,
        email: 'jane@example.com',
        nickname: null,
        pronouns: null,
        gender: null,
        jobTitle: 'Engineer',
        organization: 'Acme',
        department: null,
        website: null,
        address: null,
        streetAddress: null,
        streetAddress2: null,
        city: null,
        region: null,
        country: null,
        postalCode: null,
      },
    ]);

    const results = await h.stage.run(ctx, ['person-1']);

    expect(h.loads[0].sql).toContain('ci.entities');
    expect(h.loads[0].sql).toContain("entity_type = 'Person'");
    expect(h.loads[0].sql).toContain('merged_into_entity_id IS NULL');
    // A slice queued before a forget, or replayed after it, re-checks the archive here.
    expect(h.loads[0].sql).toContain('is_active IS NOT FALSE');
    expect(h.loads[0].params).toEqual([['person-1'], USER]);

    const doc = h.generateEmbeddings.mock.calls[0][0][0] as string;
    expect(doc).toContain('Jane Doe');
    expect(doc).toContain('jane@example.com');
    expect(doc).toContain('Engineer');

    expect(results.get('person-1')).toEqual({ outcome: 'done' });
    expect((h.upserts[0].params as unknown[])[0]).toBe('person');
  });

  it('does NOT apply the message heuristics: a bare short name embeds — a person IS a bare short name', async () => {
    const h = makeStage([
      {
        id: 'person-1',
        name: 'Al',
        description: null,
        properties: {},
        firstName: null,
        middleName: null,
        lastName: null,
        birthDate: null,
        email: null,
        nickname: null,
        pronouns: null,
        gender: null,
        jobTitle: null,
        organization: null,
        department: null,
        website: null,
        address: null,
        streetAddress: null,
        streetAddress2: null,
        city: null,
        region: null,
        country: null,
        postalCode: null,
      },
    ]);

    const results = await h.stage.run(ctx, ['person-1']);

    expect(results.get('person-1')).toEqual({ outcome: 'done' });
    expect(h.generateEmbeddings).toHaveBeenCalledTimes(1);
    expect(h.generateEmbeddings.mock.calls[0][0][0]).toBe('Al');
  });

  it('never re-indexes a merge tombstone or a forgotten person', () => {
    // The tombstone predicate itself is exercised against real Postgres in
    // entityRows.integration.spec.ts; this pins the source declaration the
    // stage actually ships, which is what a slice replayed from a dead letter
    // reads.
    expect(INDEX_EMBED_PERSON_SOURCE.predicate).toContain('merged_into_entity_id IS NULL');
    // Nor a person the user asked Memory to forget.
    expect(INDEX_EMBED_PERSON_SOURCE.predicate).toContain('is_active IS NOT FALSE');
  });
});

/* ===================================================================== *
 * FileEmbedStage — skipHeuristics: false, honorsEmbedAllowlist: false
 * ===================================================================== */

describe('FileEmbedStage', () => {
  function makeStage(rows: Array<Record<string, unknown>>) {
    const h = makeHarness(rows);
    const stage = new FileEmbedStage(
      h.dataSource as never,
      h.embeddingGenerationService as never,
      h.logger as never,
    );

    return { stage, ...h };
  }

  it('loads ci.files (originals only), scoped to the user, and embeds title + filename + content type', async () => {
    const h = makeStage([
      {
        id: 'file-1',
        title: 'Vacation photo album',
        description: null,
        filename: 'album.zip',
        contentType: 'application/zip',
      },
    ]);

    const results = await h.stage.run(ctx, ['file-1']);

    expect(h.loads[0].sql).toContain('ci.files');
    expect(h.loads[0].sql).toContain("variant = 'ORIGINAL'");
    expect(h.loads[0].params).toEqual([['file-1'], USER]);

    const doc = h.generateEmbeddings.mock.calls[0][0][0] as string;
    expect(doc).toContain('Vacation photo album');
    expect(doc).toContain('album.zip');

    expect(results.get('file-1')).toEqual({ outcome: 'done' });
    expect((h.upserts[0].params as unknown[])[0]).toBe('file');
  });

  it('does NOT apply the message heuristics: a bare short title embeds instead of being rejected as too-short', async () => {
    const h = makeStage([
      { id: 'file-1', title: 'Al', description: null, filename: null, contentType: null },
    ]);

    const results = await h.stage.run(ctx, ['file-1']);

    expect(results.get('file-1')).toEqual({ outcome: 'done' });
    expect(h.generateEmbeddings).toHaveBeenCalledTimes(1);
    expect(h.generateEmbeddings.mock.calls[0][0][0]).toBe('Al');
  });

  it('skips a wholly empty row as "empty"', async () => {
    const h = makeStage([
      { id: 'file-1', title: null, description: null, filename: null, contentType: null },
    ]);

    const results = await h.stage.run(ctx, ['file-1']);

    expect(results.get('file-1')).toEqual({ outcome: 'skipped', reason: 'empty' });
  });

  it('excludes derived variants and soft-deleted files at the source', () => {
    expect(INDEX_EMBED_FILE_SOURCE.predicate).toContain("variant = 'ORIGINAL'");
    expect(INDEX_EMBED_FILE_SOURCE.predicate).toContain('deleted_at IS NULL');
  });
});

/* ===================================================================== *
 * BrowserActivityEmbedStage — skipHeuristics: true, honorsEmbedAllowlist: true
 * ===================================================================== */

describe('BrowserActivityEmbedStage', () => {
  function makeStage(rows: Array<Record<string, unknown>>) {
    const h = makeHarness(rows);
    const stage = new BrowserActivityEmbedStage(
      h.dataSource as never,
      h.embeddingGenerationService as never,
      h.logger as never,
    );

    return { stage, ...h };
  }

  it('loads ci.browser_activity, scoped to the user, and embeds title + url + description', async () => {
    const h = makeStage([
      {
        id: 'browse-1',
        title: 'Pasta Recipe - AllRecipes',
        url: 'https://allrecipes.com/pasta',
        properties: { description: 'A simple weeknight pasta recipe' },
      },
    ]);

    const results = await h.stage.run(ctx, ['browse-1']);

    expect(h.loads[0].sql).toContain('ci.browser_activity');
    expect(h.loads[0].params).toEqual([['browse-1'], USER]);

    const doc = h.generateEmbeddings.mock.calls[0][0][0] as string;
    expect(doc).toContain('Pasta Recipe - AllRecipes');
    expect(doc).toContain('allrecipes.com/pasta');
    expect(doc).toContain('simple weeknight pasta recipe');

    expect(results.get('browse-1')).toEqual({ outcome: 'done' });
    expect((h.upserts[0].params as unknown[])[0]).toBe('browser-activity');
  });

  it('applies the message heuristics: a short title with no url is skipped as too-short', async () => {
    const h = makeStage([{ id: 'browse-1', title: 'Hi', url: null, properties: null }]);

    const results = await h.stage.run(ctx, ['browse-1']);

    expect(results.get('browse-1')).toEqual({ outcome: 'skipped', reason: 'too-short' });
    expect(h.generateEmbeddings).not.toHaveBeenCalled();
  });

  it('applies the URL-only heuristic: a bare link with no title is skipped as url-only, not embedded as noise', async () => {
    const h = makeStage([
      { id: 'browse-1', title: null, url: 'https://example.com/some/path', properties: null },
    ]);

    const results = await h.stage.run(ctx, ['browse-1']);

    expect(results.get('browse-1')).toEqual({ outcome: 'skipped', reason: 'url-only' });
    expect(h.generateEmbeddings).not.toHaveBeenCalled();
  });

  it('skips a wholly empty row as "empty"', async () => {
    const h = makeStage([{ id: 'browse-1', title: null, url: null, properties: null }]);

    const results = await h.stage.run(ctx, ['browse-1']);

    expect(results.get('browse-1')).toEqual({ outcome: 'skipped', reason: 'empty' });
  });

  it('declares the browser_activity source', () => {
    expect(INDEX_EMBED_BROWSER_ACTIVITY_SOURCE.table).toBe('browser_activity');
  });
});

/* ===================================================================== *
 * honorsEmbedAllowlist — the OTHER per-type boolean, same failure shape
 * ===================================================================== */

describe('honorsEmbedAllowlist — mirrors which listeners consult the CI_EMBED_TYPES gate', () => {
  const originalTypes = config.embedding.types;

  afterEach(() => {
    config.embedding.types = originalTypes;
  });

  it('a message-like type (honorsEmbedAllowlist: true) skips the whole slice, WITHOUT touching the database, when its type is not on the allowlist', async () => {
    config.embedding.types = ['event'];

    const h = makeHarness([{ id: 'comm-1', subject: 'Hi', preview: null, content: null }]);
    const stage = new CommunicationEmbedStage(
      h.dataSource as never,
      h.embeddingGenerationService as never,
      h.logger as never,
    );

    const results = await stage.run(ctx, ['comm-1']);

    expect(results.get('comm-1')).toEqual({ outcome: 'skipped', reason: 'embed_type_disabled' });
    // The gate fires before the row load — an excluded type never reaches SQL.
    expect(h.query).not.toHaveBeenCalled();
    expect(h.generateEmbeddings).not.toHaveBeenCalled();
  });

  it('a non-message type (honorsEmbedAllowlist: false) embeds normally even when excluded from the allowlist — items/people/files ignore CI_EMBED_TYPES', async () => {
    config.embedding.types = ['event'];

    const h = makeHarness([
      {
        id: 'item-1',
        name: 'Cordless drill',
        description: null,
        category: null,
        subcategory: null,
        brand: null,
        model: null,
        maintenanceNotes: null,
        colors: null,
        materials: null,
        lastSeenPlaceName: null,
      },
    ]);
    const stage = new ItemEmbedStage(
      h.dataSource as never,
      h.embeddingGenerationService as never,
      h.logger as never,
    );

    const results = await stage.run(ctx, ['item-1']);

    expect(results.get('item-1')).toEqual({ outcome: 'done' });
    expect(h.generateEmbeddings).toHaveBeenCalledTimes(1);
  });
});
