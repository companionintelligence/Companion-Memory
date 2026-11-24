import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { ClientFactory, type Connection, ConnectionService, type GmailPart } from '@ci/domains/connections';
import { FileService } from '@ci/domains/files';
import { ContentService, platformIdentity } from '@ci/domains/memory';

/** The most bytes of one attachment that are saved. A larger file is kept as a record without its bytes. */
export const MAX_MAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Attachments saved at once, across every sync page: one can be 25 MiB and a page can name dozens. */
const MAX_CONCURRENT_SAVES = 2;

/** An access token with less than this left is renewed before a download uses it. */
const TOKEN_RENEW_MARGIN_MS = 10 * 60 * 1000;

type MailProvider = 'gmail' | 'outlook_mail';

/** Why a record has no file behind it, or `stored` when it has one. Kept in the record's `source_data`. */
type IngestionStatus = 'stored' | 'too_large' | 'unsupported_attachment_type';

/** How a message names a saved attachment: the content record over its file. */
export type MailAttachmentRef = { type: 'content'; id: string };

/** What became of the attachments of one message. */
export interface MailAttachmentOutcome {
  /** The records that stand for the attachments that were saved, in the order given. */
  refs: MailAttachmentRef[];
  /** Why each of the others was not saved, in the order given. Empty when every one was. */
  failures: unknown[];
}

export interface MailAttachment {
  /** The provider's id for the attachment, which its download endpoint takes. */
  id: string;
  /**
   * What names the attachment within its message, when `id` is not that. Google
   * does not document Gmail's attachment id as the same on every read of a
   * message, but a part's `partId` is immutable. The same attachment must
   * resolve to the same record every time the message is read, or each re-sync
   * would add another.
   */
  key?: string;
  name?: string;
  contentType?: string;
  size?: number;
  /** Base64url bytes the provider already sent with the message, so there is nothing to download. */
  data?: string;
  /** A link or a nested item. There are no bytes to download, so only a record of it is kept. */
  unsupported?: boolean;
}

