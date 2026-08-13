import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';

import type { BaseTool } from '../core/BaseTool';
import { intentToolName, type ToolInvocationContext, type ToolSchema, type ToolResult } from '../core/types';
import { ToolInvokedEvent } from '../events';
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
   */
  getAvailableTools(context?: RequestContext): ToolSchema[] {
    const schemas = Array.from(this.tools.values()).map((tool) => tool.schema);

    this.logger.debug(`Retrieved ${schemas.length} available tools`, {
      userId: context?.userId,
      toolNames: schemas.map((s) => s.name),
    });

    return schemas;
  }

  /**
   * The tool list to advertise to an LLM / MCP client. Every tool is a curated intent, so this is
   * simply the full list — there is no raw/intent two-tier distinction to filter.
   */
  getAgentFacingTools(context?: RequestContext): ToolSchema[] {
    return this.getAvailableTools(context);
  }

  /**
   * Check if a tool exists (by executable name).
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
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
    const tool = this.tools.get(name);

    if (!tool) {
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

    const { privacy } = tool.schema;

    if (!capabilityAllows(privacy, context.capability)) {
      const required = capabilityRequiredFor(privacy);

      // Warn, not debug: a refused call is a caller trying to do something it was not granted —
      // whether that is a misconfigured integration or an injected chat message, an operator wants
      // to see it. Deliberately NOT emitted as `tool.invoked`: nothing was invoked, and feeding a
      // refusal into the behavioral signal would teach prediction that the user did this.
      this.logger.warn(`Refused tool: ${name}`, {
        toolName: name,
        intent: tool.schema.name,
        userId: context.userId,
        capability: context.capability,
        requiredCapability: required,
        access: privacy.access,
        destructive: privacy.destructive,
      });

      return {
        success: false,
        error: {
          code: 'TOOL_FORBIDDEN',
          message: `Tool '${name}' requires "${required}" access, but this caller is "${context.capability}"`,
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

    this.logger.log(`Executing tool: ${name}`, {
      toolName: name,
      userId: context.userId,
      provider: this.toolToProvider.get(name),
    });

    const result = await tool.execute(context, input);

    await this.emitInvoked(name, tool, context, result);

    return result;
  }

  /**
   * Emit the durable `tool.invoked` behavioral signal (routed to the `telemetry` queue). Never
   * throws: a telemetry failure must not fail an already-completed tool call.
   */
  private async emitInvoked(
    toolName: string,
    tool: BaseTool,
    context: RequestContext,
    result: ToolResult,
  ): Promise<void> {
    const { schema } = tool;

    try {
      await this.events.send(
        ToolInvokedEvent,
        {
          intent: schema.name,
          tool: toolName,
          domain: schema.domain,
          userId: context.userId,
          success: result.success,
          durationMs: result.executionTimeMs,
          access: schema.privacy.access,
          external: schema.privacy.external,
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
