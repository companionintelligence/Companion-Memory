import {
  type EntityIdentifierRow,
  makeInMemoryEntityIdentifiers,
  silentLogger,
} from '../../__tests__/support/inMemoryEntityIdentifiers';

import { EntityIdentifierService } from './EntityIdentifierService';

const OWNER = '00000000-0000-0000-0000-0000000000aa';
const OTHER_OWNER = '00000000-0000-0000-0000-0000000000ab';
const ENTITY = '00000000-0000-0000-0000-0000000000bb';
const OTHER_ENTITY = '00000000-0000-0000-0000-0000000000cc';

const SEED: EntityIdentifierRow[] = [
  { ownerUserId: OWNER, entityId: ENTITY, kind: 'email', valueNormalized: 'dana@example.com' },
  { ownerUserId: OWNER, entityId: ENTITY, kind: 'phone', valueNormalized: '4155550100' },
  { ownerUserId: OWNER, entityId: OTHER_ENTITY, kind: 'email', valueNormalized: 'sam@example.com' },
  { ownerUserId: OWNER, entityId: OTHER_ENTITY, kind: 'phone', valueNormalized: '4155550199' },
  // Somebody else's appliance user: never a conflict for OWNER.
  { ownerUserId: OTHER_OWNER, entityId: OTHER_ENTITY, kind: 'email', valueNormalized: 'lee@example.com' },
];

function makeService(seed: EntityIdentifierRow[] = SEED) {
  const table = makeInMemoryEntityIdentifiers(seed);
  const service = new EntityIdentifierService(table.repository as never, silentLogger as never);

  return { service, table };
}

describe('EntityIdentifierService.findConflicts', () => {
  it('reports the values another entity holds, as they were sent, without writing', async () => {
    const { service, table } = makeService();

    const conflicts = await service.findConflicts(
      OWNER,
      ENTITY,
      ['email', 'phone'],
      [
        { kind: 'email', value: 'SAM@example.com' },
        { kind: 'email', value: 'new@example.com' },
        { kind: 'phone', value: '+1 (415) 555-0199' },
      ],
    );

    expect(conflicts).toEqual([
      { kind: 'email', value: 'SAM@example.com' },
      { kind: 'phone', value: '+1 (415) 555-0199' },
    ]);
    expect(table.writes).toEqual([]);
    expect(table.rows).toEqual(SEED);
  });

  it("does not count this entity's own values, or another user's", async () => {
    const { service } = makeService();

    await expect(
      service.findConflicts(
        OWNER,
        ENTITY,
        ['email', 'phone'],
        [
          { kind: 'email', value: ' Dana@Example.com ' },
          { kind: 'phone', value: '415.555.0100' },
          { kind: 'email', value: 'lee@example.com' },
        ],
      ),
    ).resolves.toEqual([]);
  });

  it('reports each value once, under its first spelling, in the order sent', async () => {
    const { service } = makeService();

    await expect(
      service.findConflicts(
        OWNER,
        ENTITY,
        ['email', 'phone'],
        [
          { kind: 'phone', value: '415-555-0199' },
          { kind: 'email', value: 'Sam@Example.com' },
          { kind: 'phone', value: '(415) 555-0199' },
          { kind: 'email', value: 'sam@example.com' },
        ],
      ),
    ).resolves.toEqual([
      { kind: 'phone', value: '415-555-0199' },
      { kind: 'email', value: 'Sam@Example.com' },
    ]);
  });

  it('skips kinds outside the reconciled set and values that do not normalize, without a query', async () => {
    const { service, table } = makeService();
    const lookup = jest.spyOn(table.repository.manager, 'query');

    await expect(
      service.findConflicts(
        OWNER,
        ENTITY,
        ['email'],
        [
          { kind: 'phone', value: '(415) 555-0199' },
          { kind: 'email', value: '   ' },
        ],
      ),
    ).resolves.toEqual([]);

    expect(lookup).not.toHaveBeenCalled();
  });

  it('reports exactly what replaceForEntity would, for the same table and list', async () => {
    const desired = [
      { kind: 'email' as const, value: 'dana@example.com' },
      { kind: 'email' as const, value: 'Sam@Example.com', label: 'work' },
      { kind: 'email' as const, value: 'sam@example.com' },
      { kind: 'email' as const, value: 'lee@example.com' },
      { kind: 'phone' as const, value: '+1 415 555 0199' },
      { kind: 'phone' as const, value: 'front desk' },
      { kind: 'phone' as const, value: '415 555 0123' },
    ];

    const { service } = makeService();

    const predicted = await service.findConflicts(OWNER, ENTITY, ['email', 'phone'], desired);
    const { conflicts } = await service.replaceForEntity(OWNER, ENTITY, ['email', 'phone'], desired);

    expect(predicted).toEqual(conflicts);
    expect(predicted).toEqual([
      { kind: 'email', value: 'Sam@Example.com' },
      { kind: 'phone', value: '+1 415 555 0199' },
    ]);
  });
});
