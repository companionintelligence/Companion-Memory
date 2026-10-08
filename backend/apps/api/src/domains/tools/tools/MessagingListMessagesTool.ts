import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { LoggerService } from '@ci/common/logging';
import { BlueBubblesClientService } from '@ci/domains/bluebubbles';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const messagingListMessagesInputSchema = z.object({
  chatGuid: z.string().min(1),
  maxResults: z.number().int().min(1).max(100).optional(),
});

export type MessagingListMessagesInput = z.infer<typeof messagingListMessagesInputSchema>;

export interface MessagingMessageSummary {
  guid: string;
  text: string | null;
  isFromMe: boolean;
  sender: string | null;
  dateCreated: string | null;
}

export interface MessagingListMessagesOutput {
  messages: MessagingMessageSummary[];
}

/**
 * Read recent messages in one BlueBubbles chat, newest first — the read-side
 * counterpart of `messaging.send`. Reads live off the connected BlueBubbles
 * server rather than the appliance's own ingested copy, so it reflects a
 * message sent seconds ago even if the backstop sync/webhook hasn't landed
 * it into `ci.*` yet.
 */
@Injectable()
export class MessagingListMessagesTool extends BaseTool<
  MessagingListMessagesInput,
  MessagingListMessagesOutput
> {
  private static readonly BASE_SCHEMA: IntentDefinition = {
    name: 'messaging.listMessages',
    domain: 'messaging',
    title: 'List messages in a chat',
    description:
      'List recent iMessage/SMS messages in one chat on the connected BlueBubbles server, newest first.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: true },
    localCapable: false,
    phrases: ['What did $person say', 'Show me my texts with $person'],
    parameters: {
      type: 'object',
      properties: {
        chatGuid: {
          type: 'string',
          description: "The chat's GUID (see messaging.listChats).",
        },
        maxResults: {
          type: 'integer',
          description: 'Max messages to return (default 25).',
          minimum: 1,
          maximum: 100,
        },
      },
      required: ['chatGuid'],
    },
  };

  /**
   * Owned by the BlueBubbles connector's owner, read fresh on every access: the registry hides
   * this tool from every other account and refuses to run it for them. See
   * `BlueBubblesClientService.toolOwnerUserId`.
   */
  get schema(): IntentDefinition {
    return { ...MessagingListMessagesTool.BASE_SCHEMA, ownerUserId: this.client.toolOwnerUserId() };
  }

  constructor(
    private readonly client: BlueBubblesClientService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(MessagingListMessagesTool.name);
  }

  protected validateInput(input: unknown): MessagingListMessagesInput {
    return messagingListMessagesInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: MessagingListMessagesInput,
  ): Promise<MessagingListMessagesOutput> {
    const messages = await this.client.listMessages(context.userId, input.chatGuid, input.maxResults ?? 25);

    return {
      messages: messages.map((message) => ({
        guid: message.guid,
        text: message.text ?? null,
        isFromMe: message.isFromMe === true,
        sender: message.isFromMe ? null : (message.handle?.address ?? null),
        dateCreated: message.dateCreated != null ? new Date(message.dateCreated).toISOString() : null,
      })),
    };
  }
}
