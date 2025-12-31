import { proxyActivities } from '@temporalio/workflow';

import type * as activities from '../activities/chat.activities';

// Proxy activities with appropriate timeouts
const { saveChatMessages } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 5,
  },
});

export interface StreamMessage {
  role: string;
  content: string;
  thinking?: string;
  tool_calls?: unknown[];
}

export interface SaveChatMessagesInput {
  threadId: string;
  promptMessageId: string;
  model: string;
  streamMessages: StreamMessage[];
  canceled: boolean;
}

/**
 * Workflow that persists chat messages to the database after streaming completes.
 *
 * Runs on MEDIUM priority queue since this happens after user sees the response.
 * Provides durability and retry logic for message persistence.
 */
export async function saveChatMessagesWorkflow(input: SaveChatMessagesInput): Promise<void> {
  await saveChatMessages(input);
}
