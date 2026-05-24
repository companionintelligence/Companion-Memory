import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService, GmailMessage, EmailParticipant } from '@ci/domains/connections';
import { CommunicationDirection, CommunicationService, CommunicationType } from '@ci/domains/memory';
import { TagService } from '@ci/domains/search-next';

import { ConnectionSyncJob } from '../../../types';
import { parseDate } from '../../../util';
import { PromoteService } from '../../PromoteService';

@Injectable()
export class GmailTransformService {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly connectionService: ConnectionService,
    private readonly promoteService: PromoteService,
    private readonly tagService: TagService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GmailTransformService.name);
  }

  async transformGmail({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;

    try {
      this.logger.log('Starting Gmail message transformation', {
        userId,
      });

      const messages = (data.messages as GmailMessage[]) || [];
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

      this.logger.log('Gmail message promotion completed', {
        userId,
        processedCount: messages.length,
      });
    } catch (error: unknown) {
      this.logger.error('Error promoting Gmail messages', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private async processMessage({
    message,
    userId,
    connectionId,
  }: {
    message: GmailMessage;
    userId: string;
    connectionId: string;
  }): Promise<void> {
    try {
      const messageDetails = this.extractMessageDetails(message);

      this.logger.log('Processing Gmail message', {
        messageId: messageDetails.id,
        subject: messageDetails.subject,
        from: messageDetails.from,
        participantCount: messageDetails.participants.length,
      });

      // Determine direction (inbound vs outbound)
      // For now, assume all messages are inbound unless we can determine otherwise
      const direction = CommunicationDirection.INBOUND; // TODO: Determine based on user's email

      // Process participants and create entities with relationships
      const fromParticipants = messageDetails.participants.filter((p) => p.type === 'from');
      const toParticipants = messageDetails.participants.filter((p) => p.type === 'to');
      const ccParticipants = messageDetails.participants.filter((p) => p.type === 'cc');
      const bccParticipants = messageDetails.participants.filter((p) => p.type === 'bcc');

      const fromEntityIds = await this.promoteService.processParticipants(
        fromParticipants,
        userId,
        connectionId,
        'email',
        'RECEIVED_EMAIL_FROM',
        messageDetails.date ? new Date(messageDetails.date) : undefined,
      );

      // Create person entities for recipients (with EMAILED relationship)
      const toEntityIds = await this.promoteService.processParticipants(
        toParticipants,
        userId,
        connectionId,
        'email',
        'EMAILED',
        messageDetails.date ? new Date(messageDetails.date) : undefined,
      );

      // Create person entities for recipients (with EMAILED relationship)
      const ccEntityIds = await this.promoteService.processParticipants(
        ccParticipants,
        userId,
        connectionId,
        'email',
        'EMAILED',
        messageDetails.date ? new Date(messageDetails.date) : undefined,
      );

      // Create person entities for recipients (with EMAILED relationship)
      const bccEntityIds = await this.promoteService.processParticipants(
        ccParticipants,
        userId,
        connectionId,
        'email',
        'EMAILED',
        messageDetails.date ? new Date(messageDetails.date) : undefined,
      );

      let toEntityIdsCombined = toEntityIds.length > 0 ? toEntityIds : [];
      if (ccEntityIds.length > 0) {
        toEntityIdsCombined = toEntityIdsCombined.concat(ccEntityIds);
      }

      if (bccEntityIds.length > 0) {
        toEntityIdsCombined = toEntityIdsCombined.concat(bccEntityIds);
      }

      const communication = await this.communicationService.create(
        { userId },
        {
          time: messageDetails.date ? new Date(messageDetails.date) : new Date(),
          communication_type: CommunicationType.EMAIL,
          direction,
          thread_id: message.threadId,
          from_entity_id: fromEntityIds[0] || undefined,
          to_entity_ids: toEntityIdsCombined,
          participants_metadata: {
            from: fromParticipants,
            to: toParticipants,
            cc: ccParticipants,
            bcc: bccParticipants,
          },
          subject: messageDetails.subject,
          content: messageDetails.body || messageDetails.snippet || '',
          category: 'personal', // TODO: Classify emails
          connection_id: connectionId,
          preview: messageDetails.snippet || null,
        },
      );

      await this.tagService.tagEntities(
        { userId },
        {
          labels: messageDetails.labels,
          entities: [
            {
              type: 'communication',
              id: communication.id,
            },
          ],
        },
      );

      this.logger.log('Gmail message saved successfully', {
        messageId: messageDetails.id,
        subject: messageDetails.subject,
      });
    } catch (error) {
      this.logger.error('Error processing individual Gmail message', {
        userId,
        connectionId,
        messageId: message.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing other messages
    }
  }

  private extractMessageDetails(message: GmailMessage) {
    const headers = message.payload?.headers || [];
    const getHeader = (name: string): string => {
      const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());

      return header?.value || '';
    };

    const subject = getHeader('Subject') || 'No Subject';
    const from = getHeader('From');
    const to = getHeader('To');
    const cc = getHeader('Cc');
    const bcc = getHeader('Bcc');
    const date = parseDate(getHeader('Date'));

    // Extract body
    let body = '';
    if (message.payload?.body?.data) {
      body = this.decodeBase64(message.payload.body.data);
    } else if (message.payload?.parts) {
      // Try to find text/plain or text/html part
      const textPart = message.payload.parts.find(
        (p) => p.mimeType === 'text/plain' || p.mimeType === 'text/html',
      );
      if (textPart?.body?.data) {
        body = this.decodeBase64(textPart.body.data);
      }
    }

    // Extract participants
    const participants: EmailParticipant[] = [];

    if (from) {
      const parsed = this.parseEmailAddress(from);
      participants.push({ ...parsed, type: 'from' });
    }

    if (to) {
      const addresses = to.split(',').map((addr) => addr.trim());
      for (const addr of addresses) {
        const parsed = this.parseEmailAddress(addr);
        participants.push({ ...parsed, type: 'to' });
      }
    }

    if (cc) {
      const addresses = cc.split(',').map((addr) => addr.trim());
      for (const addr of addresses) {
        const parsed = this.parseEmailAddress(addr);
        participants.push({ ...parsed, type: 'cc' });
      }
    }

    if (bcc) {
      const addresses = bcc.split(',').map((addr) => addr.trim());
      for (const addr of addresses) {
        const parsed = this.parseEmailAddress(addr);
        participants.push({ ...parsed, type: 'bcc' });
      }
    }

    return {
      id: message.id || 'unknown',
      subject,
      from,
      to,
      cc,
      bcc,
      date,
      body,
      snippet: message.snippet || '',
      participants,
      labels: message.labelIds || [],
    };
  }

  private parseEmailAddress(emailString: string): { email: string; name: string } {
    // Handle formats like: "John Doe <john@example.com>" or "john@example.com"
    const match = emailString.match(/^"?([^"<]+)"?\s*<([^>]+)>$|^([^<\s]+)$/);

    if (match) {
      if (match[2]) {
        // Format: "Name <email>"
        return {
          name: match[1].trim(),
          email: match[2].trim(),
        };
      } else if (match[3]) {
        // Format: "email"
        return {
          email: match[3].trim(),
          name: match[3].trim(), // Use email as name if no name provided
        };
      }
    }

    // Fallback
    return {
      email: emailString.trim(),
      name: emailString.trim(),
    };
  }

  private decodeBase64(encodedString: string): string {
    try {
      // Gmail uses URL-safe base64 encoding
      const base64 = encodedString.replace(/-/g, '+').replace(/_/g, '/');

      return Buffer.from(base64, 'base64').toString('utf-8');
    } catch (error) {
      this.logger.warn('Failed to decode base64 string', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return '';
    }
  }
}
