import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { headersFromOutlookMessage, liveMailDropReason, mailIncludeBulkEnabled } from '@ci/domains/import';
import {
  CommunicationService,
  CommunicationType,
  type CreateCommunicationDto,
  canonicalSystem,
  emailFallbackIdentity,
  emailIdentity,
} from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import {
  type MailAttachment,
  type MailAttachmentOutcome,
  MailAttachmentService,
  type MailAttachmentRef,
  withAttachmentRefs,
} from '../../MailAttachmentService';
import { type ParticipantGroup, PromoteService } from '../../PromoteService';

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
  categories?: string[];
  conversationId?: string;
  internetMessageId?: string;
  webLink?: string;
  inferenceClassification?: string;
  internetMessageHeaders?: Array<{
    name?: string;
    value?: string;
  }>;
  attachments?: Array<{
    id?: string;
    name?: string;
    contentType?: string;
    size?: number;
    '@odata.type'?: string;
  }>;
}

interface Participant {
  email: string;
  name: string;
  role: 'from' | 'to' | 'cc' | 'bcc';
}

/** The participant groups one message contributes to the page's PromoteService call: from, to, cc, bcc. */
const GROUPS_PER_MESSAGE = 4;

/**
 * The attachments the sync listed for a message. Graph names the kind of each
 * in `@odata.type`: only a file attachment has bytes to download, while a
 * linked file (referenceAttachment) or an attached item (itemAttachment) is
 * kept as a record. One that names no kind is taken for a file.
 */
function outlookAttachments(message: OutlookMessage): MailAttachment[] {
  return (message.attachments ?? [])
    .filter((attachment) => attachment.id)
    .map((attachment) => ({
      id: attachment.id!,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      unsupported: Boolean(
        attachment['@odata.type'] && attachment['@odata.type'] !== '#microsoft.graph.fileAttachment',
      ),
    }));
}

/** A message that passed the gates, with everything the page-level write needs from it. */
interface PreparedMessage {
  message: OutlookMessage;
  date: Date;
  fromParticipants: Participant[];
  toParticipants: Participant[];
  ccParticipants: Participant[];
  bccParticipants: Participant[];
  groups: ParticipantGroup[];
  /** The files the message carries, which are saved before it is written. */
  attachments: MailAttachment[];
  /** The content records of the files that were saved: empty until {@link OutlookMailTransformService.saveAttachments} has run. */
  attachmentRefs: MailAttachmentRef[];
}

@Injectable()
export class OutlookMailTransformService {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly connectionService: ConnectionService,
    private readonly promoteService: PromoteService,
    private readonly logger: LoggerService,
    private readonly mailAttachments: MailAttachmentService,
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

      const outcome = await this.processPage(messages, userId, connection);

