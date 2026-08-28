import {
  BrowserActivityVectorStage,
  CommunicationVectorStage,
  ContentVectorStage,
  EventVectorStage,
  FileVectorStage,
  ItemVectorStage,
  PersonVectorStage,
} from '../index/vectorStages';

const USER = '00000000-0000-0000-0000-0000000000aa';

function makeStage(rows: Array<Record<string, unknown>>, failOnInsert = false) {
  const query = jest.fn(async (sql: string) => {
    if (/FROM ci\.content/i.test(sql)) {
      return rows;
    }

    if (failOnInsert && /INSERT INTO ci_search\.vectors/i.test(sql)) {
      throw new Error('vector column rejected');
    }

    return [];
  });
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stage = new ContentVectorStage({ query } as any, logger as any);

  return { stage, query };
}

describe('VectorStageBase (via ContentVectorStage)', () => {
  it('writes a weighted tsvector per row and records done', async () => {
    const { stage, query } = makeStage([{ id: 'c1', title: 'Hello', text: 'World' }]);

    const results = await stage.run({ userId: USER }, ['c1']);

    expect(results.get('c1')).toEqual({ outcome: 'done' });
    const insert = query.mock.calls.find(([sql]) => /INSERT INTO ci_search\.vectors/i.test(sql as string));
    expect(insert).toBeDefined();
    const [sql, params] = insert as unknown as [string, unknown[]];
    // Same statement family as VectorService.upsert: conflict on the
    // (entity_type, entity_id) key, weighted setweight expression inline.
    expect(sql.replace(/\s+/g, ' ')).toContain('ON CONFLICT (entity_type, entity_id)');
    expect(params).toContain('content');
    expect(params).toContain('c1');
    expect(params[params.length - 1]).toBe(USER);
  });

  it('records skipped: empty for a row with no weighted texts, and writes nothing for it', async () => {
    const { stage, query } = makeStage([{ id: 'c1', title: null, text: null }]);

    const results = await stage.run({ userId: USER }, ['c1']);

    expect(results.get('c1')).toEqual({ outcome: 'skipped', reason: 'empty' });
    expect(query.mock.calls.some(([sql]) => /INSERT/i.test(sql as string))).toBe(false);
  });

  it('answers for an id whose row is gone rather than staying silent', async () => {
    const { stage } = makeStage([]);

    const results = await stage.run({ userId: USER }, ['ghost']);

    expect(results.get('ghost')).toEqual({ outcome: 'skipped', reason: 'source_row_missing' });
  });

  it('a write failure is per row, with the reason recorded, and does not abort the slice', async () => {
    const { stage } = makeStage(
      [
        { id: 'c1', title: 'One' },
        { id: 'c2', title: 'Two' },
      ],
      true,
    );

    const results = await stage.run({ userId: USER }, ['c1', 'c2']);

    expect(results.get('c1')).toMatchObject({ outcome: 'failed', reason: 'vector_write_failed' });
    expect(results.get('c2')).toMatchObject({ outcome: 'failed', reason: 'vector_write_failed' });
  });

  it('returns an empty map for an empty slice without touching the database', async () => {
    const { stage, query } = makeStage([]);

    const results = await stage.run({ userId: USER }, []);

    expect(results.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

/* ===================================================================== *
 * The other six VectorStageBase subclasses
 * ===================================================================== */

/**
 * `ContentVectorStage` above exhaustively covers the shared mechanics
 * (skip/fail/batch/empty-slice) `VectorStageBase.run` implements once for
 * every subclass. What varies per subclass is only `loadTexts`: which table it
 * reads, and which `*WeightedTexts` builder turns the row into weighted parts.
 * Neither had ever been executed for the other six types before this file —
 * `entityRows.integration.spec.ts` proves each loader's SQL is valid against
 * the live schema, but validity says nothing about which BUILDER a stage
 * pairs a loader with. Get that pairing wrong — `EventVectorStage` built with
 * `itemWeightedTexts`, say, a one-line mistake in `vectorStages.ts` — and the
 * result is silent: the write still succeeds, still lands under the CORRECT
 * `entity_type` tag (that part is a stage-level constant, not derived from the
 * row), so nothing downstream can tell the vector holds the wrong entity's
 * words. Each block below drives one row through the real subclass and reads
 * back what actually landed in the tsvector params — not what the source file
 * claims it built from.
 */

/** Every INSERT INTO ci_search.vectors call's bound weighted-text params, flattened to one string for a substring check that doesn't care which weight bucket a phrase landed in. */
function insertedText(params: unknown[] | undefined): string {
  return (params ?? []).filter((p): p is string => typeof p === 'string').join(' | ');
}

function makeVectorStageHarness(loadMatch: RegExp, rows: Array<Record<string, unknown>>) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });

    if (loadMatch.test(sql)) {
      return rows;
    }

    return [];
  });
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  return {
    query,
    dataSource: { query },
    logger,
    calls,
    load: () => calls.find((c) => loadMatch.test(c.sql)),
    insert: () => calls.find((c) => /INSERT INTO ci_search\.vectors/i.test(c.sql)),
  };
}

