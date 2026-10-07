import type { ToolRequestContext } from '../context';
import { coerceArgumentsToSchema } from '../core/coerceArguments';
import type { ToolHandle } from '../core/ToolHandle';
import {
  canonicalizeExecutableToolName,
  intentToolName,
  type IntentDefinition,
  type IntentPrivacy,
  type ToolInvocationContext,
  type ToolResult,
  type ToolSchema,
} from '../core/types';
import {
  TOOL_INVOCATION_ERROR_MAX_LENGTH,
  type ToolInvocationOutcome,
  type ToolInvokedPayload,
} from '../events';
import type { ToolCoreLogger } from '../logging';
import { capabilityAllows, capabilityRequiredFor, stricterPrivacy } from '../policy';
import type { ToolGateRuling } from '../policy/toolGate';
import type { ProviderHealthStatus, ToolProvider } from '../providers/ToolProvider';

import type { ToolGate, ToolInvocationSink } from './ports';

/**
 * Centralized registry for managing all tools from various providers.
 *
 * Every tool is an intent: its `schema.name` is the dotted semantic id (e.g. `memory.recall`),
 * while the registry keys tools by the executable name ({@link intentToolName}, e.g.
 * `memory_recall`) — the same name advertised to the LLM and MCP, so a tool call round-trips by
 * that name.
 *
 * ## Why this class is framework-free
 *
 * It has three collaborators — a logger, somewhere to record invocations, and the confirmation
 * queue — and it used to name all three by their Nest class. That made the one chokepoint every
 * dispatcher goes through reachable only from inside the Nest process, which is backwards: the
 * MCP server, the LLM dispatcher and (eventually) the CLI all need the same rules, and only the
 * in-process ones could have them. Each collaborator is now a small interface (see `./ports`), and
 * the API supplies its Nest providers as implementations from a thin subclass
 * (`domains/tools/registry/ToolRegistry.ts`).
 *
 * Generic over the tool type so that subclass keeps its own: the API instantiates
 * `ToolRegistryCore<BaseTool>`, so `getTool` there still hands back a `BaseTool`.
 */
export class ToolRegistryCore<TTool extends ToolHandle = ToolHandle> {
  private readonly providers = new Map<string, ToolProvider<TTool>>();

  private readonly tools = new Map<string, TTool>();

  private readonly toolToProvider = new Map<string, string>();

  constructor(
    protected readonly logger: ToolCoreLogger,
    private readonly invocations: ToolInvocationSink,
    private readonly pendingActions: ToolGate,
  ) {
    this.logger.setContext('ToolRegistry');
  }

  /**
   * Bring the registry up. Called from the host's own lifecycle hook — the API's Nest subclass
   * calls it from `onModuleInit`, so the framework's vocabulary stays on the framework's side of
   * the boundary.
   */
  async start(): Promise<void> {
    this.logger.debug('Initializing ToolRegistry');
  }

  /** The counterpart to {@link start}: shut every provider down and forget every tool. */
  async stop(): Promise<void> {
    this.logger.debug('Shutting down ToolRegistry');
    await this.shutdownProviders();
  }

  /**
   * Register a tool provider
   */
  async registerProvider(provider: ToolProvider<TTool>): Promise<void> {
    if (this.providers.has(provider.name)) {
      throw new Error(`Provider '${provider.name}' is already registered`);
    }

    this.providers.set(provider.name, provider);

    this.logger.debug(`Registered provider: ${provider.name}`);

    // Initialize provider and load its tools
    await this.initializeProvider(provider);
  }

  /**
   * Initialize a specific provider and load its tools
   */
  private async initializeProvider(provider: ToolProvider<TTool>): Promise<void> {
    try {
      await provider.initialize();
      await this.loadToolsFromProvider(provider);

      this.logger.debug(`Initialized provider: ${provider.name}`);
    } catch (error) {
      this.logger.error(`Failed to initialize provider: ${provider.name}`, error as Error);
    }
  }

