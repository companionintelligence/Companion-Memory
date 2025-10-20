import { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';
import { ConnectionService } from '@ci/domains/connections';
import { FileService } from '@ci/domains/files';
import { CommunicationService } from '@ci/domains/memory';

import { PersonPromotionService } from '../PersonPromotionService';

interface RawData {
  data: object;
  syncState: object;
}

interface MessageUser {
  emailAddress: {
    name: string;
    address: string;
  };
}

interface ExtractedUser {
  name: string;
  email: string;
  type: string;
}

interface OutlookMailMessage {
  id?: string;
  bodyPreview?: string;
  body: {
    contentType: string;
    content: string;
  };
  from: MessageUser;
  sender: MessageUser;
  subject: string;
  toRecipients: MessageUser[];
  ccRecipients: MessageUser[];
  bccRecipients: MessageUser[];
  hasAttachments: boolean;
  sentDateTime: string;
}

interface OutlookMailAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  contentBytes?: string; // Base64 encoded content
}

interface ExtractedMessage {
  id: string;
  subject: string;
  from?: ExtractedUser;
  to?: ExtractedUser[];
  cc?: ExtractedUser[];
  bcc?: ExtractedUser[];
  date: string;
  bodyPreview?: string | null;
  body: string;
  participants: ExtractedUser[];
  attachments?: OutlookMailAttachment[];
}

interface EmailParticipant {
  email: string;
  name: string;
  type: 'from' | 'to' | 'cc' | 'bcc';
}

@Injectable()
export class OutlookMailPromotionService {
  private logger = new LoggerService(OutlookMailPromotionService.name);

  constructor(
    private readonly fileService: FileService,
    private readonly communicationService: CommunicationService,
    private readonly personPromotionService: PersonPromotionService,
    private readonly connectionService: ConnectionService,
  ) {}

