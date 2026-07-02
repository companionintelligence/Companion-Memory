import { Injectable } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';

import type { IntentPrivacy, ToolSchema } from '../core/types';
import { IntentAuthorizedEvent, IntentDeniedEvent, type IntentSurface } from '../events';

/**
 * Runtime policy that turns the {@link IntentPrivacy} labels into execution-time enforcement.
 *
 * The whole "trust as the product" pitch rests on these labels being *load-bearing*, not
 * decorative — so the dispatcher is the single gate every execution surface (native
 * {@link ToolRegistry}, MCP {@link McpToolService}, and the future `AppIntentToolProvider`) must
 * pass through before running a tool. See the agents-and-intents subsystem plan §4 (P0) and §5.
 */
export interface IntentPolicy {
  /**
   * Deny `destructive` intents by default. There is no interactive user on the API-key / MCP
   * path, so we cannot safely prompt for confirmation yet (plan §5: "Deny-by-default policy
   * config now; MCP elicitation + Hub notification queue as the P1 follow-on. Never silently
   * auto-confirm destructive"). Operators can opt in per-deployment.
   */
  denyDestructive: boolean;
  /** Deny `external` intents (data leaves the appliance) rather than merely warning. */
  denyExternal: boolean;
  /** Deny intents touching `sensitive` data. Off by default; the label still rides the audit. */
  denySensitive: boolean;
}

/** The default deny-by-default posture (destructive blocked, external allowed-with-warning). */
export const DEFAULT_INTENT_POLICY: IntentPolicy = {
  denyDestructive: true,
  denyExternal: false,
  denySensitive: false,
};

/** Outcome of an authorization check. `allowed: false` must short-circuit execution. */
export type IntentDecision =
  | { allowed: true; warned: boolean }
  | { allowed: false; reason: string; message: string };

/**
 * Read the policy from the environment, falling back to {@link DEFAULT_INTENT_POLICY}. Env values
 * are opt-*out* toggles so a deployment that sets nothing gets the safe default-deny posture.
 */
function policyFromEnv(): IntentPolicy {
  const flag = (name: string, fallback: boolean): boolean => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
      return fallback;
    }

    return raw === 'true' || raw === '1';
  };

  return {
    denyDestructive: flag('INTENT_POLICY_DENY_DESTRUCTIVE', DEFAULT_INTENT_POLICY.denyDestructive),
    denyExternal: flag('INTENT_POLICY_DENY_EXTERNAL', DEFAULT_INTENT_POLICY.denyExternal),
    denySensitive: flag('INTENT_POLICY_DENY_SENSITIVE', DEFAULT_INTENT_POLICY.denySensitive),
  };
}

/**
 * The enforcing dispatcher. Callers hand it the invoked tool's schema (which carries the
 * {@link IntentPrivacy} label) and get back an {@link IntentDecision}; a denial must abort the
 * call. Every gated decision emits a durable `intent.authorized` or `intent.denied` audit event
 * alongside the existing `tool.invoked` telemetry.
 */
@Injectable()
export class IntentDispatcherService {
  private readonly policy: IntentPolicy;

  constructor(
    private readonly logger: LoggerService,
    private readonly events: EventService,
    policy?: IntentPolicy,
  ) {
    this.logger.setContext(IntentDispatcherService.name);
    this.policy = policy ?? policyFromEnv();
  }

  /** The active policy (exposed for diagnostics / tests). */
  getPolicy(): IntentPolicy {
    return this.policy;
  }

  /**
   * Decide whether an intent may execute, and record the decision.
   *
   * Order of checks (most-restrictive first): destructive → sensitive → external. `external`
   * defaults to allow-with-warning (CI's local-data pitch means we surface it, but reads of
   * public data such as streaming availability are legitimate). Emitting the audit event never
   * throws — an audit-bus failure must not silently drop the security decision, but it also must
   * not crash the request; failures are logged and the (fail-closed) decision still stands.
   */
  async authorize(
    schema: Pick<ToolSchema, 'name' | 'domain' | 'privacy'>,
    context: RequestContext,
    surface: IntentSurface,
    toolName: string,
  ): Promise<IntentDecision> {
    const { privacy } = schema;

    const denial = this.evaluate(privacy);

    if (denial) {
      await this.emitDenied(schema, context, surface, toolName, denial.reason);

      this.logger.warn(`intent denied: ${schema.name}`, {
        intent: schema.name,
        tool: toolName,
        surface,
        reason: denial.reason,
        userId: context.userId,
      });

      return { allowed: false, ...denial };
    }

    const warned = privacy.external && !this.policy.denyExternal;

    await this.emitAuthorized(schema, context, surface, toolName, warned);

    if (warned) {
      this.logger.warn(`intent authorized with warning (external): ${schema.name}`, {
        intent: schema.name,
        tool: toolName,
        surface,
        userId: context.userId,
      });
    }

    return { allowed: true, warned };
  }

  /** Pure policy evaluation — returns a denial or `null` if permitted. */
  private evaluate(privacy: IntentPrivacy): { reason: string; message: string } | null {
    if (privacy.destructive && this.policy.denyDestructive) {
      return {
        reason: 'destructive_denied_by_policy',
        message:
          'This action is destructive (irreversible data removal) and is blocked by policy. ' +
          'Destructive intents require explicit confirmation, which is not available on this surface.',
      };
    }

    if (privacy.sensitivity === 'sensitive' && this.policy.denySensitive) {
      return {
        reason: 'sensitive_denied_by_policy',
        message: 'This action touches sensitive data and is blocked by policy.',
      };
    }

    if (privacy.external && this.policy.denyExternal) {
      return {
        reason: 'external_denied_by_policy',
        message: 'This action sends data off the appliance and is blocked by policy.',
      };
    }

    return null;
  }

  private async emitAuthorized(
    schema: Pick<ToolSchema, 'name' | 'domain' | 'privacy'>,
    context: RequestContext,
    surface: IntentSurface,
    toolName: string,
    warned: boolean,
  ): Promise<void> {
    try {
      await this.events.send(
        IntentAuthorizedEvent,
        {
          intent: schema.name,
          tool: toolName,
          domain: schema.domain,
          userId: context.userId,
          surface,
          access: schema.privacy.access,
          sensitivity: schema.privacy.sensitivity,
          destructive: schema.privacy.destructive,
          external: schema.privacy.external,
          warned,
        },
        { queue: 'telemetry' },
      );
    } catch (error) {
      this.logger.warn('intent.authorized emit failed (non-fatal)', { error });
    }
  }

  private async emitDenied(
    schema: Pick<ToolSchema, 'name' | 'domain' | 'privacy'>,
    context: RequestContext,
    surface: IntentSurface,
    toolName: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.events.send(
        IntentDeniedEvent,
        {
          intent: schema.name,
          tool: toolName,
          domain: schema.domain,
          userId: context.userId,
          surface,
          access: schema.privacy.access,
          sensitivity: schema.privacy.sensitivity,
          destructive: schema.privacy.destructive,
          external: schema.privacy.external,
          reason,
        },
        { queue: 'telemetry' },
      );
    } catch (error) {
      this.logger.warn('intent.denied emit failed (non-fatal)', { error });
    }
  }
}
