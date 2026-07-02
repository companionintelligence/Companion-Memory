import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';

import {
  IntentAuthorizedEvent,
  IntentDeniedEvent,
  ToolInvokedEvent,
  type IntentAuthorizedPayload,
  type IntentDeniedPayload,
  type ToolInvokedPayload,
} from '../events';

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

  /**
   * Records the enforcing dispatcher's authorization decisions. These are the durable security
   * audit trail (distinct from the behavioral `tool.invoked` signal): every gated `destructive` /
   * `external` invocation lands here as authorized (optionally warned) or denied.
   */
  @OnEvent(IntentAuthorizedEvent, { queue: 'telemetry' })
  handleIntentAuthorized(payload: IntentAuthorizedPayload): void {
    this.logger.log('intent.authorized', {
      intent: payload.intent,
      tool: payload.tool,
      surface: payload.surface,
      warned: payload.warned,
      destructive: payload.destructive,
      external: payload.external,
      userId: payload.userId,
    });
  }

  @OnEvent(IntentDeniedEvent, { queue: 'telemetry' })
  handleIntentDenied(payload: IntentDeniedPayload): void {
    this.logger.warn('intent.denied', {
      intent: payload.intent,
      tool: payload.tool,
      surface: payload.surface,
      reason: payload.reason,
      destructive: payload.destructive,
      external: payload.external,
      userId: payload.userId,
    });
  }
}
