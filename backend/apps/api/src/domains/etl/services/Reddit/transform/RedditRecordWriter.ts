import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { firstRedditMediaLink, mimeForFile, redditLinkMedia, type RedditMediaRef } from '@ci/domains/import';
import {
  CalendarEventService,
  CommunicationDirection,
  CommunicationService,
  CommunicationType,
  ContentService,
  type CreateCommunicationDto,
  type CreateContentDto,
  SOURCE_NATIVE_EXTERNAL_ID_KIND,
  isRedditCommentFullname,
  platformIdentity,
  redditBareId,
  redditIdentity,
  type RedditRecordKind,
} from '@ci/domains/memory';

import type { RedditComment, RedditPost, RedditSavedItem } from '../sync/redditListing';

/** `source_type` on every row the Reddit connection writes — provenance only, not part of any unique index. */
export const REDDIT_SOURCE_TYPE = 'ETL';

/**
 * One Reddit post or comment, authored or saved, normalized from whichever
 * listing shape the API returned it in. The three listing transforms build
 * these (see {@link postRecord}, {@link commentRecord}, {@link savedRecord})
 * and hand them to {@link RedditRecordWriter.write}.
 */
export interface RedditRecord {
  kind: RedditRecordKind;
  /** Reddit's fullname (`t3_…` post, `t1_…` comment). */
  fullname: string;
  /** Absolute permalink on reddit.com. */
  permalink: string;
  subreddit: string;
  /** A post's own title. Comments have none, and none is invented for them. */
  title: string | null;
  /** The body: a self post's selftext or a comment's markdown. Empty for a bare link post. */
  text: string;
  /** When it was written — null when the API gave no `created_utc`. */
  createdAt: Date | null;
  /** The image/video the record points at, if any. */
  media: RedditMediaRef | null;
  author: string;
  score: number;
  /** Native fields with no column of their own; stored on the row's metadata / source_data. */
  extra: Record<string, unknown>;
}

const LEGACY_CONTENT_TYPES = new Set(['reddit_post', 'reddit_comment']);
const LEGACY_EVENT_TYPES = new Set([
  'reddit_post',
  'reddit_comment',
  'reddit_saved_post',
  'reddit_saved_comment',
]);

function absolutePermalink(permalink: string): string {
  return permalink.startsWith('http') ? permalink : `https://www.reddit.com${permalink}`;
}

function createdAtOf(createdUtc: number | null | undefined): Date | null {
  return typeof createdUtc === 'number' && Number.isFinite(createdUtc) && createdUtc > 0
    ? new Date(createdUtc * 1000)
    : null;
}

