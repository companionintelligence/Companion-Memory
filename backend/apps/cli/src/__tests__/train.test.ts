import {
  trainCalibrationCommand,
  trainRebuildPlacesCommand,
  trainRunCommand,
} from '../commands/train';
import { CliError } from '../context';

import { harness } from './support/harness';

describe('ci train', () => {
  it('enqueues the HBPE training pipeline and reports status', async () => {
    const ctx = harness({}, { triggerHbpe: async () => 'triggered' });

    await trainRunCommand(ctx);
    expect(ctx.term.text()).toContain('HBPE training pipeline enqueued');
  });

  it('fails with CliError when HBPE is disabled on the appliance', async () => {
    const ctx = harness({}, { triggerHbpe: async () => 'disabled' });

    await expect(trainRunCommand(ctx)).rejects.toBeInstanceOf(CliError);
  });

  it('renders walk-forward calibration metrics and history', async () => {
    const score = {
      scoredAt: '2026-11-12T06:00:00.000Z',
      brier: 0.1425,
      l0Top1Acc: 0.785,
      l1Top3Acc: 0.912,
      ece: 0.038,
      coverage: 0.95,
      driftFlag: false,
      nBuckets: 96,
      modelVersion: 'hmt',
    };
    const ctx = harness(
      {},
      {
        predictionCalibration: async () => ({
          basis: 'walk-forward self-consistency against behavior labels',
          latest: score,
          history: [score],
        }),
      },
    );

    await trainCalibrationCommand(ctx, { limit: '7' });

    expect(ctx.term.text()).toContain('brier=0.1425');
    expect(ctx.term.text()).toContain('ece=0.0380');
    expect(ctx.term.text()).toContain('78.5%');
    expect(ctx.term.text()).toContain('hmt');
  });

  it('rebuilds stay-point clusters and place transitions', async () => {
    const ctx = harness({}, { rebuildPlaces: async () => '14 clusters, 62 transitions' });

    await trainRebuildPlacesCommand(ctx);
    expect(ctx.term.text()).toContain('Rebuilt place transition model: 14 clusters, 62 transitions.');
  });
});
