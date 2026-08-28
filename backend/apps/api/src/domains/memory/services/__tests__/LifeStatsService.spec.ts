import { OUTGOING_EVENT_TYPES, SIGNED_EVENT_TYPES, SOCIAL_EVENT_TYPES } from '../lifeStats';
import { LifeStatsService } from '../LifeStatsService';

describe('LifeStatsService SQL contracts', () => {
  function setup(rows: (sql: string) => unknown[] = () => []) {
    const query = jest.fn<Promise<unknown[]>, [string, unknown[]]>(async (sql) => rows(sql));
    const eventRepo = { manager: { query } };
    const logger = { setContext: jest.fn(), warn: jest.fn() };
    const service = new LifeStatsService(eventRepo as never, logger as never);

    return { service, query, logger };
  }

  /**
   * `readSelfIdentity`'s query, told apart by the column only it selects — the
   * conversation query also reads `ci.users`, for the owner's entity_id.
   */
  // The owner-name lookup: three UNION arms over ci.users.name / .email and
  // the is_self Person, each yielding a bare `name`. Matched on the users
  // arm, which no other query in this service issues.
  const isSelfIdentitySql = (sql: string) => sql.includes('SELECT u.name AS name FROM ci.users');

  function conversationRow(pid: string, name: string, n: number) {
    return { pid, name, n: String(n), inbound: String(n), outbound: '0', last_at: null };
  }

  const range = { from: new Date('2026-05-01T00:00:00.000Z'), to: new Date('2026-08-01T00:00:00.000Z') };

  it('scopes spend to the owner, range, outgoing types, and signed transactions', async () => {
    const { service, query } = setup();
    await service.spendByMerchant('user-1', range);

    const [sql, params] = query.mock.calls[0];
    const normalized = sql.replace(/\s+/g, ' ');

    expect(params[0]).toBe('user-1');
    expect(params[1]).toEqual(range.from);
    expect(params[2]).toEqual(range.to);
    expect(params[3]).toEqual([...OUTGOING_EVENT_TYPES]);
    expect(params[4]).toEqual([...SIGNED_EVENT_TYPES]);
    expect(normalized).toContain('e.event_type = ANY($4::text[])');
    expect(normalized).toContain('e.event_type = ANY($5::text[])');
    expect(normalized).toContain('FROM ci.receipts r');
    expect(normalized).toContain("e.metadata->>'Amount'");
    expect(normalized).not.toContain('credit');
  });

  it('drops the event leg of a purchase a counted receipt already claims', async () => {
    const { service, query } = setup();
    await service.spendByMerchant('user-1', range);

    const normalized = query.mock.calls[0][0].replace(/\s+/g, ' ');

    // Both legs read the SAME receipt set, so a receipt outside the window can
    // never suppress an event inside it.
    expect(normalized).toContain('WITH counted_receipts AS (');
    expect(normalized).toContain('FROM counted_receipts cr');
    expect(normalized).not.toMatch(/UNION ALL SELECT COALESCE\(NULLIF\(r\.merchant_name/);

    // Explicit link, then the shared importer natural key.
    expect(normalized).toContain('WHERE cr.event_id = e.event_id');
    expect(normalized).toContain('cr.source_id = e.source_id');
    expect(normalized).toContain("COALESCE(cr.source_system, '') = COALESCE(e.source_system, '')");
    expect(normalized.match(/NOT EXISTS/g)).toHaveLength(2);
  });

  it('excludes the self person from conversation ranks', async () => {
    const { service, query } = setup();
    await service.topConversations('user-1', range);

    const [sql, params] = query.mock.calls[0];
    const normalized = sql.replace(/\s+/g, ' ');

    expect(params[0]).toBe('user-1');
    expect(normalized).toContain('COALESCE(e.is_self, false) = false');
    expect(normalized).toContain('e.merged_into_entity_id IS NULL');
    expect(normalized).toContain("e.entity_type = 'Person'");
  });

  it('ranks counterparties only — the sender of inbound, the recipients of outbound', async () => {
    const { service, query } = setup();
    await service.topConversations('user-1', range);

    const normalized = query.mock.calls[0][0].replace(/\s+/g, ' ');

    // The owner is the sender of every outbound message and a recipient of
    // every inbound one, so taking the other end excludes them structurally.
    expect(normalized).toContain("c.direction = 'inbound' AND c.from_entity_id IS NOT NULL");
    expect(normalized).toContain("c.direction = 'outbound' AND c.to_entity_ids IS NOT NULL");
    expect(normalized).not.toContain("c.direction = 'inbound' AND c.to_entity_ids IS NOT NULL");
    expect(normalized).not.toContain("c.direction = 'outbound' AND c.from_entity_id IS NOT NULL");
  });

  it('excludes every declared owner entity, including merge tombstones', async () => {
    const { service, query } = setup();
    await service.topConversations('user-1', range);

    const normalized = query.mock.calls[0][0].replace(/\s+/g, ' ');

    expect(normalized).toContain("e.is_self IS TRUE OR e.properties ->> 'is_self' = 'true'");
    expect(normalized).toContain('SELECT u.entity_id FROM ci.users u WHERE u.id = $1::uuid');
    // Recursive arm: a Person merged INTO an owner row still carries their messages.
    expect(normalized).toContain('JOIN self_entities s ON e.merged_into_entity_id = s.entity_id');
    expect(normalized).toContain('NOT EXISTS (SELECT 1 FROM self_entities s WHERE s.entity_id = m.pid)');
  });

  it('drops rows whose display name resolves to the owner and still fills the chart', async () => {
    const ranked = [
      conversationRow('self-a', 'Liam Broza', 900),
      conversationRow('self-b', 'liam.broza', 800),
      ...Array.from({ length: 20 }, (_unused, index) =>
        conversationRow(`p${index}`, `Person ${index}`, 700 - index),
      ),
    ];

    const { service, query } = setup((sql) =>
      isSelfIdentitySql(sql)
        ? [{ name: 'Liam Broza' }, { name: 'liam.broza@example.com' }, { name: 'Liam Broza' }]
        : ranked,
    );

    const rows = await service.topConversations('user-1', range);

    // Overfetch so the two owner aliases cost rows nobody sees, not chart rows.
    expect(query.mock.calls[0][1][3]).toBe(24);
    expect(rows.map((row) => row.name)).not.toContain('Liam Broza');
    expect(rows.map((row) => row.name)).not.toContain('liam.broza');
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ personId: 'p0', name: 'Person 0', count: 700 });
  });

  it('keeps everyone when the owner identity cannot be read', async () => {
    const { service, logger } = setup((sql) => {
      if (isSelfIdentitySql(sql)) {
        throw new Error('no ci.users row');
      }

      return [conversationRow('p1', 'Liam Broza', 5)];
    });

    const rows = await service.topConversations('user-1', range);

    // Fail open: the structural counterparty rule is still doing the work, and
    // a failed name lookup must not blank the whole stats page.
    expect(rows).toEqual([
      { personId: 'p1', name: 'Liam Broza', count: 5, inbound: 5, outbound: 0, lastAt: null },
    ]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('restricts time hours to duration-bearing or known timed types', async () => {
    const { service, query } = setup();
    await service.timeBreakdown('user-1', range);

    const eventSql = query.mock.calls[0][0].replace(/\s+/g, ' ');
    expect(eventSql).toContain('e.duration_minutes IS NOT NULL');
    expect(eventSql).toContain('e.event_type = ANY($8::text[])');

    const callSql = query.mock.calls[1][0].replace(/\s+/g, ' ');
    expect(callSql).toContain('c.duration_seconds IS NOT NULL');
  });

  it('buckets social events by like/post/comment and range span', async () => {
    const { service, query } = setup();
    await service.socialOverTime('user-1', range);

    const [sql, params] = query.mock.calls[0];
    expect(params[3]).toBe('week');
    expect(params[4]).toEqual([...SOCIAL_EVENT_TYPES]);
    expect(sql.replace(/\s+/g, ' ')).toContain('e.event_type = ANY($5::text[])');
  });

  it('uses monthly social buckets for an unbounded range', async () => {
    const { service, query } = setup();
    await service.socialOverTime('user-1', { from: null, to: null });

    expect(query.mock.calls[0][1][3]).toBe('month');
  });

  it('casts communication_type to text so COALESCE can mix it with source_system', async () => {
    const { service, query } = setup();
    await service.channels('user-1', range);

    const [sql] = query.mock.calls[0];
    expect(sql.replace(/\s+/g, ' ')).toContain(
      "COALESCE(NULLIF(c.source_system, ''), c.communication_type::text, 'unknown')",
    );
  });
});