export function gmailAttachments(payload: GmailPart | undefined): MailAttachment[] {
  const found: MailAttachment[] = [];
  const visit = (part: GmailPart, path: string) => {
    const disposition = part.headers?.find(
      (header) => header.name.toLowerCase() === 'content-disposition',
    )?.value;
    if (
      part.filename ||
      /^attachment\b/i.test(disposition ?? '') ||
      (part.body?.attachmentId && !/^text\//i.test(part.mimeType ?? ''))
    ) {
      // Gmail gives the message's own top-level part an empty partId.
      const key = part.partId || path;

      found.push({
        id: part.body?.attachmentId ?? key,
        key,
        name: part.filename,
        contentType: part.mimeType,
        size: part.body?.size,
        data: part.body?.data,
        unsupported: !part.body?.attachmentId && part.body?.data === undefined,
      });

      return;
    }

    part.parts?.forEach((child, index) => visit(child, `${path}.${index}`));
  };

  if (payload) {
    visit(payload, '0');
  }

  return found;
}

/**
 * What a message's `attachments` should become with `refs` added, or null when
 * it already holds all of them.
 *
 * References are compared by what they say, not by their JSON text: the column
 * is jsonb, which hands an object back with its keys in its own order, so a
 * stored `{ type, id }` does not stringify like the one that was written.
 */
export function withAttachmentRefs(
  stored: readonly unknown[] | null | undefined,
  refs: readonly MailAttachmentRef[],
): unknown[] | null {
  const held = stored ?? [];
  const holds = (list: readonly unknown[], ref: MailAttachmentRef) =>
    list.some((entry) => {
      const named = entry as Partial<MailAttachmentRef> | null;

      return named?.type === ref.type && named.id === ref.id;
    });
  const added: MailAttachmentRef[] = [];

  for (const ref of refs) {
    if (!holds(held, ref) && !holds(added, ref)) {
      added.push(ref);
    }
  }

  return added.length > 0 ? [...held, ...added] : null;
}

/** Store authenticated mail attachments as local files; never keep expiring provider URLs. */
@Injectable()
export class MailAttachmentService {
  private active = 0;

  private readonly waiting: Array<() => void> = [];

  /** The renewal in flight for each connection, so downloads that need one at the same moment share it. */
  private readonly renewals = new Map<string, Promise<Connection>>();

  constructor(
    private readonly clients: ClientFactory,
    private readonly files: FileService,
    private readonly content: ContentService,
    private readonly connections: ConnectionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(MailAttachmentService.name);
  }

  /**
   * Save the attachments of one message and say what became of each: the
   * records that now stand for the ones that were saved, and why the others
   * were not.
   *
   * Every attachment is tried, so one the provider no longer has does not keep
   * the rest of its message from being saved, and this does not reject: the
   * caller can still write the message with what did save, and raise the
   * failures afterwards. A file that is too large, or that has no bytes to
   * fetch, is not a failure: its record is kept without them.
   */
  async ingest(
    connection: Connection,
    userId: string,
    provider: MailProvider,
    messageId: string,
    attachments: MailAttachment[],
  ): Promise<MailAttachmentOutcome> {
    const outcome: MailAttachmentOutcome = { refs: [], failures: [] };

    for (const attachment of attachments) {
      try {
        // One global limit across a whole sync page, whose messages are saved
        // together. Bytes are never written into pg-boss jobs.
        outcome.refs.push(
          await this.limited(() => this.store(connection, userId, provider, messageId, attachment)),
        );
      } catch (error) {
        outcome.failures.push(error);
        this.logger.warn('Mail attachment could not be saved', {
          provider,
          messageId,
          attachmentId: attachment.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return outcome;
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT_SAVES) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }

    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    }
  }

  private async store(
    connection: Connection,
    userId: string,
    provider: MailProvider,
    messageId: string,
    attachment: MailAttachment,
  ): Promise<MailAttachmentRef> {
    const context = { userId };
    // Provider message/attachment ids are mailbox-local. A person may connect
    // several mailboxes, so one connection must never borrow another's bytes.
    const identity = platformIdentity(
      provider,
      `mail-attachment:${connection.id}:${messageId}:${attachment.key ?? attachment.id}`,
    );
    const source = { source_type: 'ETL', source_system: identity.system, source_id: identity.id };
    const existing = await this.content.findBySource(context, source);
    if (existing?.externalIdKind === 'file' && existing.externalId) {
      return { type: 'content', id: existing.id };
    }

    const filename = (attachment.name ?? `attachment-${attachment.id}`).split(/[\\/]/).at(-1) || 'attachment';
    let status: IngestionStatus = attachment.unsupported
      ? 'unsupported_attachment_type'
      : attachment.size != null && attachment.size > MAX_MAIL_ATTACHMENT_BYTES
        ? 'too_large'
        : 'stored';
    let fileId: string | undefined;
    if (status === 'stored') {
      const bytes = await this.download(connection, userId, provider, messageId, attachment);
      if (bytes === null) {
        status = 'too_large';
      } else {
        const stored = await this.files.upload(context, {
          filename,
          buffer: bytes,
          size: bytes.length,
          contentType: attachment.contentType ?? 'application/octet-stream',
          skipDescription: true,
        });
        fileId = stored.id;
      }
    }

    if (status !== 'stored') {
      this.logger.warn('Mail attachment retained as metadata without bytes', {
        provider,
        messageId,
        attachmentId: attachment.id,
        status,
      });
    }

    const fields = {
      ...source,
      connection_id: connection.id,
      type: /^(image|video|audio)\//i.test(attachment.contentType ?? '') ? 'media' : 'document',
      title: filename,
      mimetype: attachment.contentType ?? 'application/octet-stream',
      text:
        status === 'stored'
          ? ''
          : `Attachment bytes are unavailable: ${status === 'too_large' ? 'the file exceeds the 25 MiB mail attachment limit' : 'this linked or nested attachment type is not supported'}.`,
      source_data: {
        provider,
        message_id: messageId,
        attachment_id: attachment.id,
        size: attachment.size ?? null,
        ingestion_status: status,
      },
      ...(fileId ? { external_id: fileId, external_id_kind: 'file' as const } : {}),
    };
    if (existing) {
      await this.content.update(context, existing.id, fields);

      return { type: 'content', id: existing.id };
    }

    const [created] = await this.content.create(context, fields);
    if (!created) {
      throw new Error('Mail attachment content was not saved');
    }

    return { type: 'content', id: created.id };
  }

  /** The attachment's bytes through the connection's own authenticated client, or null when there are more than the limit. */
  private async download(
    connection: Connection,
    userId: string,
    provider: MailProvider,
    messageId: string,
    attachment: MailAttachment,
  ): Promise<Buffer | null> {
    const client = this.clients.getClientByProviderId(connection.providerId);

    if (provider === 'gmail') {
      const body =
        attachment.data !== undefined
          ? { data: attachment.data }
          : await client.request<{ data?: string }>(
              await this.authorised(connection, userId),
              `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}`,
              { signal: AbortSignal.timeout(60_000) },
            );
      if (typeof body.data !== 'string') {
        throw new Error('Mail attachment has invalid encoded bytes');
      }

      // Four characters carry three bytes, so a string this long cannot decode to a file within the limit.
      if (body.data.length > Math.ceil(MAX_MAIL_ATTACHMENT_BYTES / 3) * 4 + 4) {
        return null;
      }

      if (!/^[a-zA-Z0-9_+/=\s-]*$/.test(body.data)) {
        throw new Error('Mail attachment has invalid encoded bytes');
      }

      const bytes = Buffer.from(body.data, 'base64url');

      return bytes.length > MAX_MAIL_ATTACHMENT_BYTES ? null : bytes;
    }

    const response = await client.requestRaw(
      await this.authorised(connection, userId),
      `/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}/$value`,
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!response.ok) {
      throw new Error(`Mail attachment download failed with HTTP ${response.status}`);
    }

    return await this.readBounded(response);
  }

  /**
   * The connection to download with, its access token renewed first when it has
   * run out or is about to.
   *
   * Only the sync step renews a token, and only once it has already run out.
   * This runs later, on a page the sync fetched earlier, with the connection
   * as the orchestrator loaded it, so the token may have run out since. The
   * stored connection is read again, because a sync in between may have
   * renewed it, and renewed here if it still needs it. A renewal that fails is
   * logged and the download goes ahead: if the token is dead, the request says so.
   */
  private async authorised(connection: Connection, userId: string): Promise<Connection> {
    const stored = (await this.connections.findById({ userId }, connection.id)) ?? connection;
    const { refreshToken, tokenExpiry } = stored;

    if (
      !refreshToken ||
      !tokenExpiry ||
      new Date(tokenExpiry).getTime() - Date.now() > TOKEN_RENEW_MARGIN_MS
    ) {
      return stored;
    }

    // Downloads that fall due together share one renewal.
    let renewal = this.renewals.get(stored.id);
    if (!renewal) {
      renewal = this.renew(stored, userId).finally(() => this.renewals.delete(stored.id));
      this.renewals.set(stored.id, renewal);
    }

    return await renewal;
  }

  private async renew(connection: Connection, userId: string): Promise<Connection> {
    try {
      const renewed = await this.clients
        .getClientByProviderId(connection.providerId)
        .refreshAccessToken(connection);
      if (!renewed.accessToken) {
        throw new Error('The provider answered without an access token');
      }

      // Some providers answer a null refresh token, meaning "keep yours": as the sync does.
      const { refreshToken, ...kept } = renewed;
      const updated = await this.connections.update(
        { userId },
        connection.id,
        refreshToken == null ? kept : renewed,
      );

      return updated ?? connection;
    } catch (error) {
      this.logger.warn('Could not renew the access token for a mail attachment download', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return connection;
    }
  }

  /** The response body, or null as soon as it is known to exceed the limit: by its declared length, or by the bytes that have arrived. */
  private async readBounded(response: Response): Promise<Buffer | null> {
    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_MAIL_ATTACHMENT_BYTES) {
      await response.body?.cancel();

      return null;
    }

    if (!response.body) {
      throw new Error('Mail attachment response has no body');
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        length += value.byteLength;
        if (length > MAX_MAIL_ATTACHMENT_BYTES) {
          await reader.cancel();

          return null;
        }

        chunks.push(Buffer.from(value));
      }

      return Buffer.concat(chunks, length);
    } finally {
      reader.releaseLock();
    }
  }
}
