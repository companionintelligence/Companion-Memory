import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CalibrationStore, type CalibrationRecord } from '../calibrationStore';

const QWEN: CalibrationRecord = {
  numCtx: 32_768,
  sizeVramBytes: 18_496_995_982,
  weightBytes: 17_420_432_739,
  seenAt: '2026-09-14T19:00:00.000Z',
};

describe('CalibrationStore', () => {
  it('round-trips observations through disk, atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'calib-'));
    const path = join(dir, 'nested', 'llm-residency-calibration.json');
    const store = new CalibrationStore([path]);

    expect(store.save(new Map([['qwen3.6:27b', QWEN]]))).toEqual([path]);

    const onDisk = JSON.parse(await readFile(path, 'utf8'));

    expect(onDisk).toEqual({ version: 1, observations: { 'qwen3.6:27b': QWEN } });
    expect(new CalibrationStore([path]).load()).toEqual(new Map([['qwen3.6:27b', QWEN]]));
  });

  it('reads the first path that has a well-formed file and skips the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'calib-'));
    const broken = join(dir, 'broken.json');
    const missing = join(dir, 'missing.json');
    const good = join(dir, 'good.json');
    const warn = jest.fn();

    await writeFile(broken, '{ not json');
    new CalibrationStore([good]).save(new Map([['gemma4:e4b', { ...QWEN, numCtx: 8_192 }]]));

    const loaded = new CalibrationStore([missing, broken, good], { warn }).load();

    expect([...loaded.keys()]).toEqual(['gemma4:e4b']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unreadable'),
      expect.objectContaining({ path: broken }),
    );
  });

  it('drops records with impossible numbers rather than feeding them to the estimator', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'calib-'));
    const path = join(dir, 'calibration.json');

    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        observations: {
          fine: QWEN,
          zeroCtx: { ...QWEN, numCtx: 0 },
          negativeVram: { ...QWEN, sizeVramBytes: -1 },
          missingWeights: { numCtx: 4_096, sizeVramBytes: 1 },
        },
      }),
    );

    expect([...new CalibrationStore([path]).load().keys()]).toEqual(['fine']);
  });

  it('ignores a file from a different schema version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'calib-'));
    const path = join(dir, 'calibration.json');

    await writeFile(path, JSON.stringify({ version: 2, observations: { x: QWEN } }));

    expect(new CalibrationStore([path]).load().size).toBe(0);
  });

  it('keeps going when one path is unwritable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'calib-'));
    const good = join(dir, 'calibration.json');
    const warn = jest.fn();
    // A path under a regular FILE cannot be created.
    const blocker = join(dir, 'blocker');
    const bad = join(blocker, 'child.json');

    await writeFile(blocker, 'not a directory');

    const written = new CalibrationStore([bad, good], { warn }).save(new Map([['m', QWEN]]));

    expect(written).toEqual([good]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not persist'),
      expect.objectContaining({ path: bad }),
    );
  });

  it('builds the path ladder: explicit, then APP_DATA_DIR, then the working directory', () => {
    expect(
      CalibrationStore.defaultPaths(
        { LLM_RESIDENCY_CALIBRATION_PATH: '/etc/ci/calib.json', APP_DATA_DIR: '/app-data' },
        '/srv/api',
      ),
    ).toEqual([
      '/etc/ci/calib.json',
      '/app-data/data/llm-residency-calibration.json',
      '/srv/api/.llm-residency-calibration.json',
    ]);
    expect(CalibrationStore.defaultPaths({}, '/srv/api')).toEqual([
      '/srv/api/.llm-residency-calibration.json',
    ]);
  });

  it('round-trips the optional card-level fields, and drops one without the other', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'calib-'));
    const path = join(dir, 'calibration.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        observations: {
          full: { ...QWEN, cardBytes: 24_000_000_000, totalTokens: 32_768 },
          half: { ...QWEN, cardBytes: 24_000_000_000 },
        },
      }),
    );

    const loaded = new CalibrationStore([path]).load();

    expect(loaded.get('full')).toMatchObject({ cardBytes: 24_000_000_000, totalTokens: 32_768 });
    expect(loaded.get('half')?.cardBytes).toBeUndefined();
    expect(loaded.get('half')?.totalTokens).toBeUndefined();
  });
});
