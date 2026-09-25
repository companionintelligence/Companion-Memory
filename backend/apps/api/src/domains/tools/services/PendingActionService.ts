import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { PersonalizationService } from '@ci/domains/personalization/services/PersonalizationService';
import type { TrustDecision } from '@ci/tool-core';

import type { IntentDefinition, ToolInvocationContext, ToolResult } from '../core/types';
import { PendingActionEntity, type PendingAction } from '../entities/PendingActionEntity';
import {
  assertPendingActionTransition,
  authorisesExecution,
  TERMINAL_PENDING_ACTION_STATUSES,
  type PendingActionStatus,
} from '../pendingActionStatus';
import { needsConfirmation, resolveToolGate, type ToolGateRuling } from '../policy/toolGate';

/**
 * The feature flag, shaped like `ask` and `smart.rotation` — but ON by default
 * since 2026-09-25. It shipped dark while the queue had no UI; the Approvals
 * page has one now, and with the flag off the owner's own chat ran every delete
 * and every send unattended, which made a planted email one tool call from
 * exfiltration (see {@link trustForToolCall}). Off is now the kill switch, and
 * while it is off `evaluate` is provably the pre-gate behaviour (see the flag
 * branch there).
 */
export const PENDING_ACTIONS_FEATURE = 'tools.pendingActions' as const;

/**
 * The dial's mode, named through the service this file already depends on:
 * importing it from personalization's barrel closes a dependency cycle
 * (personalization → llm → tools → here), and its `types.ts` is that domain's
 * internal.
 */
type TrustMode = Awaited<ReturnType<PersonalizationService['getProfile']>>['trustMode'];

/**
 * The owner's trust dial, read DIRECTLY for a tool call rather than through
 * `PersonalizationService.decide`.
 *
 * `decide` grades inferences: it takes a confidence and compares it with the
 * mode's auto-promote threshold. A tool call is not an inference — the model
 * emitted this exact intent, so its "confidence" is 1 — and 1 clears every
 * threshold, so routing a tool call through `decide` meant `balanced` (the
 * default dial) answered `auto` and the gate never queued anything for the
 * owner. That was the hole: the chat model reads mail, messages and web pages
 * somebody else wrote, and a model steered by one of them into `messaging.send`
 * or `memory.forget` met no confirmation at all.
 *
 * So the mapping is the mode's own rule, stated for actions rather than for
 * guesses: only `hands_off` — the owner explicitly choosing to be asked nothing —
 * runs a destructive or external intent unattended. `balanced` and `cautious`
 * both produce an approval card. This is consulted only for intents
 * {@link needsConfirmation} already flags, so an ordinary read or write never
 * reaches it.
 */
export function trustForToolCall(trustMode: TrustMode): TrustDecision {
  return trustMode === 'hands_off' ? 'auto' : 'review';
}

/**
 * How long an unanswered proposal stays answerable.
 *
 * A day, not a year: this is a confirmation prompt, not an audit record. A
 * "delete my 2019 photos" the user never answered should not still be one tap
 * from firing a week later, by which time neither they nor the appliance can
 * reconstruct what was being asked.
 */
export const DEFAULT_PENDING_ACTION_TTL_HOURS = 24;

/**
 * How long a RESOLVED row is kept before the sweep deletes it — the house
 * 365-day retention convention. Shipped with the table rather than promised
 * later, because this table gains a row per queued intent forever otherwise.
 */
export const PENDING_ACTION_RETENTION_DAYS = 365;

/** A bound on one sweep, for the same reason `AskExpiryService` has one. */
export const PENDING_ACTION_SWEEP_BATCH_SIZE = 200;

export interface SweepOutcome {
  expired: number;
  pruned: number;
}

/**
 * Owns `ci.pending_actions`: the gate ruling, the row it writes, and the
 * lifecycle transitions over it.
 *
 * Deliberately knows nothing about executing a tool. `ToolRegistry` injects
 * this service (to ask {@link evaluate} and to {@link propose}); the confirmed
 * run is driven the other way round by `PendingActionConfirmService`, which
 * injects both. Splitting it that way is what keeps the dependency acyclic.
 */
