import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';

import { ToolInvokedEvent, type ToolInvokedPayload } from '../events';
import { ToolInvocationLedgerService } from '../services/ToolInvocationLedgerService';

/**
 * Consumes the durable {@link ToolInvokedEvent} on the `telemetry` queue and appends it to
 * `ci.tool_invocations`.
 *
 * It registers that queue (via {@link OnEvent}) so the signal is actually delivered rather than
 * dropped, and it is the ledger's only writer. Until this body existed the entire record of a tool
 * call was the debug line below, which answers "is anything happening" from a live log tail and
 * nothing else — not "which key ran `memory.forget` last Tuesday", not "what was the agent
 * refused".
 *
 * The log line is kept alongside the insert on purpose: a tail is still the fastest way to watch
 * a chat turn dispatch tools in real time, and it survives the ledger being unreachable.
 *
 * This is also the seam where HBPE / behavioral prediction will fold tool usage into forecasting.
 * A consumer that must not learn from calls the user was not allowed to make filters
 * `outcome <> 'refused'` — see {@link ToolInvocationOutcome}.
 */
@Injectable()
export class ToolInvokedListener {
  constructor(
    private readonly ledger: ToolInvocationLedgerService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ToolInvokedListener.name);
  }

  @OnEvent(ToolInvokedEvent, { queue: 'telemetry' })
  async handleToolInvoked(payload: ToolInvokedPayload): Promise<void> {
    // Log the full payload, not a hand-picked subset: the eventual HBPE consumer needs `tool`,
    // `durationMs`, `access` and `external` as much as the fields already here.
    this.logger.debug('tool.invoked', {
      intent: payload.intent,
      tool: payload.tool,
      domain: payload.domain,
      source: payload.source,
      access: payload.access,
      external: payload.external,
      destructive: payload.destructive,
      outcome: payload.outcome,
      errorCode: payload.errorCode,
      durationMs: payload.durationMs,
      userId: payload.userId,
      apiKeyId: payload.apiKeyId,
      correlationId: payload.correlationId,
      capability: payload.capability,
    });

    await this.ledger.record(payload);
  }
}
