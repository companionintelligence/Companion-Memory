import { STAGE_ID_LIST, STAGE_IDS } from '../constants';
import {
  STAGE_SCHEDULES,
  assertStageSchedules,
  automaticStageIds,
  isMeteredStage,
  meteredStageIds,
  stageDueness,
  stagePerRunCap,
  stageSchedule,
} from '../schedule';
import { STAGE_REGISTRY } from '../services/StageRegistry';
import type { StageSchedule } from '../types';

/**
 * THE SCHEDULE — what runs when, and what it is allowed to spend.
 *
 * Three claims are pinned here, and each one exists because the alternative has
 * already failed on this appliance:
 *
 *  1. **Completeness.** Every registered stage declares a schedule, checked at
 *     module load in exactly the style of `assertStageRegistryComplete`. A stage
 *     with no cadence is a stage that either never runs or runs on whatever the
 *     most expensive default happens to be, and both are silent.
 *  2. **Cost discipline is derived, not restated.** `cost: 'metered'` is the
 *     only place "this stage spends money" is written down. It used to be a
 *     `METERED_STAGES` set in `PipelineControlService` AND a sentence in a
 *     `STAGE_IDS` comment, which is two copies and a comment nothing executes.
 *  3. **Due-ness is arithmetic over a DECLARED policy and a per-leg last-run
 *     instant** — pure, injectable, and therefore assertable without a clock, a
 *     database or a queue.
 *
 * Every due-ness call passes `now` and `windowOpen` explicitly, and that is not
 * merely test hygiene — it is the contract. `stageDueness` owns no clock and
 * makes no query: whether the enrichment window is open is
 * `EnrichmentWindowService`'s answer (a zoned wall clock, a nightly budget,
 * `ci.pipeline_turns`), and there is exactly one implementation of it. A spec
 * that had to fake a timezone to test a cadence would be evidence that the
 * split had been got wrong.
 */

/** A fixed instant. Nothing here depends on which one, only on the differences. */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 7, 12, hour, minute, 0, 0);
}

const OPEN = true;
const SHUT = false;

const SECONDS = 1000;
const HOURS = 60 * 60 * SECONDS;
const DAYS = 24 * HOURS;

/** `now` minus a duration in milliseconds. */
function ago(now: Date, ms: number): Date {
  return new Date(now.getTime() - ms);
}

/** A schedule map with one entry replaced, for the guard tests. */
function withSchedule(stageId: string, patch: Partial<StageSchedule>): Record<string, StageSchedule> {
  const copy: Record<string, StageSchedule> = { ...(STAGE_SCHEDULES as Record<string, StageSchedule>) };

  copy[stageId] = { ...copy[stageId], ...patch };

  return copy;
}

/* ===================================================================== *
 * Completeness
 * ===================================================================== */

describe('STAGE_SCHEDULES completeness', () => {
  it('declares a schedule for every registered stage', () => {
    // Against the REGISTRY, not against its own keys. The registry is what the
    // tick resolves and sweeps, so "every stage that can run has a cadence" is
    // the property that matters; comparing the map to itself would pass with
    // both sides empty.
    for (const stageId of Object.keys(STAGE_REGISTRY)) {
      expect(() => stageSchedule(stageId)).not.toThrow();
    }

    expect(Object.keys(STAGE_SCHEDULES).sort()).toEqual(Object.keys(STAGE_REGISTRY).sort());
  });

  it('declares no schedule for a stage that does not exist', () => {
    const declared = new Set<string>(STAGE_ID_LIST);

    for (const stageId of Object.keys(STAGE_SCHEDULES)) {
      expect(declared.has(stageId)).toBe(true);
    }
  });

  it('throws rather than defaulting for an unknown stage', () => {
    // The most expensive possible default — every tick, any hour, uncapped — is
    // the one an accidental fallback would produce.
    expect(() => stageSchedule('enrich.not_a_stage')).toThrow(/No STAGE_SCHEDULES entry/);
  });

  it('passes its own boot guard', () => {
    expect(() => assertStageSchedules()).not.toThrow();
  });
});

