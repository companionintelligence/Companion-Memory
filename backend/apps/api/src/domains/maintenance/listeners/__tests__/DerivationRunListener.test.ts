import type { LoggerService } from '@ci/common/logging';
import { PersonalizationService } from '@ci/domains/personalization';

import type { OrchestrateBody, OrchestrateSummary } from '../../services/MaintenanceOrchestratorService';
import { DerivationRunListener } from '../DerivationRunListener';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GATE, EXERCISED THROUGH THE REAL TRUST DIAL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The one rule this scheduled pass must not break: it may PROJECT edges the
 * user's own data already asserts, and it may not MINT an entity nobody's data
 * names — not unless the Autonomy setting says a machine may act unattended.
 * Household `Group` reification mints one, and `person_self_merge` rewrites
 * identity, so both are asked of `PersonalizationService.decideAction` first.
 *
 * The real `PersonalizationService` is wired here rather than a mock of it,
 * because the assertion is precisely that ITS mapping — `graph_entity` and
 * `person_self_merge` are in GRAPH_CONNECTION_KINDS, so balanced answers
 * `review` — reaches the leg options. A mocked decideAction would let the
 * listener pass while the mapping underneath it changed.
 *
 * Only the profile read is stubbed: `getSelfIdentity` returning null is the
 * documented path to the DEFAULT trust mode, which is the mode that matters
 * most here.
 */

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

const USER_ID = 'user-1';

const emptySummary: OrchestrateSummary = { ok: true, legs: [], totalDurationMs: 0 };

/**
 * @param trustMode omitted → no self identity, which is how
 *   `PersonalizationService.getProfile` falls back to the DEFAULT mode.
 */
function makeListener(trustMode?: 'cautious' | 'balanced' | 'hands_off', isRunning = false) {
  const orchestrate = jest.fn(async (): Promise<OrchestrateSummary> => emptySummary);
  const orchestrator = { orchestrate, isRunning: () => isRunning };

  const personalization = new PersonalizationService(
    { findById: async () => ({ properties: { planner: { trust_mode: trustMode } } }) } as never,
    { getSelfIdentity: async () => (trustMode == null ? null : { entityId: 'self-1' }) } as never,
  );

  const listener = new DerivationRunListener(orchestrator as never, personalization, noopLogger);

  return { listener, orchestrate };
}

/**
 * The body the listener handed the orchestrator on its single call.
 *
 * `jest.fn`'s inferred zero-arity signature types `mock.calls` as `[]`, so the
 * recorded arguments are read through the shape `orchestrate(userId, body)`
 * actually receives.
 */
function bodyOf(orchestrate: jest.Mock): OrchestrateBody {
  expect(orchestrate).toHaveBeenCalledTimes(1);

  return (orchestrate.mock.calls as unknown as Array<[string, OrchestrateBody]>)[0][1];
}

describe('DerivationRunListener', () => {
  it('runs ONLY the two chosen legs', async () => {
    const { listener, orchestrate } = makeListener();

    await listener.handleRun({ userId: USER_ID, dayKey: '2026-08-21' });

    expect((orchestrate.mock.calls as unknown as Array<[string, OrchestrateBody]>)[0][0]).toBe(USER_ID);
    expect(bodyOf(orchestrate).stages).toEqual(['heal_self_collation', 'derive_relationships']);
  });

  it('does NOT auto-apply the household Group under the default trust mode', async () => {
    const { listener, orchestrate } = makeListener();

    await listener.handleRun({ userId: USER_ID });

    expect(bodyOf(orchestrate).options?.deriveRelationships).toEqual({ reifyHouseholdGroups: false });
  });

  it('does NOT auto-merge owner stubs under the default trust mode', async () => {
    const { listener, orchestrate } = makeListener();

    await listener.handleRun({ userId: USER_ID });

    expect(bodyOf(orchestrate).options?.healSelfCollation).toEqual({ dryRun: true });
  });

  it('withholds both mutations in cautious mode too', async () => {
    const { listener, orchestrate } = makeListener('cautious');

    await listener.handleRun({ userId: USER_ID });

    const body = bodyOf(orchestrate);

    expect(body.options?.deriveRelationships).toEqual({ reifyHouseholdGroups: false });
    expect(body.options?.healSelfCollation).toEqual({ dryRun: true });
  });

  it('applies both only when the user has chosen hands_off', async () => {
    const { listener, orchestrate } = makeListener('hands_off');

    await listener.handleRun({ userId: USER_ID });

    const body = bodyOf(orchestrate);

    expect(body.options?.deriveRelationships).toEqual({ reifyHouseholdGroups: true });
    expect(body.options?.healSelfCollation).toEqual({ dryRun: false });
  });

  it('stands down when an operator orchestration is already running for the user', async () => {
    const { listener, orchestrate } = makeListener('hands_off', true);

    await listener.handleRun({ userId: USER_ID });

    expect(orchestrate).not.toHaveBeenCalled();
  });

  it('refuses a request with no user rather than guessing at one', async () => {
    const { listener, orchestrate } = makeListener();

    await listener.handleRun({ requestedBy: 'DerivationCron' });

    expect(orchestrate).not.toHaveBeenCalled();
  });
});
