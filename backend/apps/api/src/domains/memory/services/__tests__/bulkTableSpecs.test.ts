import { communicationsBulkSpec, eventsBulkSpec } from '../bulkTableSpecs';
import { encodeCopyRow } from '../copyText';

// Collapse runs of whitespace so SQL assertions ignore formatting.
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('communicationsBulkSpec', () => {
  it('targets ci.communications via a per-request TEMP staging table', () => {
    expect(communicationsBulkSpec.destination).toBe('ci.communications');
    expect(communicationsBulkSpec.stagingTable).toBe('bulk_stage_communications');
  });

  it('binds the owning user as $1, never interpolated', () => {
    expect(communicationsBulkSpec.insertSelectSql).toContain('$1::uuid');
    // no naive string interpolation of a user id
    expect(communicationsBulkSpec.insertSelectSql).not.toMatch(/'\$\{/);
  });

  it('dedupes on the EXACT communications_source_triple_uniq target + predicate', () => {
    // Migration 20260623120100: UNIQUE (user_id, time, source_type, source_system,
    // source_id) WHERE source_id IS NOT NULL — hypertable partition cols included.
    const sql = flat(communicationsBulkSpec.insertSelectSql);
    expect(sql).toContain(
      'ON CONFLICT (user_id, "time", source_type, source_system, source_id) WHERE source_id IS NOT NULL DO NOTHING',
    );
    expect(sql).toContain('RETURNING id');
  });

  it('casts the staging enums to the ci enum types', () => {
    const sql = flat(communicationsBulkSpec.insertSelectSql);
    expect(sql).toContain('s.communication_type::ci.communication_type');
    expect(sql).toContain('s.direction::ci.communication_direction');
  });

  it('encodes a validated record to COPY text in staging-column order', () => {
    const record = communicationsBulkSpec.schema.parse({
      time: '2026-01-02T03:04:05.000Z',
      communication_type: 'email',
      direction: 'inbound',
      content: 'hi there',
      source_type: 'import',
      source_system: 'gmail',
      source_id: 'msg-1',
    });
    const row = encodeCopyRow(record, communicationsBulkSpec.copyColumns);
    const fields = row.split('\t');
    // time, type, direction, content, subject, preview, thread, category, conn, st, ss, sid
    expect(fields).toHaveLength(12);
    expect(fields[0]).toBe('2026-01-02T03:04:05.000Z');
    expect(fields[1]).toBe('email');
    expect(fields[2]).toBe('inbound');
    expect(fields[3]).toBe('hi there');
    expect(fields[4]).toBe('\\N'); // subject absent
    expect(fields[9]).toBe('import');
    expect(fields[10]).toBe('gmail');
    expect(fields[11]).toBe('msg-1');
  });

  it('accepts epoch-millis timestamps and normalises to ISO', () => {
    const epochMs = Date.UTC(2026, 0, 2, 3, 4, 5); // 2026-01-02T03:04:05.000Z
    const record = communicationsBulkSpec.schema.parse({
      time: epochMs,
      communication_type: 'sms',
      direction: 'outbound',
      content: 'x',
    });
    const fields = encodeCopyRow(record, communicationsBulkSpec.copyColumns).split('\t');
    expect(fields[0]).toBe('2026-01-02T03:04:05.000Z');
  });

  it('rejects an unknown communication_type', () => {
    expect(
      communicationsBulkSpec.schema.safeParse({
        time: '2026-01-02T03:04:05.000Z',
        communication_type: 'telepathy',
        direction: 'inbound',
        content: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('eventsBulkSpec', () => {
  it('targets ci.events', () => {
    expect(eventsBulkSpec.destination).toBe('ci.events');
    expect(eventsBulkSpec.stagingTable).toBe('bulk_stage_events');
    expect(eventsBulkSpec.idColumn).toBe('event_id');
  });

  it('dedupes on the EXACT events_source_triple_uniq target + predicate', () => {
    // Migration 20260620213807: UNIQUE (source_type, source_system, source_id)
    // WHERE source_id IS NOT NULL.
    const sql = flat(eventsBulkSpec.insertSelectSql);
    expect(sql).toContain(
      'ON CONFLICT (source_type, source_system, source_id) WHERE source_id IS NOT NULL DO NOTHING',
    );
    expect(sql).toContain('RETURNING event_id');
    expect(sql).toContain('$1::uuid');
  });

  it('defaults confidence_score to 1.0 to match EventEntity', () => {
    expect(flat(eventsBulkSpec.insertSelectSql)).toContain('COALESCE(s.confidence_score, 1.0)');
  });

  it('encodes a validated event with a null end_time', () => {
    const record = eventsBulkSpec.schema.parse({
      title: 'Standup',
      start_time: '2026-01-02T09:00:00.000Z',
      event_type: 'meeting',
      source_type: 'import',
      source_system: 'gcal',
      source_id: 'evt-1',
    });
    const fields = encodeCopyRow(record, eventsBulkSpec.copyColumns).split('\t');
    expect(fields).toHaveLength(11);
    expect(fields[0]).toBe('Standup');
    expect(fields[1]).toBe('2026-01-02T09:00:00.000Z');
    expect(fields[2]).toBe('\\N'); // end_time
    expect(fields[8]).toBe('import');
    expect(fields[10]).toBe('evt-1');
  });
});