/* ===================================================================== *
 * Cost: one source of truth
 * ===================================================================== */

describe('metered stages', () => {
  it('derives "metered" from the declared cost and nothing else', () => {
    expect(isMeteredStage(STAGE_IDS.ENRICH_GEOCODE)).toBe(true);
    expect(isMeteredStage(STAGE_IDS.ENRICH_POSITION_REVERSE)).toBe(true);

    expect(isMeteredStage(STAGE_IDS.ENRICH_MEDIA_DIMENSIONS)).toBe(false);
    expect(isMeteredStage(STAGE_IDS.INDEX_EMBED)).toBe(false);

    // STAGE_ID_LIST order — declaration order, so the answer is comparable
    // between runs and between log lines.
    expect(meteredStageIds()).toEqual([
      STAGE_IDS.ENRICH_POSITION_REVERSE,
      STAGE_IDS.ENRICH_GEOCODE,
      // The other direction over `ci.events`, and the same provider — a stage
      // that names a coordinate is billed exactly like one that resolves a name.
      STAGE_IDS.ENRICH_EVENT_REVERSE,
      STAGE_IDS.ENRICH_UNFURL,
    ]);
  });

  it('agrees with the map for every stage, in both directions', () => {
    for (const stageId of STAGE_ID_LIST) {
      expect(isMeteredStage(stageId)).toBe(stageSchedule(stageId).cost === 'metered');
    }
  });

  it('never reports an unknown stage as metered', () => {
    // `isMeteredStage` is a guard on a spend decision; it answers false for an
    // id it does not know rather than throwing, because a caller asking "is this
    // expensive?" about a typo must not be told yes.
    expect(isMeteredStage('enrich.not_a_stage')).toBe(false);
  });

  it('cannot be triggered on arrival', () => {
    // Arrival triggering means one provider call per row at import rate — the
    // precise opposite of a budget.
    for (const stageId of meteredStageIds()) {
      expect(stageSchedule(stageId).trigger).not.toBe('onArrival');
    }
  });

  it('is confined to the enrichment window and capped per sweep', () => {
    for (const stageId of meteredStageIds()) {
      const schedule = stageSchedule(stageId);

      expect(schedule.window).toBe('enrichment');
      expect(schedule.perRunCap).toBeGreaterThan(0);
      // Weekly at least. The user asked for geocoding at a slower cadence, and
      // "slower" is the number this line pins. `enrich.unfurl` is the one
      // exception — daily, so a large existing corpus backfills over days
      // rather than months at the same per-run cap.
      const minFloor = stageId === STAGE_IDS.ENRICH_UNFURL ? 24 * 60 * 60 : 7 * 24 * 60 * 60;
      expect(schedule.minInterval).toBeGreaterThanOrEqual(minFloor);
    }
  });

  it('runs enrich.unfurl daily, not weekly like the other metered stages', () => {
    // A personal library backlog (tens of thousands of Spotify/YouTube keys)
    // reaches full coverage in days at the per-run cap instead of months.
    expect(stageSchedule(STAGE_IDS.ENRICH_UNFURL).minInterval).toBe(24 * 60 * 60);

    for (const stageId of meteredStageIds()) {
      if (stageId === STAGE_IDS.ENRICH_UNFURL) {
        continue;
      }

      expect(stageSchedule(stageId).minInterval).toBe(7 * 24 * 60 * 60);
    }
  });

  it('is reachable by a timer, unlike the exclusion it replaces', () => {
    // The regression this guards: metered stages used to be filtered out of
    // `defaultStageSet()`, which made "costs money" and "can never be scheduled"
    // the same statement. Weekly-and-capped is a cadence; exclusion is not.
    for (const stageId of meteredStageIds()) {
      expect(automaticStageIds()).toContain(stageId);
    }
  });
});