  /**
   * Load tools from a provider into the registry
   */
  private async loadToolsFromProvider(provider: ToolProvider<TTool>): Promise<void> {
    try {
      const schemas = await provider.getAvailableTools();

      for (const schema of schemas) {
        const tool = provider.getTool(schema.name);
        if (tool) {
          this.registerTool(tool, provider.name);
        }
      }

      this.logger.debug(`Loaded ${schemas.length} tools from provider: ${provider.name}`);
    } catch (error) {
      this.logger.error(`Failed to load tools from provider: ${provider.name}`, error as Error);
    }
  }

  /**
   * Register a tool from a provider. Keyed by the executable name (dots→underscores) so it
   * matches what the LLM/MCP call back with.
   */
  private registerTool(tool: TTool, providerName: string): void {
    const name = intentToolName(tool.schema.name);

    if (this.tools.has(name)) {
      this.logger.warn(`Tool '${name}' is already registered, skipping`);

      return;
    }

    this.tools.set(name, tool);
    this.toolToProvider.set(name, providerName);

    this.logger.debug(`Registered tool: ${name}`, {
      toolName: name,
      intent: tool.schema.name,
      provider: providerName,
      category: tool.schema.category,
    });
  }

  /**
   * Re-read an already-registered provider's tool list and replace what the registry has on file
   * for it.
   *
   * Every other tool set is fixed at boot (native tools, persona's single tool), so nothing has
   * needed this until now: an MCP-client provider's tools change at RUNTIME — a server connects,
   * reconnects with a different tools/list, or gets disabled — and there was previously no way to
   * make the registry see that without a full restart.
   *
   * First drops every tool currently mapped to `providerName` (from both the tools map and
   * toolToProvider map), then re-runs {@link loadToolsFromProvider} against the provider instance
   * already tracked in `providers` — the same load path `registerProvider` uses, just without
   * re-initializing or re-adding the provider itself.
   */
  async refreshProvider(providerName: string): Promise<void> {
    const provider = this.providers.get(providerName);

    if (!provider) {
      throw new Error(`Provider '${providerName}' is not registered`);
    }

    for (const [toolName, ownerName] of Array.from(this.toolToProvider.entries())) {
      if (ownerName === providerName) {
        this.tools.delete(toolName);
        this.toolToProvider.delete(toolName);
      }
    }

    await this.loadToolsFromProvider(provider);

    this.logger.debug(`Refreshed provider: ${providerName}`);
  }

  /**
   * Shutdown all providers
   */
  private async shutdownProviders(): Promise<void> {
    const promises = Array.from(this.providers.values()).map(async (provider) => {
      try {
        await provider.shutdown();
      } catch (error) {
        this.logger.error(`Error shutting down provider: ${provider.name}`, error as Error);
      }
    });
    await Promise.all(promises);

    this.providers.clear();
    this.tools.clear();
    this.toolToProvider.clear();
  }

  /**
   * Get all available tool schemas (for LLM function calling). Schemas carry the dotted intent
   * `name`; callers that advertise to the LLM/MCP derive the executable name via
   * {@link intentToolName}.
   *
   * Tools that name an {@link IntentDefinition.ownerUserId} are visible only to that user. This
   * map is process-global and every provider loads into it once, so an MCP-client tool built from
   * one account's stored server config would otherwise be offered to every other account's chat —
   * along with the description of a server they never configured. `context` was previously logged
   * here and nothing else; it now decides what the caller is shown.
   */
  getAvailableTools(context?: ToolRequestContext): ToolSchema[] {
    const schemas = Array.from(this.tools.values())
      .map((tool) => tool.schema)
      .filter((schema) => this.isVisibleTo(schema, context?.userId));

    this.logger.debug(`Retrieved ${schemas.length} available tools`, {
      userId: context?.userId,
      toolNames: schemas.map((s) => s.name),
    });

    return schemas;
  }

