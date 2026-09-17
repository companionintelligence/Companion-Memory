import { QueryFailedError } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';

import { RelationshipService } from './RelationshipService';

/**
 * RelationshipService.create wraps three real invariants that
 * relationshipNormalize.spec.ts (the pure normalizer it calls) does not, and
 * that had zero coverage before this file:
 *
 *  - the RelationshipMap allowlist check AFTER normalizeRelationship's
 *    endpoint-swap — a regression here could silently accept a disallowed
 *    (fromType,toType,relationshipType) triple;
 *  - symmetric-type isBidirectional stamping, which overrides whatever the
 *    caller passed;
 *  - the unique-violation race fallback: two concurrent writers racing the
 *    same edge should both get the same row back, not one erroring.
 */

const ownerCtx = { userId: 'owner-1' } as UserServiceContext;

function makeRepo() {
  return {
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn(async (row: Record<string, unknown>) => ({
      ...row,
      createdAt: new Date('2026-08-18T00:00:00Z'),
      updatedAt: new Date('2026-08-18T00:00:00Z'),
    })),
    findOne: jest.fn(),
  };
}

function makeService(repo: ReturnType<typeof makeRepo>) {
  const personService = { findById: jest.fn().mockResolvedValue({ id: 'person-stub' }) };
  const placeService = { findById: jest.fn().mockResolvedValue({ id: 'place-stub' }) };
  const stubFinder = { findById: jest.fn().mockResolvedValue({ id: 'stub' }) };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  const service = new RelationshipService(
    repo as never,
    stubFinder as never, // conceptService
    stubFinder as never, // communicationService
    stubFinder as never, // contentService
    stubFinder as never, // eventService
    stubFinder as never, // itemService
    stubFinder as never, // noteService
    personService as never,
    placeService as never,
    stubFinder as never, // threadService
    logger as never,
  );

  return { service, repo, personService, placeService };
}

describe('RelationshipService.create — allowlist enforcement', () => {
  it('rejects a type not permitted for an otherwise-valid node-type pair', async () => {
    const { service, repo } = makeService(makeRepo());

    // person -> place only allows LIVES_IN/OWNS/VISITED/... — not KNOWS.
    await expect(
      service.create(ownerCtx, {
        fromNodeId: 'p1',
        fromNodeType: 'person',
        toNodeId: 'pl1',
        toNodeType: 'place',
        type: 'KNOWS',
      }),
    ).rejects.toThrow(/Cannot create relationship of type KNOWS from person to place/);

    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rejects a toType that is not reachable from the fromType at all', async () => {
    const { service, repo } = makeService(makeRepo());

    // RelationshipMap.place only has a `place` cell — no `person` cell.
    await expect(
      service.create(ownerCtx, {
        fromNodeId: 'pl1',
        fromNodeType: 'place',
        toNodeId: 'p1',
        toNodeType: 'person',
        type: 'KNOWS',
      }),
    ).rejects.toThrow(/Cannot create relationship from place to person/);

    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rejects IS — identity is not a relationship', async () => {
    const { service, repo } = makeService(makeRepo());

    await expect(
      service.create(ownerCtx, {
        fromNodeId: 'p1',
        fromNodeType: 'person',
        toNodeId: 'p2',
        toNodeType: 'person',
        type: 'IS',
      }),
    ).rejects.toThrow(/IS is not a relationship/);

    expect(repo.save).not.toHaveBeenCalled();
  });

  it('accepts an allowed triple and persists it', async () => {
    const { service, repo } = makeService(makeRepo());

    const result = await service.create(ownerCtx, {
      fromNodeId: 'p1',
      fromNodeType: 'person',
      toNodeId: 'p2',
      toNodeType: 'person',
      type: 'FRIENDS_WITH',
    });

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(result?.type).toBe('FRIENDS_WITH');
  });
});

