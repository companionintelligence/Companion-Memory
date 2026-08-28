/**
 * Chat lives under Memory now (`/memory/chat`), not as its own top-level
 * route. Every caller that used to hand-write `/chat` or `` `/chat/${id}` ``
 * goes through this one constant/helper instead, so there is exactly one
 * place to change if the base path ever moves again.
 */
export const CHAT_BASE = '/memory/chat';

export function chatThreadPath(threadId: string): string {
  return `${CHAT_BASE}/${threadId}`;
}
