import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';

import { ContrastiveDecisionService } from './ContrastiveDecisionService';
import {
  describeError,
  GenerativeDecisionEvaluatorAdapter,
  type DecisionChatModel,
} from './GenerativeDecisionEvaluatorAdapter';

/** Turns the System 2 handoff on. Off unless set to `true`; with it off, nothing is registered. */
export const DECISION_GENERATIVE_HANDOFF_ENV = 'DECISION_GENERATIVE_HANDOFF';

/**
 * Provider name of the llm domain's chat service. It is matched by name because importing that class
 * here would close a module cycle (the llm domain imports this module).
 */
const CHAT_SERVICE_NAME = 'OllamaService';

export function isGenerativeHandoffEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DECISION_GENERATIVE_HANDOFF_ENV]?.trim().toLowerCase() === 'true';
}

/**
 * Registers the local-LLM evaluator on the shared decision service at module init, when
 * `DECISION_GENERATIVE_HANDOFF=true`. With the flag off it does nothing, and the decision service
 * keeps its word-overlap fallback exactly as before.
 */
@Injectable()
export class GenerativeDecisionHandoffService implements OnModuleInit {
  private readonly logger = new Logger(GenerativeDecisionHandoffService.name);

  constructor(
    private readonly decisions: ContrastiveDecisionService,
    private readonly discovery: DiscoveryService,
  ) {}

  /**
   * Never throws. A failed lookup is logged and leaves the lexical fallback in place, so a broken
   * handoff cannot stop the application from starting.
   */
  onModuleInit(): void {
    try {
      if (!isGenerativeHandoffEnabled()) {
        return;
      }

      const chat = this.findChatModel();
      if (!chat) {
        this.logger.warn(
          `${DECISION_GENERATIVE_HANDOFF_ENV} is on but the llm chat service is not registered; keeping the lexical fallback`,
        );

        return;
      }

      this.decisions.setGenerativeEvaluator(
        new GenerativeDecisionEvaluatorAdapter(chat, { logger: this.logger }),
      );
      this.logger.log('Generative decision handoff registered');
    } catch (err) {
      this.logger.warn(
        `${DECISION_GENERATIVE_HANDOFF_ENV} is on but the handoff could not be registered; keeping the lexical fallback: ${describeError(err)}`,
      );
    }
  }

  private findChatModel(): DecisionChatModel | undefined {
    const wrapper = this.discovery
      .getProviders()
      .find(
        (candidate) =>
          candidate.metatype?.name === CHAT_SERVICE_NAME && typeof candidate.instance?.chat === 'function',
      );

    return wrapper?.instance as DecisionChatModel | undefined;
  }
}
