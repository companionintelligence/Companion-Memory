import { type UserServiceContext } from '@ci/common/context';

import { ActionEntity } from '../entities/ActionEntity';

import { ActionService } from './ActionService';

const USER = '00000000-0000-0000-0000-0000000000aa';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

function makeSelectBuilder(rows: ActionEntity[], record: { andWheres: Array<[string, unknown?]> }) {
  const qb: Record<string, unknown> = {};
  qb.where = jest.fn(() => qb);
  qb.andWhere = jest.fn((clause: string, params?: unknown) => {
    record.andWheres.push([clause, params]);

    return qb;
  });
  qb.orderBy = jest.fn(() => qb);
  qb.take = jest.fn(() => qb);
  qb.getMany = jest.fn(async () => rows);

  return qb;
}

function makeService(rows: ActionEntity[] = []) {
  const record = { andWheres: [] as Array<[string, unknown?]> };

  const create = jest.fn((partial: Partial<ActionEntity>) => Object.assign(new ActionEntity(), partial));
  const save = jest.fn(async (entity: ActionEntity) => entity);
  const find: jest.Mock<Promise<ActionEntity[]>, [{ where?: Record<string, unknown> }?]> = jest.fn(
    async () => rows,
  );

  const repository = {
    create,
    save,
    find,
    createQueryBuilder: jest.fn(() => makeSelectBuilder(rows, record)),
  };

  const eventService = { send: jest.fn(async () => []) };

  const service = new ActionService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventService as any,
  );

  return { service, repository, eventService, record };
}

describe('ActionService source provenance (CI-Engineering #63)', () => {
  it('defaults source to unspecified on create', async () => {
    const { service, repository } = makeService();

    await service.create(CONTEXT, { title: 't', text: 'x', threadId: 'thread-1' });

    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'unspecified' }));
  });

  it('passes an explicit source through to the row', async () => {
    const { service, repository } = makeService();

    await service.create(CONTEXT, {
      title: 't',
      text: 'x',
      threadId: 'thread-1',
      source: 'onboarding',
    });

    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'onboarding' }));
  });

  it('findAll filters by sources when provided', async () => {
    const { service, repository } = makeService();

    await service.findAll(CONTEXT, { sources: ['divergence-anomaly'] });

    const where = repository.find.mock.calls[0][0]?.where ?? {};
    expect(where.source).toBeDefined();

    await service.findAll(CONTEXT);
    const bareWhere = repository.find.mock.calls[1][0]?.where ?? {};
    expect(bareWhere.source).toBeUndefined();
  });

  it('findForFeed applies the source filter to both unseen and seen queries', async () => {
    const { service, record } = makeService();

    await service.findForFeed(CONTEXT, 5, { sources: ['suggestion-engine', 'divergence-anomaly'] });

    const sourceClauses = record.andWheres.filter(([clause]) => clause.includes('action.source IN'));
    expect(sourceClauses).toHaveLength(2); // unseen query + seen backfill query
    expect(sourceClauses[0][1]).toEqual({ sources: ['suggestion-engine', 'divergence-anomaly'] });
  });

  it('findForFeed adds no source clause when sources are omitted', async () => {
    const { service, record } = makeService();

    await service.findForFeed(CONTEXT, 5);

    expect(record.andWheres.some(([clause]) => clause.includes('action.source IN'))).toBe(false);
  });
});

describe('ActionEntity.toEgressType', () => {
  it('falls back to unspecified for legacy rows without a source', () => {
    const entity = Object.assign(new ActionEntity(), {
      id: '00000000-0000-0000-0000-000000000001',
      metadata: {},
    });

    expect(ActionEntity.toEgressType(entity).source).toBe('unspecified');
  });

  it('carries the stored source through', () => {
    const entity = Object.assign(new ActionEntity(), {
      id: '00000000-0000-0000-0000-000000000002',
      metadata: {},
      source: 'llm-narrative',
    });

    expect(ActionEntity.toEgressType(entity).source).toBe('llm-narrative');
  });
});
