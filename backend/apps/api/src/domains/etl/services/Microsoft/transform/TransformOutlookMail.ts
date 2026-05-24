import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { CommunicationService, CommunicationType, type CreateCommunicationDto } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import { PromoteService } from '../../PromoteService';

interface OutlookEmailAddress {
  name?: string;
  address?: string;
}

interface OutlookMessage {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  body?: {
    content?: string;
    contentType?: string;
  };
  from?: {
    emailAddress?: OutlookEmailAddress;
  };
  toRecipients?: Array<{
    emailAddress?: OutlookEmailAddress;
  }>;
  ccRecipients?: Array<{
    emailAddress?: OutlookEmailAddress;
  }>;
  bccRecipients?: Array<{
    emailAddress?: OutlookEmailAddress;
  }>;
  replyTo?: Array<{
    emailAddress?: OutlookEmailAddress;
  }>;
  sender?: {
    emailAddress?: OutlookEmailAddress;
  };
  receivedDateTime?: string;
  sentDateTime?: string;
  hasAttachments?: boolean;
  importance?: string;
  isRead?: boolean;
  isDraft?: boolean;
  conversationId?: string;
  internetMessageId?: string;
  webLink?: string;
  attachments?: Array<{
    id?: string;
    name?: string;
    contentType?: string;
    size?: number;
  }>;
}

interface Participant {
  email: string;
  name: string;
  role: 'from' | 'to' | 'cc' | 'bcc';
}

