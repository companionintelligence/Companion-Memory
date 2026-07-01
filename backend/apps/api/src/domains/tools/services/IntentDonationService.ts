import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { LoggerService } from '@ci/common/logging';

import type { IntentAccess } from '../core/types';

/** Event name emitted for every tool (intent) invocation. */
export const INTENT_INVOKED_EVENT = 'intent.invoked';

/**
 * A behavioral signal recorded each time an agent invokes a tool. Consumers (e.g. HBPE's
 * behavioral forecaster, proactive suggestions) can subscribe to {@link INTENT_INVOKED_EVENT}
 * to fold tool usage into prediction. This closes the feedback loop the harnesses otherwise
 * lack. Emitted centrally by the {@link ToolRegistry} for every executed tool.
 */
export interface IntentInvocation {
  /** Dotted intent id, e.g. `memory.recall`. */
  intent: string;
  domain: string;
  userId?: string;
  success: boolean;
  durationMs?: number;
  access: IntentAccess;
  /** True if the intent touched a third-party service. */
  external: boolean;
  /** ISO timestamp of the invocation (stamped by the service). */
  at: string;
}

@Injectable()
export class IntentDonationService {
  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(IntentDonationService.name);
  }

  /**
   * Record (donate) a tool invocation. Emits an in-process event so prediction consumers can
   * subscribe; never throws (a donation failure must not break the tool it is recording).
   */
  donate(record: Omit<IntentInvocation, 'at'>): void {
    const invocation: IntentInvocation = { ...record, at: new Date().toISOString() };

    try {
      this.eventEmitter.emit(INTENT_INVOKED_EVENT, invocation);
      this.logger.debug('Intent donated', {
        intent: invocation.intent,
        success: invocation.success,
        userId: invocation.userId,
      });
    } catch (error) {
      this.logger.warn('Intent donation failed (non-fatal)', { error });
    }
  }
}