      this.logger.log('Outlook Mail transformation completed', {
        userId,
        syncJobId,
        processedCount: messages.length,
        ...outcome,
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

  /**
   * One sync page in a fixed number of round trips — the same shape as
   * GmailTransformService.processPage, for the same reason: per message this
   * used to be four PromoteService calls and a create(), run for every message
   * of the page in parallel. Gate each message on its own (a bad one is
   * skipped and logged, not the page), resolve and link every participant of
   * the page in one call, write the page once with `emitCreated` so the rows
   * this sync inserted still raise CommunicationCreatedEvent for the search
   * index and the people-linker.
   *
   * Attachments are saved before the write ({@link saveAttachments}). A message
   * whose files could not all be saved is still written, with the references
   * of the ones that were, so a provider that hiccups never costs an email.
   * The failure is raised after the page is written: the sync job records it
   * as its `transformError` and the page does not report as clean. A failed
   * transform is not run again by itself, but processing the message again
   * repairs it: the files already saved are reused, the missing one is tried
   * again, and {@link writePage} adds its reference to the stored row. That
   * is the only per-message error let out; any other is skipped and logged
   * in `prepareMessage`.
   */
  private async processPage(
    messages: OutlookMessage[],
    userId: string,
    connection: Connection,
  ): Promise<{ written: number; inserted: number }> {
    const gated = messages
      .map((message) => this.prepareMessage(message, userId, connection.id))
      .filter((entry): entry is PreparedMessage => entry != null);

    const { prepared, failures } = await this.saveAttachments(gated, userId, connection);
    const outcome = await this.writePage(prepared, userId, connection.id);

    if (failures.length > 0) {
      throw failures[0];
    }

    return outcome;
  }

  /**
   * Save the files of every message on the page, and give each message the
   * references of the ones that saved.
   *
   * All the messages are started together; MailAttachmentService itself keeps
   * at most two downloads running. This waits for every message, so nothing is
   * still downloading once the page has been written. A message whose files
   * did not all save is not dropped: the failure is logged against it here and
   * handed back, for processPage to raise once the page is written.
   */
  private async saveAttachments(
    gated: PreparedMessage[],
    userId: string,
    connection: Connection,
  ): Promise<{ prepared: PreparedMessage[]; failures: unknown[] }> {
    const outcomes = await Promise.all(
      gated.map(async ({ message, attachments }): Promise<MailAttachmentOutcome> => {
        if (attachments.length === 0 || !message.id) {
          return { refs: [], failures: [] };
        }

        return await this.mailAttachments.ingest(connection, userId, 'outlook_mail', message.id, attachments);
      }),
    );
    const failures: unknown[] = [];
    const prepared = gated.map((entry, index) => {
      const { refs, failures: unsaved } = outcomes[index];

      if (unsaved.length > 0) {
        failures.push(...unsaved);
        this.logger.error('Importing an Outlook Mail message without all of its attachments', {
          userId,
          connectionId: connection.id,
          messageId: entry.message.id,
          saved: refs.length,
          unsaved: unsaved.length,
          error: unsaved[0] instanceof Error ? unsaved[0].message : 'Unknown error',
        });
      }

      return { ...entry, attachmentRefs: refs };
    });

    return { prepared, failures };
  }

  /** The page-level write: participants resolved once, one upsert, then the missing references added to rows already stored. */
  private async writePage(
    prepared: PreparedMessage[],
    userId: string,
    connectionId: string,
  ): Promise<{ written: number; inserted: number }> {
    const context = { userId };

    if (prepared.length === 0) {
      return { written: 0, inserted: 0 };
    }

    const groupIds = await this.promoteService.promoteParticipantGroups(context, {
      connectionId,
      source: 'email',
      groups: prepared.flatMap((entry) => entry.groups),
    });

    const dtos = await Promise.all(
      prepared.map((entry, index) => {
        const [fromEntityIds = [], toEntityIds = [], ccEntityIds = [], bccEntityIds = []] = groupIds.slice(
          index * GROUPS_PER_MESSAGE,
          (index + 1) * GROUPS_PER_MESSAGE,
        );

        return this.transformToCommunicationDto(
          entry.message,
          userId,
          connectionId,
          {
            fromEntityIds,
            toEntityIdsCombined: [...toEntityIds, ...ccEntityIds, ...bccEntityIds],
            fromParticipants: entry.fromParticipants,
            toParticipants: entry.toParticipants,
            ccParticipants: entry.ccParticipants,
            bccParticipants: entry.bccParticipants,
          },
          entry.date,
          entry.attachmentRefs,
        );
      }),
    );
    const results = await this.communicationService.createManyDetailed(context, dtos, { emitCreated: true });

    // A message the page found already imported comes back as it was stored:
    // `attachments` is not among the columns a re-sync refreshes. So a message
    // imported before its files were saved, or without one that failed the
    // last time, gets the references added here, and one it already holds is
    // not added again. A row this write inserted already has them.
    for (const [index, { entity, inserted }] of results.entries()) {
      const attachments = inserted
        ? null
        : withAttachmentRefs(entity.attachments, prepared[index].attachmentRefs);

      if (attachments) {
        await this.communicationService.update(context, entity.id, { attachments });
      }
    }

    return { written: results.length, inserted: results.filter(({ inserted }) => inserted).length };
  }

  /**
   * Gate one message. Null for a message the sync should not write (a drop, a
   * blank) or could not read (logged, so one bad message never costs the page).
   */
  private prepareMessage(
    message: OutlookMessage,
    userId: string,
    connectionId: string,
  ): PreparedMessage | null {
    try {
      const messageId = message.id || 'unknown';
      const subject = message.subject || '(No Subject)';

      const headers = headersFromOutlookMessage({
        subject: message.subject,
        from: message.from,
        inferenceClassification: message.inferenceClassification,
        importance: message.importance,
        categories: message.categories,
        internetMessageHeaders: message.internetMessageHeaders,
      });
      const drop = liveMailDropReason({
        headers,
        bodyText: message.body?.content || message.bodyPreview,
        isExplicitDraft: message.isDraft,
        includeBulk: mailIncludeBulkEnabled(),
      });
      if (drop) {
        this.logger.log('Skipping Outlook Mail message', {
          userId,
          connectionId,
          messageId,
          subject,
          drop,
        });

        return null;
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

        return null;
      }

      this.logger.log('Processing Outlook Mail message', {
        messageId,
        subject,
        hasAttachments: message.hasAttachments,
      });

      const participants = this.extractParticipants(message);
      const byRole = (role: Participant['role']) => participants.filter((p) => p.role === role);
      const fromParticipants = byRole('from');
      const toParticipants = byRole('to');
      const ccParticipants = byRole('cc');
      const bccParticipants = byRole('bcc');

      const timestamp = message.sentDateTime || message.receivedDateTime;
      const date = timestamp ? new Date(timestamp) : new Date();

      return {
        message,
        date,
        fromParticipants,
        toParticipants,
        ccParticipants,
        bccParticipants,
        // In GROUPS_PER_MESSAGE order: from, to, cc, bcc.
        groups: [
          { participants: fromParticipants, relationshipType: 'RECEIVED_EMAIL_FROM', startDate: date },
          { participants: toParticipants, relationshipType: 'EMAILED', startDate: date },
          { participants: ccParticipants, relationshipType: 'EMAILED', startDate: date },
          { participants: bccParticipants, relationshipType: 'EMAILED', startDate: date },
        ],
        attachments: outlookAttachments(message),
        attachmentRefs: [],
      };
    } catch (error) {
      this.logger.error('Error processing individual Outlook Mail message', {
        userId,
        connectionId,
        messageId: message.id,
        subject: message.subject,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return null;
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
    attachments: MailAttachmentRef[],
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
      thread_id: message.conversationId,
      category: 'personal', // TODO: Classify emails
      connection_id: connectionId,
      attachments,
      preview: message.bodyPreview ?? null,
      // Identity: the RFC Message-ID (Graph `internetMessageId`) under the
      // federated `email` system, so the same message converges with a
      // Takeout/mbox import or a Gmail fetch of the same mail
      // (docs/design/cross-pipeline-identity.md). The Graph `id` stays the
      // fallback only — it is not stable across folder moves, so keying on it
      // would re-duplicate a message the user refiles; the fallback hashes it
      // into an outlook_mail-scoped id instead. A message with neither leaves
      // source_id NULL (uncovered by the partial index) rather than
      // collapsing every id-less message onto one shared row.
      // communications_source_identity_uniq still rejects a re-synced message.
      source_type: 'ETL',
      // Ledger platform: the Outlook connection delivered it.
      source_platform: canonicalSystem('outlook_mail'),
      ...(() => {
        const identity =
          emailIdentity(message.internetMessageId) ??
          (message.id ? emailFallbackIdentity('outlook_mail', `graph:${message.id}`) : null);

        return identity
          ? { source_system: identity.system, source_id: identity.id }
          : { source_system: canonicalSystem('outlook_mail'), source_id: undefined };
      })(),
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
