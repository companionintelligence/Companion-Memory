import { PLANNING_PREFS_DEFAULTS } from '../../entities/PlanningPrefsEntity';
import { PlanningPrefsService } from '../PlanningPrefsService';

const CTX = { userId: 'user-1' } as never;

function makeService(stored: Record<string, unknown> | null = null) {
  const prefsRepository = {
    findOne: jest.fn().mockResolvedValue(stored),
    upsert: jest.fn().mockResolvedValue(undefined),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() };

  const service = new PlanningPrefsService(prefsRepository as never, logger as never);

  return { service, prefsRepository };
}

describe('PlanningPrefsService.resolve', () => {
  // The acceptance criterion for adding this table: a user who has never set a
  // preference must behave exactly as they did before it existed.
  it('returns the shipped defaults when the user has no row', async () => {
    const { service } = makeService(null);

    await expect(service.resolve(CTX)).resolves.toEqual({
      workStart: '09:00',
      workEnd: '17:00',
      defaultEstimatedMinutes: 30,
      flexDays: 7,
    });
  });

  it('collapses individually unset columns onto their defaults', async () => {
    const { service } = makeService({
      userId: 'user-1',
      workStart: '07:30:00',
      workEnd: null,
      defaultEstimatedMinutes: null,
      flexDays: 3,
    });

    await expect(service.resolve(CTX)).resolves.toEqual({
      workStart: '07:30',
      workEnd: PLANNING_PREFS_DEFAULTS.workEnd,
      defaultEstimatedMinutes: PLANNING_PREFS_DEFAULTS.defaultEstimatedMinutes,
      flexDays: 3,
    });
  });

  // Postgres hands back `time` as HH:MM:SS while the placer compares HH:MM. If
  // the two shapes ever meet, the mismatch is a silently wrong workday boundary
  // rather than an error, so the trim happens once, here.
  it('normalises a HH:MM:SS time column down to HH:MM', async () => {
    const { service } = makeService({
      userId: 'user-1',
      workStart: '09:15:00',
      workEnd: '18:45:00',
      defaultEstimatedMinutes: 45,
      flexDays: 14,
    });

    const resolved = await service.resolve(CTX);

    expect(resolved.workStart).toBe('09:15');
    expect(resolved.workEnd).toBe('18:45');
  });

  it('falls back to the default for an unparseable stored time', async () => {
    const { service } = makeService({
      userId: 'user-1',
      workStart: 'not-a-time',
      workEnd: '17:00:00',
      defaultEstimatedMinutes: null,
      flexDays: null,
    });

    const resolved = await service.resolve(CTX);

    expect(resolved.workStart).toBe(PLANNING_PREFS_DEFAULTS.workStart);
  });
});

describe('PlanningPrefsService.update', () => {
  // A settings page that saves the workday must not blank the estimate it never
  // showed, so only the keys actually present are written.
  it('writes only the keys present on the DTO', async () => {
    const { service, prefsRepository } = makeService(null);

    await service.update(CTX, { workStart: '08:00' });

    expect(prefsRepository.upsert).toHaveBeenCalledWith(
      { userId: 'user-1', workStart: '08:00' },
      { conflictPaths: ['userId'] },
    );
  });

  it('treats an explicit null as a reset to the default, keeping the row', async () => {
    const { service, prefsRepository } = makeService(null);

    await service.update(CTX, { flexDays: null });

    expect(prefsRepository.upsert).toHaveBeenCalledWith(
      { userId: 'user-1', flexDays: null },
      { conflictPaths: ['userId'] },
    );
  });

  // Upsert rather than read-modify-write: two concurrent saves of different
  // fields must not lose one another.
  it('upserts on the user id rather than reading first', async () => {
    const { service, prefsRepository } = makeService(null);

    await service.update(CTX, { workStart: '08:00', workEnd: '16:00' });

    expect(prefsRepository.upsert).toHaveBeenCalledTimes(1);
    expect(prefsRepository.findOne).toHaveBeenCalledTimes(1); // only the resolve() readback
  });

  it('returns the effective preferences after writing', async () => {
    const { service, prefsRepository } = makeService(null);

    prefsRepository.findOne.mockResolvedValue({
      userId: 'user-1',
      workStart: '08:00:00',
      workEnd: '16:00:00',
      defaultEstimatedMinutes: null,
      flexDays: null,
    });

    await expect(service.update(CTX, { workStart: '08:00', workEnd: '16:00' })).resolves.toEqual({
      workStart: '08:00',
      workEnd: '16:00',
      defaultEstimatedMinutes: PLANNING_PREFS_DEFAULTS.defaultEstimatedMinutes,
      flexDays: PLANNING_PREFS_DEFAULTS.flexDays,
    });
  });
});

describe('PlanningPrefsService.find', () => {
  it('returns null rather than throwing when there is no row', async () => {
    const { service } = makeService(null);

    await expect(service.find(CTX)).resolves.toBeNull();
  });

  it('scopes the read to the calling user', async () => {
    const { service, prefsRepository } = makeService(null);

    await service.find(CTX);

    expect(prefsRepository.findOne).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });
});