  async promoteOutlookMailMessages(
    apiLogContent: unknown,
    userId: string,
    connectionId: string,
  ): Promise<void> {
    this.logger.log('Starting OutlookMail message promotion', {
      userId,
      connectionId,
      contentType: typeof apiLogContent,
      contentKeys: apiLogContent && typeof apiLogContent === 'object' ? Object.keys(apiLogContent) : [],
    });

    try {
      // Extract message ids from the API log content
      const messages = this.extractOutlookMailMessages(apiLogContent as RawData[]);

      // Get the connection
      const connection = await this.connectionService.findById(connectionId);
      if (!connection || !connection.accessToken) {
        this.logger.error('Connection not found or missing access token', { connectionId });

        return;
      }

      // Process each message individually
      for (const message of messages) {
        if (!message.id) {
          this.logger.warn('Skipping message without ID', { message });
          continue;
        }

        // Process the message
        await this.processOutlookMailMessage(message, userId, connectionId);
      }
    } catch (error) {
      this.logger.error('Error promoting OutlookMail messages', {
        userId,
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractOutlookMailMessages(content: RawData[]): OutlookMailMessage[] {
    if (!content || typeof content !== 'object') {
      this.logger.warn('Invalid content type for OutlookMail messages', {
        contentType: typeof content,
        contentNull: content === null,
      });

      return [];
    }

    let returned = [] as OutlookMailMessage[];

    content.map((obj) => {
      const dataObj = obj.data as Record<string, unknown>;

      // Handle the structure from OutlookMail API - messages array
      if (dataObj.messages && Array.isArray(dataObj.messages)) {
        this.logger.log('Extracting messages from messages array', {
          messageCount: dataObj.messages.length,
        });

        returned = returned.concat(dataObj.messages as OutlookMailMessage[]);
      }

      this.logger.warn('No messages found in content', {
        contentKeys: Object.keys(dataObj),
      });
    });

    return returned;
  }

  private async processOutlookMailMessage(
    message: OutlookMailMessage,
    userId: string,
    connectionId: string,
  ): Promise<void> {
    // Extract message details
    const messageDetails = await this.extractMessageDetails(message, connectionId);

    this.logger.log('Processing OutlookMail message', {
      messageId: messageDetails.id,
      subject: messageDetails.subject,
      from: messageDetails.from,
      participantCount: messageDetails.participants.length,
    });

    const direction = 'inbound'; // TODO: Determine based on user's email

    const fromParticipants = messageDetails.participants.filter((p) => p.type === 'from');
    const toParticipants = messageDetails.participants.filter((p) => p.type === 'to');
    const ccParticipants = messageDetails.participants.filter((p) => p.type === 'cc');
    const bccParticipants = messageDetails.participants.filter((p) => p.type === 'bcc');

    // Use the message date as the interaction timestamp
    const messageDate = messageDetails.date ? new Date(messageDetails.date) : undefined;

    const fromEntityIds = await this.personPromotionService.processParticipants(
      fromParticipants,
      userId,
      connectionId,
      'email',
      'RECEIVED_EMAIL_FROM',
      messageDate,
    );

    // Create person entities for recipients (with EMAILED relationship)
    const toEntityIds = await this.personPromotionService.processParticipants(
      toParticipants,
      userId,
      connectionId,
      'email',
      'EMAILED',
      messageDate,
    );

    // Create person entities for recipients (with EMAILED relationship)
    const ccEntityIds = await this.personPromotionService.processParticipants(
      ccParticipants,
      userId,
      connectionId,
      'email',
      'EMAILED',
      messageDate,
    );

    // Create person entities for recipients (with EMAILED relationship)
    const bccEntityIds = await this.personPromotionService.processParticipants(
      bccParticipants,
      userId,
      connectionId,
      'email',
      'EMAILED',
      messageDate,
    );

    const attachmentUploads = await Promise.all(
      (messageDetails.attachments || []).map(async (attachment) => {
        const file = {
          fieldname: 'attachment',
          originalname: attachment.name,
          mimetype: attachment.contentType,
          size: attachment.size,
          encoding: 'base64',
          destination: '',
          stream: '' as unknown as Readable,
          filename: attachment.name,
          path: '',
          buffer: attachment.contentBytes ? Buffer.from(attachment.contentBytes, 'base64') : Buffer.from(''),
        };

        return this.fileService.upload({ userId }, file);
      }),
    );

    let toEntityIdsCombined = toEntityIds.length > 0 ? toEntityIds : [];
    if (ccEntityIds.length > 0) {
      toEntityIdsCombined = toEntityIdsCombined.concat(ccEntityIds);
    }

    if (bccEntityIds.length > 0) {
      toEntityIdsCombined = toEntityIdsCombined.concat(bccEntityIds);
    }

    // Save to communications table
    await this.communicationService.create({
      time: messageDetails.date ? new Date(messageDetails.date) : new Date(),
      user_id: userId,
      communication_type: 'email',
      direction,
      from_entity_id: fromEntityIds[0] || undefined,
      to_entity_ids: toEntityIdsCombined,
      participants_metadata: {
        from: fromParticipants,
        to: toParticipants,
        cc: ccParticipants,
        bcc: bccParticipants,
      },
      subject: messageDetails.subject,
      content: messageDetails.body || messageDetails.bodyPreview || '',
      category: 'personal', // TODO: Classify emails
      connection_id: connectionId,
      attachments: attachmentUploads.map((file) => file.id),
    });
  }

  private async extractMessageDetails(
    message: OutlookMailMessage,
    connectionId: string,
  ): Promise<ExtractedMessage> {
    const connection = await this.connectionService.findById(connectionId);
    const { id, subject, from, toRecipients, ccRecipients, bccRecipients, sentDateTime, hasAttachments } =
      message;
    let attachments;

    // Extract participants
    const participants: EmailParticipant[] = [];

    if (hasAttachments) {
      attachments = await this.fetchMailAttachments(connection!.accessToken!, id!);
    }

    // Parse From
    if (from) {
      const parsed = {
        name: from.emailAddress.name,
        email: from.emailAddress.address,
      };
      participants.push({ ...parsed, type: 'from' });
    }

    // Parse To
    if (toRecipients) {
      for (const addr of toRecipients) {
        const parsed = {
          name: addr.emailAddress.name,
          email: addr.emailAddress.address,
        };
        participants.push({ ...parsed, type: 'to' });
      }
    }

    // Parse CC
    if (ccRecipients) {
      for (const addr of ccRecipients) {
        const parsed = {
          name: addr.emailAddress.name,
          email: addr.emailAddress.address,
        };
        participants.push({ ...parsed, type: 'cc' });
      }
    }

    // Parse BCC
    if (bccRecipients) {
      for (const addr of bccRecipients) {
        const parsed = {
          name: addr.emailAddress.name,
          email: addr.emailAddress.address,
        };
        participants.push({ ...parsed, type: 'bcc' });
      }
    }

    // Extract body
    const body = message.body?.content || '';

    return {
      id: message.id || 'unknown',
      subject,
      from: from
        ? {
            name: from.emailAddress.name,
            email: from.emailAddress.address,
            type: 'from',
          }
        : undefined,
      to: toRecipients
        ? toRecipients.map((item) => {
            return {
              name: item.emailAddress.name,
              email: item.emailAddress.address,
              type: 'to',
            };
          })
        : [],
      cc: ccRecipients
        ? ccRecipients.map((item) => {
            return {
              name: item.emailAddress.name,
              email: item.emailAddress.address,
              type: 'cc',
            };
          })
        : [],
      bcc: bccRecipients
        ? bccRecipients.map((item) => {
            return {
              name: item.emailAddress.name,
              email: item.emailAddress.address,
              type: 'bcc',
            };
          })
        : [],
      date: sentDateTime,
      bodyPreview: message.bodyPreview || null,
      body,
      participants,
      attachments,
    };
  }

  private async fetchMailAttachments(
    accessToken: string,
    messageId: string,
  ): Promise<OutlookMailAttachment[] | undefined> {
    try {
      const response = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${messageId}/attachments`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        this.logger.error('Failed to fetch Outlook Mail message', {
          messageId,
          status: response.status,
          statusText: response.statusText,
        });

        return undefined;
      }

      return (await response.json()).value as OutlookMailAttachment[];
    } catch (error) {
      this.logger.error('Failed to fetch Outlook Mail message', {
        messageId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return undefined;
    }
  }
}
