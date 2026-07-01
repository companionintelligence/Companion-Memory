import { Injectable, type OnModuleInit } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type BaseTool, type ProviderHealthStatus, ToolRegistry, type ToolProvider } from '@ci/domains/tools';

import { IntentDonationService } from './IntentDonationService';
import { IntentRegistry } from './IntentRegistry';
import { IntentTool } from './IntentTool';

/**
 * Exposes the curated CI Intent catalog as a {@link ToolProvider}. Because it
 * plugs into the same {@link ToolRegistry} the native tools use, every intent
 * automatically becomes available to the local LLM (function-calling) AND the MCP
 * server (`McpToolService` consolidates the registry) — one registration, two
 * surfaces, plus the external manifest. This is the seam that lets CI-Hermes and
 * CI-OpenClaw consume one typed catalog instead of bespoke per-harness glue.
 */
@Injectable()
export class IntentToolProvider implements ToolProvider, OnModuleInit {
  readonly name = 'intents';

  private readonly tools = new Map<string, BaseTool>();

  private isInitialized = false;

  constructor(
    private readonly intentRegistry: IntentRegistry,
    private readonly toolRegistry: ToolRegistry,
    private readonly donation: IntentDonationService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(IntentToolProvider.name);
  }

  /**
   * Self-register with the shared registry at boot. `registerProvider` loads
   * this provider's tools and (via {@link getSupersededToolNames}) demotes the
   * raw tools they wrap — the wiring the old IntentsRegistrationService did.
   *
   * Ordering: `McpToolService` consolidates the registry in its own
   * `onModuleInit`; McpModule imports IntentsModule so intents register first.
   */
  async onModuleInit(): Promise<void> {
    await this.toolRegistry.registerProvider(this);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    for (const intent of this.intentRegistry.getIntents()) {
      const tool = new IntentTool(intent, this.toolRegistry, this.logger, this.donation);
      this.tools.set(tool.schema.name, tool);
    }

    this.isInitialized = true;

    this.logger.debug(`Initialized intent provider with ${this.tools.size} intents`, {
      toolNames: Array.from(this.tools.keys()),
    });
  }

  async shutdown(): Promise<void> {
    this.tools.clear();
    this.isInitialized = false;
  }

  getTools(): BaseTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * The raw tools these intents wrap. The registry demotes them from the
   * agent-facing list so the model reaches for the curated intent, not the
   * low-level tool. (Previously wired by a separate registration service.)
   */
  getSupersededToolNames(): string[] {
    return this.intentRegistry.getSupersededToolNames();
  }

  async getHealthStatus(): Promise<ProviderHealthStatus> {
    return {
      name: this.name,
      status: this.isInitialized ? 'healthy' : 'unknown',
      toolCount: this.tools.size,
      lastCheck: new Date(),
    };
  }
}
