import { GraphUtilityService } from '../GraphUtilityService';

/**
 * The provenance precedence and `kind` classification live in SQL, so they are
 * only truly exercised against Postgres — a mocked `query` can assert what is
 * *sent*, not what Postgres makes of it. These tests therefore pin the part a
 * mock can prove and that nothing else guards:
 *
 * the positional parameter contract. `$4` (generic keys, rejected) and `$5`
 * (derived-import keys, classified) are both `string[]`, so swapping them
 * type-checks cleanly while silently inverting both rules — the generic
 * `import:importer` would start naming buckets and CI-Server's own derived
 * routes would be reported as external imports.
 */
describe('GraphUtilityService.getEntityCountsBySource', () => {
  function setup(rows: unknown[] = []) {
    // Declare the call signature on jest.fn itself, so `mock.calls[0]` is a
    // (sql, params) tuple instead of `[]` — the implementation ignores both.
    const query = jest.fn<Promise<unknown[]>, [string, unknown[]]>(async () => rows);
    const entityRepo = { manager: { query } };
    const logger = { setContext: jest.fn() };

    const service = new GraphUtilityService(entityRepo as never, {} as never, logger as never);

    return { service, query };
  }

  /** The parameter array of the single query the method issues. */
  async function paramsOf(ownerId = 'user-1'): Promise<unknown[]> {
    const { service, query } = setup();
    await service.getEntityCountsBySource(ownerId);

    return query.mock.calls[0][1];
  }

  /** The SQL text, whitespace-normalized so assertions ignore formatting. */
  async function sqlOf(): Promise<string> {
    const { service, query } = setup();
    await service.getEntityCountsBySource('user-1');

    return query.mock.calls[0][0].replace(/\s+/g, ' ');
  }

  it('scopes the count to the owner and passes both sentinels', async () => {
    const params = await paramsOf('owner-42');

    expect(params[0]).toBe('owner-42');
    expect(params[1]).toBe('self');
    expect(params[2]).toBe('Unknown');
  });

  it('passes the generic keys at $4 and the derived-import keys at $5', async () => {
    const params = await paramsOf();

    // Generic: content-free linked_table values that must not name a bucket.
    expect(params[3]).toEqual(expect.arrayContaining(['import:importer']));
    // Derived: import:-prefixed routes CI-Server writes itself.
    expect(params[4]).toEqual(expect.arrayContaining(['import:communications:participant']));
    // The swap this test exists to catch.
    expect(params[3]).not.toContain('import:communications:participant');
    expect(params[4]).not.toContain('import:importer');
  });

  it('binds $4 to the linked_table rejection and $5 to the derived branch', async () => {
    const sql = await sqlOf();

    expect(sql).toContain('WHEN linked_table = ANY($4::text[]) THEN NULL');
    expect(sql).toContain("WHEN linked_src = ANY($5::text[]) THEN 'derived'");
  });

  it('lists no bare table name as a derived-import key', async () => {
    const params = await paramsOf();

    // `files`/`users` are covered by the bare-linked_table rule (a first-party
    // record is derived by construction); listing them here would be dead
    // config that later readers would mistake for the whole rule.
    for (const key of params[4] as string[]) {
      expect(key.startsWith('import:')).toBe(true);
    }
  });

  it('resolves self before every other branch', async () => {
    const sql = await sqlOf();

    // is_self short-circuits, so the owner's own node — which carries no
    // provenance at all — never falls through to the Unknown bucket.
    expect(sql).toContain("WHEN properties ->> 'is_self' = 'true' THEN $2");
  });

  it('ranks data_source above Source: contract before convention', async () => {
    const sql = await sqlOf();

    const dataSource = sql.indexOf("properties ->> 'data_source'");
    const source = sql.indexOf("properties ->> 'Source'");

    expect(dataSource).toBeGreaterThan(-1);
    expect(source).toBeGreaterThan(dataSource);
  });

  it('consults the provenance ledger after the properties and before the bare linked_table', async () => {
    // Imported events, content, items and messages carry no data_source or
    // Source property, only a bare linked_table ('events', 'content'), which
    // classifies as derived. The ledger is what says they were imported.
    const sql = await sqlOf();

    expect(sql).toContain('FROM ci.record_sources rs');
    expect(sql).toContain('rs.record_table = e.linked_table AND rs.record_id = e.entity_id');
    expect(sql).toContain('COALESCE(self_src, prop_src, ledger_src, linked_src, shape_src, $3)');
    expect(sql).toContain("WHEN ledger_src IS NOT NULL THEN 'imported'");
    // A File entity reaches the ledger through the content row naming the file.
    expect(sql).toContain("c.external_id_kind = 'file'");
    expect(sql).toContain("e.linked_table = 'files' AND fs.file_id = e.linked_id::text");
  });

  it('spells a ledger source as the import route, so one importer is one row', async () => {
    // People from an import are filed under linked_table 'import:venmo'; the
    // payments' ledger platform is 'venmo'. Same prefix, same bucket.
    const sql = await sqlOf();

    expect(sql).toContain("'import:' || COALESCE(ledger.src, fs.src) AS ledger_src");
  });

  it('returns the driver rows unchanged', async () => {
    // COUNT(*)::int is already a number, so nothing re-parses it; a mapping
    // layer here would be the place a bigint-as-string regression hid.
    const rows = [
      { source: 'linkedin', kind: 'imported', count: 2360 },
      { source: 'self', kind: 'self', count: 1 },
    ];
    const { service } = setup(rows);

    await expect(service.getEntityCountsBySource('user-1')).resolves.toEqual(rows);
  });

  it('issues exactly one statement', async () => {
    const { service, query } = setup();

    await service.getEntityCountsBySource('user-1');

    expect(query).toHaveBeenCalledTimes(1);
  });
});
