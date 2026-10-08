/**
 * A scan title has to name a piece of work. Message headers and subject lines
 * are not titles, and a missing confidence must not look like a confident one.
 *
 * 0.4 sits under the balanced auto-create bar (0.55) so an omitted score stays
 * a proposal. Filling it in as 0.75 used to open the task and then ask to put
 * it on the calendar.
 */
export const OMITTED_CONFIDENCE = 0.4;

const HEADER_TITLE = /^(email|sms|chat)\s+\d{4}-\d{2}-\d{2}t/i;
const SUBJECT_TITLE = /^subject\s*:/i;
const TYPE_LABEL_TITLE = /^(chat|email|sms|communication|content)\s*:/i;

export function confidenceForScan(value: number | undefined): number {
  if (value == null || Number.isNaN(value)) {
    return OMITTED_CONFIDENCE;
  }

  return Math.min(1, Math.max(0, value));
}

export function isEchoTitle(title: string, headerLine?: string): boolean {
  const trimmed = title.trim();

  if (!trimmed) {
    return true;
  }

  if (HEADER_TITLE.test(trimmed) || SUBJECT_TITLE.test(trimmed) || TYPE_LABEL_TITLE.test(trimmed)) {
    return true;
  }

  return headerLine != null && trimmed.toLowerCase() === headerLine.trim().toLowerCase();
}

export interface InboxText {
  subject?: string | null;
  preview?: string | null;
  summary?: string | null;
  content?: string | null;
  communicationType?: string | null;
  time?: Date | null;
  threadId?: string | null;
  attachments?: unknown[] | null;
}

export function inboxBody(message: InboxText): string {
  return (message.preview || message.summary || message.content || '').replace(/\s+/g, ' ').trim();
}

export function inboxMessageIsEmpty(message: InboxText): boolean {
  return (message.subject?.trim() ?? '').length === 0 && inboxBody(message).length === 0;
}

export function inboxHeaderLine(message: InboxText): string {
  const type = message.communicationType?.trim() || 'message';
  const when = message.time instanceof Date ? message.time.toISOString() : '';

  return `${type} ${when}`.trim();
}

/** Labeled fields. The old first line was `email <iso>`, and the model copied it. */
export function formatInboxMessage(message: InboxText, index: number): string {
  const subject = message.subject?.trim() || '(no subject)';
  const body = inboxBody(message);

  return [
    `[${index}]`,
    `Type: ${message.communicationType?.trim() || 'message'}`,
    `When: ${message.time instanceof Date ? message.time.toISOString() : ''}`,
    `Subject: ${subject}`,
    body ? `Body: ${body.slice(0, 500)}` : 'Body: (empty)',
  ].join('\n');
}

export function formatMemoryHit(text: string, index: number): string {
  return [`[${index}]`, text].join('\n');
}

export function memoryHitText(entityType: string, name: string, snippet: string): string {
  return [`Type: ${entityType}`, `Name: ${name || '(untitled)'}`, snippet]
    .filter((line) => line.trim())
    .join('\n');
}