describe('automaticStageIds', () => {
  it('is every stage a timer may start, in declaration order', () => {
    expect(automaticStageIds()).toEqual(
      STAGE_ID_LIST.filter((stageId) => stageSchedule(stageId).trigger !== 'manual'),
    );

    expect(automaticStageIds().length).toBeGreaterThan(0);
  });

  it('excludes anything declared manual', () => {
    const manual = STAGE_ID_LIST.filter((stageId) => stageSchedule(stageId).trigger === 'manual');

    for (const stageId of manual) {
      expect(automaticStageIds()).not.toContain(stageId);
    }
  });
});

/* ===================================================================== *
 * The decided cadences
 * ===================================================================== */

describe('the declared cadences', () => {
  it('sweeps index.embed on arrival with an hourly backstop, at any hour', () => {
    const schedule = stageSchedule(STAGE_IDS.INDEX_EMBED);

    expect(schedule.trigger).toBe('onArrival');
    expect(schedule.cost).toBe('contended');
    expect(schedule.window).toBe('any');
    expect(schedule.minInterval).toBe(60 * 60);
  });

  it('puts every local stage on a nightly, windowed cadence', () => {
    const nightly = [
      STAGE_IDS.ENRICH_MEDIA_DIMENSIONS,
      STAGE_IDS.ENRICH_PERSON_LINK,
      STAGE_IDS.ENRICH_EVENT_PERSON_LINK,
      STAGE_IDS.ENRICH_ESTIMATE_LOCATION,
      STAGE_IDS.CLEAN_TEMPORAL_REPAIR,
      STAGE_IDS.CLEAN_DUPLICATE_DETECT,
      STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE,
      STAGE_IDS.PROMOTE_PLACE,
      STAGE_IDS.PROMOTE_OBJECT,
    ];

    for (const stageId of nightly) {
      const schedule = stageSchedule(stageId);

      expect(schedule.cost).toBe('local');
      expect(schedule.window).toBe('enrichment');
      expect(schedule.minInterval).toBe(24 * 60 * 60);
    }
  });

  it('runs every deterministic-edge projection hourly, at any hour', () => {
    // THE REGRESSION THIS PINS. These ten legs were nightly and windowed, on a
    // batch-affinity argument borrowed from their producers. Their input does
    // not arrive at their producers' rate: a bulk import writes
    // `communications.from_entity_id` / `to_entity_ids` for the whole corpus at
    // ingest, with no linker involved. On the QA corpus that put 598,146
    // resolved senders and 525,706 recipient lists in the table minutes after a
    // sweep had already started — so `minInterval: 1 * DAYS`, measured from the
    // sweep's START, held ~1.5M derivable edges for twenty-four hours and left
    // the graph traversal (which reads `ci.relationships` and nothing else)
    // with 2,880 of 1,001,475 entities reachable.
    //
    // They are `cost: 'local'` — ten INSERT…SELECTs, no provider, no Ollama —
    // so the enrichment window, which exists to bound spend and Ollama
    // contention, was never bounding anything here.
    const edgeLegs = [
      STAGE_IDS.PROMOTE_EDGE_COMMUNICATION,
      STAGE_IDS.PROMOTE_EDGE_EVENT,
      STAGE_IDS.PROMOTE_EDGE_CONTENT,
      STAGE_IDS.PROMOTE_EDGE_OBJECT,
      STAGE_IDS.PROMOTE_EDGE_RECEIPT,
      STAGE_IDS.PROMOTE_EDGE_OBSERVATION,
      STAGE_IDS.PROMOTE_EDGE_POSITION,
      STAGE_IDS.PROMOTE_EDGE_DEVICE,
      STAGE_IDS.PROMOTE_EDGE_FILE,
      STAGE_IDS.PROMOTE_EDGE_PLACE,
    ];

    for (const stageId of edgeLegs) {
      const schedule = stageSchedule(stageId);

      expect(schedule.cost).toBe('local');
      expect(schedule.window).toBe('any');
      expect(schedule.minInterval).toBe(60 * 60);
      expect(schedule.maxStaleness).toBe(6 * 60 * 60);
    }

    // And the property that makes the tier safe rather than merely fast: with
    // the window shut — every hour of the day outside the nightly box — they are
    // still due once the interval has elapsed.
    const now = at(14);

    for (const stageId of edgeLegs) {
      expect(
        stageDueness({ stageId, lastStartedAt: ago(now, 90 * 60 * SECONDS), windowOpen: SHUT, now }).due,
      ).toBe(true);
    }
  });

  it('accounts for every stage in exactly one tier', () => {
    // No stage may be forgotten by the two lists above — the failure mode of a
    // hand-maintained tier table is a stage nobody assigned a cost to.
    const nightly = STAGE_ID_LIST.filter((stageId) => stageSchedule(stageId).minInterval === 24 * 60 * 60);
    const hourly = STAGE_ID_LIST.filter((stageId) => stageSchedule(stageId).minInterval === 60 * 60);
    const weekly = STAGE_ID_LIST.filter((stageId) => stageSchedule(stageId).minInterval === 7 * 24 * 60 * 60);

    expect(hourly.length + nightly.length + weekly.length).toBe(STAGE_ID_LIST.length);
    // `enrich.unfurl` shares the nightly bucket's interval (daily) without
    // sharing the edge legs' cost profile — it is the one metered stage NOT
    // weekly, backfilling a large corpus faster than a weekly cadence would.
    expect(weekly).toEqual(meteredStageIds().filter((id) => id !== STAGE_IDS.ENRICH_UNFURL));
    expect(nightly).toContain(STAGE_IDS.ENRICH_UNFURL);
  });

  it('caps the reverse geocoder, because the cap matters more than the interval', () => {
    // `ci.position` is empty today only because a debug push used the legacy
    // GraphQL lane; a real /v1 import fills it from 66,579 Google Fit records
    // plus GPX and location history. Weekly with no cap is one week in which all
    // of them hit a paid provider at once.
    expect(stagePerRunCap(STAGE_IDS.ENRICH_POSITION_REVERSE)).toBe(2_000);
    expect(stagePerRunCap(STAGE_IDS.ENRICH_GEOCODE)).toBe(1_000);
  });

  it('leaves local and contended stages uncapped', () => {
    // A cap on `index.embed` would be a second, weaker copy of
    // QUEUE_READY_CAPS['pipeline-embed'].
    for (const stageId of STAGE_ID_LIST) {
      if (isMeteredStage(stageId)) {
        continue;
      }

      expect(stagePerRunCap(stageId)).toBeNull();
    }
  });
});