@Injectable()
export class PendingActionService {
  constructor(
    @InjectRepository(PendingActionEntity)
    private readonly repository: Repository<PendingActionEntity>,
    private readonly personalization: PersonalizationService,
    private readonly features: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PendingActionService.name);
  }

  /**
   * The gate's answer for one about-to-run intent.
   *
   * Called from `ToolRegistry.executeTool` **after** its own `capabilityAllows`
   * check has already passed, so a capability denial never reaches this method
   * and therefore can never be turned into a queue row. {@link resolveToolGate}
   * re-runs the same check anyway (via `resolveDispatch`) as the second half of
   * that belt-and-braces pair.
   */
  async evaluate(schema: IntentDefinition, context: ToolInvocationContext): Promise<ToolGateRuling> {
    const capability = context.capability;

    // A confirmation the owner actually gave stands the gate aside — but only a
    // real one. The id is not trusted as a token: the row must exist, belong to
    // this user, and be `approved`. Anything else falls through to a normal
    // evaluation, so a forged or stale id gets the gate rather than a bypass.
    if (context.pendingActionId) {
      const confirmed = await this.repository.findOne({
        where: { id: context.pendingActionId, userId: context.userId },
      });

      if (confirmed && authorisesExecution(confirmed.status)) {
        return {
          decision: 'execute',
          reason: 'allowed',
          explanation: `"${schema.name}" was confirmed by the owner`,
        };
      }
    }

    if (!(await this.features.isFeatureEnabled(PENDING_ACTIONS_FEATURE))) {
      // Flag off is the pre-gate behaviour, exactly: appliance tier, no trust dial.
      // The tier is pinned rather than read from the context on purpose — a
      // `?tier=local` caller must not be able to reach a queue branch that this
      // appliance has switched off.
      // `principal` is passed even here, on purpose. The flag gates the DIAL-driven
      // review; it must not also gate the harness rule, or turning it off would
      // silently restore unattended destructive calls for installed apps — which
      // is exactly the window `capabilityForApp`'s `full` opened.
      return resolveToolGate(schema, {
        tier: 'appliance',
        capability,
        trust: null,
        principal: context.principal,
      });
    }

    const tier = context.tier ?? 'appliance';

    // The dial is consulted ONLY for the intents that could need confirming,
    // and only when there is an owner to consult it for. Every ordinary read or
    // write skips it entirely, so the gate cannot slow or change them. The
    // profile read is cached per user inside PersonalizationService.
    const trust =
      needsConfirmation(schema) && context.userId && context.principal !== 'managed-app'
        ? trustForToolCall((await this.personalization.getProfile(context.userId)).trustMode)
        : null;

    return resolveToolGate(schema, { tier, capability, trust, principal: context.principal });
  }

  /**
   * Park a queued intent for the owner to answer. Returns the row so the caller
   * can name it in the `TOOL_QUEUED` result.
   *
   * `userId` is required by the table (it is the FK to the person whose
   * confirmation is being asked for), which is why `executeTool` refuses rather
   * than executes when a queue ruling arrives without one.
   */
  async propose(
    schema: IntentDefinition,
    toolName: string,
    context: ToolInvocationContext & { userId: string },
    input: unknown,
    ruling: ToolGateRuling,
    now: Date = new Date(),
  ): Promise<PendingAction> {
    const row = this.repository.create({
      id: uuidv7(),
      userId: context.userId,
      intent: schema.name,
      tool: toolName,
      input: input ?? {},
      reason: ruling.reason,
      origin: context.tier ?? 'appliance',
      actor: context.capability,
      // Only meaningful for a managed app; the owner proposing their own action
      // is not a third party the card needs to name.
      principalName: context.principal === 'managed-app' ? (context.principalName ?? null) : null,
      status: 'proposed',
      expiresAt: new Date(now.getTime() + DEFAULT_PENDING_ACTION_TTL_HOURS * 60 * 60 * 1000),
      resolvedAt: null,
      result: null,
    });

    const saved = await this.repository.save(row);

    this.logger.log(`Queued intent for confirmation: ${schema.name}`, {
      pendingActionId: saved.id,
      intent: schema.name,
      tool: toolName,
      userId: context.userId,
      reason: ruling.reason,
      origin: saved.origin,
      actor: saved.actor,
    });

    return saved;
  }

  /** One user's queue, newest first. */
  async list(userId: string, status?: PendingActionStatus): Promise<PendingAction[]> {
    return this.repository.find({
      where: { userId, ...(status ? { status } : {}) },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  async findForUser(userId: string, id: string): Promise<PendingAction | null> {
    return this.repository.findOne({ where: { id, userId } });
  }

  /** `proposed → approved`. Asserted, so an already-answered row throws. */
  async markApproved(userId: string, id: string): Promise<PendingAction> {
    return this.transition(userId, id, 'approved');
  }

  /** `approved → executed`, stamping what the confirmed run actually returned. */
  async markExecuted(userId: string, id: string, result: ToolResult): Promise<PendingAction> {
    return this.transition(userId, id, 'executed', result);
  }

  /** `proposed → declined`. */
  async decline(userId: string, id: string): Promise<PendingAction> {
    return this.transition(userId, id, 'declined');
  }

  /**
   * `proposed → expired` for one row. Public because the confirm path retires
   * an overdue row on the spot rather than leaving the owner staring at a
   * proposal that will refuse to run.
   */
  async expire(userId: string, id: string): Promise<PendingAction> {
    return this.transition(userId, id, 'expired');
  }

  private async transition(
    userId: string,
    id: string,
    to: PendingActionStatus,
    result?: ToolResult,
  ): Promise<PendingAction> {
    const row = await this.repository.findOne({ where: { id, userId } });

    if (!row) {
      throw new Error(`Pending action ${id} not found`);
    }

    // Assert BEFORE the write, the way `assertAskTransition` is used: an
    // illegal edge must never reach the row.
    row.status = assertPendingActionTransition(row.status, to);

    if (to !== 'approved') {
      row.resolvedAt = new Date();
    }

    if (result !== undefined) {
      row.result = result;
    }

    return this.repository.save(row);
  }

  /**
   * Retire overdue proposals and prune long-resolved rows.
   *
   * Both halves in one sweep because both are the same maintenance obligation
   * for the same table, and shipping the table without them is how a queue
   * becomes an unbounded log. Driven by `PendingActionExpiryCron`.
   */
  async sweep(now: Date = new Date()): Promise<SweepOutcome> {
    const overdue = await this.repository.find({
      // A NULL `expires_at` never satisfies the comparison, so a deadline-free
      // proposal is never swept — same rule as `AskExpiryService`.
      where: { status: 'proposed', expiresAt: LessThan(now) },
      order: { expiresAt: 'ASC' },
      take: PENDING_ACTION_SWEEP_BATCH_SIZE,
    });

    let expired = 0;
    for (const row of overdue) {
      try {
        await this.expire(row.userId, row.id);
        expired += 1;
      } catch (err) {
        // One malformed row must not abandon the rest of the batch: everything
        // behind it would stay confirmable past its deadline, which is the
        // exact state this sweep exists to end.
        this.logger.error(
          `Failed to expire pending action ${row.id}`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    const cutoff = new Date(now.getTime() - PENDING_ACTION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { affected } = await this.repository.delete({
      status: In([...TERMINAL_PENDING_ACTION_STATUSES]),
      resolvedAt: LessThan(cutoff),
    });

    if (expired > 0 || (affected ?? 0) > 0) {
      this.logger.log(`Pending-action sweep: expired ${expired}, pruned ${affected ?? 0}`);
    }

    return { expired, pruned: affected ?? 0 };
  }
}
