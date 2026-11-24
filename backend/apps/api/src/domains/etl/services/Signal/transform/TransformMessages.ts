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

    // One idempotent write for the page, with `emitCreated` so the rows this
    // sync inserted still raise CommunicationCreatedEvent for the search index
    // and the people-linker — see SlackMessagesTransformService for why the
    // bulk path alone would not do. A re-synced message is an upsert on
    // communications_source_identity_uniq now, not a unique violation to log.
    const rows: CreateCommunicationDto[] = [];

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

      rows.push({
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
      });
    }

    const results = await this.communicationService.createManyDetailed({ userId }, rows, {
      emitCreated: true,
    });

    this.logger.log('Signal messages transformation completed', {
      userId,
      connectionId: connection.id,
      totalMessages: messages.length,
      written: results.length,
      inserted: results.filter(({ inserted }) => inserted).length,
    });
  }
}
