import { BadRequestException, ConflictException } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';

import { PlaceEntity } from '../entities/PlaceEntity';

import { PlaceService } from './PlaceService';

const USER = '00000000-0000-0000-0000-0000000000aa';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

function makeInsertBuilder(record: { values?: unknown[]; inserted: boolean }) {
  const qb: Record<string, unknown> = {};
  qb.insert = jest.fn(() => qb);
  qb.into = jest.fn(() => qb);
  qb.values = jest.fn((v: unknown[]) => {
    record.values = v;

    return qb;
  });
  qb.execute = jest.fn(async () => {
    record.inserted = true;

    return { raw: [] };
  });

  return qb;
}

function makeService() {
  const insertRecord = { inserted: false } as { values?: unknown[]; inserted: boolean };
  const created: PlaceEntity[] = [];

  const create = jest.fn((partial: Partial<PlaceEntity>) => {
    const entity = Object.assign(new PlaceEntity(), {
      entityType: 'Location',
      properties: {},
      ...partial,
    });

    created.push(entity);

    return entity;
  });

  const save = jest.fn(async (entity: PlaceEntity) => entity);

  // Hydration read returns whatever ids we "inserted".
  const find = jest.fn(async () => created);

  const repository = {
    create,
    save,
    find,
    // 7 scalar columns + the owner_user_id relation-join column = 8, matching
    // repository.metadata.columns.length; drives computeChunkSize in createMany.
    metadata: { target: PlaceEntity, columns: { length: 8 } },
    createQueryBuilder: jest.fn(() => makeInsertBuilder(insertRecord)),
  };

  const send = jest.fn<Promise<string[]>, [string, Record<string, unknown>]>(async () => []);

  const service = new PlaceService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
    {
      entityCreated: jest.fn(async () => undefined),
      entityUpdated: jest.fn(async () => undefined),
      entityDeleted: jest.fn(async () => undefined),
      recordMany: jest.fn(async () => undefined),
    } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  );

  return { service, send, insert: insertRecord, save };
}