  /**
   * An unowned tool is everyone's; an owned one is only its owner's.
   *
   * A caller with no `userId` (an api-key request that never resolved to a user, an in-process
   * system job) is deliberately treated as "nobody", not as "everybody": the alternative would
   * make an unauthenticated surface the widest one.
   */
  private isVisibleTo(schema: ToolSchema, userId: string | undefined): boolean {
    return schema.ownerUserId == null || schema.ownerUserId === userId;
  }

  /**
   * The tool list to advertise to an LLM / MCP client. Every tool is a curated intent, so this is
   * simply the full list — there is no raw/intent two-tier distinction to filter.
   */
  getAgentFacingTools(context?: ToolRequestContext): ToolSchema[] {
    return this.getAvailableTools(context);
  }

  /**
   * The tool list CI-Server advertises on its OWN outbound surfaces: the `/api/intents` manifest
   * and the tools its own MCP server exposes to a connecting client.
   *
   * Excludes every tool whose owning provider set {@link ToolProvider.includeInOutboundCatalog}
   * to `false` — today, exactly the MCP-client provider, so that a tool sourced from a user's own
   * external MCP server is usable in chat but is not re-published as if CI-Server originated it.
   * Republishing it would also let an outside caller reach back through CI-Server to that same
   * external server, which is the recursive re-exposure this method exists to prevent.
   *
   * Deliberately separate from {@link getAvailableTools}: chat/agent dispatch must still see every
   * provider's tools, so that method (and {@link getAgentFacingTools}) stays a full, unfiltered
   * list.
   */
  getOutboundCatalogTools(context?: ToolRequestContext): ToolSchema[] {
    const schemas = this.outboundCatalogSchemas()
      // A user-owned tool is never part of the appliance's public manifest, whatever its
      // provider's flag says: with no caller it is nobody's, and with a caller it is listed only
      // to its owner. The `messaging.*` intents are the case where the two rules part: they are
      // native tools (in the catalog) owned by whoever the BlueBubbles connector belongs to.
      .filter((schema) => this.isVisibleTo(schema, context?.userId));

    this.logger.debug(`Retrieved ${schemas.length} outbound-catalog tools`, {
      userId: context?.userId,
      toolNames: schemas.map((s) => s.name),
    });

    return schemas;
  }

  /**
   * The outbound catalog BEFORE the per-account ownership filter.
   *
   * For a transport that builds its tool list once, before any caller exists, and filters each
   * request itself with {@link isToolVisibleTo}. MCP is that transport: its map is built at boot,
   * and an owned tool there would otherwise be missing for its own owner as well. Never hand this
   * list to a caller as it is.
   */
  getOutboundCatalogToolsForEveryOwner(): ToolSchema[] {
    return this.outboundCatalogSchemas();
  }

  /** Every registered tool whose provider takes part in the outbound catalog. */
  private outboundCatalogSchemas(): ToolSchema[] {
    return Array.from(this.tools.entries())
      .filter(([toolName]) => {
        const providerName = this.toolToProvider.get(toolName);
        const provider = providerName ? this.providers.get(providerName) : undefined;

        return provider?.includeInOutboundCatalog !== false;
      })
      .map(([, tool]) => tool.schema);
  }

  /**
   * Whether `userId` may see (and so run) the tool `name` resolves to: the rule
   * {@link getAvailableTools} filters with and {@link executeTool} refuses on, asked about one
   * tool. False for a name that resolves to nothing.
   *
   * Reads the schema now, not at registration: a tool may decide its owner at runtime.
   */
  isToolVisibleTo(name: string, userId: string | undefined): boolean {
    const resolved = this.resolveRegisteredTool(name);

    return resolved != null && this.isVisibleTo(resolved.tool.schema, userId);
  }

  /**
   * Check if a tool exists (by executable name).
   */
  hasTool(name: string): boolean {
    return this.resolveRegisteredTool(name) != null;
  }

