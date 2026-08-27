import { BadRequestException } from '@nestjs/common';

import { DEFAULT_HOUSEHOLD_TIER, HouseholdTierService } from './HouseholdTierService';

const OWNER = { userId: 'owner-1' } as never;

function makeService(rows: Record<string, unknown>[] = []) {
  const repository = {
    findOne: jest.fn(async ({ where }: { where: Record<string, string> }) =>
      rows.find((r) => r.ownerUserId === where.ownerUserId && r.memberUserId === where.memberUserId),
    ),
    find: jest.fn(async ({ where }: { where: Record<string, string> }) =>
      rows.filter((r) => r.ownerUserId === where.ownerUserId),
    ),
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn(async (row: Record<string, unknown>) => ({ ...row, updatedAt: new Date() })),
  };
  const logger = { setContext: jest.fn(), warn: jest.fn(), log: jest.fn(), debug: jest.fn() };

  return { service: new HouseholdTierService(repository as never, logger as never), repository, logger };
}

describe('HouseholdTierService.tierFor', () => {
  /**
   * THE DEFAULT THIS FILE DOES NOT CHANGE.
   *
   * Every box that exists behaves exactly as it did — the mechanism lands
   * without moving the default, because whether `household` is the right one is
   * a product decision (threat model §12, #1) and not an engineering call. See
   * docs/asks-household-default.md.
   */
  it('returns household when the owner has said nothing', async () => {
    const { service } = makeService();

    expect(await service.tierFor('owner-1', 'sam')).toBe('household');
    expect(DEFAULT_HOUSEHOLD_TIER).toBe('household');
  });

  it('returns the tier the owner assigned', async () => {
    const { service } = makeService([{ ownerUserId: 'owner-1', memberUserId: 'sam', trustTier: 'trusted' }]);

    expect(await service.tierFor('owner-1', 'sam')).toBe('trusted');
  });

  /**
   * Two people on the same box may rate each other differently, and neither
   * gets to set the other's view. In exactly the households this feature is
   * least safe in, that would be the whole attack.
   */
  it('is scoped to the owner, so one housemate cannot set another’s posture', async () => {
    const { service } = makeService([{ ownerUserId: 'owner-1', memberUserId: 'sam', trustTier: 'stranger' }]);

    // The same pair, read from the OTHER direction, is a different question.
    expect(await service.tierFor('sam', 'owner-1')).toBe('household');
  });

  /**
   * `ceilingOf`'s rule, one table over: present-but-unreadable is not the same
   * as absent, and it fails to the STRICTEST reading rather than the default.
   */
  it('falls back to stranger — not the default — on an unreadable stored tier', async () => {
    const { service, logger } = makeService([
      { ownerUserId: 'owner-1', memberUserId: 'sam', trustTier: 'HOUSEHOLD ' },
    ]);

    expect(await service.tierFor('owner-1', 'sam')).toBe('stranger');
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('HouseholdTierService.setTier', () => {
  it('records a demotion', async () => {
    const { service, repository } = makeService();

    const row = await service.setTier(OWNER, 'sam', 'trusted');

    expect(row.trustTier).toBe('trusted');
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it('accepts household, so a demotion can be undone without deleting the row', async () => {
    const { service } = makeService([{ ownerUserId: 'owner-1', memberUserId: 'sam', trustTier: 'stranger' }]);

    expect((await service.setTier(OWNER, 'sam', 'household')).trustTier).toBe('household');
  });

  it('UPDATES in place rather than writing a second row for the pair', async () => {
    // Unlike a grant, this is a current setting and not an append-only consent
    // record. Two live rows for one pair would make the ceiling depend on which
    // Postgres returned first.
    const { service, repository } = makeService([
      { id: 'existing-1', ownerUserId: 'owner-1', memberUserId: 'sam', trustTier: 'peer' },
    ]);

    await service.setTier(OWNER, 'sam', 'trusted');

    expect((repository.save.mock.calls[0][0] as { id: string }).id).toBe('existing-1');
  });

  it('normalizes casing and padding', async () => {
    const { service } = makeService();

    expect((await service.setTier(OWNER, 'sam', '  TRUSTED ')).trustTier).toBe('trusted');
  });

  /**
   * Rejected at the WRITE boundary rather than coerced. `tierFor` fails closed
   * when it reads something unreadable — but silently storing a tier that later
   * reads as `stranger` hands the owner a setting they did not choose and no
   * explanation of why their housemate stopped getting answers.
   */
  it('rejects an off-vocabulary tier instead of storing it', async () => {
    const { service, repository } = makeService();

    await expect(service.setTier(OWNER, 'sam', 'trustworthy')).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('refuses a self-verdict, which nothing would ever read', async () => {
    const { service } = makeService();

    await expect(service.setTier(OWNER, 'owner-1', 'stranger')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('HouseholdTierService.listForOwner', () => {
  it('returns only rows the owner actively set', async () => {
    // An account with no row is at the default. Inventing a row for every local
    // user would turn "I have not thought about this" into "I decided
    // household", which is a different statement.
    const { service } = makeService([
      { ownerUserId: 'owner-1', memberUserId: 'sam', trustTier: 'trusted' },
      { ownerUserId: 'someone-else', memberUserId: 'sam', trustTier: 'stranger' },
    ]);

    const rows = await service.listForOwner(OWNER);

    expect(rows).toHaveLength(1);
    expect(rows[0].memberUserId).toBe('sam');
  });
});
