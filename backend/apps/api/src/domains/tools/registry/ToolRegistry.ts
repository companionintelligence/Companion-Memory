import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import { ToolRegistryCore, type ToolInvocationSink } from '@ci/tool-core';

import type { BaseTool } from '../core/BaseTool';
import { ToolInvokedEvent } from '../events';
import { PendingActionService } from '../services/PendingActionService';

/**
 * The appliance's tool registry: {@link ToolRegistryCore} wired to this application's Nest
 * providers.
 *
 * Everything that decides anything — the capability check, the dispatch gate, the ownership
 * filter, the ledger payload — is in `@ci/tool-core`, because the MCP server, the LLM dispatcher
 * and (eventually) the CLI all need the same answers and only the in-process ones could reach them
 * before. What is left here is the wiring the package deliberately has no opinion about:
 *
 * - **`LoggerService`** satisfies the core's `ToolCoreLogger` as it stands.
 * - **`EventService`** becomes a {@link ToolInvocationSink}. The core hands over a finished
 *   payload; the choice to deliver it as the durable `tool.invoked` event on the `telemetry`
 *   queue is this appliance's, and stays on this side of the boundary along with the events domain
 *   that would otherwise be dragged into the package.
 * - **`PendingActionService`** satisfies the core's `ToolGate`: a TypeORM repository, a feature
 *   flag and the owner's trust dial, none of which the registry should know about.
 *
 * The constructor signature, the method set and the exported name are unchanged from before the
 * extraction — this is a Nest provider called `ToolRegistry` taking those three services, and
 * `new ToolRegistry(logger, events, pendingActions)` still builds one.
 */
@Injectable()
export class ToolRegistry extends ToolRegistryCore<BaseTool> implements OnModuleInit, OnModuleDestroy {
  constructor(logger: LoggerService, events: EventService, pendingActions: PendingActionService) {
    // `events`, the parameter, and not `this.events`: a subclass may not touch `this` until
    // `super()` has returned, and the sink is needed to build the instance.
    super(
      logger,
      {
        record: (payload) => events.send(ToolInvokedEvent, payload, { queue: 'telemetry' }),
      } satisfies ToolInvocationSink,
      pendingActions,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }
}

export { outcomeOf } from '@ci/tool-core';