/* ===================================================================== *
 * Due-ness
 * ===================================================================== */

describe('stageDueness', () => {
  describe('minInterval', () => {
    it('holds a nightly stage back for a day after its last sweep', () => {
      const now = at(3);

      const tooSoon = stageDueness({
        stageId: STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE,
        lastStartedAt: ago(now, 6 * HOURS),
        windowOpen: OPEN,
        now,
      });

      expect(tooSoon.due).toBe(false);
      expect(tooSoon.reason).toBe('too_soon');
      expect(tooSoon.overdue).toBe(false);
    });

    it('releases it once the interval has elapsed, with the window open', () => {
      const now = at(3);

      const due = stageDueness({
        stageId: STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE,
        lastStartedAt: ago(now, 25 * HOURS),
        windowOpen: OPEN,
        now,
      });

      expect(due.due).toBe(true);
      expect(due.reason).toBe('interval_elapsed');
      expect(due.overdue).toBe(false);
      expect(due.eligibleAt).toBeNull();
    });

    it('is exact at the boundary: one interval exactly is due, a second short is not', () => {
      const now = at(3);
      const stageId = STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE;
      const interval = stageSchedule(stageId).minInterval * SECONDS;

      expect(stageDueness({ stageId, lastStartedAt: ago(now, interval), windowOpen: OPEN, now }).due).toBe(
        true,
      );

      expect(
        stageDueness({ stageId, lastStartedAt: ago(now, interval - SECONDS), windowOpen: OPEN, now }).due,
      ).toBe(false);
    });

    it('holds the weekly geocoder for a week, not a night', () => {
      // The cadence the user asked for: the same open window, six nights in a
      // row, and geocode declines all but one of them.
      const now = at(3);
      const stageId = STAGE_IDS.ENRICH_GEOCODE;

      expect(stageDueness({ stageId, lastStartedAt: ago(now, 2 * DAYS), windowOpen: OPEN, now }).reason).toBe(
        'too_soon',
      );

      expect(stageDueness({ stageId, lastStartedAt: ago(now, 8 * DAYS), windowOpen: OPEN, now }).due).toBe(
        true,
      );
    });

    it('reports when the interval next elapses, and nothing about the window', () => {
      const now = at(3);
      const stageId = STAGE_IDS.ENRICH_GEOCODE;
      const lastStartedAt = ago(now, 2 * DAYS);

      const decision = stageDueness({ stageId, lastStartedAt, windowOpen: OPEN, now });

      // Exactly `lastStartedAt + minInterval`. When the window next opens is
      // `WindowStatus.nextOpensAt`'s answer, and combining the two is the
      // caller's business — an approximation here would be a second, worse copy
      // of a fact that already exists.
      expect(decision.eligibleAt).toEqual(
        new Date(lastStartedAt.getTime() + stageSchedule(stageId).minInterval * SECONDS),
      );
    });

    it('measures the interval per leg, so a second user is not held back by the first', () => {
      // THE requirement that the schedule work for every user, reduced to its
      // smallest form: two users, one stage, one declaration, two independent
      // answers — because the last-run instant is an argument and not a module
      // variable.
      const now = at(3);
      const stageId = STAGE_IDS.ENRICH_MEDIA_DIMENSIONS;

      const firstUser = stageDueness({
        stageId,
        lastStartedAt: ago(now, 1 * HOURS),
        windowOpen: OPEN,
        now,
      });

      const secondUser = stageDueness({ stageId, lastStartedAt: null, windowOpen: OPEN, now });

      expect(firstUser.due).toBe(false);
      expect(secondUser.due).toBe(true);
    });
  });

  describe('an overdue retry', () => {
    // The bug this closes: a leg swept 19 hours ago (well inside a metered
    // stage's 7-day minInterval) has a handful of rows that failed
    // `provider_unavailable` and are past their OWN backoff. Before
    // `hasOverdueRetry` existed, `too_soon` won regardless, so those rows sat
    // with `attempts` frozen at 1 until the leg's minInterval elapsed a week
    // later — the retry backoff `RETRY_BACKOFF_BASE_SECONDS` declares never
    // got a chance to fire.
    it('jumps the interval for a metered stage with a due retry', () => {
      const now = at(3);

      const decision = stageDueness({
        stageId: STAGE_IDS.ENRICH_POSITION_REVERSE,
        lastStartedAt: ago(now, 19 * HOURS),
        windowOpen: OPEN,
        hasOverdueRetry: true,
        now,
      });

      expect(decision.due).toBe(true);
      expect(decision.reason).toBe('retry_due');
      // Not `overdue`: a retry must still respect the window (see below), and
      // `overdue` is documented as bypassing it.
      expect(decision.overdue).toBe(false);
      expect(decision.eligibleAt).toBeNull();
    });

    it('still waits for a shut window, even with a due retry', () => {
      // The spend-timing control still applies — only the FREQUENCY control
      // (`minInterval`) yields to a due retry.
      const now = at(13);

      const decision = stageDueness({
        stageId: STAGE_IDS.ENRICH_GEOCODE,
        lastStartedAt: ago(now, 19 * HOURS),
        windowOpen: SHUT,
        hasOverdueRetry: true,
        now,
      });

      expect(decision.due).toBe(false);
      expect(decision.reason).toBe('outside_window');
    });

    it('changes nothing when there is no due retry — the pre-existing gate holds', () => {
      const now = at(3);

      const decision = stageDueness({
        stageId: STAGE_IDS.ENRICH_POSITION_REVERSE,
        lastStartedAt: ago(now, 19 * HOURS),
        windowOpen: OPEN,
        hasOverdueRetry: false,
        now,
      });

      expect(decision.due).toBe(false);
      expect(decision.reason).toBe('too_soon');
    });

    it('defaults to false when the caller omits it, so the pre-existing gate is the default behaviour', () => {
      const now = at(3);

      const decision = stageDueness({
        stageId: STAGE_IDS.ENRICH_POSITION_REVERSE,
        lastStartedAt: ago(now, 19 * HOURS),
        windowOpen: OPEN,
        now,
      });

      expect(decision.due).toBe(false);
      expect(decision.reason).toBe('too_soon');
    });

    it('is irrelevant once the interval has already elapsed — interval_elapsed wins either way', () => {
      const now = at(3);

      for (const hasOverdueRetry of [true, false]) {
        const decision = stageDueness({
          stageId: STAGE_IDS.ENRICH_GEOCODE,
          lastStartedAt: ago(now, 8 * DAYS),
          windowOpen: OPEN,
          hasOverdueRetry,
          now,
        });

        expect(decision.due).toBe(true);
        expect(decision.reason).toBe('interval_elapsed');
      }
    });
  });

  describe('the window', () => {
    it('refuses a windowed stage while the window is shut, even when the interval has elapsed', () => {
      const now = at(13);

      const decision = stageDueness({
        stageId: STAGE_IDS.PROMOTE_OBJECT,
        lastStartedAt: ago(now, 2 * DAYS),
        windowOpen: SHUT,
        now,
      });

      expect(decision.due).toBe(false);
      expect(decision.reason).toBe('outside_window');
      expect(decision.overdue).toBe(false);
    });

    it('lets an unwindowed stage run whether the window is open or shut', () => {
      const now = at(13);

      for (const windowOpen of [OPEN, SHUT]) {
        const decision = stageDueness({
          stageId: STAGE_IDS.INDEX_EMBED,
          lastStartedAt: ago(now, 2 * HOURS),
          windowOpen,
          now,
        });

        expect(decision.due).toBe(true);
        expect(decision.reason).toBe('interval_elapsed');
      }
    });

    it('reports too_soon rather than outside_window when both apply', () => {
      // The order of the checks is the policy: a leg swept an hour ago is not
      // due whatever the clock says, and blaming the window would send a reader
      // looking in the wrong place.
      const now = at(13);

      const decision = stageDueness({
        stageId: STAGE_IDS.PROMOTE_OBJECT,
        lastStartedAt: ago(now, 1 * HOURS),
        windowOpen: SHUT,
        now,
      });

      expect(decision.reason).toBe('too_soon');
    });
  });

  describe('maxStaleness — the escape from the window', () => {
    it('makes a windowed stage due with the window shut, once it is overdue', () => {
      // An appliance that is powered down every night has an enrichment window
      // it is never awake for. Without this, its enrichment silently never runs
      // — the exact failure this rebuild exists to delete.
      const now = at(13);

      const decision = stageDueness({
        stageId: STAGE_IDS.CLEAN_TEMPORAL_REPAIR,
        lastStartedAt: ago(now, 5 * DAYS),
        windowOpen: SHUT,
        now,
      });

      expect(decision.due).toBe(true);
      expect(decision.reason).toBe('max_staleness_exceeded');
      expect(decision.overdue).toBe(true);
    });

    it('does not fire while the leg is merely due', () => {
      const now = at(3);

      const decision = stageDueness({
        stageId: STAGE_IDS.CLEAN_TEMPORAL_REPAIR,
        lastStartedAt: ago(now, 2 * DAYS),
        windowOpen: OPEN,
        now,
      });

      expect(decision.overdue).toBe(false);
      expect(decision.reason).toBe('interval_elapsed');
    });

    it('is exact at the boundary', () => {
      const now = at(13);
      const stageId = STAGE_IDS.CLEAN_TEMPORAL_REPAIR;
      const ceiling = stageSchedule(stageId).maxStaleness * SECONDS;

      expect(stageDueness({ stageId, lastStartedAt: ago(now, ceiling), windowOpen: SHUT, now }).due).toBe(
        true,
      );

      expect(
        stageDueness({ stageId, lastStartedAt: ago(now, ceiling - SECONDS), windowOpen: SHUT, now }).due,
      ).toBe(false);
    });

    it('releases a metered stage too — the cap is what still bounds the spend', () => {
      const now = at(13);

      const decision = stageDueness({
        stageId: STAGE_IDS.ENRICH_POSITION_REVERSE,
        lastStartedAt: ago(now, 40 * DAYS),
        windowOpen: SHUT,
        now,
      });

      expect(decision.due).toBe(true);
      expect(decision.overdue).toBe(true);
      expect(decision.perRunCap).toBe(2_000);
    });
  });

  describe('a leg that has never run', () => {
    it('is due immediately, with the window shut, and is overdue', () => {
      // A freshly imported appliance enriches now rather than sitting idle until
      // tonight. Never-run is infinite staleness, so this is the maxStaleness
      // rule at its limit rather than a special case beside it.
      const now = at(13);

      const decision = stageDueness({
        stageId: STAGE_IDS.ENRICH_MEDIA_DIMENSIONS,
        lastStartedAt: null,
        windowOpen: SHUT,
        now,
      });

      expect(decision.due).toBe(true);
      expect(decision.reason).toBe('never_run');
      expect(decision.overdue).toBe(true);
      expect(decision.eligibleAt).toBeNull();
    });

    it('is bounded by the cap for a metered stage, and by nothing else', () => {
      // The first pass of the reverse geocoder on a fresh appliance is the
      // measured worst case: 66,579 candidate fixes and no last-run to hold it
      // back. `perRunCap` is the only thing standing between that and a bill.
      const decision = stageDueness({
        stageId: STAGE_IDS.ENRICH_POSITION_REVERSE,
        lastStartedAt: null,
        windowOpen: SHUT,
        now: at(13),
      });

      expect(decision.due).toBe(true);
      expect(decision.perRunCap).toBe(2_000);
    });
  });

  it('carries the declaration it decided from', () => {
    const decision = stageDueness({
      stageId: STAGE_IDS.ENRICH_GEOCODE,
      lastStartedAt: null,
      windowOpen: OPEN,
    });

    expect(decision.stageId).toBe(STAGE_IDS.ENRICH_GEOCODE);
    expect(decision.schedule).toBe(stageSchedule(STAGE_IDS.ENRICH_GEOCODE));
    expect(decision.perRunCap).toBe(stagePerRunCap(STAGE_IDS.ENRICH_GEOCODE));
  });

  it('is answerable for every registered stage without a clock or a database', () => {
    for (const stageId of STAGE_ID_LIST) {
      expect(() => stageDueness({ stageId, lastStartedAt: null, windowOpen: OPEN })).not.toThrow();
    }
  });

  it('throws for a stage with no schedule rather than inventing one', () => {
    expect(() =>
      stageDueness({ stageId: 'enrich.not_a_stage', lastStartedAt: null, windowOpen: OPEN }),
    ).toThrow(/No STAGE_SCHEDULES entry/);
  });
});

