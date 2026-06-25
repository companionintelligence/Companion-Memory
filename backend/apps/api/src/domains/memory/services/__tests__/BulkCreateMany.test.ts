import type { ServiceContext, UserServiceContext } from '@ci/common/context';

import { ConceptService } from '../ConceptService';
import { PersonService } from '../PersonService';
import { PlaceService } from '../PlaceService';

/**
 * Unit tests for the batch `createMany` added to the memory services (Person,
 * Place, Concept) behind the createPeople / createPlaces / createConcepts
 * mutations. `createMany` delegates to the single `create` (so per-row event
 * emission + dedup are preserved); these tests pin the batch contract — every
 * item is created, results come back in input order — by spying on `create`.
 */
const ctx = { userId: 'user-1' } as UserServiceContext;

// Minimal stand-ins for constructor deps; `create` is spied, so none are touched.
const logger = () => ({ setContext: jest.fn() }) as never;
const signalling = () => ({ send: jest.fn() }) as never;
const repo = () => ({}) as never;

describe('PersonService.createMany', () => {
  it('creates every person and returns them in input order', async () => {
    const service = new PersonService(repo(), logger(), signalling());
    const spy = jest
      .spyOn(service, 'create')
      .mockImplementation(async (_context: ServiceContext, dto) => ({ id: dto.name }) as never);

    const result = await service.createMany(ctx, [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }]);

    expect(result.map((p) => p.id)).toEqual(['alice', 'bob', 'carol']);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.map((call) => call[1])).toEqual([
      { name: 'alice' },
      { name: 'bob' },
      { name: 'carol' },
    ]);
  });

  it('returns an empty array for an empty batch (no create calls)', async () => {
    const service = new PersonService(repo(), logger(), signalling());
    const spy = jest.spyOn(service, 'create');

    await expect(service.createMany(ctx, [])).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ConceptService.createMany', () => {
  it('creates every concept and returns them in input order', async () => {
    const service = new ConceptService(repo(), logger(), signalling());
    const spy = jest
      .spyOn(service, 'create')
      .mockImplementation(async (_context: ServiceContext, dto) => ({ id: dto.name }) as never);

    const result = await service.createMany(ctx, [{ name: 'gravity' }, { name: 'inertia' }]);

    expect(result.map((c) => c.id)).toEqual(['gravity', 'inertia']);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('PlaceService.createMany', () => {
  it('delegates the whole batch to create (array-capable) and preserves order', async () => {
    const service = new PlaceService(repo(), signalling());
    // PlaceService.create already accepts an array; createMany delegates to it in
    // ONE call rather than fanning out per item.
    const spy = jest
      .spyOn(service, 'create')
      .mockImplementation(
        async (_context: ServiceContext, data) =>
          (Array.isArray(data) ? data : [data]).map((d) => ({ id: d.name })) as never,
      );

    const result = await service.createMany(ctx, [{ name: 'home' }, { name: 'office' }]);

    expect(result.map((p) => p.id)).toEqual(['home', 'office']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual([{ name: 'home' }, { name: 'office' }]);
  });
});
