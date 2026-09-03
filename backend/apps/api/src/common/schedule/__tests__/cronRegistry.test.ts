import config from '@ci/configuration';

import { CronRegistry } from '../CronRegistry';
import { Cron } from '../decorators/Cron';

/**
 * What the settings API is allowed to believe about the schedules on this
 * appliance.
 *
 * The role gate is deliberately blunt — a cron whose role this process does not
 * serve never reaches Nest's scheduler at all (see `cronRole.test.ts`). That is
 * correct for RUNNING a schedule and wrong for LISTING one: under the Procfile's
 * split the web process runs none of the eleven worker schedules, so a settings
 * page sourced from the scheduler offered a list that quietly ended at "the ones
 * this process happens to run" and counted it as the total.
 *
 * So the property here is the one the role gate cannot provide: a declaration is
 * recorded in EVERY process, whether or not that process will ever fire it.
 */

function declareUnderRole(role: 'all' | 'web' | 'worker', cronRole: 'web' | 'worker', name: string) {
  const previous = config.role;

  (config as { role: string }).role = role;

  try {
    class Probe {
      @Cron('0 30 3 * * *', { name, role: cronRole })
      async tick(): Promise<void> {
        /* declaration is the subject, not execution */
      }
    }

    // Referenced so the class is not elided; the decorator has already run.
    void Probe;

    return CronRegistry.get(name);
  } finally {
    (config as { role: string }).role = previous;
  }
}

beforeEach(() => {
  CronRegistry.clear();
});

describe('CronRegistry', () => {
  it('records a worker schedule even in a process that will never run it', () => {
    const declared = declareUnderRole('web', 'worker', 'Probe.workerOnly');

    // The whole point. Without this the settings API cannot name
    // OrphanCleanupCron, DerivationCron or ImportRetentionCron from the web
    // process, so an operator cannot find them and is not told they exist.
    expect(declared).toMatchObject({
      name: 'Probe.workerOnly',
      cron: '0 30 3 * * *',
      role: 'worker',
      servedHere: false,
    });
  });

  it('marks a schedule this process does run as served here', () => {
    expect(declareUnderRole('web', 'web', 'Probe.webHere')).toMatchObject({
      role: 'web',
      servedHere: true,
    });

    // The single-process topology every default deployment runs: both roles are
    // served, so nothing is elsewhere and the UI note stays silent.
    expect(declareUnderRole('all', 'worker', 'Probe.workerUnderAll')).toMatchObject({
      role: 'worker',
      servedHere: true,
    });
  });

  it('lists the whole build in name order, both roles together', () => {
    declareUnderRole('web', 'worker', 'Probe.zzz');
    declareUnderRole('web', 'web', 'Probe.aaa');

    expect(CronRegistry.all().map((declaration) => declaration.name)).toEqual(['Probe.aaa', 'Probe.zzz']);
  });
});
