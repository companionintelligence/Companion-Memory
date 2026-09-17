import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { SuggestionEngine } from '@ci/domains/daily-metrics';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

import { booleanish } from './booleanish';

const InputSchema = z.object({
  id: z.string().min(1),
  accepted: booleanish(),
});

export type SuggestionsFeedbackInput = z.infer<typeof InputSchema>;

export interface SuggestionsFeedbackOutput {
  ok: boolean;
  id: string | null;
  accepted: boolean;
  text: string;
}

@Injectable()
export class SuggestionsFeedbackTool extends BaseTool<SuggestionsFeedbackInput, SuggestionsFeedbackOutput> {
  readonly schema: IntentDefinition = {
    name: 'suggestions.feedback',
    domain: 'suggestions',
    title: 'Suggestion feedback',
    description:
      'Accept or dismiss an evidence-linked suggestion. Trains the per-arm prior. Not destructive.',
    privacy: { access: 'write', sensitivity: 'personal', destructive: false, external: false },
    localCapable: true,
    phrases: ['Dismiss that suggestion', 'I will take that suggestion', 'Not now'],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Suggestion id from suggestions.list' },
        accepted: { type: 'boolean', description: 'true to accept, false to dismiss' },
      },
      required: ['id', 'accepted'],
    },
  };

  constructor(
    private readonly suggestionEngine: SuggestionEngine,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(SuggestionsFeedbackTool.name);
  }

  protected validateInput(input: unknown): SuggestionsFeedbackInput {
    return InputSchema.parse(input ?? {});
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: SuggestionsFeedbackInput,
  ): Promise<SuggestionsFeedbackOutput> {
    const row = await this.suggestionEngine.feedback(toServiceContext(context), input.id, input.accepted);
    if (!row) {
      return { ok: false, id: input.id, accepted: input.accepted, text: 'No such suggestion.' };
    }

    return {
      ok: true,
      id: row.id,
      accepted: input.accepted,
      text: input.accepted ? 'Noted — suggestion accepted.' : 'Noted — suggestion dismissed.',
    };
  }
}
