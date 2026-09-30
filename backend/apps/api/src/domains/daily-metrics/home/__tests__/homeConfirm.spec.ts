import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { ActionService } from '@ci/domains/intelligence';
import type { KnownPlaceCandidate, KnownPlacesService } from '@ci/domains/memory';

import { CONFIRM_HOME_ACTION_KEY, HOME_QUESTION_ID, isHomeConfirmSourceId } from '../homeConfirm';
import { HomeConfirmService } from '../HomeConfirmService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const CONTEXT: UserServiceContext = { userId: USER };

function candidate(overrides: Partial<KnownPlaceCandidate> = {}): KnownPlaceCandidate {
  return {
    locationId: 'loc-1',
    label: 'Oak St',
    kind: 'home',
    lat: 1,
    lng: 2,
    eventCount: 9,
    sampleEvents: [],
    confidence: 0.7,
    ...overrides,
  };
}

function makeLogger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;
}

function makeService(
  overrides: {
    dataSource?: { query: jest.Mock };
    knownPlaces?: Partial<{
      getKnownPlaces: jest.Mock;
      buildKnownPlaces: jest.Mock;
      updateKnownPlace: jest.Mock;
    }>;
    actionService?: Partial<{ create: jest.Mock }>;
  } = {},
) {
  const dataSource = overrides.dataSource ?? { query: jest.fn().mockResolvedValue([]) };
  const knownPlaces = {
    getKnownPlaces: jest.fn().mockResolvedValue([]),
    buildKnownPlaces: jest.fn().mockResolvedValue([]),
    updateKnownPlace: jest.fn().mockResolvedValue(undefined),
    ...overrides.knownPlaces,
  };
  const actionService = {
    create: jest.fn().mockResolvedValue(undefined),
    ...overrides.actionService,
  };
  const logger = makeLogger();

  const service = new HomeConfirmService(
    dataSource as never,
    knownPlaces as unknown as KnownPlacesService,
    actionService as unknown as ActionService,
    logger,
  );

  return { service, dataSource, knownPlaces, actionService, logger };
}

describe('isHomeConfirmSourceId', () => {
  it('matches the selector and one-place surprise ids', () => {
    expect(isHomeConfirmSourceId('confirm_home')).toBe(true);
    expect(isHomeConfirmSourceId('one_place')).toBe(true);
    expect(isHomeConfirmSourceId('conversations_low')).toBe(false);
  });
});

describe('HomeConfirmService.candidateOptions / topHomeCandidate', () => {
  const service = new HomeConfirmService(
    {} as never,
    {} as never,
    {} as never,
    { setContext: jest.fn() } as never,
  );

  it('keeps only located candidates as selector options', () => {
    const options = service.candidateOptions([
      {
        locationId: 'loc-1',
        label: 'Oak St',
        kind: 'home',
        lat: 1,
        lng: 2,
        eventCount: 9,
        sampleEvents: [],
        confidence: 0.7,
      },
      {
        locationId: null,
        label: 'Grid cell',
        kind: 'other',
        lat: 3,
        lng: 4,
        eventCount: 2,
        sampleEvents: [],
        confidence: 0.4,
      },
    ]);

    expect(options).toEqual([{ id: 'loc-1', label: 'Oak St' }]);
  });

  it('prefers the night-ranked home candidate', () => {
    const top = service.topHomeCandidate([
      {
        locationId: 'work',
        label: 'Office',
        kind: 'work',
        lat: 0,
        lng: 0,
        eventCount: 20,
        sampleEvents: [],
        confidence: 0.8,
      },
      {
        locationId: 'home',
        label: 'Oak St',
        kind: 'home',
        lat: 1,
        lng: 2,
        eventCount: 9,
        sampleEvents: [],
        confidence: 0.7,
      },
    ]);

    expect(top?.locationId).toBe('home');
  });

  it('returns null, not the busiest candidate, when none is tagged home', () => {
    expect(
      service.topHomeCandidate([
        candidate({ locationId: 'loc-busy', label: 'Taipei TPE', kind: 'other', eventCount: 12 }),
        candidate({ locationId: 'loc-work', label: 'Office', kind: 'work', eventCount: 6 }),
      ]),
    ).toBeNull();
  });
});