describe('RelationshipService.create — symmetric stamping and endpoint swap', () => {
  it('forces isBidirectional=true for a symmetric type even when the caller passes false', async () => {
    const { service, repo } = makeService(makeRepo());

    await service.create(ownerCtx, {
      fromNodeId: 'p1',
      fromNodeType: 'person',
      toNodeId: 'p2',
      toNodeType: 'person',
      type: 'KNOWS',
      isBidirectional: false,
    });

    const savedRow = repo.save.mock.calls[0][0] as Record<string, unknown>;
    expect(savedRow.isBidirectional).toBe(true);
  });

  it('respects the caller-supplied isBidirectional for a non-symmetric type', async () => {
    const { service, repo } = makeService(makeRepo());

    await service.create(ownerCtx, {
      fromNodeId: 'p1',
      fromNodeType: 'person',
      toNodeId: 'p2',
      toNodeType: 'person',
      type: 'MENTORED',
      isBidirectional: true,
    });

    const savedRow = repo.save.mock.calls[0][0] as Record<string, unknown>;
    expect(savedRow.isBidirectional).toBe(true);
  });

  it('swaps endpoints for an inverse alias (CHILD_OF -> PARENT_OF) before the allowlist check and the write', async () => {
    const { service, repo, personService } = makeService(makeRepo());

    // Caller describes "child-person CHILD_OF parent-person"; the canonical
    // stored form is "parent-person PARENT_OF child-person".
    await service.create(ownerCtx, {
      fromNodeId: 'child-1',
      fromNodeType: 'person',
      toNodeId: 'parent-1',
      toNodeType: 'person',
      type: 'CHILD_OF',
    });

    const savedRow = repo.save.mock.calls[0][0] as Record<string, unknown>;
    expect(savedRow.type).toBe('PARENT_OF');
    expect(savedRow.fromNodeId).toBe('parent-1');
    expect(savedRow.toNodeId).toBe('child-1');

    // findNodeById is called against the POST-swap endpoints too — the
    // existence check must agree with what actually gets persisted.
    expect(personService.findById).toHaveBeenCalledWith(ownerCtx, 'parent-1');
    expect(personService.findById).toHaveBeenCalledWith(ownerCtx, 'child-1');
  });
});

describe('RelationshipService.create — unique-violation race fallback', () => {
  it('returns the existing row instead of throwing when a concurrent writer already inserted the same edge', async () => {
    const repo = makeRepo();
    const conflictError = new QueryFailedError('INSERT ...', [], { code: '23505' } as never);
    repo.save.mockRejectedValueOnce(conflictError);
    const existingRow = {
      id: 'existing-rel-id',
      fromNodeId: 'p1',
      fromNodeType: 'person',
      toNodeId: 'p2',
      toNodeType: 'person',
      type: 'FRIENDS_WITH',
      userId: 'owner-1',
      isBidirectional: true,
      properties: {},
    };
    repo.findOne.mockResolvedValue(existingRow);
    const { service } = makeService(repo);

    const result = await service.create(ownerCtx, {
      fromNodeId: 'p1',
      fromNodeType: 'person',
      toNodeId: 'p2',
      toNodeType: 'person',
      type: 'FRIENDS_WITH',
    });

    expect(result?.id).toBe('existing-rel-id');
    // The recovery lookup must be scoped to the same owner as the failed write.
    expect(repo.findOne).toHaveBeenCalledWith({
      where: expect.objectContaining({
        fromNodeId: 'p1',
        toNodeId: 'p2',
        type: 'FRIENDS_WITH',
        userId: 'owner-1',
      }),
    });
  });

  it('returns null (does not throw) when the unique-violation fallback lookup also comes up empty', async () => {
    const repo = makeRepo();
    const conflictError = new QueryFailedError('INSERT ...', [], { code: '23505' } as never);
    repo.save.mockRejectedValueOnce(conflictError);
    repo.findOne.mockResolvedValue(null);
    const { service } = makeService(repo);

    await expect(
      service.create(ownerCtx, {
        fromNodeId: 'p1',
        fromNodeType: 'person',
        toNodeId: 'p2',
        toNodeType: 'person',
        type: 'FRIENDS_WITH',
      }),
    ).resolves.toBeNull();
  });

  it('re-throws any other database error unchanged', async () => {
    const repo = makeRepo();
    const otherError = new QueryFailedError('INSERT ...', [], { code: '40001' } as never); // serialization_failure
    repo.save.mockRejectedValueOnce(otherError);
    const { service } = makeService(repo);

    await expect(
      service.create(ownerCtx, {
        fromNodeId: 'p1',
        fromNodeType: 'person',
        toNodeId: 'p2',
        toNodeType: 'person',
        type: 'FRIENDS_WITH',
      }),
    ).rejects.toBe(otherError);
  });
});

