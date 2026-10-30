import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { LoggerService } from '@ci/common/logging';
import { BlueBubblesClientService } from '@ci/domains/bluebubbles';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const messagingSendInputSchema = z.object({
  chatGuid: z.string().min(1),
  message: z.string().min(1).max(10_000),
});

export type MessagingSendInput = z.infer<typeof messagingSendInputSchema>;

export interface MessagingSendOutput {
  sent: true;
  guid: string;
}

/**
 * Send an iMessage/SMS through the appliance's connected BlueBubbles server.
 *
 * `destructive: true` — not because a sent message can be un-sent, but
 * because it is irreversible and leaves the appliance the moment it runs;
 * {@link capabilityAllows} requires full capability for exactly that reason,
 * so a dispatcher must confirm before this one fires. `external: true` for
 * the same reason it forces `localCapable: false`: sending rides BlueBubbles'
 * own REST API on the configured Mac, which is reachable only from the
 * server, never from an offline device.
 */
@Injectable()
export class MessagingSendTool extends BaseTool<MessagingSendInput, MessagingSendOutput> {
  private static readonly BASE_SCHEMA: IntentDefinition = {
    name: 'messaging.send',
    domain: 'messaging',
    title: 'Send a message',
    description:
      'Send an iMessage or SMS through the connected BlueBubbles server, into an existing chat identified by its chat GUID.',
    privacy: { access: 'write', sensitivity: 'personal', destructive: true, external: true },
    localCapable: false,
    phrases: ['Text $person $message', 'Send a message to $chat'],
    parameters: {
      type: 'object',
      properties: {
        chatGuid: {
          type: 'string',
          description: "The target chat's GUID (see messaging.listChats).",
        },
        message: { type: 'string', description: 'The text to send.' },
      },
      required: ['chatGuid', 'message'],
    },
  };

  /**
   * Owned by the BlueBubbles connector's owner, read fresh on every access: the registry hides
   * this tool from every other account and refuses to run it for them. See
   * `BlueBubblesClientService.toolOwnerUserId`.
   */
  get schema(): IntentDefinition {
    return { ...MessagingSendTool.BASE_SCHEMA, ownerUserId: this.client.toolOwnerUserId() };
  }

  constructor(
    private readonly client: BlueBubblesClientService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(MessagingSendTool.name);
  }

  protected validateInput(input: unknown): MessagingSendInput {
    return messagingSendInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: MessagingSendInput,
  ): Promise<MessagingSendOutput> {
    const sent = await this.client.sendText(context.userId, input.chatGuid, input.message);

    return { sent: true, guid: sent.guid };
  }
}
