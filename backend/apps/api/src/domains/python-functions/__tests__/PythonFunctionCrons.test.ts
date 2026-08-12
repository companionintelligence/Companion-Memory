import type { DataSource } from 'typeorm';

import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';

import { PythonFunctionCrons } from '../cron/PythonFunctionCrons';
import type { PythonFunctionService } from '../services/PythonFunctionService';

const logger = { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;

function makeCrons(userIds: string[], smartRotation = false) {
  const dataSource = {
    query: jest.fn().mockResolvedValue(userIds.map((id) => ({ id }))),
  } as unknown as DataSource;
  const pythonFunctionService = {
    dispatch: jest.fn().mockResolvedValue(true),
  } as unknown as PythonFunctionService;
  const featureService = {
    isFeatureEnabled: jest.fn().mockResolvedValue(smartRotation),
  } as unknown as FeatureService;

  return {
    crons: new PythonFunctionCrons(dataSource, pythonFunctionService, logger, featureService),
    pythonFunctionService,
  };
}

describe('PythonFunctionCrons', () => {
  it('fans hourly summaries out per onboarded user with an hour-window singleton key', async () => {
    const { crons, pythonFunctionService } = makeCrons(['user-1', 'user-2']);

    await crons.hourlySummaries();

    expect(pythonFunctionService.dispatch).toHaveBeenCalledTimes(2);

    const hourKey = new Date().toISOString().slice(0, 13);

    expect(pythonFunctionService.dispatch).toHaveBeenCalledWith(
      'summary',
      'hourly_summary',
      'user-1',
      {},
      { singletonKey: `fn:hourly_summary:user-1:${hourKey}` },
    );
    expect(pythonFunctionService.dispatch).toHaveBeenCalledWith(
      'summary',
      'hourly_summary',
      'user-2',
      {},
      { singletonKey: `fn:hourly_summary:user-2:${hourKey}` },
    );
  });

  it('scopes nightly HBPE singleton keys to the UTC day', async () => {
    const { crons, pythonFunctionService } = makeCrons(['user-1']);

    await crons.hbpeNightly();

    const dayKey = new Date().toISOString().slice(0, 10);

    expect(pythonFunctionService.dispatch).toHaveBeenCalledWith(
      'hbpe',
      'nightly',
      'user-1',
      {},
      { singletonKey: `fn:nightly:user-1:${dayKey}` },
    );
  });

  it('keeps fanning out when one user fails to enqueue', async () => {
    const { crons, pythonFunctionService } = makeCrons(['user-1', 'user-2']);

    (pythonFunctionService.dispatch as jest.Mock)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(true);

    await expect(crons.insights()).resolves.toBeUndefined();
    expect(pythonFunctionService.dispatch).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no users are onboarded', async () => {
    const { crons, pythonFunctionService } = makeCrons([]);

    await crons.dailySummaries();

    expect(pythonFunctionService.dispatch).not.toHaveBeenCalled();
  });

  describe('under smart.rotation', () => {
    it.each([['insights'], ['hourlySummaries'], ['dossierRefresh']] as const)(
      'cedes %s to SmartRotationListener instead of double-enqueuing',
      async (method) => {
        const { crons, pythonFunctionService } = makeCrons(['user-1'], true);

        await crons[method]();

        expect(pythonFunctionService.dispatch).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['dailySummaries'],
      ['weeklySummaries'],
      ['monthlySummaries'],
      ['actions'],
      ['hbpeNightly'],
    ] as const)('still runs %s, which smart rotation has no equivalent for', async (method) => {
      const { crons, pythonFunctionService } = makeCrons(['user-1'], true);

      await crons[method]();

      expect(pythonFunctionService.dispatch).toHaveBeenCalledTimes(1);
    });
  });
});