describe('PlaceService bulk createMany', () => {
  it('inserts set-based (one INSERT, no per-row save) and does NOT emit a per-row PlaceCreatedEvent', async () => {
    const { service, send, insert, save } = makeService();

    const result = await service.createMany(CONTEXT, [
      { id: 'pl1', name: 'Home' },
      { id: 'pl2', name: 'Office' },
    ]);

    expect(insert.inserted).toBe(true);
    expect(insert.values).toHaveLength(2);
    // The per-row save() loop is NOT used on the bulk path.
    expect(save).not.toHaveBeenCalled();
    expect(result.map((p) => p.id)).toEqual(['pl1', 'pl2']);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns an empty array (and issues no INSERT) for empty input', async () => {
    const { service, send, insert } = makeService();

    const result = await service.createMany(CONTEXT, []);

    expect(result).toEqual([]);
    expect(insert.inserted).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('PlaceService single create still emits', () => {
  it('emits one PlaceCreatedEvent per row on the interactive create path', async () => {
    const { service, send } = makeService();

    await service.create(CONTEXT, { id: 'pl1', name: 'Home' });

    expect(send).toHaveBeenCalledTimes(1);
    const [, payload] = send.mock.calls[0];
    expect(payload).toEqual({ placeId: 'pl1' });
  });

  it('suppresses the event when emitCreated: false is passed', async () => {
    const { service, send } = makeService();

    await service.create(CONTEXT, { id: 'pl1', name: 'Home' }, { emitCreated: false });

    expect(send).not.toHaveBeenCalled();
  });
});

describe('PlaceService.create next to another place', () => {
  function makeCreateService(occupant: string | null) {
    const query = jest.fn(async () => (occupant ? [{ name: occupant }] : []));
    const repository = {
      create: jest.fn((partial: Partial<PlaceEntity>) => Object.assign(new PlaceEntity(), partial)),
      save: jest.fn(async () => {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }),
      manager: { query },
    };
    const send = jest.fn(async () => []);
    const service = new PlaceService(repository as never, { send } as never, {} as never);

    return { service, query, send };
  }

  const point = { type: 'Point' as const, coordinates: [-122.4602, 37.8102] };

  it('names the place already saved in the same spot instead of failing with an internal error', async () => {
    const { service, query, send } = makeCreateService('Spot A');

    const attempt = service.create(CONTEXT, { name: 'Spot B', locationPoint: point });

    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow('"Spot A" is already saved at this spot.');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ST_SnapToGrid'), [USER, -122.4602, 37.8102]);
    expect(send).not.toHaveBeenCalled();
  });

  it('still answers with a conflict when the place holding the spot cannot be named', async () => {
    const { service } = makeCreateService(null);

    await expect(service.create(CONTEXT, { name: 'Spot B', locationPoint: point })).rejects.toThrow(
      'Another place is already saved at this spot.',
    );
  });

  it('rethrows a unique violation on a place without a point unchanged', async () => {
    const { service, query } = makeCreateService('Spot A');

    await expect(service.create(CONTEXT, { name: 'Spot B' })).rejects.not.toBeInstanceOf(ConflictException);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('PlaceService.findAll', () => {
  it('leaves out places that were merged into another', async () => {
    const wheres: string[] = [];
    const qb: Record<string, jest.Mock> = {};
    qb.leftJoinAndSelect = jest.fn(() => qb);
    qb.where = jest.fn((sql: string) => {
      wheres.push(sql);

      return qb;
    });
    qb.andWhere = jest.fn((sql: string) => {
      wheres.push(sql);

      return qb;
    });
    qb.orderBy = jest.fn(() => qb);
    qb.addOrderBy = jest.fn(() => qb);
    qb.getMany = jest.fn(async () => []);
    const service = new PlaceService({ createQueryBuilder: () => qb } as never, {} as never, {} as never);

    await service.findAll(CONTEXT);

    expect(wheres).toContain('place.merged_into_entity_id IS NULL');
    expect(wheres).toContain('place.is_active IS DISTINCT FROM FALSE');
  });
});

describe('PlaceService.update', () => {
  const PLACE_ID = '00000000-0000-0000-0000-0000000000bb';

  function place(properties: Record<string, unknown> = {}) {
    return Object.assign(new PlaceEntity(), {
      id: PLACE_ID,
      entityType: 'Location',
      name: 'Cafe',
      properties,
    });
  }

  function makeUpdateService(existing: PlaceEntity) {
    const update = jest.fn(
      async (_criteria: unknown, _patch: { properties: Record<string, unknown>; name?: string }) => ({
        affected: 1,
      }),
    );
    const findOne = jest.fn(async () => existing);
    const send = jest.fn(async () => []);
    const repository = {
      update,
      findOne,
      metadata: { target: PlaceEntity, columns: { length: 8 } },
    };
    const service = new PlaceService(
      repository as never,
      { send } as never,
      {
        entityCreated: jest.fn(async () => undefined),
        entityUpdated: jest.fn(async () => undefined),
        entityDeleted: jest.fn(async () => undefined),
        recordMany: jest.fn(async () => undefined),
      } as never,
    );

    return { service, update };
  }

  it('stores punctuation and symbols in the name as typed', async () => {
    const existing = place({ source: 'reverse_geocode', lat: 37.7, lng: -122.4 });
    const { service, update } = makeUpdateService(existing);

    await service.update(CONTEXT, PLACE_ID, {
      name: "Mom's café & co.",
      properties: existing.properties,
    });

    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "Mom's café & co." }),
    );
  });

  it('drops a non-numeric geocode coordinate so a rename does not abort the index cast', async () => {
    const existing = place({ source: 'reverse_geocode', lat: '37°', lng: 'not-a-number' });
    const { service, update } = makeUpdateService(existing);

    await service.update(CONTEXT, PLACE_ID, {
      name: 'Home',
      properties: {},
    });

    const written = update.mock.calls[0][1];

    expect(written.properties.lat).toBe(37);
    expect(written.properties.lng).toBeUndefined();
  });

  it('turns a duplicate-name unique violation into a conflict instead of an internal error', async () => {
    const existing = place({ source: 'reverse_geocode', lat: 37.7, lng: -122.4 });
    const { service, update } = makeUpdateService(existing);

    update.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

    await expect(
      service.update(CONTEXT, PLACE_ID, { name: 'Home', properties: existing.properties }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses an empty name', async () => {
    const { service, update } = makeUpdateService(place());

    await expect(service.update(CONTEXT, PLACE_ID, { name: '   ', properties: {} })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(update).not.toHaveBeenCalled();
  });
});

describe('PlaceService Change History', () => {
  it('records a place added by hand', async () => {
    const { service } = makeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deltas = (service as any).graphDeltaWriter;

    await service.create(CONTEXT, { id: 'pl1', name: 'Corner Cafe' });

    expect(deltas.entityCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'pl1',
        entityType: 'Location',
        name: 'Corner Cafe',
        changeSource: 'PlaceService.create',
      }),
    );
  });

  it('records only what a place edit changed', async () => {
    const existing = Object.assign(new PlaceEntity(), {
      id: 'pl1',
      entityType: 'Location',
      name: 'Cafe',
      description: null,
      placeKind: null,
      parentPlaceId: null,
      locationPoint: { type: 'Point', coordinates: [-122.41, 37.8] },
      properties: { type: 'venue' },
    });
    const entityUpdated = jest.fn(async () => undefined);
    const repository = {
      update: jest.fn(async () => ({ affected: 1 })),
      findOne: jest.fn(async () => existing),
      metadata: { target: PlaceEntity, columns: { length: 8 } },
    };
    const service = new PlaceService(
      repository as never,
      { send: jest.fn(async () => []) } as never,
      {
        entityUpdated,
      } as never,
    );

    await service.update(CONTEXT, 'pl1', {
      name: 'Corner Cafe',
      latitude: 37.8,
      longitude: -122.41,
      properties: { type: 'venue' },
    });

    expect(entityUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'pl1',
        changeSource: 'PlaceService.update',
        changedFields: { name: { old: 'Cafe', new: 'Corner Cafe' } },
      }),
    );
  });
});
