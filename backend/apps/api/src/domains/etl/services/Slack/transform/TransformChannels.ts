import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, SOURCE_NATIVE_EXTERNAL_ID_KIND } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import type { SlackConversation } from '../sync/slackApi';

@Injectable()
export class SlackChannelsTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SlackChannelsTransformService.name);
  }

  async transform({ connection, syncJob }: { connection: Connection; syncJob: ConnectionSyncJob }) {
    const { userId, data } = syncJob;
    const channels = (data?.channels as SlackConversation[]) || [];

    this.logger.log('Starting Slack channels transformation', {
      userId,
      connectionId: connection.id,
    });

    for (const channel of channels) {
      const title = channel.name || channel.id;
      const existingContent = await this.contentService.search({ userId }, { external_id: channel.id });

      if (existingContent.length > 0) {
        continue;
      }

      await this.contentService.create(
        { userId },
        {
          connection_id: connection.id,
          type: 'slack_channel',
          title,
          text: `Slack channel ${title}`,
          external_id: channel.id,
          external_id_kind: SOURCE_NATIVE_EXTERNAL_ID_KIND,
          source_type: 'ETL',
          source_system: 'slack',
          source_id: channel.id,
          source_data: {
            slack_channel_id: channel.id,
            is_private: channel.is_private,
            is_im: channel.is_im,
            is_mpim: channel.is_mpim,
            num_members: channel.num_members,
          },
        },
      );
    }

    this.logger.log('Slack channels transformation completed', {
      userId,
      connectionId: connection.id,
      totalChannels: channels.length,
    });
  }
}
