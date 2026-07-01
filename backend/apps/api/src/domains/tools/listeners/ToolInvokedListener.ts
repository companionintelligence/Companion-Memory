import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';

import { ToolInvokedEvent, type ToolInvokedPayload } from '../events';

/**
 * Consumes the durable {@link ToolInvokedEvent} on the `telemetry` queue.
 *
 * Its primary job today is to register that queue (via {@link OnEvent}) so the signal is actually
 * delivered rather than dropped, and to record the invocation. This is the seam where HBPE /
 * behavioral prediction will fold tool usage into forecasting — replace the body, keep the wiring.
 */
@Injectable()
export class ToolInvokedListener {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(ToolInvokedListener.name);
  }

  @OnEvent(ToolInvokedEvent, { queue: 'telemetry' })
  handleToolInvoked(payload: ToolInvokedPayload): void {
    this.logger.debug('tool.invoked', {
      intent: payload.intent,
      domain: payload.domain,
      success: payload.success,
      userId: payload.userId,
    });
  }
}
