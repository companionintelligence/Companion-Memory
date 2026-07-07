import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ActionService } from '@ci/domains/intelligence';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const SuggestionsFeedbackInputSchema = z.object({
  id: z.string().min(1),
  action: z.enum(['seen', 'dismissed']),
});

export type SuggestionsFeedbackInput = z.infer<typeof SuggestionsFeedbackInputSchema>;

export type SuggestionsFeedbackOutput =
  | {
      applied: true;
      id: string;
      action: 'seen' | 'dismissed';
      suggestion: { id: string; seen: boolean; dismissed: boolean };
    }
  | { applied: false; id: string; action: 'seen' | 'dismissed'; reason: string };

/**
 * Curated `suggestions.feedback` intent — record that the user has seen or dismissed a
 * suggestion, so it stops being re-surfaced and the signal feeds suggestion quality.
 *
 * Deliberately `access: 'write'` but `destructive: false`: marking seen/dismissed flips
 * reversible presentation state on the suggestion row — no user data is removed or made
 * unrecoverable — so it does not need the destructive-confirmation flow.
 */
@Injectable()
export class SuggestionsFeedbackTool extends BaseTool<SuggestionsFeedbackInput, SuggestionsFeedbackOutput> {
  readonly schema: IntentDefinition = {
    name: 'suggestions.feedback',
    domain: 'suggestions',
    title: 'Give suggestion feedback',
    description:
      "Mark a suggestion as 'seen' or 'dismissed'. This flips reversible presentation state " +
      '(the suggestion row is kept, nothing is deleted), which is why it is a write but not a ' +
      'destructive intent. Use the id from suggestions.list.',
    privacy: { access: 'write', sensitivity: 'personal', destructive: false, external: false },
    phrases: ['Dismiss that suggestion', 'Mark that suggestion as seen'],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Suggestion id (from suggestions.list).' },
        action: {
          type: 'string',
          enum: ['seen', 'dismissed'],
          description: "Feedback to record: 'seen' or 'dismissed'.",
        },
      },
      required: ['id', 'action'],
    },
  };

  constructor(
    private readonly actions: ActionService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(SuggestionsFeedbackTool.name);
  }

  protected validateInput(input: unknown): SuggestionsFeedbackInput {
    return SuggestionsFeedbackInputSchema.parse(input ?? {});
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: SuggestionsFeedbackInput,
  ): Promise<SuggestionsFeedbackOutput> {
    const serviceContext = toServiceContext(context);
    const updated =
      input.action === 'seen'
        ? await this.actions.markAsSeen(serviceContext, input.id)
        : await this.actions.markAsDismissed(serviceContext, input.id);

    if (!updated) {
      return {
        applied: false,
        id: input.id,
        action: input.action,
        reason: 'suggestion not found',
      };
    }

    return {
      applied: true,
      id: updated.id,
      action: input.action,
      suggestion: { id: updated.id, seen: updated.seen, dismissed: updated.dismissed },
    };
  }
}
