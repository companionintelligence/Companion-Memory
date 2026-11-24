import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { PersonalizationService } from '@ci/domains/personalization';

import { DERIVATION_RUN_QUEUE, DerivationRunRequestEvent, type DerivationRunRequestPayload } from '../events';
import { MaintenanceOrchestratorService } from '../services/MaintenanceOrchestratorService';

/**
 * The confidence the two GATED legs are offered to the trust dial at.
 *
 * 0.7 is not a guess dressed up as a number — it is the exact value
 * `PersonalizationService.ALWAYS_REVIEW_BELOW_CONFIDENCE` uses as the floor
 * under which NOTHING auto-applies in any trust mode, and the value
 * `hands_off`'s `autoPromoteThreshold` sits at. Offering these legs at exactly
 * that boundary produces the intended behaviour and nothing else:
 *
 *  - `cautious`  → `review` (never mutates on a timer)
 *  - `balanced`  → `review` (graph connections are never auto-applied)
 *  - `hands_off` → `auto`   (the user asked for exactly this)
 *
 * Anything LOWER would make the leg unreachable in every mode — a gate no
 * setting can open is a deletion with extra steps. Anything HIGHER would claim
 * a certainty the derivation does not have: a household cluster is inferred
 * from a LIVES_WITH edge plus a shared LIVES_IN place, which is strong evidence
 * and not proof, and the service itself stamps the resulting MEMBER_OF edges
 * `strength: 0.7`.
 *
 * The per-CANDIDATE judgement for the self-collation leg stays inside
 * `HealSelfCollationService` (`decideSelfCollation(trustMode, match)`);
 * this gate answers the coarser question the schedule raises, which is whether
 * an unattended pass may apply that leg's merges AT ALL.
 */
const AUTONOMY_GATE_CONFIDENCE = 0.7;

/**
 * The nightly derivation pass for ONE user — the consumer half of
 * {@link DerivationCron}'s fan-out.
 *
 * ── What it runs, and why only these two legs ──────────────────────────────
 *
 * `ORCHESTRATE_STAGES` declares sixteen legs and seven of them had no caller
 * but HTTP/CLI. This schedules two of the seven, and the choice of which is the
 * whole substance of the change (`docs/jobs-schedule-review.md` Q4 item 5):
 *
 *  - `heal_self_collation` — folds owner-representing Person stubs into the
 *    self Person. Already fully trust-gated internally, so under the DEFAULT
 *    `balanced` mode a nightly run mutates nothing and reports a count: "N
 *    owner stubs are waiting in People → Possible duplicates". That count is
 *    the point — it turns a silence into a number on the Jobs dashboard.
 *  - `derive_relationships` — the L2 aggregates. `COMMUNICATES_WITH` from
 *    person↔person episodic edges and `FREQUENTS` from repeated `VISITED` are
 *    pure projections of assertions the user's own data already makes, set-based
 *    SQL, `ON CONFLICT DO NOTHING`, no LLM and no egress. Its third leg mints a
 *    household `Group` and is withheld unless the trust dial says otherwise.
 *
 * ── Why the other five are NOT here ────────────────────────────────────────
 *
 *  - `materialize_edges` — already covered. `promote.edge_*` (ten stages,
 *    hourly and unwindowed in `STAGE_SCHEDULES`) DELEGATES to the very same
 *    `DeterministicEdgeBackfillService` this leg calls. Its own docblock says
 *    "Never auto-run", and a second timer over the same projection would buy
 *    nothing.
 *  - `media_dimensions` — already covered, and its event is deprecated:
 *    `MediaDimensionsBackfillListener` logs a deprecation and delegates to the
 *    `enrich.media_dimensions` pipeline stage, which `STAGE_SCHEDULES` runs
 *    nightly in the enrichment window.
 *  - `extract_graph` — LLM-bound (per-chunk Ollama extraction). It already has
 *    a scheduled caller in `SmartRotationGraphEnrichCron` (every 6 h, gated on
 *    novelty) whenever `smart.rotation` is on. Adding an unconditional nightly
 *    fan-out of LLM work is a capacity decision, not a maintenance one.
 *  - `normalize_relationships` — a one-shot historical repair, not a recurring
 *    derivation: it REWRITES `relationship_type` on existing rows and
 *    deactivates others. Migration-shaped work belongs behind an operator, not
 *    a timer.
 *  - `fold_notes` — mints `Content` entities mirroring `ci.notes`. Notes are
 *    already independently searchable (`entitySourceMap`'s `note` type), so
 *    folding them changes what flows into graph/derivation surfaces rather than
 *    repairing anything. That is a product decision (#1945), not a chore.
 *
 * ── Overlap ───────────────────────────────────────────────────────────────
 *
 * The orchestrator holds a per-user in-process lock and throws 409 on overlap;
 * this checks `isRunning` first and stands down, exactly as
 * `SmartRotationListener`'s `graph_link` case does — a nightly pass has no
 * business interrupting an operator's live orchestration.
 */
