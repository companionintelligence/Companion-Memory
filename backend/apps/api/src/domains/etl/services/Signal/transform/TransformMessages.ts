import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import {
  CommunicationDirection,
  CommunicationService,
  CommunicationType,
  platformIdentity,
} from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import type { SignalEnvelope } from '../sync/signalApi';

@Injectable()
export class SignalMessagesTransformService {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SignalMessagesTransformService.name);
  }

  async transform({ connection, syncJob }: { connection: Connection; syncJob: ConnectionSyncJob }) {
    const { userId, data } = syncJob;
    const messages = (data?.messages as SignalEnvelope['envelope'][]) || [];
    const phoneNumber = String(data?.phoneNumber || connection.externalId || '');

    this.logger.log('Starting Signal messages transformation', {
      userId,
      connectionId: connection.id,
    });

    for (const envelope of messages) {
      const dataMessage = envelope?.dataMessage;
      const text = dataMessage?.message;

      if (!text || !envelope?.timestamp) {
        continue;
      }

      const sourceId = `${envelope.sourceNumber || envelope.source || 'unknown'}:${envelope.timestamp}`;
      const direction =
        envelope.sourceNumber === phoneNumber || envelope.source === phoneNumber
          ? CommunicationDirection.OUTBOUND
          : CommunicationDirection.INBOUND;

      try {
        await this.communicationService.create(
          { userId },
          {
            time: new Date(envelope.timestamp),
            communication_type: CommunicationType.SMS,
            direction,
            thread_id: dataMessage.groupInfo?.groupId || envelope.sourceNumber || envelope.source,
            subject: dataMessage.groupInfo?.groupName || envelope.sourceNumber || envelope.source,
            content: text,
            connection_id: connection.id,
            source_type: 'ETL',
            ...(() => {
              const identity = platformIdentity('signal', sourceId);

              return { source_system: identity.system, source_id: identity.id };
            })(),
            participants_metadata: {
              source: envelope.source,
              source_number: envelope.sourceNumber,
              group_id: dataMessage.groupInfo?.groupId,
              group_name: dataMessage.groupInfo?.groupName,
            },
          },
        );
      } catch (error) {
        this.logger.error('Failed to transform Signal message', {
          sourceId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.log('Signal messages transformation completed', {
      userId,
      connectionId: connection.id,
      totalMessages: messages.length,
    });
  }
}