@Injectable()
export class OutlookMailTransformService {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly connectionService: ConnectionService,
    private readonly promoteService: PromoteService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(OutlookMailTransformService.name);
  }

  async transformOutlookMail({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;

    try {
      this.logger.log('Starting Outlook Mail transformation', {
        userId,
        syncJobId,
      });

      const messages = this.extractMessages(data);

      if (messages.length === 0) {
        this.logger.log('No Outlook Mail messages found to transform', { userId, syncJobId });

        return;
      }

      this.logger.log(`Processing ${messages.length} Outlook Mail messages`, {
        userId,
        syncJobId,
        messageCount: messages.length,
      });

      console.log('messages to transform', messages);
      await Promise.all(
        messages.map(
          async (message) =>
            await this.processMessage({
              message,
              connectionId: connection.id,
              userId,
            }),
        ),
      );

      this.logger.log('Outlook Mail transformation completed', {
        userId,
        syncJobId,
        processedCount: messages.length,
      });
    } catch (error: unknown) {
      this.logger.error('Error transforming Outlook Mail messages', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractMessages(data: unknown): OutlookMessage[] {
    if (!data || typeof data !== 'object') {
      this.logger.warn('Invalid data type for Outlook Mail messages', {
        dataType: typeof data,
      });

      return [];
    }

    const dataObj = data as Record<string, unknown>;

    // Handle the structure from Microsoft Graph API
    if ('messages' in dataObj && Array.isArray(dataObj.messages)) {
      return dataObj.messages as OutlookMessage[];
    }

    if ('id' in dataObj && ('subject' in dataObj || 'from' in dataObj)) {
      return [dataObj as OutlookMessage];
    }

    this.logger.warn('No Outlook Mail messages found in data', {
      dataKeys: Object.keys(dataObj),
    });

    return [];
  }

  private async processMessage({
    message,
    userId,
    connectionId,
  }: {
    message: OutlookMessage;
    userId: string;
    connectionId: string;
  }): Promise<void> {
    try {
      const messageId = message.id || 'unknown';
      const subject = message.subject || '(No Subject)';

      // Skip drafts
      if (message.isDraft) {
        this.logger.debug('Skipping draft message', {
          userId,
          connectionId,
          messageId,
          subject,
        });

        return;
      }

      // Skip messages without subject, body, and from (like OutlookMailPromotionService)
      if (
        subject == null &&
        (message.body?.content?.length === 0 || !message.body?.content) &&
        (message.bodyPreview?.length === 0 || !message.bodyPreview) &&
        message.from == undefined
      ) {
        this.logger.debug('Skipping blank message', {
          userId,
          connectionId,
          messageId,
        });

        return;
      }

      this.logger.log('Processing Outlook Mail message', {
        messageId,
        subject,
        hasAttachments: message.hasAttachments,
      });

      // Extract participants
      const participants = this.extractParticipants(message);

      // Process participants separately by type
      const fromParticipants = participants.filter((p) => p.role === 'from');
      const toParticipants = participants.filter((p) => p.role === 'to');
      const ccParticipants = participants.filter((p) => p.role === 'cc');
      const bccParticipants = participants.filter((p) => p.role === 'bcc');

      const timestamp = message.sentDateTime || message.receivedDateTime;
      const date = timestamp ? new Date(timestamp) : new Date();

      const fromEntityIds = await this.promoteService.processParticipants(
        fromParticipants,
        userId,
        connectionId,
        'email',
        'RECEIVED_EMAIL_FROM',
        date,
        undefined,
      );

      const toEntityIds = await this.promoteService.processParticipants(
        toParticipants,
        userId,
        connectionId,
        'email',
        'EMAILED',
        date,
        undefined,
      );

      const ccEntityIds = await this.promoteService.processParticipants(
        ccParticipants,
        userId,
        connectionId,
        'email',
        'EMAILED',
        date,
        undefined,
      );

      const bccEntityIds = await this.promoteService.processParticipants(
        bccParticipants,
        userId,
        connectionId,
        'email',
        'EMAILED',
        date,
        undefined,
      );

      // Combine all to entity IDs
      let toEntityIdsCombined = toEntityIds.length > 0 ? toEntityIds : [];
      if (ccEntityIds.length > 0) {
        toEntityIdsCombined = toEntityIdsCombined.concat(ccEntityIds);
      }

      if (bccEntityIds.length > 0) {
        toEntityIdsCombined = toEntityIdsCombined.concat(bccEntityIds);
      }

      // Transform and save message
      const communicationDto = await this.transformToCommunicationDto(
        message,
        userId,
        connectionId,
        {
          fromEntityIds,
          toEntityIdsCombined,
          fromParticipants,
          toParticipants,
          ccParticipants,
          bccParticipants,
        },
        date,
      );

      console.log('communication to insert', communicationDto);
      await this.communicationService.create({ userId }, communicationDto);

      console.log('communication inserted', communicationDto);

      this.logger.log('Outlook Mail message saved successfully', {
        messageId,
        subject,
      });
    } catch (error) {
      this.logger.error('Error processing individual Outlook Mail message', {
        userId,
        connectionId,
        messageId: message.id,
        subject: message.subject,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing other messages
    }
  }

  private extractParticipants(message: OutlookMessage): Participant[] {
    const participants: Participant[] = [];

    // Add sender/from
    if (message.from?.emailAddress) {
      participants.push({
        email: message.from.emailAddress.address || 'unknown',
        name: message.from.emailAddress.name || message.from.emailAddress.address || 'unknown',
        role: 'from',
      });
    }

    // Add to recipients
    if (message.toRecipients) {
      for (const recipient of message.toRecipients) {
        if (recipient.emailAddress) {
          participants.push({
            email: recipient.emailAddress.address || 'unknown',
            name: recipient.emailAddress.name || recipient.emailAddress.address || 'unknown',
            role: 'to',
          });
        }
      }
    }

    // Add cc recipients
    if (message.ccRecipients) {
      for (const recipient of message.ccRecipients) {
        if (recipient.emailAddress) {
          participants.push({
            email: recipient.emailAddress.address || 'unknown',
            name: recipient.emailAddress.name || recipient.emailAddress.address || 'unknown',
            role: 'cc',
          });
        }
      }
    }

    // Add bcc recipients
    if (message.bccRecipients) {
      for (const recipient of message.bccRecipients) {
        if (recipient.emailAddress) {
          participants.push({
            email: recipient.emailAddress.address || 'unknown',
            name: recipient.emailAddress.name || recipient.emailAddress.address || 'unknown',
            role: 'bcc',
          });
        }
      }
    }

    return participants;
  }

  private async transformToCommunicationDto(
    message: OutlookMessage,
    userId: string,
    connectionId: string,
    participantData: {
      fromEntityIds: string[];
      toEntityIdsCombined: string[];
      fromParticipants: Participant[];
      toParticipants: Participant[];
      ccParticipants: Participant[];
      bccParticipants: Participant[];
    },
    date: Date,
  ): Promise<CreateCommunicationDto> {
    const direction = this.determineDirection(message);

    return {
      id: uuidv7(),
      time: date,
      communication_type: CommunicationType.EMAIL,
      direction,
      from_entity_id: participantData.fromEntityIds[0] || undefined,
      to_entity_ids: participantData.toEntityIdsCombined,
      participants_metadata: {
        from: participantData.fromParticipants,
        to: participantData.toParticipants,
        cc: participantData.ccParticipants,
        bcc: participantData.bccParticipants,
      },
      subject: message.subject || '(No Subject)',
      content: message.body?.content || message.bodyPreview || '',
      category: 'personal', // TODO: Classify emails
      connection_id: connectionId,
      attachments: [], // TODO: Handle attachments
      preview: message.bodyPreview ?? null,
    };
  }

  private determineDirection(message: OutlookMessage): 'inbound' | 'outbound' {
    // This is a simplified version - you might need to get the user's email from connection
    // For now, assume if this is a sent message, it's outbound

    // Check if this is a sent message (could be enhanced with actual user email comparison)
    if (message.sentDateTime && !message.receivedDateTime) {
      return 'outbound';
    }

    return 'inbound';
  }
}