/* ===================================================================== *
 * The boot guard
 * ===================================================================== */

describe('assertStageSchedules', () => {
  it('fails on a stage with no schedule', () => {
    const incomplete: Record<string, StageSchedule> = {
      ...(STAGE_SCHEDULES as Record<string, StageSchedule>),
    };

    delete incomplete[STAGE_IDS.PROMOTE_OBJECT];

    expect(() => assertStageSchedules(incomplete)).toThrow(/promote\.object/);
    expect(() => assertStageSchedules(incomplete)).toThrow(/absent from STAGE_SCHEDULES/);
  });

  it('fails on a schedule for a stage that does not exist', () => {
    const extra: Record<string, StageSchedule> = {
      ...(STAGE_SCHEDULES as Record<string, StageSchedule>),
      'enrich.typo': stageSchedule(STAGE_IDS.PROMOTE_OBJECT),
    };

    expect(() => assertStageSchedules(extra)).toThrow(/enrich\.typo/);
  });

  it('fails a metered stage declared onArrival', () => {
    // One provider call per arriving row, at import rate.
    expect(() =>
      assertStageSchedules(withSchedule(STAGE_IDS.ENRICH_GEOCODE, { trigger: 'onArrival', window: 'any' })),
    ).toThrow(/metered and trigger: 'onArrival'/);
  });

  it('fails a metered stage that is not confined to the window', () => {
    expect(() => assertStageSchedules(withSchedule(STAGE_IDS.ENRICH_GEOCODE, { window: 'any' }))).toThrow(
      /metered but window/,
    );
  });

  it('fails a metered stage with no perRunCap', () => {
    const uncapped = withSchedule(STAGE_IDS.ENRICH_POSITION_REVERSE, {});

    delete uncapped[STAGE_IDS.ENRICH_POSITION_REVERSE].perRunCap;

    expect(() => assertStageSchedules(uncapped)).toThrow(/metered with no perRunCap/);
  });

  it('fails an onArrival stage confined to the window', () => {
    expect(() => assertStageSchedules(withSchedule(STAGE_IDS.INDEX_EMBED, { window: 'enrichment' }))).toThrow(
      /not arrival-triggered/,
    );
  });

  it('fails a maxStaleness below its minInterval', () => {
    // A ceiling below the floor makes every leg permanently overdue, which
    // silently deletes both the interval and the window: a five-minute metered
    // geocoder, arrived at by a typo.
    expect(() => assertStageSchedules(withSchedule(STAGE_IDS.ENRICH_GEOCODE, { maxStaleness: 60 }))).toThrow(
      /below minInterval/,
    );
  });

  it('fails a non-positive interval', () => {
    expect(() => assertStageSchedules(withSchedule(STAGE_IDS.PROMOTE_PLACE, { minInterval: 0 }))).toThrow(
      /minInterval must be a positive number/,
    );
  });

  it('fails a perRunCap that is zero or fractional', () => {
    expect(() => assertStageSchedules(withSchedule(STAGE_IDS.ENRICH_GEOCODE, { perRunCap: 0 }))).toThrow(
      /perRunCap must be an integer/,
    );

    expect(() => assertStageSchedules(withSchedule(STAGE_IDS.ENRICH_GEOCODE, { perRunCap: 1.5 }))).toThrow(
      /perRunCap must be an integer/,
    );
  });

  it('reports every problem at once', () => {
    // A guard that stops at the first mistake turns one boot into three.
    const broken = withSchedule(STAGE_IDS.ENRICH_GEOCODE, {
      trigger: 'onArrival',
      window: 'any',
      maxStaleness: 1,
    });

    let message = '';

    try {
      assertStageSchedules(broken);
    } catch (err: unknown) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toMatch(/metered and trigger: 'onArrival'/);
    expect(message).toMatch(/metered but window/);
    expect(message).toMatch(/below minInterval/);
  });
});
