import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ActionService } from '@ci/domains/intelligence';
import { SummaryService } from '@ci/domains/summaries';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const DEFAULT_LIMIT = 20;

const BriefListInputSchema = z.object({
  since: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'since must be an ISO-8601 date' })
    .optional(),
  limit: z.number().int().min(1).max(100).optional().default(DEFAULT_LIMIT),
});

export type BriefListInput = z.infer<typeof BriefListInputSchema>;

export type BriefItemKind = 'insight' | 'anomaly' | 'action';

export interface BriefListItem {
  id: string;
  type: BriefItemKind;
  text: string;
  occurredAt: string | null;
}

export interface BriefListOutput {
  items: BriefListItem[];
}

@Injectable()
export class BriefListTool extends BaseTool<BriefListInput, BriefListOutput> {
  readonly schema: IntentDefinition = {
    name: 'brief.list',
    domain: 'brief',
    title: 'List Brief',
    description:
      'List recent derived insights and anomalies from the summary engine plus active (non-dismissed) ' +
      'suggested actions, newest first. Prefers computed anomaly/suggestion cards when present; ' +
      'legacy onboarding stubs remain visible.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    localCapable: true,
    phrases: [
      'What is on Brief',
      'What insights do you have for me',
      'Anything unusual lately',
      'Any suggested actions',
    ],
    parameters: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          format: 'date-time',
          description: 'Only include items from this ISO-8601 date/datetime onward.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: DEFAULT_LIMIT,
        },
      },
    },
  };

  constructor(
    private readonly summaryService: SummaryService,
    private readonly actionService: ActionService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(BriefListTool.name);
  }

  protected validateInput(input: unknown): BriefListInput {
    return BriefListInputSchema.parse(input ?? {});
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: BriefListInput,
  ): Promise<BriefListOutput> {
    const serviceContext = toServiceContext(context);
    const since = input.since ? new Date(input.since) : null;
    const [summaries, actions] = await Promise.all([
      this.summaryService.findRecent(serviceContext, input.limit),
      this.actionService.findAll(serviceContext),
    ]);

    const derived: BriefListItem[] = [];
    const other: BriefListItem[] = [];

    for (const summary of summaries) {
      const occurredAt = toIsoOrNull(summary.periodEnd);
      if (since && summary.periodEnd && new Date(summary.periodEnd) < since) {
        continue;
      }

      for (const text of summary.keyInsights ?? []) {
        pushItem(other, { id: summary.summaryId, type: 'insight', text, occurredAt });
      }

      for (const text of summary.anomalies ?? []) {
        pushItem(other, { id: summary.summaryId, type: 'anomaly', text, occurredAt });
      }
    }

    for (const action of actions) {
      if (action.dismissed) {
        continue;
      }

      if (since && action.createdAt && new Date(action.createdAt) < since) {
        continue;
      }

      const item: BriefListItem = {
        id: action.id,
        type: 'action',
        text: action.text ?? action.title ?? '',
        occurredAt: toIsoOrNull(action.createdAt),
      };
      if (action.source === 'anomaly' || action.source === 'suggestion') {
        pushItem(derived, item);
      } else {
        pushItem(other, item);
      }
    }

    const byRecency = (left: BriefListItem, right: BriefListItem) => {
      if (left.occurredAt === right.occurredAt) {
        return left.id.localeCompare(right.id);
      }

      if (left.occurredAt === null) {
        return 1;
      }

      if (right.occurredAt === null) {
        return -1;
      }

      return right.occurredAt.localeCompare(left.occurredAt);
    };

    derived.sort(byRecency);
    other.sort(byRecency);

    const items = derived.length > 0 ? [...derived, ...other] : other;

    return { items: items.slice(0, input.limit) };
  }
}

function pushItem(items: BriefListItem[], item: BriefListItem): void {
  if (item.text.trim().length > 0) {
    items.push(item);
  }
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
