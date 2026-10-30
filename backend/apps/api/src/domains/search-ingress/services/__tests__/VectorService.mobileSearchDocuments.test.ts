import { DEVICE_INDEXED_ENTITIES, DEVICE_RECORD_VERSION } from '@ci/domains/search-next';

import { DOCUMENT_BODY_MAX_CHARS } from '../../entities/MobileSearchDocumentEntity';
import { buildVectorUpsertStatement, searchDocumentText } from '../VectorService';

describe('searchDocumentText', () => {
  it('takes the first weight-A text as the title and the rest, in order, as the body', () => {
    const { title, body } = searchDocumentText([
      { text: 'Dinner with Ana', weight: 10 },
      { text: 'Tapas place near the harbour', weight: 5 },
      { text: 'meal', weight: 3 },
      { text: 'Harbour Grill', weight: 8 },
    ]);

    expect(title).toBe('Dinner with Ana');
    expect(body).toBe('Tapas place near the harbour meal Harbour Grill');
  });

  it('a row with no weight-A text (a message without a subject) titles itself with its first text', () => {
    const { title, body } = searchDocumentText([{ text: '  Running late, order without me  ', weight: 5 }]);

    expect(title).toBe('Running late, order without me');
    expect(body).toBe('');
  });

  it('drops blank parts and cuts the body at the device limit', () => {
    const { title, body } = searchDocumentText([
      { text: '', weight: 10 },
      { text: 'Quarterly report', weight: 10 },
      { text: 'x'.repeat(DOCUMENT_BODY_MAX_CHARS + 500), weight: 1 },
    ]);

    expect(title).toBe('Quarterly report');
    expect(body).toHaveLength(DOCUMENT_BODY_MAX_CHARS);
  });

  it('nothing to index gives an empty document rather than throwing', () => {
    expect(searchDocumentText([])).toEqual({ title: '', body: '' });
  });
});

describe('buildVectorUpsertStatement', () => {
  const row = {
    id: '0192f1a0-0000-7000-8000-000000000001',
    entityType: 'communication',
    entityId: '0192f1a0-0000-7000-8000-000000000002',
    userId: '0192f1a0-0000-7000-8000-000000000003',
  };

  it('writes the tsvector and, through its RETURNING, the document keyed by the same id', () => {
    const { sql, params } = buildVectorUpsertStatement(
      [
        { text: 'Lunch?', weight: 10 },
        { text: 'are you free at noon', weight: 5 },
      ],
      row,
    );

    expect(sql).toContain('INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)');
    expect(sql).toMatch(
      /INSERT INTO ci_search\.mobile_search_documents\s+\(id, entity_type, entity_id, user_id, title, body, occurred_at, related_id, detail, detail_version\)/,
    );
    expect(sql).toContain('FROM vector_row v');
    // The vectors upsert keeps the existing row's id on conflict and the
    // document references it — one id, not a second generated one.
    expect(sql).toContain('RETURNING id, entity_type, entity_id, user_id, created_at, updated_at');
    expect(sql).toMatch(/ON CONFLICT \(entity_type, entity_id\)\s+DO UPDATE SET title = EXCLUDED.title/);
    // The row's own time, per type.
    expect(sql).toContain(
      "WHEN 'communication' THEN (SELECT c.time FROM ci.communications c WHERE c.id = v.entity_id)",
    );

    // $1..$3 identity, $4 the A group, $5 the B group, then user, title, body, types.
    expect(sql).toContain("setweight(to_tsvector('english', $4), 'A')");
    expect(sql).toContain("setweight(to_tsvector('english', $5), 'B')");
    expect(sql).toContain('$6)'); // user_id closes the VALUES list
    expect(sql).toContain('SELECT v.id, v.entity_type, v.entity_id, v.user_id, $7, $8,');
    expect(sql).toContain('WHERE v.entity_type = ANY($9::text[])');
    expect(params).toEqual([
      row.id,
      row.entityType,
      row.entityId,
      'Lunch?',
      'are you free at noon',
      row.userId,
      'Lunch?',
      'are you free at noon',
      [...DEVICE_INDEXED_ENTITIES],
    ]);
  });

  it('derives the device record from the source row and stamps the current recipe version', () => {
    const { sql, params } = buildVectorUpsertStatement([{ text: 'Lunch?', weight: 10 }], row);

    expect(sql).toContain('LEFT JOIN LATERAL (');
    expect(sql).toContain(') rec ON true');
    expect(sql).toContain(`rec.related_id, rec.detail, ${DEVICE_RECORD_VERSION}`);
    // Every derived column is refreshed on conflict, or a re-index would leave a stale record.
    for (const column of ['related_id', 'detail', 'detail_version']) {
      expect(sql).toContain(`${column} = EXCLUDED.${column}`);
    }

    // Derived in SQL: no new positional parameters for the listeners to supply —
    // still id, type, entity id, the one A group, user, title, body, types.
    expect(params).toHaveLength(8);
    expect(params[3]).toBe('Lunch?');
  });

  it('indexing an event moves its place’s document to that visit, only forward', () => {
    const { sql } = buildVectorUpsertStatement([{ text: 'Dinner', weight: 10 }], {
      ...row,
      entityType: 'event',
    });

    expect(sql).toMatch(
      /place_visit AS \(\s+UPDATE ci_search\.mobile_search_documents d\s+SET occurred_at = e\.start_time/,
    );
    expect(sql).toContain("WHERE v.entity_type = 'event'");
    expect(sql).toContain('AND (d.occurred_at IS NULL OR d.occurred_at < e.start_time)');
  });

  it('a type outside the device list still gets its tsvector; the document half simply matches no row', () => {
    const { params } = buildVectorUpsertStatement([{ text: '37.7749,-122.4194', weight: 10 }], {
      ...row,
      entityType: 'position',
    });

    expect(params.at(-1)).not.toContain('position');
    expect(DEVICE_INDEXED_ENTITIES).not.toContain('position');
  });

  it('browser visits and document excerpts are device-indexed (2026-10-23)', () => {
    expect(DEVICE_INDEXED_ENTITIES).toContain('browser-activity');
    expect(DEVICE_INDEXED_ENTITIES).toContain('file-chunk');

    const { sql } = buildVectorUpsertStatement([{ text: 'Quarterly report', weight: 10 }], row);

    // The device record for each: a visit's url, a chunk's file (its related_id).
    expect(sql).toContain("WHERE v.entity_type = 'browser-activity' AND b.id = v.entity_id");
    expect(sql).toContain("WHERE v.entity_type = 'file-chunk' AND fc.id = v.entity_id");
    expect(sql).toContain('SELECT fc.file_id,');
  });
});
