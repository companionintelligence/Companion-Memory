/*
 * Conversation key for a single email.
 *
 * A thread_id names the CONVERSATION, not the message. Using the message's
 * own Message-ID made every archive row its own thread, while live Gmail/
 * Outlook already write a conversation id (threadId / conversationId).
 *
 * The key format lives in the identity registry (domains/memory/identity/
 * email.ts) so the importer and the Gmail connection derive the SAME thread
 * key for one message: Takeout's `X-GM-THRID` (decimal) and the API's
 * `threadId` (hex) are one number, normalized there to one spelling. The
 * RFC 5322 References / In-Reply-To / Message-ID chain is the fallback for
 * mailboxes that carry no Gmail id. This module is the importer's name for
 * it, kept so the datasources read as they always did.
 */
export { cleanMessageId, parseMessageIds, emailThreadKey as emailThreadId } from '@ci/domains/memory';
