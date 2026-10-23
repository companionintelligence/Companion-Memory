import { describe, expect, it } from 'vitest';

import {
  ftsIdPhrase,
  localListCountStatement,
  localListStatement,
  localPinsStatement,
  occurredAtBound,
  peopleColumns,
  peopleMatchExpression,
  pinnedListTypes,
  resolveListTypes,
} from './localList';

describe('resolveListTypes', () => {
  it('covers every type the device holds, including the ones the header box has no row for', () => {
    expect(resolveListTypes()).toEqual([
      'communication',
      'concept',
      'content',
      'event',
      'file',
      'item',
      'note',
      'person',
      'place',
      'product',
      'receipt',
      'task',
      'thread',
    ]);
    expect(resolveListTypes(['Receipt', 'event'])).toEqual(['event', 'receipt']);
    expect(resolveListTypes(undefined, ['event', 'communication'])).not.toContain('event');
  });
});

describe('localListStatement', () => {
  it('a query drives the scan through the FTS index, ranked by bm25 with the title over the body', () => {
    const statement = localListStatement(
      { query: 'harbour grill', sort: 'relevance' },
      { limit: 30, offset: 0 },
    );

    expect(statement).not.toBeNull();
    expect(statement!.sql).toContain(
      'JOIN mobile_search_documents d ON d.rowid = mobile_search_documents_fts.rowid',
    );
    expect(statement!.sql).toContain('mobile_search_documents_fts MATCH ?');
    expect(statement!.sql).toContain(
      'ORDER BY bm25(mobile_search_documents_fts, 10.0, 1.0, 0.0, 0.0, 0.0), d.id',
    );
    // The FTS scan drives; the type term must not tempt the planner onto the type index (15 s).
    expect(statement!.sql).toContain('+d.entity_type IN (');
    expect(statement!.sql).toContain('d.related_id, d.detail');
    expect(statement!.sql).toMatch(/LIMIT \? OFFSET \?$/);
    expect(statement!.params[0]).toBe('({title body}: ("harbour"* OR "grill"*))');
    expect(statement!.params.slice(-2)).toEqual([30, 0]);
  });

  it('a browse with no query reads the table alone, newest first with undated rows last', () => {
    const statement = localListStatement({ query: '', sort: 'relevance' }, { limit: 30, offset: 60 });

    expect(statement!.sql).not.toContain('MATCH');
    expect(statement!.sql).toContain('FROM mobile_search_documents d');
    expect(statement!.sql).toContain('ORDER BY d.occurred_at DESC NULLS LAST, d.id');
    // A broad scope in time order walks the time index: the type term must not tempt the planner onto another.
    expect(statement!.sql).toContain('+d.entity_type IN (');
    // A narrow scope has its own (entity_type, occurred_at) range instead.
    expect(
      localListStatement(
        { query: '', sort: 'relevance', includeTypes: ['receipt', 'task'] },
        { limit: 30, offset: 0 },
      )!.sql,
    ).toContain(' d.entity_type IN (');
    expect(statement!.params.slice(-2)).toEqual([30, 60]);
  });

  it('Oldest orders by time ascending', () => {
    expect(localListStatement({ query: 'x', sort: 'oldest' }, { limit: 1, offset: 0 })!.sql).toContain(
      'ORDER BY d.occurred_at ASC NULLS LAST, d.id',
    );
  });

  it('tags mean every label, through the synced join, as the appliance applies them', () => {
    const statement = localListStatement(
      { query: '', sort: 'newest', tags: ['vacation', 'family', 'vacation'] },
      { limit: 30, offset: 0 },
    );

    // The tagged pairs drive the loop into the documents — not a subquery per
    // document (29 s on the phone), and not the documents probing the tagged
    // set (10 s); CROSS JOIN pins that order.
    expect(statement!.sql).toContain('FROM (SELECT et.entity_type, et.entity_id');
    expect(statement!.sql).toContain('FROM entity_tag et');
    expect(statement!.sql).toContain('JOIN tags t ON t.id = et.tag_id');
    expect(statement!.sql).toContain('HAVING count(DISTINCT t.label) = ?) tagged');
    expect(statement!.sql).toContain(
      'CROSS JOIN mobile_search_documents d ON tagged.entity_type = d.entity_type AND tagged.entity_id = d.entity_id',
    );
    expect(statement!.sql.split(') tagged')[1]).not.toContain('count(DISTINCT');
    // The two distinct labels, then how many a record must carry, before the types.
    expect(statement!.params.slice(0, 3)).toEqual(['vacation', 'family', 2]);
  });

  it('with a text query the FTS scan drives and the tags are a per-hit check', () => {
    const statement = localListStatement(
      { query: 'beach', sort: 'relevance', tags: ['vacation'] },
      { limit: 30, offset: 0 },
    );

    expect(statement!.sql).toMatch(/FROM mobile_search_documents_fts\s+JOIN mobile_search_documents d/);
    expect(statement!.sql).toContain('AND (SELECT count(DISTINCT t.label)');
    expect(statement!.sql).toContain('WHERE et.entity_type = d.entity_type');
    expect(statement!.sql).not.toContain('CROSS JOIN');
    expect(statement!.params.slice(0, 3)).toEqual(['({title body}: ("beach"*))', 'vacation', 1]);
  });

  it('a date range bounds occurred_at in the stored text form: from the second, to before the next', () => {
    const statement = localListStatement(
      { query: '', sort: 'newest', from: '2026-01-01T00:00:00.000Z', to: '2026-01-07T23:59:59.999Z' },
      { limit: 30, offset: 0 },
    );

    expect(statement!.sql).toContain('d.occurred_at >= ?');
    expect(statement!.sql).toContain('d.occurred_at < ?');
    expect(statement!.params).toContain('2026-01-01 00:00:00');
    expect(statement!.params).toContain('2026-01-08 00:00:00');
  });

  it('is null when nothing can match: an empty type scope, or a query with no searchable term', () => {
    expect(
      localListStatement(
        { query: 'x', sort: 'relevance', includeTypes: ['answer'] },
        { limit: 1, offset: 0 },
      ),
    ).toBeNull();
    expect(localListStatement({ query: '!!!', sort: 'relevance' }, { limit: 1, offset: 0 })).toBeNull();
  });
});

