import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { LoggerService } from '@ci/common/logging';
import { BlueBubblesClientService } from '@ci/domains/bluebubbles';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const messagingListChatsInputSchema = z.object({
  maxResults: z.number().int().min(1).max(100).optional(),
});

export type MessagingListChatsInput = z.infer<typeof messagingListChatsInputSchema>;

export interface MessagingChatSummary {
  guid: string;
  chatIdentifier: string | null;
  displayName: string | null;
  isGroup: boolean;
  participants: string[];
}

export interface MessagingListChatsOutput {
  chats: MessagingChatSummary[];
}

/** BlueBubbles `chat.style`: 43 = group chat, 45 = direct message. */
const GROUP_CHAT_STYLE = 43;

/**
 * List the chats (conversations) known to the connected BlueBubbles server —
 * how the AI assistant discovers a `chatGuid` to pass to `messaging.send` /
 * `messaging.listMessages` rather than requiring one memorized.
 */
@Injectable()
export class MessagingListChatsTool extends BaseTool<MessagingListChatsInput, MessagingListChatsOutput> {
  readonly schema: IntentDefinition = {
    name: 'messaging.listChats',
    domain: 'messaging',
    title: 'List message chats',
    description: 'List the iMessage/SMS conversations known to the connected BlueBubbles server.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: true },
    // Reads live off the configured Mac's BlueBubbles server, not off any
    // on-device mirror.
    localCapable: false,
    phrases: ['What conversations do I have', 'List my text chats'],
    parameters: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', description: 'Max chats to return (default 25).', minimum: 1, maximum: 100 },
      },
      required: [],
    },
  };

  constructor(
    private readonly client: BlueBubblesClientService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(MessagingListChatsTool.name);
  }

  protected validateInput(input: unknown): MessagingListChatsInput {
    return messagingListChatsInputSchema.parse(input);
  }

  protected async executeInternal(
    _context: ToolExecutionContext,
    input: MessagingListChatsInput,
  ): Promise<MessagingListChatsOutput> {
    const chats = await this.client.listChats(input.maxResults ?? 25);

    return {
      chats: chats.map((chat) => ({
        guid: chat.guid,
        chatIdentifier: chat.chatIdentifier ?? null,
        displayName: chat.displayName ?? null,
        isGroup: chat.style === GROUP_CHAT_STYLE,
        participants: (chat.participants ?? []).map((p) => p.address).filter(Boolean),
      })),
    };
  }
}
