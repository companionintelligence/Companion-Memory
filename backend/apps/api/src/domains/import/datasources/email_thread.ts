/*
 * Conversation key for a single email.
 *
 * A thread_id names the CONVERSATION, not the message. Using the message's
 * own Message-ID made every archive row its own thread, while live Gmail/
 * Outlook already write a conversation id (threadId / conversationId).
 *
 * RFC 5322: References lists ancestors oldest-first, so the first msg-id is
 * the thread root. In-Reply-To is the immediate parent when References is
 * absent. Own Message-ID is only the last resort — a new conversation root.
 */

function headerValue(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) {
    return '';
  }

  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want && value) {
      return value;
    }
  }

  return '';
}

/** Strip angle brackets and collapse whitespace; empty → undefined. */
export function cleanMessageId(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  const cleaned = raw.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();

  return cleaned || undefined;
}

/**
 * Message-IDs in a References / In-Reply-To value, in listed order.
 * Prefers bracketed ids (`<a@x> <b@x>`) and falls back to whitespace split.
 */
export function parseMessageIds(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  const bracketed = raw.match(/<[^>]+>/g);
  if (bracketed?.length) {
    return bracketed.map((id) => id.replace(/[<>]/g, '').trim()).filter(Boolean);
  }

  return raw
    .split(/\s+/)
    .map((id) => id.replace(/[<>]/g, '').trim())
    .filter(Boolean);
}

/**
 * Conversation id for this message. Same meaning as Gmail `threadId` /
 * Outlook `conversationId`: every message in the thread shares one key.
 */
export function emailThreadId(headers: Record<string, string>): string | undefined {
  const references = parseMessageIds(headerValue(headers, 'References'));
  if (references[0]) {
    return references[0];
  }

  const inReplyTo = parseMessageIds(headerValue(headers, 'In-Reply-To'));
  if (inReplyTo[0]) {
    return inReplyTo[0];
  }

  return cleanMessageId(headerValue(headers, 'Message-ID'));
}
