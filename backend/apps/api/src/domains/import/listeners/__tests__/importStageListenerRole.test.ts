import config from '@ci/configuration';

import { ImportStageListener } from '../ImportStageListener';

/**
 * The bootstrap recovery sweep is the split topology's one actively harmful
 * duplicate: two processes racing resumeInterrupted() over the same runs.
 * Only the process that RUNS stages may recover them.
 */

const stubLogger = {
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
};
const stage = (kind: string) => ({ kind }) as never;

function build() {
  const runs = { resumeInterrupted: jest.fn(async () => undefined) };
  const listener = new ImportStageListener(
    runs as never,
    {} as never,
    stage('unpack'),
    stage('parse'),
    stage('media'),
    stage('push'),
    stubLogger as never,
  );

  return { listener, runs };
}

async function bootUnderRole(role: 'all' | 'web' | 'worker') {
  const previous = config.role;

  (config as { role: string }).role = role;

  try {
    const { listener, runs } = build();

    await listener.onApplicationBootstrap();

    return runs.resumeInterrupted.mock.calls.length;
  } finally {
    (config as { role: string }).role = previous;
  }
}

describe('ImportStageListener bootstrap sweep role gating', () => {
  it('sweeps in worker and all, never in web', async () => {
    expect(await bootUnderRole('worker')).toBe(1);
    expect(await bootUnderRole('all')).toBe(1);
    expect(await bootUnderRole('web')).toBe(0);
  });
});
