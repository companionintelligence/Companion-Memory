import { defineEvent } from '@ci/domains/events';

/**
 * Event emitted when creating a new question.
 *
 * @see {@link QuestionService.create} - The method that emits this event
 */
export const QuestionCreatedEvent = 'question.created';
export const QuestionUpdatedEvent = 'question.updated';
export const QuestionRemovedEvent = 'question.deleted';

/**
 * Event payload of the event {@link QuestionCreatedEvent}.
 *
 * @see {@link QuestionCreatedEvent} - The event this payload is associated with
 * @see {@link QuestionService.create} - The method that emits this event payload
 */
export type QuestionCreatedPayload = {
  /** The identifier of the newly created question */
  questionId: string;
};

/**
 * Event payload of the event {@link QuestionUpdatedEvent}.
 *
 * @see {@link QuestionUpdatedEvent} - The event this payload is associated with
 * @see {@link QuestionService.update} - The method that emits this event payload
 */
export type QuestionUpdatedPayload = {
  /** The identifier of the newly created question */
  questionId: string;
};

/**
 * Event payload of the event {@link QuestionRemovedEvent}.
 *
 * @see {@link QuestionRemovedEvent} - The event this payload is associated with
 * @see {@link QuestionService.remove} - The method that emits this event payload
 */
export type QuestionDeletedPayload = {
  /** The identifier of the newly created question */
  questionId: string;
};

defineEvent<QuestionCreatedPayload>(QuestionCreatedEvent);
defineEvent<QuestionUpdatedPayload>(QuestionUpdatedEvent);
defineEvent<QuestionDeletedPayload>(QuestionRemovedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [QuestionCreatedEvent]: QuestionCreatedPayload;
    [QuestionUpdatedEvent]: QuestionUpdatedPayload;
    [QuestionRemovedEvent]: QuestionDeletedPayload;
  }
}

/**
 * Event emitted when creating a new answer.
 *
 * @see {@link AnswerService.create} - The method that emits this event
 */
export const AnswerCreatedEvent = 'answer.created';
export const AnswerUpdatedEvent = 'answer.updated';
export const AnswerRemovedEvent = 'answer.deleted';

/**
 * Event payload of the event {@link AnswerCreatedEvent}.
 *
 * @see {@link AnswerCreatedEvent} - The event this payload is associated with
 * @see {@link AnswerService.create} - The method that emits this event payload
 */
export type AnswerCreatedPayload = {
  /** The identifier of the newly created answer */
  answerId: string;
};

/**
 * Event payload of the event {@link AnswerUpdatedEvent}.
 *
 * @see {@link AnswerUpdatedEvent} - The event this payload is associated with
 * @see {@link AnswerService.update} - The method that emits this event payload
 */
export type AnswerUpdatedPayload = {
  /** The identifier of the newly created answer */
  answerId: string;
};

/**
 * Event payload of the event {@link AnswerRemovedEvent}.
 *
 * @see {@link AnswerRemovedEvent} - The event this payload is associated with
 * @see {@link AnswerService.remove} - The method that emits this event payload
 */
export type AnswerDeletedPayload = {
  /** The identifier of the newly created answer */
  answerId: string;
};

defineEvent<AnswerCreatedPayload>(AnswerCreatedEvent);
defineEvent<AnswerUpdatedPayload>(AnswerUpdatedEvent);
defineEvent<AnswerDeletedPayload>(AnswerRemovedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [AnswerCreatedEvent]: AnswerCreatedPayload;
    [AnswerUpdatedEvent]: AnswerUpdatedPayload;
    [AnswerRemovedEvent]: AnswerDeletedPayload;
  }
}

/**
 * Event emitted when creating a new action.
 *
 * @see {@link ActionService.create} - The method that emits this event
 */
export const ActionCreatedEvent = 'action.created';

/**
 * Event payload of the event {@link ActionCreatedEvent}.
 *
 * @see {@link ActionCreatedEvent} - The event this payload is associated with
 * @see {@link ActionService.create} - The method that emits this event payload
 */
export type ActionCreatedPayload = {
  /** The identifier of the newly created action */
  actionId: string;
  /** Owner of the created action */
  userId: string;
};

defineEvent<ActionCreatedPayload>(ActionCreatedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [ActionCreatedEvent]: ActionCreatedPayload;
  }
}