describe('CommunicationVectorStage (loadTexts: ci.communications -> communicationWeightedTexts)', () => {
  it('writes the subject + preview as weighted text under entity_type "communication"', async () => {
    const h = makeVectorStageHarness(/FROM ci\.communications/i, [
      { id: 'comm-1', subject: 'Dinner Friday?', preview: 'Grab dinner this Friday', content: null },
    ]);
    const stage = new CommunicationVectorStage(h.dataSource as never, h.logger as never);

    const results = await stage.run({ userId: USER }, ['comm-1']);

    expect(results.get('comm-1')).toEqual({ outcome: 'done' });
    expect(h.load()?.params).toEqual([['comm-1'], USER]);

    const [, entityType, entityId, ...rest] = h.insert()!.params as unknown[];
    expect(entityType).toBe('communication');
    expect(entityId).toBe('comm-1');
    expect(insertedText(rest)).toContain('Dinner Friday?');
    expect(insertedText(rest)).toContain('Grab dinner this Friday');
  });

  it('skips a row with no weighted text as "empty" rather than writing a blank tsvector', async () => {
    const h = makeVectorStageHarness(/FROM ci\.communications/i, [
      { id: 'comm-1', subject: null, preview: null, content: null },
    ]);
    const stage = new CommunicationVectorStage(h.dataSource as never, h.logger as never);

    const results = await stage.run({ userId: USER }, ['comm-1']);

    expect(results.get('comm-1')).toEqual({ outcome: 'skipped', reason: 'empty' });
    expect(h.insert()).toBeUndefined();
  });
});

