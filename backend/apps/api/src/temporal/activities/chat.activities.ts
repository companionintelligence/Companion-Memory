import { toServiceContext } from '@ci/common/context';
import type { MessageService } from '@ci/domains/conversations';

// Services will be injected by the worker
let messageService: MessageService;

export function setMessageService(service: MessageService) {
  messageService = service;
}

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
 * Activity that saves chat messages to the database.
 *
 * Called after streaming completes to persist the conversation with retry logic.
 */
export async function saveChatMessages(input: SaveChatMessagesInput): Promise<void> {
  // Extract user ID from thread ID (format: userId-timestamp)
  const userId = input.threadId.split('-')[0];

  const serviceContext = toServiceContext({
    userId,
  });

  // Save all assistant messages from the stream
  for (let i = 0; i < input.streamMessages.length; i++) {
    const message = input.streamMessages[i];

    await messageService.create(serviceContext, {
      model: input.model,
      role: message.role,
      content: message.content,
      canceled: i === input.streamMessages.length - 1 && input.canceled,
      threadId: input.threadId,
      ...(message.tool_calls && {
        toolCalls: message.tool_calls as Record<string, unknown>[],
      }),
      promptMessageId: input.promptMessageId,
    });
  }
}