describe('pinnedListTypes', () => {
  it('pins the scope the way the appliance does: direction to messages, place filters and event kinds to events, file kinds to files, people to both', () => {
    expect(pinnedListTypes({ query: '', sort: 'newest', direction: 'inbound' })).toEqual(['communication']);
    expect(pinnedListTypes({ query: '', sort: 'newest', eventTypes: ['meal'] })).toEqual(['event']);
    expect(pinnedListTypes({ query: '', sort: 'newest', places: ['Harbour'] })).toEqual(['event']);
    expect(pinnedListTypes({ query: '', sort: 'newest', hasLocation: true })).toEqual(['event']);
    expect(pinnedListTypes({ query: '', sort: 'newest', areas: [[-118, 33, -117, 34]] })).toEqual(['event']);
    expect(pinnedListTypes({ query: '', sort: 'newest', fileKinds: ['image'] })).toEqual(['file']);
    expect(pinnedListTypes({ query: '', sort: 'newest', people: ['Ana'] })).toEqual([
      'communication',
      'event',
    ]);
    // Pins intersect with the What picker, and with each other.
    expect(pinnedListTypes({ query: '', sort: 'newest', people: ['Ana'], includeTypes: ['event'] })).toEqual([
      'event',
    ]);
    expect(pinnedListTypes({ query: '', sort: 'newest', people: ['Ana'], direction: 'inbound' })).toEqual([
      'communication',
    ]);
    expect(
      pinnedListTypes({ query: '', sort: 'newest', direction: 'inbound', eventTypes: ['meal'] }),
    ).toEqual([]);
  });
});

