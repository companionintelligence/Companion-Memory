import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';

import { GraphDeltaWriter } from '../GraphDeltaWriter';

describe('GraphDeltaWriter', () => {
  it('inserts a created entity delta with change_source and name anchor', async () => {
    const query = jest.fn(async () => undefined);
    const writer = new GraphDeltaWriter(
      { query } as unknown as DataSource,
      { setContext: jest.fn(), debug: jest.fn(), error: jest.fn() } as unknown as LoggerService,
    );

    await writer.entityCreated({
      entityId: '00000000-0000-0000-0000-0000000000c1',
      entityType: 'Content',
      name: 'Docs',
      ownerUserId: '00000000-0000-0000-0000-0000000000a1',
      changeSource: 'ContentService.create',
    });

    expect(query).toHaveBeenCalledTimes(1);
    const call = query.mock.calls[0] as unknown as [string, unknown[]];
    const [sql, params] = call;
    expect(sql).toContain('INSERT INTO ci.graph_deltas');
    expect(params).toContain('Content');
    expect(params).toContain('created');
    expect(params).toContain('ContentService.create');
    expect(params.some((p) => typeof p === 'string' && p.includes('"name"'))).toBe(true);
  });
});
