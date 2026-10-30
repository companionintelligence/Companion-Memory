import type { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';

import type { ContentService } from './ContentService';
import { SourceSystemService, sourcedTablesForTypes } from './SourceSystemService';

const types = (legs: ReturnType<typeof sourcedTablesForTypes>) => legs.map((leg) => leg.type);

describe('sourcedTablesForTypes', () => {
  it('offers the default browse kinds when nothing is narrowed', () => {
    expect(types(sourcedTablesForTypes())).toEqual(['event', 'communication', 'content', 'browser-activity']);
  });

  it('follows a What selection exactly, including the opt-in kinds it names', () => {
    expect(types(sourcedTablesForTypes(['content', 'receipt']))).toEqual(['content', 'receipt']);
  });

  it('drops excluded kinds from the default set', () => {
    expect(types(sourcedTablesForTypes(undefined, ['event', 'communication']))).toEqual([
      'content',
      'browser-activity',
    ]);
  });

  it('yields nothing for kinds that record no source', () => {
    // People only: nothing to list, so the picker shows it has no sources.
    expect(sourcedTablesForTypes(['person'])).toEqual([]);
  });
});

describe('SourceSystemService.getDistinctSourceSystems', () => {
  const context = { userId: 'user-1' } as UserServiceContext;

  function build(rows: string[], contentSystems: string[]) {
    const query = jest.fn(async (_sql: string, _params: unknown[]) =>
      rows.map((source_system) => ({ source_system })),
    );
    const getSourceSystems = jest.fn(async () => contentSystems);
    const service = new SourceSystemService(
      { query } as unknown as DataSource,
      { getSourceSystems } as unknown as ContentService,
    );

    return { service, query, getSourceSystems };
  }

  it('lists content by the platform that delivered it, never by its own column', async () => {
    // A document a Dropbox sync fetched is `file` in ci.content; only the
    // ledger, which ContentService reads, knows it came from Dropbox.
    const { service, query, getSourceSystems } = build(['dropbox', 'gmail'], ['dropbox']);

    await expect(service.getDistinctSourceSystems(context)).resolves.toEqual(['dropbox', 'gmail']);

    const [sql, params] = query.mock.calls[0];

    expect(getSourceSystems).toHaveBeenCalledWith(context);
    expect(sql).not.toContain('ci.content');
    expect(sql).toContain('FROM ci.communications');
    expect(sql).toContain('unnest($2::text[])');
    expect(params).toEqual(['user-1', ['dropbox']]);
  });

  it('asks nothing about content when a What selection leaves it out', async () => {
    const { service, query, getSourceSystems } = build(['gmail'], ['dropbox']);

    await service.getDistinctSourceSystems(context, { includeTypes: ['communication'] });

    expect(getSourceSystems).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0]).not.toContain('unnest');
    expect(query.mock.calls[0][1]).toEqual(['user-1']);
  });

  it('answers a content-only list from the ledger alone', async () => {
    // The content library's picker. No column leg, so nothing to union with.
    const { service, query } = build([], ['dropbox', 'file']);

    await expect(service.getDistinctSourceSystems(context, { includeTypes: ['content'] })).resolves.toEqual([
      'dropbox',
      'file',
    ]);
    expect(query).not.toHaveBeenCalled();
  });

  it('runs no query at all for kinds that record no source', async () => {
    const { service, query, getSourceSystems } = build([], []);

    await expect(service.getDistinctSourceSystems(context, { includeTypes: ['person'] })).resolves.toEqual(
      [],
    );
    expect(query).not.toHaveBeenCalled();
    expect(getSourceSystems).not.toHaveBeenCalled();
  });
});
