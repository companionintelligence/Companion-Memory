import { buildContentAggregateFold } from '../contentAggregateSql';

describe('buildContentAggregateFold', () => {
  it('emits a Content CTI dual-insert (detail + entities base)', () => {
    const { sql, params } = buildContentAggregateFold([
      {
        userId: '00000000-0000-0000-0000-000000000001',
        title: 'Docs',
        type: 'web-page',
        text: 'summary',
        url: 'https://example.com',
        sourceUrl: 'https://example.com',
        sourceType: 'browser_activity',
        sourceSystem: 'fold',
        sourceId: 'src-1',
        sourceData: { browser_activity_id: 'ba-1' },
      },
    ]);

    expect(sql).toContain('INSERT INTO ci.content');
    expect(sql).toContain('INSERT INTO ci.entities');
    expect(sql).toContain('INSERT INTO ci.graph_deltas');
    expect(sql).toContain("'Content'");
    expect(sql).toContain('linked_table');
    expect(sql).toContain('contentAggregateFold');
    expect(sql).not.toMatch(/INSERT INTO ci\.content\s*\([^)]*\btitle\b/);
    expect(params).toContain('Docs');
    expect(params).toContain('web-page');
  });
});
