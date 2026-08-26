import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';

import type { BaseTool } from '../core/BaseTool';
import {
  intentToolName,
  canonicalizeExecutableToolName,
  type ToolInvocationContext,
  type ToolSchema,
  type ToolResult,
} from '../core/types';
import {
  TOOL_INVOCATION_ERROR_MAX_LENGTH,
  ToolInvokedEvent,
  type ToolInvocationOutcome,
  type ToolInvokedPayload,
} from '../events';
import { capabilityAllows, capabilityRequiredFor } from '../policy';
import type { ToolProvider, ProviderHealthStatus } from '../providers/ToolProvider';

/**
 * Centralized registry for managing all tools from various providers.
 *
 * Every tool is an intent: its `schema.name` is the dotted semantic id (e.g. `memory.recall`),
 * while the registry keys tools by the executable name ({@link intentToolName}, e.g.
 * `memory_recall`) — the same name advertised to the LLM and MCP, so a tool call round-trips by
 * that name.
 */
@Injectable()
export class ToolRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly providers = new Map<string, ToolProvider>();

  private readonly tools = new Map<string, BaseTool>();

  private readonly toolToProvider = new Map<string, string>();

  constructor(
    private readonly logger: LoggerService,
    private readonly events: EventService,
  ) {
    this.logger.setContext(ToolRegistry.name);
  }

  async onModuleInit() {
    this.logger.debug('Initializing ToolRegistry');
  }

  async onModuleDestroy() {
    this.logger.debug('Shutting down ToolRegistry');
    await this.shutdownProviders();
  }

  /**
   * Register a tool provider
   */
  async registerProvider(provider: ToolProvider): Promise<void> {
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
  private async initializeProvider(provider: ToolProvider): Promise<void> {
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
  private async loadToolsFromProvider(provider: ToolProvider): Promise<void> {
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
  private registerTool(tool: BaseTool, providerName: string): void {
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
  getAvailableTools(context?: RequestContext): ToolSchema[] {
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
  getAgentFacingTools(context?: RequestContext): ToolSchema[] {
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
  getOutboundCatalogTools(context?: RequestContext): ToolSchema[] {
    const schemas = Array.from(this.tools.entries())
      .filter(([toolName]) => {
        const providerName = this.toolToProvider.get(toolName);
        const provider = providerName ? this.providers.get(providerName) : undefined;

        return provider?.includeInOutboundCatalog !== false;
      })
      .map(([, tool]) => tool.schema)
      // A user-owned tool is never part of the appliance's public manifest, whatever its
      // provider's flag says. Today the two rules agree (the only owning provider is also the
      // only one opted out of the catalog), and this is the one that stays true if a future
      // provider sets ownership without opting out.
      .filter((schema) => this.isVisibleTo(schema, context?.userId));

    this.logger.debug(`Retrieved ${schemas.length} outbound-catalog tools`, {
      userId: context?.userId,
      toolNames: schemas.map((s) => s.name),
    });

    return schemas;
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
  private resolveRegisteredTool(name: string): { name: string; tool: BaseTool } | undefined {
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

    const { privacy } = tool.schema;

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
        ...this.invocationFacts(toolName, tool, context),
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

    if (privacy.external) {
      // `external` is the label that says data leaves the appliance, which is the one thing CI
      // promises it does not do quietly. It gates nothing today (see the README note on the warn
      // path); surfacing every egress in the log is the floor, not the finished feature.
      this.logger.warn(`Intent leaves the appliance: ${name}`, {
        toolName: name,
        intent: tool.schema.name,
        userId: context.userId,
        sensitivity: privacy.sensitivity,
      });
    }

    this.logger.log(`Executing tool: ${toolName}`, {
      toolName,
      userId: context.userId,
      provider: this.toolToProvider.get(toolName),
    });

    const result = await tool.execute(context, input);

    await this.recordInvocation({
      ...this.invocationFacts(toolName, tool, context),
      outcome: outcomeOf(result),
      errorCode: result.error?.code,
      error: result.error?.message,
      durationMs: result.executionTimeMs,
    });

    return result;
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
    tool: BaseTool,
    context: ToolInvocationContext,
  ): Omit<ToolInvokedPayload, 'outcome'> {
    const { schema } = tool;

    return {
      intent: schema.name,
      tool: toolName,
      domain: schema.domain,
      source: this.toolToProvider.get(toolName) ?? 'unknown',
      userId: context.userId,
      correlationId: context.traceId,
      apiKeyId: context.apiKeyId,
      capability: context.capability,
      occurredAt: new Date().toISOString(),
      access: schema.privacy.access,
      external: schema.privacy.external,
      destructive: schema.privacy.destructive,
    };
  }

  /**
   * Emit the durable `tool.invoked` signal (routed to the `telemetry` queue), which
   * {@link ToolInvokedListener} appends to `ci.tool_invocations`. Never throws: a telemetry
   * failure must not fail an already-completed tool call.
   *
   * Public because the GraphQL-over-MCP plane does not go through this registry at all —
   * `McpToolService` branches on `tool.source === 'graphql'` and returns via the GraphQL executor,
   * so without a way in it would be the one dispatcher with no ledger row. It calls this.
   *
   * Truncates `error` to {@link TOOL_INVOCATION_ERROR_MAX_LENGTH} at the emit rather than only at
   * the insert: the payload is serialised into `pgboss.job` on the way, and an unbounded tool
   * error message would be copied into the queue table too.
   */
  async recordInvocation(payload: ToolInvokedPayload): Promise<void> {
    try {
      await this.events.send(
        ToolInvokedEvent,
        {
          ...payload,
          error: payload.error?.slice(0, TOOL_INVOCATION_ERROR_MAX_LENGTH),
        },
        { queue: 'telemetry' },
      );
    } catch (error) {
      this.logger.warn('tool.invoked emit failed (non-fatal)', { error });
    }
  }

  /**
   * Get tool by executable name (for testing/debugging)
   */
  getTool(name: string): BaseTool | undefined {
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
