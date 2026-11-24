import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { SuggestionEngine } from '@ci/domains/daily-metrics';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const InputSchema = z.object({});

export type SuggestionsListInput = z.infer<typeof InputSchema>;

export interface SuggestionsListItem {
  id: string;
  key: string;
  title: string;
  text: string;
  priority: number | null;
}

export interface SuggestionsListOutput {
  items: SuggestionsListItem[];
  text: string;
}

@Injectable()
export class SuggestionsListTool extends BaseTool<SuggestionsListInput, SuggestionsListOutput> {
  readonly schema: IntentDefinition = {
    name: 'suggestions.list',
    domain: 'suggestions',
    title: 'List suggestions',
    description:
      'List live evidence-linked suggestions (source=suggestion). Does not include onboarding stubs or free-LLM actions.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    localCapable: true,
    phrases: ['What should I do', 'Any suggestions', 'Suggested actions'],
    parameters: { type: 'object', properties: {} },
  };

  constructor(
    private readonly suggestionEngine: SuggestionEngine,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(SuggestionsListTool.name);
  }

  protected validateInput(input: unknown): SuggestionsListInput {
    return InputSchema.parse(input ?? {});
  }

  protected async executeInternal(context: ToolExecutionContext): Promise<SuggestionsListOutput> {
    const rows = await this.suggestionEngine.list(toServiceContext(context), false);
    const items = rows.map((row) => ({
      id: row.id,
      key: row.key,
      title: row.title,
      text: row.text,
      priority: row.priority,
    }));

    return {
      items,
      text:
        items.length === 0
          ? 'Still learning your patterns. No evidence-linked suggestions yet.'
          : items.map((item) => item.text).join(' '),
    };
  }
}
