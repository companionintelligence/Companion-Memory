import { defineEvent } from '@ci/domains/events';

export const SummaryCreatedEvent = 'summary.created';
export const SummaryUpdatedEvent = 'summary.updated';
export const SummaryDeletedEvent = 'summary.deleted';

export type SummaryCreatedPayload = { summaryId: string };
export type SummaryUpdatedPayload = { summaryId: string };
export type SummaryDeletedPayload = { summaryId: string };

defineEvent<SummaryCreatedPayload>(SummaryCreatedEvent);
defineEvent<SummaryUpdatedPayload>(SummaryUpdatedEvent);
defineEvent<SummaryDeletedPayload>(SummaryDeletedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [SummaryCreatedEvent]: SummaryCreatedPayload;
    [SummaryUpdatedEvent]: SummaryUpdatedPayload;
    [SummaryDeletedEvent]: SummaryDeletedPayload;
  }
}