describe('structured filters', () => {
  const page = { limit: 30, offset: 0 };

  it('connectors read source_system, any of, and drive: the type term stays off its index', () => {
    const statement = localListStatement(
      { query: '', sort: 'newest', connectors: ['gmail', 'discord'] },
      page,
    )!;

    expect(statement.sql).toContain(' d.source_system IN (?, ?)');
    expect(statement.sql).toContain('+d.entity_type IN (');
    expect(statement.params).toContain('gmail');
  });

  it('a place filter drives through its own indexes, so the type term stays off the type index', () => {
    expect(localListStatement({ query: '', sort: 'newest', places: ['Irvine'] }, page)!.sql).toContain(
      '+d.entity_type IN (',
    );
    // A direction has its own (direction, occurred_at) index too.
    expect(localListStatement({ query: '', sort: 'newest', direction: 'outbound' }, page)!.sql).toContain(
      '+d.entity_type IN (',
    );
    // A bare narrow scope keeps its (entity_type, occurred_at) range.
    expect(localListStatement({ query: '', sort: 'newest', includeTypes: ['receipt'] }, page)!.sql).toContain(
      ' d.entity_type IN (',
    );
  });

  it('behind a text query every field is kept off its index so the FTS scan drives', () => {
    const statement = localListStatement(
      {
        query: 'beatles',
        sort: 'relevance',
        connectors: ['spotify'],
        hasLocation: true,
        eventTypes: ['listen'],
      },
      page,
    )!;

    expect(statement.sql).toContain('+d.source_system IN (?)');
    expect(statement.sql).toContain('+d.lat IS NOT NULL');
    expect(statement.sql).toContain('+d.event_type IS NOT NULL AND +d.event_type IN (?)');
    expect(statement.sql).toContain('+d.entity_type IN (');
  });

  it('direction and event kinds read their detail fields', () => {
    expect(localListStatement({ query: '', sort: 'newest', direction: 'outbound' }, page)!.sql).toContain(
      'd.direction = ?',
    );
    // Qualified for its partial index.
    expect(
      localListStatement({ query: '', sort: 'newest', eventTypes: ['meal', 'travel'] }, page)!.sql,
    ).toContain('d.event_type IS NOT NULL AND d.event_type IN (?, ?)');
  });

  it('file kinds follow the appliance rule: a media prefix, or document for the rest', () => {
    const statement = localListStatement(
      { query: '', sort: 'newest', fileKinds: ['image', 'document'] },
      page,
    )!;

    expect(statement.sql).toContain('d.content_type LIKE ?');
    expect(statement.sql).toContain('d.content_type IS NULL OR');
    expect(statement.params).toEqual(expect.arrayContaining(['image/%', 'video/%', 'audio/%']));
  });

  const ana = '01a08268-d224-75df-8cd0-5b40f116d0f3';
  const bo = '01a08791-e8fa-715f-9151-47a31b73546e';

  it('a direction binds the Who filter to one role: received FROM, sent TO, or any', () => {
    expect(peopleColumns('inbound')).toEqual(['from_id']);
    expect(peopleColumns('outbound')).toEqual(['to_ids']);
    expect(peopleColumns(undefined)).toEqual(['from_id', 'to_ids', 'people']);
  });

  it('a person id is an FTS phrase of its five hex groups, scoped to the role columns', () => {
    expect(ftsIdPhrase(ana)).toBe('"01a08268 d224 75df 8cd0 5b40f116d0f3"');
    expect(peopleMatchExpression({ ids: [ana, bo], columns: ['to_ids', 'people'] })).toBe(
      '{to_ids people}: ("01a08268 d224 75df 8cd0 5b40f116d0f3" OR "01a08791 e8fa 715f 9151 47a31b73546e")',
    );
  });

  it('on the FTS plan (a person in few records) the ids ride in the MATCH, with the text when there is one', () => {
    const plan = { ids: [ana], columns: peopleColumns(undefined), via: 'fts' as const, matches: 1 };
    const browse = localListStatement({ query: '', sort: 'newest', people: ['Ana'] }, page, plan)!;

    expect(browse.sql).toContain('mobile_search_documents_fts MATCH ?');
    expect(browse.params[0]).toBe(`({from_id to_ids people}: (${ftsIdPhrase(ana)}))`);
    expect(browse.sql).not.toContain('instr(');

    const searched = localListStatement({ query: 'lunch', sort: 'relevance', people: ['Ana'] }, page, plan)!;

    expect(searched.params[0]).toBe(
      `({title body}: ("lunch"*)) AND ({from_id to_ids people}: (${ftsIdPhrase(ana)}))`,
    );
  });

  it('on the walk plan (a person in many records) each row is tested with literal ids, in the role columns only', () => {
    const plan = {
      ids: [ana, bo],
      columns: peopleColumns('outbound'),
      via: 'walk' as const,
      matches: 100_000,
    };
    const statement = localListStatement(
      { query: '', sort: 'newest', people: ['Ana'], direction: 'outbound' },
      page,
      plan,
    )!;

    expect(statement.sql).not.toContain('MATCH');
    expect(statement.sql).toContain(
      '(d.to_ids IS NOT NULL AND (instr(d.to_ids, ?) > 0 OR instr(d.to_ids, ?) > 0))',
    );
    expect(statement.sql).not.toContain('d.from_id');
    expect(statement.sql).not.toContain('d.people');
    expect(statement.params.filter((p) => p === ana)).toHaveLength(1);

    const either = localListStatement({ query: '', sort: 'newest', people: ['Ana'] }, page, {
      ...plan,
      columns: peopleColumns(undefined),
    })!;

    expect(either.sql).toContain('d.from_id IN (?, ?)');
    expect(either.sql).toContain('instr(d.people, ?) > 0');
    expect(either.params.filter((p) => p === ana)).toHaveLength(3);
  });

  it('a Who filter that matches nobody matches nothing', () => {
    expect(
      localListStatement({ query: '', sort: 'newest', people: ['Nobody'] }, page, {
        ids: [],
        columns: peopleColumns(undefined),
        via: 'fts',
        matches: 0,
      }),
    ).toBeNull();
  });

  it("places match the phone's place records by id or the event's own location name", () => {
    const statement = localListStatement({ query: '', sort: 'newest', places: ['Harbour'] }, page)!;

    expect(statement.sql).toContain('d.location_id IS NOT NULL AND d.location_id IN (SELECT p.entity_id');
    expect(statement.sql).toContain("p.entity_type = 'place'");
    expect(statement.sql).toContain('d.location_name IS NOT NULL AND (d.location_name LIKE ? ESCAPE');
    expect(statement.params.filter((p) => p === '%Harbour%')).toHaveLength(2);
  });

  it('hasLocation needs coordinates; areas are ORed rectangles over them', () => {
    expect(localListStatement({ query: '', sort: 'newest', hasLocation: true }, page)!.sql).toContain(
      'd.lat IS NOT NULL',
    );

    const statement = localListStatement(
      {
        query: '',
        sort: 'newest',
        areas: [
          [-118, 33, -117, 34],
          [10, 50, 11, 51],
          [1, 2],
        ],
      },
      page,
    )!;

    expect(statement.sql).toContain('d.lat IS NOT NULL');
    expect(statement.sql).toMatch(/\(d\.lng BETWEEN \? AND \? AND d\.lat BETWEEN \? AND \?\) OR \(/);
    // Each usable rectangle as lng range then lat range; the two-number one is dropped.
    expect(statement.params.slice(-10, -2)).toEqual([-118, -117, 33, 34, 10, 11, 50, 51]);
  });
});

describe('occurredAtBound', () => {
  // PowerSync sends the timestamp as Postgres text: a space, not a T, and an
  // optional fraction before the Z. Text order must put every row of the
  // bounded range inside, including the first day and the last second.
  it('brackets the stored text form', () => {
    const lower = occurredAtBound('2024-01-01T00:00:00.000Z', 'lower')!;
    const upper = occurredAtBound('2024-12-31T23:59:59.999Z', 'upper')!;

    expect(lower).toBe('2024-01-01 00:00:00');
    expect(upper).toBe('2025-01-01 00:00:00');
    // Rows as the device holds them.
    for (const row of [
      '2024-01-01 00:00:00Z',
      '2024-01-01 00:00:00.5Z',
      '2024-12-31 23:59:59Z',
      '2024-12-31 23:59:59.999Z',
    ]) {
      expect(row >= lower && row < upper).toBe(true);
    }

    for (const row of ['2023-12-31 23:59:59.999Z', '2025-01-01 00:00:00Z']) {
      expect(row >= lower && row < upper).toBe(false);
    }
  });

  it('is null for text that is not an instant', () => {
    expect(occurredAtBound('last week', 'lower')).toBeNull();
  });
});

describe('localListCountStatement', () => {
  it('counts with the same FROM and WHERE as the page', () => {
    const options = { query: 'harbour', sort: 'relevance' as const, tags: ['vacation'] };
    const page = localListStatement(options, { limit: 30, offset: 0 })!;
    const count = localListCountStatement(options)!;

    expect(count.sql).toMatch(/^SELECT count\(\*\) AS n/);
    expect(count.sql).toContain('mobile_search_documents_fts MATCH ?');
    expect(count.sql).toContain('AND (SELECT count(DISTINCT t.label)');
    expect(count.sql).not.toContain('ORDER BY');
    expect(count.params).toEqual(page.params.slice(0, -2));
  });

  it('a count has no order, so its type term stays indexable even for a broad scope', () => {
    const count = localListCountStatement({ query: '', sort: 'newest', from: '2024-01-01T00:00:00.000Z' })!;

    expect(count.sql).toContain(' d.entity_type IN (');
    expect(count.sql).not.toContain('+d.entity_type');
  });
});

describe('localPinsStatement', () => {
  it('reads the located events for the same filters, newest first, capped', () => {
    const statement = localPinsStatement(
      { query: '', sort: 'relevance', connectors: ['google_photos'] },
      10_000,
    )!;

    expect(statement.sql).toContain(
      'SELECT d.id, d.entity_type, d.entity_id, d.title, d.occurred_at, d.lat, d.lng',
    );
    // The geo index is named outright: offered the time index for the ORDER BY,
    // the planner walked all 589k rows (37 s on the S23U for 2.7k pins).
    expect(statement.sql).toContain(
      'FROM mobile_search_documents d INDEXED BY mobile_search_documents_geo_idx',
    );
    // `hasLocation` is forced: the scope is events and the rows must carry coordinates.
    expect(statement.sql).toContain('d.lat IS NOT NULL');
    expect(statement.sql).toContain('d.entity_type IN (?)');
    expect(statement.params).toContain('event');
    expect(statement.sql).toContain('ORDER BY d.occurred_at DESC NULLS LAST, d.id');
    expect(statement.sql.trim()).toMatch(/LIMIT \?$/);
    expect(statement.params.at(-1)).toBe(10_000);
    expect(statement.sql).not.toContain('OFFSET');
  });

  it('keeps a text query and a map area as the list does', () => {
    const statement = localPinsStatement(
      { query: 'beach', sort: 'relevance', areas: [[-118.5, 33.7, -117.6, 34.3]] },
      500,
    )!;

    expect(statement.sql).toContain('mobile_search_documents_fts MATCH ?');
    // Behind a text query the FTS scan drives; naming the geo index would refuse that plan.
    expect(statement.sql).not.toContain('INDEXED BY');
    expect(statement.sql).toContain('+d.lng BETWEEN ? AND ? AND +d.lat BETWEEN ? AND ?');
    expect(statement.params.slice(-5)).toEqual([-118.5, -117.6, 33.7, 34.3, 500]);
  });
});

describe('the gallery filter (hasPreview)', () => {
  it('pins the scope to photos and videos with a preview, each photo once, through the preview index', () => {
    const statement = localListStatement(
      { query: '', sort: 'newest', hasPreview: true },
      { limit: 30, offset: 0 },
    )!;

    expect(statement.sql).toContain('+d.entity_type IN (?, ?)');
    expect(statement.params.slice(0, 2)).toEqual(['content', 'file']);
    expect(statement.sql).toContain('d.preview_id IS NOT NULL');
    // A photo's file row shares its content row's preview: shown once.
    expect(statement.sql).toContain("NOT (d.entity_type = 'file' AND EXISTS");
    expect(statement.sql).toContain('ORDER BY d.occurred_at DESC NULLS LAST, d.id');
  });

  it('leaves the file rows in when only files are asked for', () => {
    const statement = localListStatement(
      { query: '', sort: 'newest', hasPreview: true, includeTypes: ['file'] },
      { limit: 30, offset: 0 },
    )!;

    expect(statement.sql).not.toContain('NOT (d.entity_type');
    expect(statement.params[0]).toBe('file');
  });
});
