import { DEVICE_INDEXED_ENTITIES, DEVICE_RECORD_VERSION } from '@ci/domains/search-next';

import { DOCUMENT_BODY_MAX_CHARS } from '../../entities/MobileSearchDocumentEntity';
import {
  buildVectorUpsertBatchStatement,
  buildVectorUpsertStatement,
  searchDocumentText,
} from '../VectorService';

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

  it('leaves a vector-only text out of the document', () => {
    expect(
      searchDocumentText([
        { text: 'IMG_2034.JPG', weight: 10 },
        { text: 'IMG 2034 JPG', weight: 10, vectorOnly: true },
        { text: 'os-plan-lighthouse.jpg', weight: 3 },
        { text: 'os-plan-lighthouse jpg os plan lighthouse jpg', weight: 3, vectorOnly: true },
        { text: 'image/jpeg', weight: 1 },
      ]),
    ).toEqual({ title: 'IMG_2034.JPG', body: 'os-plan-lighthouse.jpg image/jpeg' });
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
      /INSERT INTO ci_search\.mobile_search_documents AS doc\s+\(id, entity_type, entity_id, user_id, title, body, occurred_at, related_id, detail, detail_version\)/,
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

    // Batch-shaped: $1 ids, $2 entity ids, $3..$6 the A..D groups, $7 titles,
    // $8 bodies — one entry per row — then type, user, and the device types.
    expect(sql).toContain("setweight(to_tsvector('english', i.text_a), 'A')");
    expect(sql).toContain("setweight(to_tsvector('english', i.text_b), 'B')");
    expect(sql).toContain('SELECT i.id, $9, i.entity_id,');
    expect(sql).toContain('SELECT v.id, v.entity_type, v.entity_id, v.user_id, i.title, i.body,');
    expect(sql).toContain('JOIN input i ON i.entity_id = v.entity_id');
    expect(sql).toContain('WHERE v.entity_type = ANY($11::text[])');
    expect(params).toEqual([
      [row.id],
      [row.entityId],
      ['Lunch?'],
      ['are you free at noon'],
      [''],
      [''],
      ['Lunch?'],
      ['are you free at noon'],
      row.entityType,
      row.userId,
      [...DEVICE_INDEXED_ENTITIES],
    ]);
  });

  it('rewrites the document only when a stored column would change', () => {
    // PowerSync sends every written row to every phone, changed or not.
    const { sql } = buildVectorUpsertStatement([{ text: 'Lunch?', weight: 10 }], row);

    expect(sql).toMatch(
      /WHERE \(doc\.title, doc\.body, doc\.occurred_at, doc\.related_id, doc\.detail, doc\.detail_version\)\s+IS DISTINCT FROM\s+\(EXCLUDED\.title, EXCLUDED\.body, EXCLUDED\.occurred_at, EXCLUDED\.related_id,\s+EXCLUDED\.detail, EXCLUDED\.detail_version\)/,
    );
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
    // still the row arrays, the four groups, titles, bodies, type, user, types.
    expect(params).toHaveLength(11);
    expect(params[2]).toEqual(['Lunch?']);
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

  it('writes a slice as one statement: one entry per row in every array, the scope once', () => {
    const { sql, params } = buildVectorUpsertBatchStatement(
      [
        { id: 'v-1', entityId: 'e-1', texts: [{ text: 'Lunch?', weight: 10 }] },
        {
          id: 'v-2',
          entityId: 'e-2',
          texts: [
            { text: 'Dinner', weight: 10 },
            { text: 'at eight', weight: 5 },
          ],
        },
      ],
      { entityType: 'communication', userId: row.userId },
    );

    expect(sql).toContain(
      'FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])',
    );
    expect(params.slice(0, 8)).toEqual([
      ['v-1', 'v-2'],
      ['e-1', 'e-2'],
      ['Lunch?', 'Dinner'],
      ['', 'at eight'],
      ['', ''],
      ['', ''],
      ['Lunch?', 'Dinner'],
      ['', 'at eight'],
    ]);
    expect(params.slice(8)).toEqual(['communication', row.userId, [...DEVICE_INDEXED_ENTITIES]]);
  });
});
