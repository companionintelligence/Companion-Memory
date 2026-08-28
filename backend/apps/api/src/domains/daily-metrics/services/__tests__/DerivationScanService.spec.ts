import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { UserService } from '@ci/domains/user';

import { makeUserService, type UserRow } from '../../__tests__/support/userServiceDouble';
import type { AnomalyEngine } from '../../anomaly/AnomalyEngine';
import type { CorrelationEngine } from '../../correlation/CorrelationEngine';
import type { MetricAnomaly } from '../../entities/MetricAnomalyEntity';
import type { SuggestionEngine } from '../../suggest/SuggestionEngine';
import { DerivationScanService } from '../DerivationScanService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const SIGNED_UP_ONLY = '00000000-0000-0000-0000-0000000000bb';
const CONTEXT: UserServiceContext = { userId: USER };

const ANOMALIES: MetricAnomaly[] = [
  {
    id: 'anom-1',
    userId: USER,
    metric: 'n_places',
    date: '2026-08-17',
    detector: 'robust_z',
    value: 1,
    baseline: 4,
    score: 3.6,
    direction: 'low',
    coverage: 1,
    metadata: {},
    actionId: null,
    computedAt: new Date(),
  },
];

function logger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;
}

function makeService(overrides: {
  correlationScan?: jest.Mock;
  anomalyScan?: jest.Mock;
  suggestionPropose?: jest.Mock;
  users?: UserService;
}) {
  const correlationScan = overrides.correlationScan ?? jest.fn().mockResolvedValue(undefined);
  const anomalyScan = overrides.anomalyScan ?? jest.fn().mockResolvedValue([]);
  const suggestionPropose = overrides.suggestionPropose ?? jest.fn().mockResolvedValue([]);
  const log = logger();

  const service = new DerivationScanService(
    { scan: correlationScan } as unknown as CorrelationEngine,
    { scan: anomalyScan } as unknown as AnomalyEngine,
    { propose: suggestionPropose } as unknown as SuggestionEngine,
    overrides.users ?? ({} as unknown as UserService),
    log,
  );

  return { service, correlationScan, anomalyScan, suggestionPropose, log };
}

describe('DerivationScanService.scanUser cascading failure isolation', () => {
  it('runs all three engines in the happy path, threading anomalies from anomalyEngine into suggestionEngine', async () => {
    const { service, correlationScan, anomalyScan, suggestionPropose } = makeService({
      anomalyScan: jest.fn().mockResolvedValue(ANOMALIES),
    });

    await service.scanUser(CONTEXT, 'America/Los_Angeles');

    expect(correlationScan).toHaveBeenCalledWith(CONTEXT, 'America/Los_Angeles');
    expect(anomalyScan).toHaveBeenCalledWith(CONTEXT, 'America/Los_Angeles');
    expect(suggestionPropose).toHaveBeenCalledWith(CONTEXT, ANOMALIES, 'America/Los_Angeles');
  });

  it('still runs the anomaly and suggestion engines when the correlation scan throws', async () => {
    const { service, anomalyScan, suggestionPropose, log } = makeService({
      correlationScan: jest.fn().mockRejectedValue(new Error('correlation boom')),
      anomalyScan: jest.fn().mockResolvedValue(ANOMALIES),
    });

    await service.scanUser(CONTEXT, 'UTC');

    expect(anomalyScan).toHaveBeenCalledWith(CONTEXT, 'UTC');
    expect(suggestionPropose).toHaveBeenCalledWith(CONTEXT, ANOMALIES, 'UTC');
    expect(log.error).toHaveBeenCalledWith(`Correlation scan failed for user ${USER}`, expect.any(Error));
  });

  it('still runs suggestionEngine.propose with an EMPTY anomalies array when the anomaly scan throws', async () => {
    const { service, suggestionPropose, log } = makeService({
      anomalyScan: jest.fn().mockRejectedValue(new Error('anomaly boom')),
    });

    await service.scanUser(CONTEXT, 'UTC');

    expect(suggestionPropose).toHaveBeenCalledWith(CONTEXT, [], 'UTC');
    expect(log.error).toHaveBeenCalledWith(`Anomaly scan failed for user ${USER}`, expect.any(Error));
  });

  it('does not throw out of scanUser when the suggestion propose call itself fails', async () => {
    const { service, log } = makeService({
      suggestionPropose: jest.fn().mockRejectedValue(new Error('suggestion boom')),
    });

    await expect(service.scanUser(CONTEXT, 'UTC')).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(`Suggestion propose failed for user ${USER}`, expect.any(Error));
  });

  it('does not throw out of scanUser when ALL three engines fail', async () => {
    const { service, log } = makeService({
      correlationScan: jest.fn().mockRejectedValue(new Error('c')),
      anomalyScan: jest.fn().mockRejectedValue(new Error('a')),
      suggestionPropose: jest.fn().mockRejectedValue(new Error('s')),
    });

    await expect(service.scanUser(CONTEXT, 'UTC')).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(3);
  });
});

const ROWS: UserRow[] = [
  { id: USER, onboarded: true, timezone: 'America/New_York' },
  { id: SIGNED_UP_ONLY, onboarded: false, timezone: 'UTC' },
];

describe('DerivationScanService.scanAll audience', () => {
  it('scans an onboarded user and skips one still in signup', async () => {
    const { service, correlationScan, anomalyScan, suggestionPropose } = makeService({
      users: makeUserService(ROWS),
    });

    await service.scanAll();

    for (const engine of [correlationScan, anomalyScan, suggestionPropose]) {
      expect(engine.mock.calls.map((call) => (call[0] as UserServiceContext).userId)).toEqual([USER]);
    }
  });

  it('scans each onboarded user in their own profile timezone', async () => {
    const { service, correlationScan } = makeService({ users: makeUserService(ROWS) });

    await service.scanAll();

    expect(correlationScan).toHaveBeenCalledWith({ userId: USER }, 'America/New_York');
  });
});