describe('HomeConfirmService.confirmFromResponse', () => {
  it.each(['no', 'not_sure', 'other', 'work', 'No', ' WORK '])(
    'treats %j as a decline and does not write anything',
    async (response) => {
      const { service, knownPlaces } = makeService();

      const result = await service.confirmFromResponse(CONTEXT, response, [candidate()]);

      expect(result).toBe(false);
      expect(knownPlaces.updateKnownPlace).not.toHaveBeenCalled();
    },
  );

  it('resolves a UUID response to the matching candidate and floors confidence at 0.8', async () => {
    const { service, knownPlaces } = makeService();
    const oak = candidate({ locationId: '11111111-1111-4111-8111-111111111111', confidence: 0.5 });

    const result = await service.confirmFromResponse(CONTEXT, '11111111-1111-4111-8111-111111111111', [oak]);

    expect(result).toBe(true);
    expect(knownPlaces.updateKnownPlace).toHaveBeenCalledWith(CONTEXT, {
      label: 'Oak St',
      kind: 'home',
      locationId: '11111111-1111-4111-8111-111111111111',
      coordinates: { lat: 1, lng: 2 },
      confidence: 0.8,
      source: 'manual',
    });
  });

  it('keeps a candidate confidence above the 0.8 floor', async () => {
    const { service, knownPlaces } = makeService();
    const oak = candidate({ locationId: '11111111-1111-4111-8111-111111111111', confidence: 0.95 });

    await service.confirmFromResponse(CONTEXT, '11111111-1111-4111-8111-111111111111', [oak]);

    expect(knownPlaces.updateKnownPlace).toHaveBeenCalledWith(
      CONTEXT,
      expect.objectContaining({ confidence: 0.95 }),
    );
  });

  it('builds a synthetic Home candidate when the UUID response matches no known candidate', async () => {
    const { service, knownPlaces } = makeService();

    const result = await service.confirmFromResponse(CONTEXT, '99999999-9999-4999-8999-999999999999', [
      candidate(),
    ]);

    expect(result).toBe(true);
    expect(knownPlaces.updateKnownPlace).toHaveBeenCalledWith(CONTEXT, {
      label: 'Home',
      kind: 'home',
      locationId: '99999999-9999-4999-8999-999999999999',
      coordinates: { lat: NaN, lng: NaN },
      confidence: 0.8,
      source: 'manual',
    });
  });

  it('resolves "yes" to the night-ranked top home candidate, not just the first candidate', async () => {
    const { service, knownPlaces } = makeService();
    const work = candidate({ locationId: 'work', label: 'Office', kind: 'work' });
    const home = candidate({ locationId: 'home', label: 'Oak St', kind: 'home' });

    await service.confirmFromResponse(CONTEXT, 'yes', [work, home]);

    expect(knownPlaces.updateKnownPlace).toHaveBeenCalledWith(
      CONTEXT,
      expect.objectContaining({ locationId: 'home', label: 'Oak St' }),
    );
  });

  it('does not confirm the busiest candidate on "yes" when none is tagged home', async () => {
    const { service, knownPlaces, logger } = makeService();
    const busiest = candidate({ locationId: 'loc-busy', label: 'Taipei TPE', kind: 'other', eventCount: 12 });

    const result = await service.confirmFromResponse(CONTEXT, 'yes', [busiest]);

    expect(result).toBe(false);
    expect(knownPlaces.updateKnownPlace).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Home confirm had no resolvable place', expect.anything());
  });

  it('resolves a free-text response by case-insensitive label match', async () => {
    const { service, knownPlaces } = makeService();
    const oak = candidate({ locationId: 'loc-9', label: 'Oak St' });

    await service.confirmFromResponse(CONTEXT, '  oak st  ', [oak]);

    expect(knownPlaces.updateKnownPlace).toHaveBeenCalledWith(
      CONTEXT,
      expect.objectContaining({ locationId: 'loc-9' }),
    );
  });

  it('returns false and logs a warning when the response matches no candidate label', async () => {
    const { service, knownPlaces, logger } = makeService();

    const result = await service.confirmFromResponse(CONTEXT, 'Some Other Place', [candidate()]);

    expect(result).toBe(false);
    expect(knownPlaces.updateKnownPlace).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Home confirm had no resolvable place',
      expect.objectContaining({ userId: USER }),
    );
  });

  it('falls back to a fresh snapshot when no candidate pool is passed in', async () => {
    const oak = candidate({ locationId: 'loc-9', label: 'Oak St' });
    const { service, knownPlaces } = makeService({
      knownPlaces: {
        getKnownPlaces: jest.fn().mockResolvedValue([]),
        buildKnownPlaces: jest.fn().mockResolvedValue([oak]),
      },
    });

    const result = await service.confirmFromResponse(CONTEXT, 'yes');

    expect(result).toBe(true);
    expect(knownPlaces.buildKnownPlaces).toHaveBeenCalledWith(CONTEXT);
    expect(knownPlaces.updateKnownPlace).toHaveBeenCalledWith(
      CONTEXT,
      expect.objectContaining({ locationId: 'loc-9' }),
    );
  });
});