// ---------------------------------------------------------------------------
// Absent vs. `undefined` vs. `null`.
//
// RelationshipResolver.updateRelationship builds its DTO as an object literal
// with every field always present (strength, properties, isBidirectional,
// startDate, endDate), so an untouched field arrives here as `key: undefined`
// rather than an absent key — reproduced below rather than passing a sparse
// object, since a sparse `{ strength: 2 }` in a test would not catch a
// regression of this fix. `Object.assign` must not let that clobber the
// entity's current value; an explicit `null` must still clear it (the same
// class of bug fixed in TaskService by #2703, generalized here).
//
// update() re-fetches via findById() after save() rather than returning the
// saved row directly. That re-fetch is what kept this bug from ever reaching
// a caller before withoutUndefined() existed: RelationshipType.isBidirectional
// is non-nullable in the GraphQL schema, so a caller relying on the
// in-memory `record` (clobbered to `undefined` by a naked Object.assign)
// would have thrown instead of silently losing data. These tests pin both
// layers — the fix itself, and that the re-fetch still returns the correct
// (unclobbered) row.
// ---------------------------------------------------------------------------
describe('RelationshipService.update', () => {
  function makeStoredRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rel-1',
      fromNodeId: 'p1',
      fromNodeType: 'person',
      toNodeId: 'p2',
      toNodeType: 'person',
      type: 'FRIENDS_WITH',
      userId: 'owner-1',
      strength: 1,
      isBidirectional: true,
      startDate: null,
      endDate: null,
      properties: {},
      createdAt: new Date('2026-08-18T00:00:00Z'),
      updatedAt: new Date('2026-08-18T00:00:00Z'),
      ...overrides,
    };
  }

  it('leaves an untouched field alone when the caller sends every key, undefined for the ones it did not set', async () => {
    const repo = makeRepo();
    const stored = makeStoredRow({ strength: 5, isBidirectional: true });
    repo.findOne.mockResolvedValue(stored);
    const { service } = makeService(repo);

    const result = await service.update(ownerCtx, 'rel-1', {
      strength: 9,
      properties: undefined,
      isBidirectional: undefined,
      startDate: undefined,
      endDate: undefined,
    });

    expect(result?.strength).toBe(9);
    expect(result?.isBidirectional).toBe(true);
  });

  it('still clears a field when the caller sends an explicit null', async () => {
    const repo = makeRepo();
    const stored = makeStoredRow({ startDate: new Date('2026-01-01') });
    repo.findOne.mockResolvedValue(stored);
    const { service } = makeService(repo);

    const result = await service.update(ownerCtx, 'rel-1', { startDate: null });

    expect(result?.startDate).toBeNull();
  });

  it('returns the freshly re-fetched row, not the in-memory saved one', async () => {
    // Guards the load-bearing findById() re-fetch on the line after save():
    // if that line is ever "simplified" away as apparent dead code, this
    // test starts asserting against the wrong object and fails loudly.
    const repo = makeRepo();
    const stored = makeStoredRow({ strength: 1 });
    const refetched = makeStoredRow({ strength: 1, properties: { fromRefetch: true } });
    repo.findOne.mockResolvedValueOnce(stored).mockResolvedValueOnce(refetched);
    const { service } = makeService(repo);

    const result = await service.update(ownerCtx, 'rel-1', {});

    expect(repo.findOne).toHaveBeenCalledTimes(2);
    expect(result?.properties).toEqual({ fromRefetch: true });
  });
});
