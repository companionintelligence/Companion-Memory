import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import { QuestionService } from '@ci/domains/intelligence';

import { SmartRotationModule } from '../../index';
import { SmartRotationService } from '../../services/SmartRotationService';
import { SMART_ROTATION_CRONS, type SmartRotationWorkType } from '../../types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE CRON OWNS EACH WORK TYPE. THIS FILE REGRESSES A SECOND, HIDDEN OWNER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `EntityPromotionCron` was a second driver of `graph_enrich`. Its docstring
 * said it scanned pending promotions from `ci.promotion_candidates`; that table
 * was dropped (`20260816010000_context_prompts_and_drop_promotion_candidates`)
 * and the body never scanned anything. What it actually did was fan
 * `graph_enrich` out to EVERY feed-queue user, every two hours — three times
 * `SMART_ROTATION_CRONS.graph_enrich`, and through `enqueueWork` directly, so
 * it also bypassed the `SMART_ROTATION_USERS_PER_TICK` cap that
 * `runScheduledWork` applies. Nothing named it in the Jobs dashboard as the
 * source of that load.
 *
 * A test that imports the crons it knows about cannot catch that: the class was
 * a perfectly ordinary provider, and its own behaviour was self-consistent. So
 * the cron sites here are DISCOVERED from `SmartRotationModule`'s `@Module`
 * providers — the same list Nest reads at boot — and each one is RUN, with
 * every feature flag on, to see which work type it actually schedules and by
 * which route. What is asserted is what the appliance will really do.
 */

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

type CronClass = new (...args: never[]) => Record<string, () => Promise<unknown>>;

interface CronSite {
  /** `Class.method` — the label the Jobs dashboard shows. */
  label: string;
  method: string;
  cronTime: string;
  CronClass: CronClass;
}

function discoverCronSites(): CronSite[] {
  const providers = (Reflect.getMetadata('providers', SmartRotationModule) ?? []) as unknown[];
  const sites: CronSite[] = [];

  for (const provider of providers) {
    if (typeof provider !== 'function') {
      continue;
    }

    const prototype = (provider as { prototype?: object }).prototype as object | undefined;

    if (prototype == null) {
      continue;
    }

    for (const method of Object.getOwnPropertyNames(prototype)) {
      if (method === 'constructor') {
        continue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(prototype, method);

      if (typeof descriptor?.value !== 'function') {
        continue;
      }

      const options = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, descriptor.value) as
        { cronTime?: unknown } | undefined;

      if (typeof options?.cronTime !== 'string') {
        continue;
      }

      const className = (provider as { name: string }).name;

      sites.push({
        label: `${className}.${method}`,
        method,
        cronTime: options.cronTime,
        CronClass: provider as CronClass,
      });
    }
  }

  return sites;
}

const CRON_SITES = discoverCronSites();

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** How a cron reached the rotation service: capped sweep, or straight enqueue. */
type Route = 'runScheduledWork' | 'enqueueWork';

interface Scheduled {
  site: string;
  via: Route;
  cronTime: string;
}

/**
 * A dependency double per constructor param type.
 *
 * Deliberately exhaustive rather than a catch-all proxy: a cron that arrives
 * with a dependency nobody listed here fails loudly, instead of silently
 * running against a stub that answers `undefined` and therefore schedules
 * nothing — which is how a second owner hides.
 */
function stubFor(
  dependency: unknown,
  record: (via: Route, workType: SmartRotationWorkType) => void,
): unknown {
  switch (dependency) {
    case SmartRotationService:
      return {
        isEnabled: async () => true,
        runScheduledWork: async (workType: SmartRotationWorkType) => {
          record('runScheduledWork', workType);

          return 1;
        },
        enqueueWork: async (_userId: string, workType: SmartRotationWorkType) => {
          record('enqueueWork', workType);

          return true;
        },
      };
    case FeatureService:
      // Every flag on — the regime in which the most crons do work, so a second
      // owner cannot hide behind a flag that happens to be false by default.
      return { isFeatureEnabled: async () => true };
    case QuestionService:
      return { listFeedQueueUserIds: async () => ['user-1'], findUnansweredByUserId: async () => new Map() };
    case EventService:
      return { send: async () => ['job-1'] };
    case LoggerService:
      return { setContext() {}, log() {}, warn() {}, error() {}, debug() {} };
    default:
      throw new Error(
        `No double for constructor dependency ${(dependency as { name?: string })?.name ?? String(dependency)} — ` +
          `add one so every smart-rotation cron stays covered by this sweep`,
      );
  }
}

/** Run every discovered cron once and report what each one scheduled. */
async function scheduledWork(): Promise<Scheduled[]> {
  const scheduled: Scheduled[] = [];

  for (const site of CRON_SITES) {
    const paramTypes = (Reflect.getMetadata('design:paramtypes', site.CronClass) ?? []) as unknown[];
    const args = paramTypes.map((paramType) =>
      stubFor(paramType, (via, workType) =>
        scheduled.push({ site: `${site.label}:${workType}`, via, cronTime: site.cronTime }),
      ),
    );

    const instance = new site.CronClass(...(args as never[]));

    await instance[site.method]();
  }

  return scheduled;
}

function driversOf(workType: SmartRotationWorkType, scheduled: Scheduled[]): Scheduled[] {
  return scheduled
    .filter((entry) => entry.site.endsWith(`:${workType}`))
    .map((entry) => ({ ...entry, site: entry.site.slice(0, -`:${workType}`.length) }));
}

/* ===================================================================== *
 * Tests
 * ===================================================================== */

describe('smart-rotation cron discovery', () => {
  it('finds the cron sites SmartRotationModule registers', () => {
    // Guards the sweep itself: an empty discovery would make every assertion
    // below pass without running anything.
    expect(CRON_SITES.length).toBeGreaterThan(0);
  });
});

describe('graph_enrich has exactly one owner', () => {
  it('is scheduled once, on its own cadence, through the capped sweep', async () => {
    const drivers = driversOf('graph_enrich', await scheduledWork());

    expect(drivers).toEqual([
      {
        site: 'SmartRotationGraphEnrichCron.run',
        via: 'runScheduledWork',
        cronTime: SMART_ROTATION_CRONS.graph_enrich,
      },
    ]);
  });

  it('leaves no cron reaching the uncapped enqueueWork route', async () => {
    // `enqueueWork` skips the per-tick user cap and the backlog check. Crons
    // belong on `runScheduledWork`; the direct route is for listeners.
    const uncapped = (await scheduledWork()).filter((entry) => entry.via === 'enqueueWork');

    expect(uncapped).toEqual([]);
  });
});