describe('HomeConfirmService.ensureAction', () => {
  it('does nothing when home is already labeled', async () => {
    // snapshot() fires getKnownPlaces/buildKnownPlaces concurrently via Promise.all, so
    // buildKnownPlaces still runs — it's the downstream actionService.create call that
    // must be skipped once `labeled` comes back true.
    const { service, actionService } = makeService({
      knownPlaces: { getKnownPlaces: jest.fn().mockResolvedValue([{ id: 'home-1' }]) },
    });

    await service.ensureAction(CONTEXT);

    expect(actionService.create).not.toHaveBeenCalled();
  });

  it('does nothing when overnight clustering produced no candidates', async () => {
    const { service, actionService } = makeService({
      knownPlaces: { buildKnownPlaces: jest.fn().mockResolvedValue([]) },
    });

    await service.ensureAction(CONTEXT);

    expect(actionService.create).not.toHaveBeenCalled();
  });

  it('does not enqueue a duplicate when an undismissed confirm_home action already exists', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 'existing-action' }]);
    const { service, actionService } = makeService({
      dataSource: { query },
      knownPlaces: { buildKnownPlaces: jest.fn().mockResolvedValue([candidate()]) },
    });

    await service.ensureAction(CONTEXT);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("metadata->>'key' = $2"), [
      USER,
      CONFIRM_HOME_ACTION_KEY,
    ]);
    expect(actionService.create).not.toHaveBeenCalled();
  });

  it('creates a confirm_home action naming the top candidate when none exists yet', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const home = candidate({ locationId: 'home-loc', label: 'Oak St', kind: 'home' });
    const work = candidate({ locationId: 'work-loc', label: 'Office', kind: 'work' });
    const { service, actionService } = makeService({
      dataSource: { query },
      knownPlaces: { buildKnownPlaces: jest.fn().mockResolvedValue([work, home]) },
    });

    await service.ensureAction(CONTEXT);

    expect(actionService.create).toHaveBeenCalledWith(CONTEXT, {
      title: 'Confirm home',
      text: 'Is Oak St home?',
      priority: 2,
      source: 'suggestion',
      metadata: {
        key: CONFIRM_HOME_ACTION_KEY,
        questionId: HOME_QUESTION_ID,
        candidateIds: ['work-loc', 'home-loc'],
        candidateLabel: 'Oak St',
        locationId: 'home-loc',
      },
    });
  });

  it('asks which named place is home, naming none, when no candidate is tagged home', async () => {
    // KnownPlacesService tags Home only on nights that recur over weeks. Without that tag, the
    // busiest candidate is a guess, so the ask lists the named places instead of "Is <it> home?".
    const query = jest.fn().mockResolvedValue([]);
    const airport = candidate({ locationId: 'loc-airport', label: 'Airport', kind: 'other', eventCount: 12 });
    const gridCell = candidate({ locationId: null, label: 'Unknown place', kind: 'other', eventCount: 8 });
    const office = candidate({ locationId: 'loc-office', label: 'Office', kind: 'work', eventCount: 6 });
    const { service, actionService } = makeService({
      dataSource: { query },
      knownPlaces: { buildKnownPlaces: jest.fn().mockResolvedValue([airport, gridCell, office]) },
    });

    await service.ensureAction(CONTEXT);

    expect(actionService.create).toHaveBeenCalledWith(CONTEXT, {
      title: 'Confirm home',
      text: 'Which of these places is home?',
      priority: 2,
      source: 'suggestion',
      metadata: {
        key: CONFIRM_HOME_ACTION_KEY,
        questionId: HOME_QUESTION_ID,
        candidateIds: ['loc-airport', 'loc-office'],
        candidateLabel: undefined,
        locationId: undefined,
      },
    });
  });

  it('asks nothing when no candidate is tagged home and none is a named place', async () => {
    // Previously this named candidates[0]: "Is Unknown place home?" about an unnamed grid cell.
    const query = jest.fn().mockResolvedValue([]);
    const gridCell = candidate({ locationId: null, label: 'Unknown place', kind: 'other' });
    const { service, actionService } = makeService({
      dataSource: { query },
      knownPlaces: { buildKnownPlaces: jest.fn().mockResolvedValue([gridCell]) },
    });

    await service.ensureAction(CONTEXT);

    expect(actionService.create).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