describe('EventVectorStage (loadTexts: ci.events -> eventWeightedTexts)', () => {
  it('writes the display title + description + category as weighted text under entity_type "event"', async () => {
    const h = makeVectorStageHarness(/FROM ci\.events/i, [
      {
        id: 'event-1',
        title: 'Team offsite planning',
        description: 'Discuss Q3 roadmap',
        category: 'work',
        eventType: 'meeting',
        locationName: null,
        startTime: null,
        sourceSystem: null,
        metadata: null,
      },
    ]);
    const stage = new EventVectorStage(h.dataSource as never, h.logger as never);

    const results = await stage.run({ userId: USER }, ['event-1']);

    expect(results.get('event-1')).toEqual({ outcome: 'done' });

    const [, entityType, entityId, ...rest] = h.insert()!.params as unknown[];
    expect(entityType).toBe('event');
    expect(entityId).toBe('event-1');
    // This is the exact substring an accidental swap to itemWeightedTexts or
    // communicationWeightedTexts would never produce — it comes only from
    // eventWeightedTexts reading `description`/`category`.
    expect(insertedText(rest)).toContain('Team offsite planning');
    expect(insertedText(rest)).toContain('Discuss Q3 roadmap');
  });

  it('answers for an id whose row is gone rather than staying silent', async () => {
    const h = makeVectorStageHarness(/FROM ci\.events/i, []);
    const stage = new EventVectorStage(h.dataSource as never, h.logger as never);

    const results = await stage.run({ userId: USER }, ['ghost']);

    expect(results.get('ghost')).toEqual({ outcome: 'skipped', reason: 'source_row_missing' });
  });

  it('skips a row with no weighted text as "empty"', async () => {
    const h = makeVectorStageHarness(/FROM ci\.events/i, [
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
    const stage = new EventVectorStage(h.dataSource as never, h.logger as never);

    const results = await stage.run({ userId: USER }, ['event-1']);

    expect(results.get('event-1')).toEqual({ outcome: 'skipped', reason: 'empty' });
  });
});

describe('ItemVectorStage (loadTexts: ci.objects -> itemWeightedTexts)', () => {
  it('writes name + brand + last-seen place as weighted text under entity_type "item"', async () => {
    const h = makeVectorStageHarness(/FROM ci\.objects/i, [
      {
        id: 'item-1',
        name: 'Cordless drill',
        description: null,
        category: null,
        subcategory: null,
        brand: 'DeWalt',
        model: null,
        maintenanceNotes: null,
        colors: null,
        materials: null,
        lastSeenPlaceName: 'Garage',
      },
    ]);
    const stage = new ItemVectorStage(h.dataSource as never, h.logger as never);

    const results = await stage.run({ userId: USER }, ['item-1']);

    expect(results.get('item-1')).toEqual({ outcome: 'done' });

    const [, entityType, entityId, ...rest] = h.insert()!.params as unknown[];
    expect(entityType).toBe('item');
    expect(entityId).toBe('item-1');
    // "Garage" only reaches the text via itemWeightedTexts' lastSeenPlaceName
    // field — no other type's builder reads a field by that name.
    expect(insertedText(rest)).toContain('Cordless drill');
    expect(insertedText(rest)).toContain('Garage');
  });

  it('skips a row with no weighted text as "empty"', async () => {
    const h = makeVectorStageHarness(/FROM ci\.objects/i, [
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
    const stage = new ItemVectorStage(h.dataSource as never, h.logger as never);

    const results = await stage.run({ userId: USER }, ['item-1']);

    expect(results.get('item-1')).toEqual({ outcome: 'skipped', reason: 'empty' });
  });
});

describe('PersonVectorStage (loadTexts: ci.entities [Person] -> personWeightedTexts)', () => {
  it('writes the name + description as weighted text under entity_type "person"', async () => {
    const h = makeVectorStageHarness(/FROM ci\.entities/i, [
      { id: 'person-1', name: 'Jane Doe', description: 'A friend from work', properties: {} },
    ]);
    const stage = new PersonVectorStage(h.dataSource as never, h.logger as never);

    const results = await stage.run({ userId: USER }, ['person-1']);

    expect(results.get('person-1')).toEqual({ outcome: 'done' });
    expect(h.load()?.sql).toContain("entity_type = 'Person'");

    const [, entityType, entityId, ...rest] = h.insert()!.params as unknown[];
    expect(entityType).toBe('person');
    expect(entityId).toBe('person-1');
    expect(insertedText(rest)).toContain('Jane Doe');
    expect(insertedText(rest)).toContain('A friend from work');
  });

  it('skips a row with no weighted text as "empty"', async () => {
    const h = makeVectorStageHarness(/FROM ci\.entities/i, [
      { id: 'person-1', name: null, description: null, properties: {} },
    ]);
    const stage = new PersonVectorStage(h.dataSource as never, h.logger as never);

    const results = await stage.run({ userId: USER }, ['person-1']);

    expect(results.get('person-1')).toEqual({ outcome: 'skipped', reason: 'empty' });
  });
});

describe('FileVectorStage (loadTexts: ci.files -> fileWeightedTexts)', () => {
  it('writes the title + filename as weighted text under entity_type "file"', async () => {
    const h = makeVectorStageHarness(/FROM ci\.files/i, [
      {
        id: 'file-1',
        title: 'Vacation photo album',
        description: null,
        filename: 'album.zip',
        contentType: 'application/zip',
      },
    ]);
    const stage = new FileVectorStage(h.dataSource as never, h.logger as never);

    const results = await stage.run({ userId: USER }, ['file-1']);

    expect(results.get('file-1')).toEqual({ outcome: 'done' });

    const [, entityType, entityId, ...rest] = h.insert()!.params as unknown[];
    expect(entityType).toBe('file');
    expect(entityId).toBe('file-1');
    expect(insertedText(rest)).toContain('Vacation photo album');
    expect(insertedText(rest)).toContain('album.zip');
  });

  it('skips a row with no weighted text as "empty"', async () => {
    const h = makeVectorStageHarness(/FROM ci\.files/i, [
      { id: 'file-1', title: null, description: null, filename: null, contentType: null },
    ]);
    const stage = new FileVectorStage(h.dataSource as never, h.logger as never);

    const results = await stage.run({ userId: USER }, ['file-1']);

    expect(results.get('file-1')).toEqual({ outcome: 'skipped', reason: 'empty' });
  });
});

describe('BrowserActivityVectorStage (loadTexts: ci.browser_activity -> browserActivityWeightedTexts)', () => {
  it('writes the title + url + description as weighted text under entity_type "browser-activity"', async () => {
    const h = makeVectorStageHarness(/FROM ci\.browser_activity/i, [
      {
        id: 'browse-1',
        title: 'Pasta Recipe - AllRecipes',
        url: 'https://allrecipes.com/pasta',
        properties: { description: 'A simple weeknight pasta recipe' },
      },
    ]);
    const stage = new BrowserActivityVectorStage(h.dataSource as never, h.logger as never);

    const results = await stage.run({ userId: USER }, ['browse-1']);

    expect(results.get('browse-1')).toEqual({ outcome: 'done' });

    const [, entityType, entityId, ...rest] = h.insert()!.params as unknown[];
    expect(entityType).toBe('browser-activity');
    expect(entityId).toBe('browse-1');
    expect(insertedText(rest)).toContain('Pasta Recipe - AllRecipes');
    expect(insertedText(rest)).toContain('allrecipes.com/pasta');
  });

  it('skips a row with no weighted text as "empty"', async () => {
    const h = makeVectorStageHarness(/FROM ci\.browser_activity/i, [
      { id: 'browse-1', title: null, url: null, properties: null },
    ]);
    const stage = new BrowserActivityVectorStage(h.dataSource as never, h.logger as never);

    const results = await stage.run({ userId: USER }, ['browse-1']);

    expect(results.get('browse-1')).toEqual({ outcome: 'skipped', reason: 'empty' });
  });
});
