import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import {
  CommunicationDirection,
  CommunicationService,
  CommunicationType,
  type CreateCommunicationDto,
  platformIdentity,
} from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import type { SlackConversation, SlackMessage, SlackUser } from '../sync/slackApi';

/** Human-readable name for a Slack member, falling back to the raw id. */
function slackUserName(user: SlackUser | undefined, userId: string | undefined): string | undefined {
  return (
    user?.profile?.display_name ||
    user?.profile?.real_name ||
    user?.real_name ||
    user?.name ||
    userId ||
    undefined
  );
}

@Injectable()
export class SlackMessagesTransformService {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SlackMessagesTransformService.name);
  }

  async transform({ connection, syncJob }: { connection: Connection; syncJob: ConnectionSyncJob }) {
    const { userId, data } = syncJob;
    const messagesByChannel = (data?.messages as Record<string, SlackMessage[]>) || {};
    const channelMap = (data?.channels as Record<string, SlackConversation>) || {};
    const userMap = (data?.users as Record<string, SlackUser>) || {};
    const authedUserId = String(data?.authedUserId || connection.externalId || '');

    this.logger.log('Starting Slack messages transformation', {
      userId,
      connectionId: connection.id,
    });

    let createdCount = 0;

    for (const [channelId, messages] of Object.entries(messagesByChannel)) {
      const channel = channelMap[channelId];
      const channelLabel = channel?.name || channelId;

      const rows: CreateCommunicationDto[] = messages.map((message) => {
        const direction =
          message.user === authedUserId ? CommunicationDirection.OUTBOUND : CommunicationDirection.INBOUND;

        return {
          time: new Date(parseFloat(message.ts) * 1000),
          communication_type: CommunicationType.CHAT,
          direction,
          thread_id: message.thread_ts || message.ts,
          subject: channelLabel,
          content: message.text || '',
          connection_id: connection.id,
          source_type: 'ETL',
          ...(() => {
            const identity = platformIdentity('slack', `${channelId}:${message.ts}`);

            return { source_system: identity.system, source_id: identity.id };
          })(),
          participants_metadata: {
            channel_id: channelId,
            channel_name: channel?.name,
            slack_user_id: message.user,
            slack_user_name: slackUserName(message.user ? userMap[message.user] : undefined, message.user),
            bot_id: message.bot_id,
          },
        };
      });

      if (rows.length === 0) {
        continue;
      }

      // One idempotent write per channel page. This was a per-row create()
      // loop on purpose: createMany is the importer's bulk path and emits no
      // CommunicationCreatedEvent, and nothing schedules the search-index
      // backfill for a connection sync (the arrival sweep covers content
      // only), so a batched page would have been invisible to search and never
      // people-linked. `emitCreated` closes that: the rows THIS sync inserted
      // raise the event exactly as create() did, and a re-synced message is an
      // upsert on communications_source_identity_uniq rather than a unique
      // violation to log and swallow. Gmail, Outlook and Signal write the same
      // way.
      const results = await this.communicationService.createManyDetailed({ userId }, rows, {
        emitCreated: true,
      });

      createdCount += results.filter(({ inserted }) => inserted).length;
    }

    this.logger.log('Slack messages transformation completed', {
      userId,
      connectionId: connection.id,
      createdCount,
    });
  }
}
