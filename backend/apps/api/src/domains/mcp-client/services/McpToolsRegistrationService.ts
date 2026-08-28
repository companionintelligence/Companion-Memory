import { Injectable, OnModuleInit } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { ToolRegistry } from '@ci/domains/tools';

import { McpToolProvider } from '../providers/McpToolProvider';

import { McpClientManagerService } from './McpClientManagerService';

/**
 * Registers the `mcp` tool provider with the global {@link ToolRegistry} and kicks off the
 * boot-time connect sweep, in that order, from within McpClientModule's own `OnModuleInit`.
 *
 * Mirrors `PersonaToolsRegistrationService`'s documented workaround, applied to a slightly
 * different problem: wiring this into `ToolsRegistrationService` (in `ToolsModule`) directly would
 * require `ToolsModule` to import `McpClientModule` for `McpToolProvider`/`McpClientManagerService`,
 * while `McpClientModule` already needs `ToolsModule` for `ToolRegistry` — a circular import.
 * Registering from here instead avoids that AND removes a second hazard the direct-wiring approach
 * would have introduced: `ToolsRegistrationService.onModuleInit` and this service's `onModuleInit`
 * are two independent Nest lifecycle hooks, so nothing would guarantee the provider was registered
 * before `McpClientManagerService`'s connect sweep started calling `ToolRegistry.refreshProvider('mcp')`
 * on the first successful connection. Doing both steps, in order, in one method removes the race
 * entirely rather than papering over it.
 */
@Injectable()
export class McpToolsRegistrationService implements OnModuleInit {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly mcpToolProvider: McpToolProvider,
    private readonly mcpClientManager: McpClientManagerService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(McpToolsRegistrationService.name);
  }

  async onModuleInit(): Promise<void> {
    await this.toolRegistry.registerProvider(this.mcpToolProvider);
    this.logger.debug('Registered MCP-client tool provider');

    // Bounded (~15s) inside the manager itself; safe to await here.
    await this.mcpClientManager.connectAllEnabled();
  }
}