/** One line, at most `n` characters — the importer's `clip` (push/canonical.ts), for the same fields. */
function clip(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();

  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

/** A post from the user's `submitted` listing. */
export function postRecord(post: RedditPost): RedditRecord {
  const permalink = absolutePermalink(post.permalink);
  const linkUrl = post.is_self ? null : post.url || null;

  return {
    kind: 'post',
    fullname: post.name,
    permalink,
    subreddit: post.subreddit,
    title: post.title,
    text: post.selftext ?? '',
    createdAt: createdAtOf(post.created_utc),
    media: redditLinkMedia(linkUrl),
    author: post.author,
    score: post.score,
    extra: {
      num_comments: post.num_comments,
      is_self: post.is_self,
      link_url: linkUrl ?? undefined,
    },
  };
}

/** A comment from the user's `comments` listing. */
export function commentRecord(comment: RedditComment): RedditRecord {
  return {
    kind: 'comment',
    fullname: comment.name,
    permalink: absolutePermalink(comment.permalink),
    subreddit: comment.subreddit,
    title: null,
    text: comment.body ?? '',
    createdAt: createdAtOf(comment.created_utc),
    media: firstRedditMediaLink(comment.body),
    author: comment.author,
    score: comment.score,
    extra: {
      link_title: comment.link_title,
    },
  };
}

/**
 * An item from the user's `saved` listing — a post or a comment written by
 * someone else (usually), told apart by the fullname prefix. RedditSavedItem
 * has no `is_self` flag, so a link post is identified by its url differing
 * from its own permalink — a self post's url is the permalink itself.
 */
export function savedRecord(item: RedditSavedItem): RedditRecord {
  const permalink = absolutePermalink(item.permalink);
  const isComment = isRedditCommentFullname(item.name);
  const linkUrl = !isComment && item.url && item.url !== permalink ? item.url : null;

  return {
    kind: isComment ? 'saved_comment' : 'saved_post',
    fullname: item.name,
    permalink,
    subreddit: item.subreddit,
    title: isComment ? null : (item.title ?? null),
    text: (isComment ? item.body : item.selftext) ?? '',
    createdAt: createdAtOf(item.created_utc),
    media: isComment ? firstRedditMediaLink(item.body) : redditLinkMedia(linkUrl),
    author: item.author,
    score: item.score,
    extra: {
      saved: true,
      link_title: item.link_title,
      link_url: linkUrl ?? undefined,
    },
  };
}

/**
 * Writes a Reddit post or comment the way the GDPR-export importer does
 * (import/push/canonical.ts `destinationsFor`, inputs.ts `toCommunicationInput`
 * / `toContentInput`), so a record arriving both ways lands in the same table
 * under the same key and the second arrival is a dedup hit:
 *
 * - A dated post or comment the user WROTE is a COMMUNICATION of type
 *   `post`, outbound, with the subreddit as its thread and, for a post, the
 *   title as its subject. Not an event: writing a post is something the user
 *   said, not a calendar entry.
 * - A CONTENT row rides along only when the record carries media: a link
 *   post's image/video, or the first image/video link in a comment's body.
 *   That row is the media, titled by the truncated text with the full body as
 *   its text, and is linked from the communication's `attachments`.
 * - A SAVED post or comment goes to content alone. The API's `created_utc` on
 *   it is when its author wrote it, and Reddit exposes no saved-at time (the
 *   export has none either), so there is no honest moment to give a
 *   communication. The content row keeps it searchable — author, subreddit,
 *   permalink, media — and lands on the same row the importer's undated
 *   saved_posts.csv / saved_comments.csv rows do.
 * - An UNDATED record likewise goes to content alone: `communications.time`
 *   is NOT NULL, and stamping the sync moment would present it as when it
 *   happened. (The API carries `created_utc` on everything, so this is the
 *   importer's rule kept for parity rather than a path the sync is expected
 *   to take.)
 *
 * Identity is `redditIdentity(kind, fullname)` — byte-identical to the id the
 * importer stamps on the same CSV row (memory/identity/reddit.ts).
 *
 * Earlier versions of these transforms wrote each post and comment as a
 * `ci.content` row plus a `ci.events` row keyed on the bare fullname. Those are
 * removed as each record is re-transformed, so the model change does not leave
 * a copy of every post behind in two other tables.
 */
@Injectable()
export class RedditRecordWriter {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly contentService: ContentService,
    private readonly eventService: CalendarEventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RedditRecordWriter.name);
  }

  async write(
    { userId, connection }: { userId: string; connection: Connection },
    record: RedditRecord,
  ): Promise<'created' | 'updated' | 'content_only'> {
    const context = { userId };
    const identity = redditIdentity(record.kind, record.fullname);
    const source = {
      source_type: REDDIT_SOURCE_TYPE,
      source_system: identity.system,
      source_id: identity.id,
    };
    const saved = record.kind === 'saved_post' || record.kind === 'saved_comment';
    const isComment = record.kind === 'comment' || record.kind === 'saved_comment';
    const sourceData: Record<string, unknown> = {
      reddit_fullname: record.fullname,
      reddit_id: redditBareId(record.fullname),
      kind: record.kind,
      permalink: record.permalink,
      subreddit: record.subreddit,
      author: record.author,
      score: record.score,
      // When the post/comment itself was written. Kept here rather than as the
      // record's time for a saved item, whose own moment (the save) is unknown.
      item_created_at: record.createdAt?.toISOString(),
      ...record.extra,
    };
    // The body. A bare link post has no selftext; its title is the only text
    // the user wrote, so it stands in (matching the importer, whose content for
    // a body-less post falls back to the title).
    const content = record.text.trim() || record.title?.trim() || '';

    // Content alone, no communication: nothing here is a moment we can place.
    // - Saved items: the API's `created_utc` is when SOMEONE ELSE wrote the
    //   thing; Reddit exposes no saved-at time (neither does the export). A
    //   communication needs a time, and that one would be a lie.
    // - Undated records: same NOT NULL `communications.time` reason, kept for
    //   parity with the importer (the API always carries created_utc).
    if (saved || !record.createdAt) {
      await this.contentService.create(
        context,
        this.contentRow(record, { content, isComment, sourceData, source, connection }),
      );

      if (saved) {
        // A saved item written as a communication by an earlier revision of
        // this writer (created_utc as its time) is the row this one replaces.
        const stale = await this.communicationService.findBySource(context, source);
        if (stale) {
          await this.communicationService.remove(context, stale.id);
          this.logger.log('Removed saved-item communication (saved items are content only)', {
            fullname: record.fullname,
            communicationId: stale.id,
          });
        }
      }

      await this.removeLegacyRows(userId, record.fullname);

      return 'content_only';
    }

    const attachments: Array<{ type: 'content'; id: string }> = [];

    if (record.media) {
      const [media] = await this.contentService.create(
        context,
        this.contentRow(record, { content, isComment, sourceData, source, connection }),
      );
      attachments.push({ type: 'content', id: media.id });
    }

    const row: CreateCommunicationDto = {
      time: record.createdAt,
      communication_type: CommunicationType.POST,
      direction: CommunicationDirection.OUTBOUND,
      thread_id: `r/${record.subreddit}`,
      content,
      connection_id: connection.id,
      ...source,
      metadata: sourceData,
      attachments,
    };

    // A post has a real authored title, so it becomes the subject. A comment
    // has none — the only subject derivable is a snippet of its own body,
    // which `content` already carries in full, so it stays blank.
    if (record.title && !isComment) {
      row.subject = record.title;
    }

    const preview = content ? clip(content, 140) : null;
    if (preview && preview !== content) {
      row.preview = preview;
    }

    const existing = await this.communicationService.findBySource(context, source);

    if (existing) {
      // Scores and comment counts move; refresh them. The importer's row may
      // already be here (that is the point of the shared key), so its metadata
      // bag is kept underneath ours rather than replaced.
      await this.communicationService.update(context, existing.id, {
        content,
        subject: row.subject,
        preview: row.preview,
        metadata: { ...(existing.metadata ?? {}), ...sourceData },
        attachments: attachments.length > 0 ? attachments : (existing.attachments ?? undefined),
      });
      // `update` does not ledger; without this the row shows only the pipeline
      // that inserted it, and the dedup hit that just happened is invisible to
      // ci.record_sources (and to the import doctor's pairing checks).
      await this.communicationService.recordArrival(context, existing.id, {
        ...source,
        connection_id: connection.id,
      });
    } else {
      await this.communicationService.create(context, row);
    }

    await this.removeLegacyRows(userId, record.fullname);

    return existing ? 'updated' : 'created';
  }

  /**
   * The record's `ci.content` row — the importer's `toContentInput` shape for a
   * Reddit record. With media it IS the media (typed image/video, the media URL
   * as its url), titled by the truncated text with the full body as its text; a
   * comment's gets no title, which would only repeat the text beside it.
   * Without media it is the post or comment itself, typed `social`, with the
   * permalink as the way back.
   */
  private contentRow(
    record: RedditRecord,
    {
      content,
      isComment,
      sourceData,
      source,
      connection,
    }: {
      content: string;
      isComment: boolean;
      sourceData: Record<string, unknown>;
      source: Pick<CreateContentDto, 'source_type' | 'source_system' | 'source_id'>;
      connection: Connection;
    },
  ): CreateContentDto {
    const row: CreateContentDto = {
      type: record.media?.kind ?? 'social',
      url: record.media?.url ?? record.permalink,
      external_id: record.fullname,
      external_id_kind: SOURCE_NATIVE_EXTERNAL_ID_KIND,
      connection_id: connection.id,
      source_data: sourceData,
      ...source,
    };

    if (!record.media) {
      if (record.title) {
        row.title = record.title;
      }

      if (content) {
        row.text = content;
      }

      return row;
    }

    if (content) {
      if (!isComment) {
        row.title = clip(content, 120);
      }

      row.text = content;
    }

    const mime = mimeForFile(new URL(record.media.url).pathname);
    if (mime) {
      row.mimetype = mime;
    }

    return row;
  }

  /** Drop the `ci.content` + `ci.events` rows the previous transforms wrote for this post/comment. */
  private async removeLegacyRows(userId: string, fullname: string): Promise<void> {
    const context = { userId };

    const contents = await this.contentService.search(context, { external_id: fullname });
    for (const row of contents) {
      if (LEGACY_CONTENT_TYPES.has(row.type)) {
        await this.contentService.remove(context, row.id);
        this.logger.log('Removed legacy Reddit content row', { fullname, contentId: row.id, type: row.type });
      }
    }

    // The old events were keyed (reddit, <fullname>) — `reddit_posts` etc.
    // aliased to `reddit` by the registry.
    const legacy = platformIdentity('reddit', fullname);
    const events = await this.eventService.search(context, {
      sourceSystem: legacy.system,
      sourceId: legacy.id,
    });
    for (const event of events) {
      if (event.eventType && LEGACY_EVENT_TYPES.has(event.eventType)) {
        await this.eventService.remove(context, event.id);
        this.logger.log('Removed legacy Reddit event row', {
          fullname,
          eventId: event.id,
          type: event.eventType,
        });
      }
    }
  }
}
