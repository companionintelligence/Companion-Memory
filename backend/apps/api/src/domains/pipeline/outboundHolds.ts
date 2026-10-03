import { isOutboundEnabled, type OutboundPathKey } from '@ci/common/outbound';

import { STAGE_IDS } from './constants';

/**
 * Which stages egress on behalf of one of the user's outbound switches
 * (`ci.outbound_settings`; Settings -> Privacy -> "What leaves your appliance").
 *
 * A closed, declared map for the same reason `STAGE_VERSIONS` and
 * `STAGE_SCHEDULES` are: which stage talks to the outside world is a fact about
 * the code that a reviewer should be able to read in one place, and a stage that
 * is added later and forgotten here fails OPEN (it keeps running) rather than
 * silently wedging.
 *
 * `promote.place` and `promote.position_place` are deliberately not listed. They
 * read `ci.geocode_cache` rows the enrich stages already wrote and never call the
 * provider, so nothing they do leaves the box.
 */
const STAGE_OUTBOUND_PATH: Readonly<Record<string, OutboundPathKey>> = {
  [STAGE_IDS.ENRICH_GEOCODE]: 'place_lookups',
  [STAGE_IDS.ENRICH_EVENT_REVERSE]: 'place_lookups',
  [STAGE_IDS.ENRICH_POSITION_REVERSE]: 'place_lookups',
  [STAGE_IDS.ENRICH_UNFURL]: 'link_previews',
};

/**
 * The outbound switch that is holding this stage right now, or `null` when the
 * stage may run.
 *
 * ── Why a HOLD, and why it sits before the ledger ──────────────────────────
 *
 * `skipped` is terminal in `ci.pipeline_state`: a skipped row is not selected
 * again until the stage VERSION is bumped. So the tempting implementation —
 * let the stage run, see the provider refused, record `skipped: user_disabled`
 * — would turn "the user switched place lookups off for a week" into "every
 * place that arrived that week is permanently decided", and switching it back on
 * would appear to do nothing. A `failed` row is not terminal, but it is not free
 * either: it writes a ledger row per entity, backs off for up to six hours (so
 * re-enabling waits out the gate), and shows up on the failure dashboards as a
 * provider outage that never happened.
 *
 * A hold avoids all of it by not starting. While it is on:
 *
 *  - the control tick does not probe, stamp or sweep the stage's legs
 *    (`PipelineControlService.serviceUser`), so `ci.pipeline_schedule`
 *    `last_started_at` is not advanced — the leg is as due the moment the switch
 *    goes back on as it was when it went off;
 *  - a sweep hop that is already in flight stops dispatching
 *    (`PipelineDispatchService.runSweepHop`) and does not re-enqueue itself;
 *  - a slice that was already queued is acknowledged without being claimed
 *    (`PipelineSliceListener.handleSlice`), so no `running` row is written and
 *    nothing is charged an attempt.
 *
 * No ledger row is written by any of the three, so re-enabling needs no repair:
 * the rows are still stale, and the next tick (or the next manual sweep) picks
 * them up exactly as it would have. The only lever that can still reach a
 * provider is a stage that runs OUTSIDE this ladder, and those are covered by the
 * service-level gates (`GeocodeService`, `UnfurlService`), which answer with an
 * outcome the stages already record as transient.
 */
export function stageHeldByOutboundPolicy(stageId: string): OutboundPathKey | null {
  const path = STAGE_OUTBOUND_PATH[stageId];

  return path !== undefined && !isOutboundEnabled(path) ? path : null;
}
