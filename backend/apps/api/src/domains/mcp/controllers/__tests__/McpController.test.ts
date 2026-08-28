import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import { CronRunStore } from '@ci/common/schedule';

import type { McpServerService } from '../../services/McpServerService';
import { McpController } from '../McpController';

const SESSION_TTL_MS = 30 * 60 * 1000;

const logger = { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;

interface ProbeSession {
  transport: { close: jest.Mock };
  lastActivity: number;
  userId: string;
  authoritySignature: string;
}

function makeController() {
  const controller = new McpController({} as McpServerService, logger);
  const sessions = (controller as unknown as { sessions: Map<string, ProbeSession> }).sessions;

  const open = (id: string, idleMs: number) => {
    const entry: ProbeSession = {
      transport: { close: jest.fn().mockResolvedValue(undefined) },
      lastActivity: Date.now() - idleMs,
      userId: 'user-1',
      authoritySignature: 'sig',
    };

    sessions.set(id, entry);

    return entry;
  };

  const reap = () =>
    (controller as unknown as { reapStaleSessions: () => Promise<void> }).reapStaleSessions();

  return { sessions, open, reap };
}

/**
 * The reaper is the only thing that bounds the in-memory session map, and its
 * "Last run" cell is how an operator tells a healthy appliance from one whose
 * scheduler died. The durable `ci.cron_runs` stamp comes from the
 * `@ci/common/schedule` wrapper — decorated with the raw `@nestjs/schedule`
 * import it reaps exactly the same sessions while writing nothing, so the
 * dashboard reports it as never run after every restart.
 */
describe('McpController session reaper', () => {
  const stamp = jest.fn().mockResolvedValue([]);

  beforeEach(() => {
    stamp.mockClear();
    CronRunStore.configure({ query: stamp } as unknown as DataSource);
  });

  afterEach(() => {
    CronRunStore.configure(null as unknown as DataSource);
  });

  it('closes idle sessions and keeps active ones', async () => {
    const { sessions, open, reap } = makeController();
    const stale = open('stale', SESSION_TTL_MS + 1000);
    const fresh = open('fresh', 1000);

    await reap();

    expect(sessions.has('stale')).toBe(false);
    expect(stale.transport.close).toHaveBeenCalled();
    expect(sessions.has('fresh')).toBe(true);
    expect(fresh.transport.close).not.toHaveBeenCalled();
  });

  it('records a run under its registry name', async () => {
    const { open, reap } = makeController();

    open('stale', SESSION_TTL_MS + 1000);

    await reap();

    expect(stamp).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO ci.cron_runs'), [
      'McpController.reapStaleSessions',
      expect.any(Date),
    ]);
  });
});
