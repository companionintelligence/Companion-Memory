import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';

import type { BaseTool } from '../core/BaseTool';
import type { ToolSchema, ToolResult } from '../core/types';
import type { ToolProvider, ProviderHealthStatus } from '../providers/ToolProvider';

/**
 * Centralized registry for managing all tools from various providers
 */
@Injectable()
export class ToolRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new LoggerService(ToolRegistry.name);

  private readonly providers = new Map<string, ToolProvider>();

  private readonly tools = new Map<string, BaseTool>();

  private readonly toolToProvider = new Map<string, string>();

  async onModuleInit() {
    this.logger.log('Initializing ToolRegistry');
  }

  async onModuleDestroy() {
    this.logger.log('Shutting down ToolRegistry');
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

      this.logger.log(`Initialized provider: ${provider.name}`);
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