  /**
   * Resolve an LLM-emitted name onto a registered tool. Qwen often drops
   * underscores (`memoryremember`) or keeps the dotted intent id.
   */
  private resolveRegisteredTool(name: string): { name: string; tool: TTool } | undefined {
    const canonical = canonicalizeExecutableToolName(name);

    for (const candidate of [canonical, name, intentToolName(name)]) {
      const tool = this.tools.get(candidate);
      if (tool) {
        return { name: candidate, tool };
      }
    }

    const mashed = name.replace(/[_.-]/g, '').toLowerCase();
    if (!mashed) {
      return undefined;
    }

    for (const [key, tool] of this.tools) {
      if (key.replace(/_/g, '').toLowerCase() === mashed) {
        return { name: key, tool };
      }
    }

    return undefined;
  }

  /**
   * Execute a tool by its executable name, **after checking the caller's authority against the
   * tool's privacy label**. Donates the invocation (success or failure) as a behavioral signal for
   * prediction.
   *
   * The check lives here rather than in each dispatcher because that is what went wrong before:
   * MCP enforced it, the LLM dispatcher did not, and the two were only ever kept in step by
   * whoever remembered. `context.capability` is mandatory (see {@link ToolInvocationContext}), so
   * a new dispatcher cannot arrive at this method without having stated an authority.
   *
   * Refusal is returned as a failed {@link ToolResult}, not thrown — matching TOOL_NOT_FOUND, and
   * giving the model a legible "you are not allowed to do that" to relay instead of an opaque
   * "tool execution failed". Transports that owe their client an HTTP status (MCP) keep their own
   * pre-check and throw there; this is the backstop underneath it.
   *
   * ## Two gates, in this order, and the order is the security property
   *
   * 1. `capabilityAllows` → `TOOL_FORBIDDEN`. A caller without the authority is refused, full
   *    stop. **A denial is never written to `ci.pending_actions`.** `dispatchPolicy.ts` orders
   *    capability before tier for exactly this reason: queuing a refusal would turn "you may not
   *    do that" into "you may do that after one extra tap".
   * 2. {@link ToolGate.evaluate} → `TOOL_QUEUED`. An intent the caller IS authorised for but that
   *    must not fire unconfirmed — destructive or external work under a cautious trust dial, or
   *    anything `resolveDispatch` refuses to run in the tier the call came from — is parked as a
   *    pending action and reported back, symmetrically with the refusal above: a ToolResult, never
   *    a throw, so the model receives it conversationally and can tell the user their appliance is
   *    waiting on them.
   */
  async executeTool(name: string, context: ToolInvocationContext, input: unknown): Promise<ToolResult> {
    const resolved = this.resolveRegisteredTool(name);

    if (!resolved) {
      this.logger.warn(`Attempted to execute unknown tool: ${name}`, {
        toolName: name,
        userId: context.userId,
        availableTools: Array.from(this.tools.keys()),
      });

      return {
        success: false,
        error: {
          code: 'TOOL_NOT_FOUND',
          message: `Tool '${name}' not found`,
          retryable: false,
        },
      };
    }

    const { name: toolName, tool } = resolved;

    // Ownership before capability, and reported as "not found" rather than "forbidden": a tool
    // built from someone else's stored config does not exist as far as this caller is concerned,
    // and a distinct refusal would confirm that another account has a server by that name.
    // Hiding it from `getAvailableTools` is presentation only — a model (or a client naming a
    // tool directly) can ask for anything, which is why the refusal lives here.
    if (!this.isVisibleTo(tool.schema, context.userId)) {
      this.logger.warn(`Refused tool owned by another user: ${name}`, {
        toolName,
        intent: tool.schema.name,
        userId: context.userId,
        provider: this.toolToProvider.get(toolName),
      });

      return {
        success: false,
        error: {
          code: 'TOOL_NOT_FOUND',
          message: `Tool '${name}' not found`,
          retryable: false,
        },
      };
    }

    // Coerced once, here, so the per-call label is computed over exactly what the tool will run on.
    const coerced = coerceArgumentsToSchema(input, tool.schema.parameters);

    // The label THIS call earns, never weaker than the declared one. Everything below (the
    // capability check, the gate, the queued row and the ledger) reads it, so a call that erases
    // data is judged as one even when its tool is declared by its mildest use. A caller the
    // declared label already refuses is refused on it, without asking the tool anything.
    const privacy = capabilityAllows(tool.schema.privacy, context.capability)
      ? await this.privacyOfCall(tool, context, coerced)
      : tool.schema.privacy;
    const schema: IntentDefinition =
      privacy === tool.schema.privacy ? tool.schema : { ...tool.schema, privacy };

    if (!capabilityAllows(privacy, context.capability)) {
      const required = capabilityRequiredFor(privacy);

      // Warn, not debug: a refused call is a caller trying to do something it was not granted —
      // whether that is a misconfigured integration or an injected chat message, an operator wants
      // to see it.
      this.logger.warn(`Refused tool: ${name}`, {
        toolName: name,
        intent: tool.schema.name,
        userId: context.userId,
        capability: context.capability,
        requiredCapability: required,
        access: privacy.access,
        destructive: privacy.destructive,
      });

      const message = `Tool '${name}' requires "${required}" access, but this caller is "${context.capability}"`;

      // Emitted as `tool.invoked` with `outcome: 'refused'`. This used to be deliberately silent,
      // with a good reason: nothing was invoked, and feeding a refusal into the behavioral signal
      // would teach prediction that the user did this. That reason is intact and now expressed in
      // the data instead of in the absence of it — HBPE and any other behavioural consumer filter
      // `outcome <> 'refused'` and see exactly what they saw before. What changes is that the
      // operator, for whom a denied call is the single most interesting row in the ledger, can now
      // see it after the log line has scrolled away.
      await this.recordInvocation({
        ...this.invocationFacts(toolName, tool, context, schema),
        outcome: 'refused',
        errorCode: 'TOOL_FORBIDDEN',
        error: message,
        // No duration: nothing ran, so there is nothing to have taken time. A zero here would read
        // as "the tool returned instantly".
      });

      return {
        success: false,
        error: {
          code: 'TOOL_FORBIDDEN',
          message,
          retryable: false,
        },
      };
    }

    // The dispatch gate. Reached only by a caller the capability check already cleared, so
    // everything below decides WHETHER TO ASK, never whether the caller is allowed.
    const gate = await this.pendingActions.evaluate(schema, context);

    if (gate.decision !== 'execute') {
      return this.refuseOrQueue(toolName, tool, schema, context, input, gate);
    }

    if (privacy.external) {
      // `external` is the label that says data leaves the appliance, which is the one thing CI
      // promises it does not do quietly. It no longer gates nothing: an external intent that
      // reaches this line is one the gate above cleared — the trust dial said auto, or the
      // pending action was confirmed. The warn stays as the record of every egress.
      this.logger.warn(`Intent leaves the appliance: ${name}`, {
        toolName: name,
        intent: tool.schema.name,
        userId: context.userId,
        sensitivity: privacy.sensitivity,
        gate: gate.reason,
      });
    }

    this.logger.log(`Executing tool: ${toolName}`, {
      toolName,
      userId: context.userId,
      provider: this.toolToProvider.get(toolName),
    });

    // Typed to the schema the model was shown, before the tool's own validation sees it: every
    // transport reaches this line, so a `"15"` for an integer is fixed once here rather than in
    // each markup salvager and engine parser. See coerceArgumentsToSchema.
    const result = await tool.execute(context, coerced);

    await this.recordInvocation({
      ...this.invocationFacts(toolName, tool, context, schema),
      outcome: outcomeOf(result),
      errorCode: result.error?.code,
      error: result.error?.message,
      durationMs: result.executionTimeMs,
    });

    return result;
  }

