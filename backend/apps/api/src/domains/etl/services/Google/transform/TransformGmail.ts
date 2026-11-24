import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import {
  type Connection,
  ConnectionService,
  GmailMessage,
  GmailPart,
  EmailParticipant,
} from '@ci/domains/connections';
import {
  emailDirection,
  headersFromGmailApi,
  htmlToText,
  liveMailDropReason,
  mailIncludeBulkEnabled,
} from '@ci/domains/import';
import {
  CommunicationDirection,
  CommunicationService,
  CommunicationType,
  type CreateCommunicationDto,
  canonicalSystem,
  emailFallbackIdentity,
  emailIdentity,
  gmailThreadKeyFromApi,
} from '@ci/domains/memory';
import { TagService } from '@ci/domains/search-next';

import { ConnectionSyncJob } from '../../../types';
import { parseDate } from '../../../util';
import { type ParticipantGroup, PromoteService } from '../../PromoteService';

/** The participant groups one message contributes to the page's PromoteService call: from, to, cc, bcc. */
const GROUPS_PER_MESSAGE = 4;

/** A message that passed the gates, with everything the page-level write needs from it. */
interface PreparedMessage {
  message: GmailMessage;
  details: ReturnType<GmailTransformService['extractMessageDetails']>;
  isOutbound: boolean;
  fromParticipants: EmailParticipant[];
  toParticipants: EmailParticipant[];
  ccParticipants: EmailParticipant[];
  bccParticipants: EmailParticipant[];
  groups: ParticipantGroup[];
}

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
      const outcome = await this.processPage(messages, userId, connection.id);

      this.logger.log('Gmail message promotion completed', {
        userId,
        processedCount: messages.length,
        ...outcome,
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

  /**
   * One sync page, written in a fixed number of round trips.
   *
   * This used to run every message of the page in parallel, each one calling
   * PromoteService four times (from / to / cc / bcc) and then create(): per
   * message, two owner lookups per call, one entity search per participant,
   * two endpoint SELECTs plus a save per edge, then a find-or-insert and two
   * queued jobs — fifteen to twenty-five statements, and two messages naming
   * the same new contact raced their searches and minted it twice.
   *
   * Now: parse and gate each message on its own (a malformed one is skipped
   * and logged, as before, not the page), resolve and link EVERY participant
   * of the page in one PromoteService call, write the page with one idempotent
   * createManyDetailed, and tag by distinct label set. `emitCreated` keeps the
   * per-row CommunicationCreatedEvent for the rows this sync inserted: the
   * search index and the people-linker consume it, and nothing else schedules
   * either for a connection sync (the arrival sweep covers content only).
   */
  private async processPage(
    messages: GmailMessage[],
    userId: string,
    connectionId: string,
  ): Promise<{ written: number; inserted: number }> {
    const context = { userId };
    const prepared = messages
      .map((message) => this.prepareMessage(message, userId, connectionId))
      .filter((entry): entry is PreparedMessage => entry != null);

    if (prepared.length === 0) {
      return { written: 0, inserted: 0 };
    }

    const groupIds = await this.promoteService.promoteParticipantGroups(context, {
      connectionId,
      source: 'email',
      groups: prepared.flatMap((entry) => entry.groups),
    });

    const dtos = prepared.map((entry, index) =>
      this.toCommunicationDto(
        entry,
        connectionId,
        groupIds.slice(index * GROUPS_PER_MESSAGE, (index + 1) * GROUPS_PER_MESSAGE),
      ),
    );
    const results = await this.communicationService.createManyDetailed(context, dtos, { emitCreated: true });

    // Labels become tags. One call per distinct label set, not one per
    // message: a page of inbox mail is mostly the same two or three labels.
    const byLabels = new Map<
      string,
      { labels: string[]; entities: Array<{ type: 'communication'; id: string }> }
    >();

    results.forEach(({ entity }, index) => {
      const labels = prepared[index].details.labels;

      if (labels.length === 0) {
        return;
      }

      const key = [...labels].sort().join('\u0000');
      const bucket = byLabels.get(key) ?? { labels, entities: [] };

      bucket.entities.push({ type: 'communication', id: entity.id });
      byLabels.set(key, bucket);
    });

    for (const { labels, entities } of byLabels.values()) {
      await this.tagService.tagEntities(context, { labels, entities });
    }

    return { written: results.length, inserted: results.filter(({ inserted }) => inserted).length };
  }

  /**
   * Parse and gate one message. Null for a message the sync should not write
   * (a drop) or could not read (logged, so one bad message never costs the page).
   */
  private prepareMessage(
    message: GmailMessage,
    userId: string,
    connectionId: string,
  ): PreparedMessage | null {
    try {
      const details = this.extractMessageDetails(message);
      const headers = headersFromGmailApi({
        headers: message.payload?.headers,
        labelIds: message.labelIds,
      });
      const drop = liveMailDropReason({
        headers,
        bodyText: details.body || details.snippet,
        isExplicitDraft: message.labelIds?.includes('DRAFT'),
        includeBulk: mailIncludeBulkEnabled(),
      });
      if (drop) {
        this.logger.log('Skipping Gmail message', {
          messageId: details.id,
          subject: details.subject,
          drop,
        });

        return null;
      }

      this.logger.log('Processing Gmail message', {
        messageId: details.id,
        subject: details.subject,
        from: details.from,
        participantCount: details.participants.length,
      });

      // Direction comes from the message's OWN headers, never a constant.
      // `headers` above already carries labelIds rewritten as X-Gmail-Labels
      // (headersFromGmailApi), and emailDirection checks the SENT label first
      // — the label SyncGmail explicitly sweeps for. Before this, every row
      // the sent sweep produced was filed 'inbound', which made LifeStats read
      // the owner as their own counterparty and drop the real recipients.
      // Same function the mbox/eml importers use, so an API sync and a Takeout
      // import of one message agree on direction.
      const isOutbound = emailDirection(headers) === 'outbound';
      const date = details.date ? new Date(details.date) : undefined;
      const byType = (type: EmailParticipant['type']) => details.participants.filter((p) => p.type === type);
      const fromParticipants = byType('from');
      const toParticipants = byType('to');
      const ccParticipants = byType('cc');
      const bccParticipants = byType('bcc');

      return {
        message,
        details,
        isOutbound,
        fromParticipants,
        toParticipants,
        ccParticipants,
        bccParticipants,
        // In GROUPS_PER_MESSAGE order: from, to, cc, bcc. On an OUTBOUND
        // message the From address is the owner, not someone the owner
        // received mail from — RECEIVED_EMAIL_FROM would be a false edge.
        groups: [
          {
            participants: fromParticipants,
            relationshipType: isOutbound ? 'EMAILED' : 'RECEIVED_EMAIL_FROM',
            startDate: date,
          },
          { participants: toParticipants, relationshipType: 'EMAILED', startDate: date },
          { participants: ccParticipants, relationshipType: 'EMAILED', startDate: date },
          { participants: bccParticipants, relationshipType: 'EMAILED', startDate: date },
        ],
      };
    } catch (error) {
      this.logger.error('Error processing individual Gmail message', {
        userId,
        connectionId,
        messageId: message.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return null;
    }
  }

  /** @param entityIds the resolved Person ids of `entry.groups`, in the same order (from, to, cc, bcc). */
  private toCommunicationDto(
    entry: PreparedMessage,
    connectionId: string,
    [fromEntityIds = [], toEntityIds = [], ccEntityIds = [], bccEntityIds = []]: string[][],
  ): CreateCommunicationDto {
    const { message, details } = entry;

    return {
      time: details.date ? new Date(details.date) : new Date(),
      communication_type: CommunicationType.EMAIL,
      direction: entry.isOutbound ? CommunicationDirection.OUTBOUND : CommunicationDirection.INBOUND,
      // The API's hex threadId, normalized to the registry's one spelling
      // so a Takeout mbox import of the same message (X-GM-THRID, the same
      // number in decimal) lands the same thread_id. A non-hex value —
      // nothing the API sends, but a replayed fixture might — is dropped
      // rather than stored as a key nothing else can produce.
      thread_id: gmailThreadKeyFromApi(message.threadId),
      from_entity_id: fromEntityIds[0] || undefined,
      to_entity_ids: [...toEntityIds, ...ccEntityIds, ...bccEntityIds],
      participants_metadata: {
        from: entry.fromParticipants,
        to: entry.toParticipants,
        cc: entry.ccParticipants,
        bcc: entry.bccParticipants,
      },
      subject: details.subject,
      // The body, or nothing. `snippet` is Gmail's ~200-char teaser and is
      // already stored below as `preview`; falling back to it here wrote a
      // truncated preview into `content`, where search and embeddings then
      // treat it as the whole message. An empty body is honest; a preview
      // masquerading as the body is not.
      content: details.body,
      category: 'personal', // TODO: Classify emails
      connection_id: connectionId,
      preview: details.snippet || null,
      // Identity: the RFC Message-ID under the federated `email` system,
      // so the same message converges with a Takeout mbox import (or an
      // Outlook fetch of the same mail) — docs/design/
      // cross-pipeline-identity.md. Message-ID-less mail falls back to a
      // gmail-scoped id derived from the API message id (stable across
      // re-syncs, not expected to converge cross-pipeline). A message
      // with neither leaves source_id NULL — uncovered by the partial
      // index — rather than collapsing onto one 'unknown' row.
      // communications_source_identity_uniq makes a re-synced message an
      // upsert either way (the sent/inbox sweeps overlap, and history
      // replays re-send whole pages). source_type stays 'ETL': provenance,
      // not identity.
      source_type: 'ETL',
      // Ledger platform: the Gmail connection delivered it (the row's
      // system is the federated `email`, which says nothing about where).
      source_platform: canonicalSystem('gmail'),
      ...(() => {
        const identity =
          emailIdentity(details.rfcMessageId) ??
          (message.id ? emailFallbackIdentity('gmail', `gmail-api:${message.id}`) : null);

        return identity
          ? { source_system: identity.system, source_id: identity.id }
          : { source_system: canonicalSystem('gmail'), source_id: undefined };
      })(),
    };
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

    const body = this.extractBody(message.payload);

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
      // RFC 5322 Message-ID — the email's cross-pipeline identity key. The
      // API's own `message.id` is Gmail-only and stays as the fallback (and
      // in the ledger via record_sources).
      rfcMessageId: getHeader('Message-ID') || getHeader('Message-Id') || undefined,
    };
  }

  /**
   * The message body, walked out of the WHOLE MIME tree.
   *
   * This used to be a flat `.find` over `payload.parts` — the top level only —
   * so any message whose top-level parts hold no direct text leaf lost its
   * body entirely and fell back to the ~200-char snippet: `multipart/mixed` or
   * `multipart/related` wrapping a `multipart/alternative` (rich-text mail
   * with an attachment, the common case), `multipart/signed` (S/MIME, PGP),
   * `multipart/report`. The tree was always in the payload; nothing walked it.
   *
   * Preference is the MIME convention and matches the archive lane
   * (`import/datasources/email_mime.ts`): the first `text/plain` leaf
   * anywhere, else the first `text/html` leaf anywhere, flattened through the
   * shared `htmlToText` rather than stored as raw markup.
   */
  private extractBody(payload: GmailPart | undefined): string {
    if (!payload) {
      return '';
    }

    const plain = this.findBodyLeaf(payload, 'text/plain');
    if (plain !== undefined) {
      return this.decodeBase64(plain);
    }

    const html = this.findBodyLeaf(payload, 'text/html');
    if (html !== undefined) {
      return htmlToText(this.decodeBase64(html));
    }

    // A single-part message whose payload carries data under an unrecognised
    // (or absent) mimeType: decode it rather than drop a body we can read.
    // This is the pre-walk behaviour for the non-multipart case.
    if (!payload.parts?.length && payload.body?.data) {
      return this.decodeBase64(payload.body.data);
    }

    return '';
  }

  /**
   * Depth-first search for the first leaf of `mimeType` carrying inline data.
   * Returns the still-encoded data so the caller decides how to decode it.
   */
  private findBodyLeaf(part: GmailPart, mimeType: string): string | undefined {
    // A named part is an attachment (Gmail sends `filename: ''` for inline
    // body parts). An attached .txt or .html file, or a forwarded
    // message/rfc822 and everything under it, is not this message's body.
    if (part.filename) {
      return undefined;
    }

    // `text/plain; charset="UTF-8"` is the same leaf as `text/plain`.
    const type = part.mimeType?.split(';')[0].trim().toLowerCase();
    if (type === mimeType && part.body?.data) {
      return part.body.data;
    }

    for (const child of part.parts ?? []) {
      const found = this.findBodyLeaf(child, mimeType);
      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
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
