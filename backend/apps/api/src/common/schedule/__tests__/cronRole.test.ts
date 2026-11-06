import { ContextService } from '@ci/common/context';
import { SCHEDULE_CRON_OPTIONS } from '@ci/common/schedule/metadataKeys';
import config from '@ci/configuration';

import { Cron } from '../decorators/Cron';

/**
 * Role-gated cron registration. The mechanism is deliberately blunt: when a
 * process does not serve a cron's role, the wrapper never hands the method to
 * Nest's scheduler — same class, same code, silent in the other process. What
 * must hold: a worker cron registers under `worker` and `all` but NOT under
 * `web`, and an unmarked cron defaults to web.
 */

function defineUnderRole(role: 'all' | 'web' | 'worker', cronRole?: 'web' | 'worker') {
  const previous = config.role;

  (config as { role: string }).role = role;

  try {
    class Probe {
      @Cron('0 0 * * * *', cronRole == null ? undefined : { role: cronRole })
      async tick(): Promise<void> {
        /* registration is the subject, not execution */
      }
    }

    return Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, Probe.prototype.tick) != null;
  } finally {
    (config as { role: string }).role = previous;
  }
}

describe('Cron role gating', () => {
  it('a worker cron registers under worker and all, never under web', () => {
    expect(defineUnderRole('worker', 'worker')).toBe(true);
    expect(defineUnderRole('all', 'worker')).toBe(true);
    expect(defineUnderRole('web', 'worker')).toBe(false);
  });

  it('an unmarked cron defaults to web: registers under web and all, never under worker', () => {
    expect(defineUnderRole('web')).toBe(true);
    expect(defineUnderRole('all')).toBe(true);
    expect(defineUnderRole('worker')).toBe(false);
  });
});

/**
 * Nest already catches a rejecting tick one frame further out
 * (`SchedulerRegistry.wrapFunctionInTryCatchBlocks`), but it logs the error with
 * no schedule name and no traceId. Catching here — where the class, method and
 * traceId are in scope — is what makes a cron failure diagnosable. The observable
 * contract is that the decorated method resolves rather than rejects, so the
 * failure is attributed here rather than anonymously upstream.
 */
describe('Cron failure reporting', () => {
  it('resolves instead of rejecting so the failure is attributed here', async () => {
    class Probe {
      @Cron('0 0 * * * *')
      async tick(): Promise<void> {
        throw new Error('transient database failure');
      }
    }

    await expect(new Probe().tick()).resolves.toBeUndefined();
  });

  it('still returns the body’s value when it succeeds', async () => {
    class Probe {
      @Cron('0 0 * * * *')
      async tick(): Promise<string> {
        return 'swept';
      }
    }

    await expect(new Probe().tick()).resolves.toBe('swept');
  });

  it('runs the body inside a trace context', async () => {
    let seen: string | null = null;

    class Probe {
      @Cron('0 0 * * * *')
      async tick(): Promise<void> {
        seen = ContextService.getTraceId();
      }
    }

    await new Probe().tick();

    expect(seen).toEqual(expect.any(String));
  });
});
