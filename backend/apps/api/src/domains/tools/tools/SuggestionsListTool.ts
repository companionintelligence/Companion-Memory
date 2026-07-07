import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ActionService, type Action } from '@ci/domains/intelligence';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const SuggestionsListInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
});

export type SuggestionsListInput = z.infer<typeof SuggestionsListInputSchema>;

export interface SuggestionItem {
  id: string;
  title: string | null;
  text: string | null;
  priority: number | null;
  seen: boolean;
  dismissed: boolean;
  createdAt: string;
  /**
   * Provenance of the suggestion. Passthrough of the action's `source` when the row carries one
   * (a `source` column is being added to ci.actions on a parallel branch); 'unspecified' until
   * then — agents should not assume these are grounded in computed signals.
   */
  basis: string;
}

export interface SuggestionsListOutput {
  items: SuggestionItem[];
  count: number;
}

/**
 * Curated `suggestions.list` intent — the non-dismissed suggested actions shown in the user's
 * feed (unseen first), with their seen/dismissed state so an agent can avoid re-surfacing what
 * the user already handled. Pair with `suggestions.feedback` to record seen/dismissed.
 */
@Injectable()
export class SuggestionsListTool extends BaseTool<SuggestionsListInput, SuggestionsListOutput> {
  readonly schema: IntentDefinition = {
    name: 'suggestions.list',
    domain: 'suggestions',
    title: 'List suggestions',
    description:
      'List non-dismissed suggested actions for the user (unseen first, then seen), with ' +
      "seen/dismissed state and a provenance 'basis' per item ('unspecified' when the " +
      'suggestion does not declare a source).',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    phrases: ['What do you suggest I do', 'Any suggestions for me'],
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Max suggestions to return (default 20).',
          minimum: 1,
          maximum: 100,
          default: 20,
        },
      },
    },
  };

  constructor(
    private readonly actions: ActionService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(SuggestionsListTool.name);
  }

  protected validateInput(input: unknown): SuggestionsListInput {
    return SuggestionsListInputSchema.parse(input ?? {});
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: SuggestionsListInput,
  ): Promise<SuggestionsListOutput> {
    const actions = await this.actions.findForFeed(toServiceContext(context), input.limit);
    const items = actions.map((action) => this.toItem(action));

    return { items, count: items.length };
  }

  private toItem(action: Action): SuggestionItem {
    // `source` is landing on ci.actions on a parallel branch (feat/actions-provenance); read it
    // opportunistically without depending on it, falling back to metadata then 'unspecified'.
    const source = (action as Action & { source?: unknown }).source ?? action.metadata?.source;

    return {
      id: action.id,
      title: action.title,
      text: action.text,
      priority: action.priority,
      seen: action.seen,
      dismissed: action.dismissed,
      createdAt: action.createdAt.toISOString(),
      basis: typeof source === 'string' && source !== '' ? source : 'unspecified',
    };
  }
}