  /**
   * The label a call to `name` with `input` would be judged by: the stricter of the tool's
   * declared label and its own per-call answer ({@link ToolHandle.privacyFor}). `undefined` for a
   * tool this caller cannot see.
   *
   * Public for the confirm path, which re-checks the CONFIRMING principal's capability before it
   * marks a row approved and must judge the stored input the way {@link executeTool} will.
   */
  async privacyOf(
    name: string,
    context: ToolInvocationContext,
    input: unknown,
  ): Promise<IntentPrivacy | undefined> {
    const resolved = this.resolveRegisteredTool(name);

    if (!resolved || !this.isVisibleTo(resolved.tool.schema, context.userId)) {
      return undefined;
    }

    const { tool } = resolved;

    return this.privacyOfCall(tool, context, coerceArgumentsToSchema(input, tool.schema.parameters));
  }

  /**
   * {@link privacyOf} for a resolved tool and an already-coerced input.
   *
   * A per-call answer that throws (a lookup the tool needed failed) is read as destructive rather
   * than as the declared label: the failure must cost a confirmation, never skip one.
   */
  private async privacyOfCall(
    tool: TTool,
    context: ToolInvocationContext,
    input: unknown,
  ): Promise<IntentPrivacy> {
    const declared = tool.schema.privacy;

    if (!tool.privacyFor) {
      return declared;
    }

    try {
      return stricterPrivacy(declared, await tool.privacyFor(context, input));
    } catch (error) {
      this.logger.warn(`Could not label this call to ${tool.schema.name}; treating it as destructive`, {
        intent: tool.schema.name,
        userId: context.userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return { ...declared, destructive: true };
    }
  }

  /**
   * Turn a non-`execute` gate ruling into a {@link ToolResult}.
   *
   * A `deny` (which `capabilityAllows` above has already caught — this is the belt to its braces)
   * is refused outright and **never** written to the queue. A `queue` is parked and named, so the
   * caller has an id to approve.
   *
   * Deliberately NOT emitted as `tool.invoked`, for the same reason a refusal is not: nothing was
   * invoked, and feeding a queued proposal into the behavioural signal would teach prediction that
   * the user did this.
   */
  private async refuseOrQueue(
    toolName: string,
    tool: TTool,
    schema: IntentDefinition,
    context: ToolInvocationContext,
    input: unknown,
    gate: ToolGateRuling,
  ): Promise<ToolResult> {
    if (gate.decision === 'deny') {
      this.logger.warn(`Refused tool at dispatch gate: ${toolName}`, {
        toolName,
        intent: tool.schema.name,
        userId: context.userId,
        capability: context.capability,
        reason: gate.reason,
      });

      return {
        success: false,
        error: { code: 'TOOL_FORBIDDEN', message: gate.explanation, retryable: false },
      };
    }

    if (!context.userId) {
      // The queue is owner-scoped: there is nobody to ask. Refusing is the safe direction —
      // executing anyway would be the gate quietly deciding it did not matter.
      this.logger.warn(`Cannot queue intent without an owner: ${toolName}`, {
        toolName,
        intent: tool.schema.name,
        reason: gate.reason,
      });

      return {
        success: false,
        error: {
          code: 'TOOL_CONFIRMATION_UNAVAILABLE',
          message: `${gate.explanation}, but this call has no user to confirm it`,
          retryable: false,
        },
      };
    }

    const action = await this.pendingActions.propose(
      schema,
      toolName,
      { ...context, userId: context.userId },
      input,
      gate,
    );

    return {
      success: false,
      error: {
        code: 'TOOL_QUEUED',
        message: gate.explanation,
        // Retryable in the sense that matters to a caller: the same call succeeds once the owner
        // approves. Re-issuing it blindly only queues a second proposal, which is why the id and
        // the deadline are handed back.
        retryable: false,
        details: {
          pendingActionId: action.id,
          reason: gate.reason,
          expiresAt: action.expiresAt?.toISOString() ?? null,
        },
      },
    };
  }

  /**
   * The half of a {@link ToolInvokedPayload} that is the same whether the call ran or was refused:
   * who called, what they named, and the curated privacy facets of it.
   *
   * `occurredAt` is stamped here rather than left to the consumer because the event is durable —
   * it can be delivered minutes later, or replayed off a dead letter, and a row timestamped at
   * insert time would silently date every replayed call to the replay.
   */
  private invocationFacts(
    toolName: string,
    tool: TTool,
    context: ToolInvocationContext,
    // The schema carrying the label this call was judged by, so the ledger row says what the
    // call could do rather than what its tool is declared to do at its mildest.
    schema: IntentDefinition = tool.schema,
  ): Omit<ToolInvokedPayload, 'outcome'> {
    return {
      intent: schema.name,
      tool: toolName,
      domain: schema.domain,
      source: this.toolToProvider.get(toolName) ?? 'unknown',
      userId: context.userId,
      correlationId: context.traceId,
      apiKeyId: context.apiKeyId,
      capability: context.capability,
      // WHO and WHERE-FROM, both of which were already on the context and both
      // of which this builder used to drop. `capability` alone cannot tell the
      // owner's own `full` key from an installed harness's, which is precisely
      // the distinction the managed-app gate turns on — so a ledger without
      // these cannot show what the gate did.
      principal: context.principal,
      // `?? undefined` because the context models "no app" as null while the
      // payload models it as absent; writing the null through would put a
      // JSON `null` into the pg-boss job body for every owner-originated call.
      principalName: context.principalName ?? undefined,
      tier: context.tier,
      occurredAt: new Date().toISOString(),
      access: schema.privacy.access,
      external: schema.privacy.external,
      destructive: schema.privacy.destructive,
    };
  }

  /**
   * Hand the durable `tool.invoked` signal to the {@link ToolInvocationSink} — in the API, an
   * event routed to the `telemetry` queue, which `ToolInvokedListener` appends to
   * `ci.tool_invocations`. Never throws: a telemetry failure must not fail an already-completed
   * tool call.
   *
   * Public because the GraphQL-over-MCP plane does not go through this registry at all —
   * `McpToolService` branches on `tool.source === 'graphql'` and returns via the GraphQL executor,
   * so without a way in it would be the one dispatcher with no ledger row. It calls this.
   *
   * Truncates `error` to {@link TOOL_INVOCATION_ERROR_MAX_LENGTH} here rather than only at the
   * insert: the payload is serialised into `pgboss.job` on the way, and an unbounded tool error
   * message would be copied into the queue table too.
   */
  async recordInvocation(payload: ToolInvokedPayload): Promise<void> {
    try {
      await this.invocations.record({
        ...payload,
        error: payload.error?.slice(0, TOOL_INVOCATION_ERROR_MAX_LENGTH),
      });
    } catch (error) {
      this.logger.warn('tool.invoked emit failed (non-fatal)', { error });
    }
  }

  /**
   * Get tool by executable name (for testing/debugging)
   */
  getTool(name: string): TTool | undefined {
    return this.tools.get(name);
  }

  /**
   * List all registered (executable) tool names
   */
  getRegisteredToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get provider health status
   */
  async getProvidersHealthStatus(): Promise<ProviderHealthStatus[]> {
    const promises = Array.from(this.providers.values()).map((provider) => provider.getHealthStatus());

    return Promise.all(promises);
  }

  /**
   * Get tools by provider
   */
  getToolsByProvider(providerName: string): ToolSchema[] {
    return Array.from(this.tools.entries())
      .filter(([toolName]) => this.toolToProvider.get(toolName) === providerName)
      .map(([, tool]) => tool.schema);
  }
}

/**
 * Which of the four outcomes a completed {@link ToolResult} represents.
 *
 * A deadline is separated from an ordinary failure because the two need different operator
 * responses — a timeout says the appliance or a third party is slow, an error says the call was
 * wrong — and the only evidence either way is the error code the tool chose.
 */
export function outcomeOf(result: ToolResult): ToolInvocationOutcome {
  if (result.success) {
    return 'success';
  }

  return result.error?.code != null && /TIMEOUT|TIMED_OUT|ETIMEDOUT/i.test(result.error.code)
    ? 'timeout'
    : 'error';
}