@Injectable()
export class DerivationRunListener {
  constructor(
    private readonly orchestrator: MaintenanceOrchestratorService,
    private readonly personalization: PersonalizationService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DerivationRunListener.name);
  }

  @OnEvent(DerivationRunRequestEvent, {
    queue: DERIVATION_RUN_QUEUE,
    // `policy: 'short'` is what makes DerivationCron's per-user, per-day
    // singletonKey actually refuse a duplicate — pg-boss's default `standard`
    // stores the key and never enforces it. Every send on this queue carries
    // one, so the queue-wide policy is safe.
    //
    // `role: 'worker'`: a graph aggregate over a full personal corpus is a
    // sweep, and sweeps are worker work. `localConcurrency: 1` because the legs
    // are set-based SQL against `ci.relationships` — running several users
    // abreast contends on the same table and the same 25-connection pool for no
    // throughput at all, since nothing is waiting on the answer.
    queueOptions: { policy: 'short', role: 'worker', localConcurrency: 1 },
  })
  async handleRun(payload: DerivationRunRequestPayload): Promise<void> {
    const { userId } = payload;

    if (userId == null || userId.length === 0) {
      this.logger.warn('Derivation run refused — no userId on the request', {
        requestedBy: payload.requestedBy ?? null,
      });

      return;
    }

    if (this.orchestrator.isRunning(userId)) {
      this.logger.log('Derivation run skipped — orchestrator busy', { userId });

      return;
    }

    // Two separate questions for the two gated writes, asked of the same dial.
    // `graph_entity` and `person_self_merge` are both in
    // GRAPH_CONNECTION_KINDS, so both answer `review` in cautious and balanced.
    const [householdDecision, selfMergeDecision] = await Promise.all([
      this.personalization.decideAction(userId, {
        kind: 'graph_entity',
        confidence: AUTONOMY_GATE_CONFIDENCE,
        hasUserInput: true,
      }),
      this.personalization.decideAction(userId, {
        kind: 'person_self_merge',
        confidence: AUTONOMY_GATE_CONFIDENCE,
        hasUserInput: true,
      }),
    ]);

    const summary = await this.orchestrator.orchestrate(userId, {
      // Canonical order is the orchestrator's, not this array's:
      // heal_self_collation (index 3) runs before derive_relationships (index
      // 6), which is the order that matters — merges land on the canonical
      // Person before the aggregates project edges onto it.
      stages: ['heal_self_collation', 'derive_relationships'],
      options: {
        // dryRun unless the dial said `auto`: the leg still examines every
        // candidate and reports how many are waiting, it just does not merge.
        healSelfCollation: { dryRun: selfMergeDecision !== 'auto' },
        deriveRelationships: { reifyHouseholdGroups: householdDecision === 'auto' },
      },
    });

    this.logger.log('Nightly derivation pass complete', {
      userId,
      dayKey: payload.dayKey ?? null,
      ok: summary.ok,
      householdDecision,
      selfMergeDecision,
      legs: summary.legs.map((leg) => ({ leg: leg.leg, ok: leg.ok, result: leg.result })),
    });
  }
}
