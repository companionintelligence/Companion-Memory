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

      // Deliberately per-row create(), NOT createMany(). createMany is the bulk
      // ingest path and does not emit CommunicationCreatedEvent — see its
      // docstring: "Search indexing for bulk-loaded rows is deferred to the
      // post-load batch embed". That backfill is only reachable by POSTing
      // /api/maintenance/search-index/backfill by hand; nothing schedules it for
      // an ETL sync. Batching here would therefore write Slack messages that are
      // absent from ci_search.vectors — i.e. invisible to search — until someone
      // ran that endpoint manually. Every sibling connector (Gmail, Outlook,
      // Signal) ingests per-row for the same reason.
      //
      // The cost is that a re-synced message raises a unique violation on
      // communications_source_identity_uniq, logged and swallowed below. That is
      // noisy but harmless, and is the same behaviour those siblings have.
      for (const row of rows) {
        try {
          await this.communicationService.create({ userId }, row);
          createdCount += 1;
        } catch (error) {
          this.logger.error('Failed to transform Slack message', {
            channelId,
            sourceId: row.source_id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }

    this.logger.log('Slack messages transformation completed', {
      userId,
      connectionId: connection.id,
      createdCount,
    });
  }
}
