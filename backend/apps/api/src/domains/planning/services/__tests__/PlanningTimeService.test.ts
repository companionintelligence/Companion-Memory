import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { UserEntity } from '@ci/domains/user';

import { PlanningTimeService } from '../PlanningTimeService';

const USER = { userId: 'user-1' } as UserServiceContext;

describe('PlanningTimeService', () => {
  let service: PlanningTimeService;
  let findOne: jest.Mock;
  let warn: jest.Mock;

  async function setup(timezone: string | null | undefined) {
    findOne = jest.fn(async () => (timezone === undefined ? null : { id: USER.userId, timezone }));
    warn = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        PlanningTimeService,
        { provide: getRepositoryToken(UserEntity), useValue: { findOne } },
        { provide: LoggerService, useValue: { setContext: jest.fn(), warn, log: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(PlanningTimeService);
  }

  describe('timezoneFor', () => {
    it('returns the stored zone', async () => {
      await setup('America/Los_Angeles');

      expect(await service.timezoneFor(USER.userId)).toBe('America/Los_Angeles');
    });

    it('falls back to UTC when the user has no zone set', async () => {
      await setup(null);

      expect(await service.timezoneFor(USER.userId)).toBe('UTC');
      expect(warn).not.toHaveBeenCalled();
    });

    it('falls back to UTC when the user row is missing', async () => {
      await setup(undefined);

      expect(await service.timezoneFor(USER.userId)).toBe('UTC');
    });

    it('falls back to UTC and warns on an unrecognised zone', async () => {
      await setup('Mars/Olympus_Mons');

      // Silently planning someone's day in the wrong zone is worse than loud.
      expect(await service.timezoneFor(USER.userId)).toBe('UTC');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Mars/Olympus_Mons'));
    });

    it('tolerates surrounding whitespace', async () => {
      await setup('  Australia/Sydney  ');

      expect(await service.timezoneFor(USER.userId)).toBe('Australia/Sydney');
    });

    it('caches, so a plan run does not re-query per lookup', async () => {
      await setup('America/New_York');

      await service.timezoneFor(USER.userId);
      await service.timezoneFor(USER.userId);
      await service.timezoneFor(USER.userId);

      expect(findOne).toHaveBeenCalledTimes(1);
    });

    /**
     * The cache used to be unbounded, so a zone changed in Settings was ignored
     * by every later placement until both api and worker were restarted. There
     * is no invalidation hook to test in its place: the worker is a separate
     * process that would never receive one, so the entry expires on its own.
     */
    it('re-reads the column once the cached zone has aged out', async () => {
      await setup('America/New_York');
      await service.timezoneFor(USER.userId);

      jest.useFakeTimers();

      try {
        // The user changes their zone; only the TTL makes the change visible.
        findOne.mockResolvedValue({ id: USER.userId, timezone: 'Australia/Sydney' });
        jest.setSystemTime(Date.now() + 61_000);

        expect(await service.timezoneFor(USER.userId)).toBe('Australia/Sydney');
        expect(findOne).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('delegation', () => {
    beforeEach(async () => {
      await setup('America/Los_Angeles');
    });

    it('resolves today in the user zone, not the server zone', async () => {
      // 02:00Z on the 15th is still the 14th in Los Angeles.
      expect(await service.today(USER, new Date('2026-01-15T02:00:00.000Z'))).toBe('2026-01-14');
    });

    it('maps an instant to the user-local date', async () => {
      expect(await service.localDate(USER, new Date('2026-01-15T02:00:00.000Z'))).toBe('2026-01-14');
    });

    it('maps an instant to the user-local wall clock', async () => {
      expect(await service.wallTime(USER, new Date('2026-01-15T17:00:00.000Z'))).toBe('09:00');
    });

    it('maps a user-local wall clock to an instant', async () => {
      expect((await service.toInstant(USER, '2026-01-15', '09:00')).toISOString()).toBe(
        '2026-01-15T17:00:00.000Z',
      );
    });

    it('returns day bounds that respect DST', async () => {
      const { start, end } = await service.dayBounds(USER, '2026-03-08');

      // Spring-forward day: 23 hours long.
      expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
    });
  });
});
