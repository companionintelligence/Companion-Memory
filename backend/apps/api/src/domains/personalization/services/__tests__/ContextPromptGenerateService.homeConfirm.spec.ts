import type { LoggerService } from '@ci/common/logging';
import { HomeConfirmService } from '@ci/domains/daily-metrics';
import type { KnownPlaceCandidate, KnownPlacesService } from '@ci/domains/memory';

import { ContextPromptGenerateService } from '../ContextPromptGenerateService';

/**
 * The home-confirmation prompt: `collectHomeGaps` decides whether to ask, and
 * `hydrateSelector` turns the generated prompt into its selector.
 *
 * An answer reaches `HomeConfirmService.confirmFromResponse` as bare text. A
 * picked option is a Location id, which resolves to itself. A "yes" resolves
 * to `topHomeCandidate`, the candidate `KnownPlacesService` tagged home, if
 * there is one. So a yes/no may only ever name that candidate, and without one
 * the prompt must offer a choice, or not be asked.
 */

const USER = '00000000-0000-0000-0000-0000000000aa';

function candidate(overrides: Partial<KnownPlaceCandidate>): KnownPlaceCandidate {
  return {
    locationId: null,
    label: 'Unknown place',
    kind: 'other',
    lat: 1,
    lng: 2,
    eventCount: 3,
    sampleEvents: [],
    confidence: 0.5,
    ...overrides,
  };
}

interface Internals {
  hydrateSelector(
    userId: string,
    parsed: {
      prompt: string;
      selectorType: string;
      options?: Array<{ id: string; label: string }>;
      source: { kind: string; id?: string };
    },
  ): Promise<{ type: string; prompt: string; options?: Array<{ id: string; label: string }> } | null>;
  collectHomeGaps(userId: string): Promise<Array<{ kind: string; id: string; label: string }>>;
}

function makeService(candidates: KnownPlaceCandidate[]): { service: Internals; logger: LoggerService } {
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;
  const knownPlaces = {
    getKnownPlaces: jest.fn().mockResolvedValue([]),
    buildKnownPlaces: jest.fn().mockResolvedValue(candidates),
  } as unknown as KnownPlacesService;
  const homeConfirm = new HomeConfirmService({} as never, knownPlaces, {} as never, logger);

  const service = new ContextPromptGenerateService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    homeConfirm,
    {} as never,
    logger,
  );

  return { service: service as unknown as Internals, logger };
}

const CONFIRM_HOME = {
  prompt: 'Which of these places is home?',
  selectorType: 'home_work_other',
  source: { kind: 'daily_metric', id: 'confirm_home' },
};

const YES_NO = [
  { id: 'yes', label: 'Yes' },
  { id: 'no', label: 'No' },
];

describe('ContextPromptGenerateService — the home confirmation prompt', () => {
  describe('hydrateSelector', () => {
    it('names the home candidate in a yes/no, not the only named place', async () => {
      // Before: "Is Airport home?", while a "yes" confirmed Oak St.
      const { service } = makeService([
        candidate({ locationId: 'loc-airport', label: 'Airport', eventCount: 9 }),
        candidate({ label: 'Oak St', kind: 'home', eventCount: 5 }),
      ]);

      await expect(service.hydrateSelector(USER, CONFIRM_HOME)).resolves.toMatchObject({
        type: 'yes_no',
        prompt: 'Is Oak St home?',
        options: YES_NO,
      });
    });

    it('offers a single named place as a choice when no candidate is tagged home', async () => {
      // Before: a yes/no about it, and a "yes" confirmed whichever candidate was busiest.
      const { service } = makeService([
        candidate({ label: 'Unknown place', eventCount: 9 }),
        candidate({ locationId: 'loc-airport', label: 'Airport', eventCount: 5 }),
      ]);

      await expect(service.hydrateSelector(USER, CONFIRM_HOME)).resolves.toMatchObject({
        type: 'home_work_other',
        options: [{ id: 'loc-airport', label: 'Airport' }],
      });
    });

    it('still offers every named place when there are several', async () => {
      const { service } = makeService([
        candidate({ locationId: 'loc-home', label: 'Oak St', kind: 'home', eventCount: 9 }),
        candidate({ locationId: 'loc-airport', label: 'Airport', eventCount: 5 }),
      ]);

      await expect(service.hydrateSelector(USER, CONFIRM_HOME)).resolves.toMatchObject({
        type: 'home_work_other',
        options: [
          { id: 'loc-home', label: 'Oak St' },
          { id: 'loc-airport', label: 'Airport' },
        ],
      });
    });

    it.each(['confirm_home', 'one_place'])(
      'discards a %s prompt when no candidate is tagged home and none is named',
      async (id) => {
        // Before: "Is Unknown place home?" about an unnamed grid cell.
        const { service } = makeService([candidate({ label: 'Unknown place', eventCount: 9 })]);

        await expect(
          service.hydrateSelector(USER, { ...CONFIRM_HOME, source: { kind: 'daily_metric', id } }),
        ).resolves.toBeNull();
      },
    );
  });

  describe('collectHomeGaps', () => {
    it('asks about the home candidate by name', async () => {
      const { service } = makeService([candidate({ locationId: 'loc-home', label: 'Oak St', kind: 'home' })]);

      await expect(service.collectHomeGaps(USER)).resolves.toEqual([
        { kind: 'daily_metric', id: 'confirm_home', label: 'Is Oak St home? Prefer yes_no.' },
      ]);
    });

    it('asks which place is home when a place is named but none is tagged home', async () => {
      const { service } = makeService([candidate({ locationId: 'loc-airport', label: 'Airport' })]);

      await expect(service.collectHomeGaps(USER)).resolves.toEqual([
        { kind: 'daily_metric', id: 'confirm_home', label: 'Which of these places is home?' },
      ]);
    });

    it('does not ask when there is no home candidate to name and no place to choose', async () => {
      const { service, logger } = makeService([candidate({ label: 'Unknown place' })]);

      await expect(service.collectHomeGaps(USER)).resolves.toEqual([]);
      // Not the catch-all that also returns []: nothing went wrong.
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
