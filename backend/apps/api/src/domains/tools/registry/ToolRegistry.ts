import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import type { BaseTool } from '../core/BaseTool';
import type { ToolSchema, ToolResult } from '../core/types';
import type { ToolProvider, ProviderHealthStatus } from '../providers/ToolProvider';

/**
 * Centralized registry for managing all tools from various providers
 */
@Injectable()
export class ToolRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly providers = new Map<string, ToolProvider>();

  private readonly tools = new Map<string, BaseTool>();

  private readonly toolToProvider = new Map<string, string>();

  /**
   * Raw tool names that are superseded by a curated intent. Populated by the
   * intents domain (which depends on tools, not the reverse) via
   * {@link markSuperseded}. Hidden from the agent-facing tool list when the
   * `CI_PREFER_INTENTS` flag is on (the default), so the model prefers the
   * curated, privacy-labelled intent over the low-level tool it wraps. The raw
   * tools stay registered and remain executable by name.
   */
  private readonly supersededTools = new Set<string>();

  constructor(private readonly logger: LoggerService) {
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
      this.loadToolsFromProvider(provider);

      this.logger.debug(`Initialized provider: ${provider.name}`);
    } catch (error) {
      this.logger.error(`Failed to initialize provider: ${provider.name}`, error as Error);
    }
  }

  /**
   * Load a provider's tools into the registry. The provider hands back
   * instances (each carrying its own schema), so there is no schema list to
   * reconcile and no tool can be silently dropped. A provider may also declare
   * the raw tools its curated tools supersede; those are demoted from the
   * agent-facing list here.
   */
  private loadToolsFromProvider(provider: ToolProvider): void {
    const tools = provider.getTools();

    for (const tool of tools) {
      this.registerTool(tool, provider.name);
    }

    if (provider.getSupersededToolNames) {
      this.markSuperseded(provider.getSupersededToolNames());
    }

    this.logger.debug(`Loaded ${tools.length} tools from provider: ${provider.name}`);
  }

  /**
   * Register a tool from a provider
   */
  private registerTool(tool: BaseTool, providerName: string): void {
    const { name } = tool.schema;

    if (this.tools.has(name)) {
      this.logger.warn(`Tool '${name}' is already registered, skipping`);

      return;
    }

    this.tools.set(name, tool);
    this.toolToProvider.set(name, providerName);

    this.logger.debug(`Registered tool: ${name}`, {
      toolName: name,
      provider: providerName,
      category: tool.schema.category,
    });
  }

  /**
   * Initialize all registered providers
   */
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
   * Get all available tool schemas (for LLM function calling)
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
   * Record raw tools that a curated intent supersedes. Idempotent; called once at
   * boot by the intents domain.
   */
  markSuperseded(toolNames: Iterable<string>): void {
    for (const name of toolNames) {
      this.supersededTools.add(name);
    }
  }

  /**
   * The tool list to advertise to an LLM / MCP client. Identical to
   * {@link getAvailableTools} except that, when `CI_PREFER_INTENTS` is on (the
   * default), tools superseded by a curated intent are omitted so the model isn't
   * offered both the intent and the raw tool it wraps. Set `CI_PREFER_INTENTS=false`
   * to advertise the raw tools too.
   */
  getAgentFacingTools(context?: RequestContext): ToolSchema[] {
    const all = this.getAvailableTools(context);

    if (process.env.CI_PREFER_INTENTS === 'false' || this.supersededTools.size === 0) {
      return all;
    }

    const filtered = all.filter((schema) => !this.supersededTools.has(schema.name));

    this.logger.debug(`Agent-facing tools: ${filtered.length}/${all.length} (intents preferred)`, {
      userId: context?.userId,
      demoted: all.length - filtered.length,
    });

    return filtered;
  }

  /**
   * Check if a tool exists
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Execute a tool by name
   */
  async executeTool(name: string, context: RequestContext, input: unknown): Promise<ToolResult> {
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

    this.logger.log(`Executing tool: ${name}`, {
      toolName: name,
      userId: context.userId,
      provider: this.toolToProvider.get(name),
    });

    return await tool.execute(context, input);
  }

  /**
   * Get tool by name (for testing/debugging)
   */
  getTool(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  /**
   * List all registered tool names
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
