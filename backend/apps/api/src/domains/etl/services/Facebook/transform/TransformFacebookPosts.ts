import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, type FacebookPost, type FacebookPostAttachment } from '@ci/domains/connections';
import {
  CommunicationDirection,
  CommunicationService,
  CommunicationType,
  ContentService,
  type CreateCommunicationDto,
  facebookPostIdentity,
} from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import {
  FACEBOOK_SOURCE_TYPE,
  FacebookMediaService,
  type FacebookMediaRef,
  facebookUrl,
} from '../FacebookMediaService';

/**
 * The post's own page on facebook.com, built from its Graph id.
 *
 * A post id is `<author-id>_<post-id>`, and `facebook.com/<author-id>/posts/<post-id>`
 * is what Graph returns as `permalink_url` for it. Used when the sync did not
 * carry `permalink_url` (payloads fetched before it was requested), so the
 * communication still links to the POST — not to `link`, which for a photo
 * post is the photo's page and for a share is the shared URL.
 */
export function derivedPostUrl(postId: string): string | undefined {
  const match = /^(\d+)_(\d+)$/.exec(postId);

  return match ? `https://www.facebook.com/${match[1]}/posts/${match[2]}` : undefined;
}

/** `source_data.contentType` values the previous transforms wrote for a post's own row. */
const LEGACY_POST_CONTENT_TYPES = new Set(['facebook_post', 'facebook_like']);

/**
 * The photos and videos a post carries, in order, as media references.
 *
 * An `album` attachment holds its items under `subattachments`; anything
 * that is a share, a link preview, or otherwise not a photo/video is dropped
 * (it is already on the communication as `metadata.link`). Facebook labels
 * the same thing two ways — `media_type` (`photo`/`video`) and the older,
 * finer `type` (`photo`, `video_inline`, `video_autoplay`, `cover_photo`,
 * ...) — so both are read. An attachment with no `target.id` (older sync
 * payloads did not request it) gets a stable synthetic id off the post.
 */
export function postMedia(post: FacebookPost): FacebookMediaRef[] {
  const refs: FacebookMediaRef[] = [];
  let n = 0;

  const visit = (attachment: FacebookPostAttachment) => {
    const nested = attachment.subattachments?.data;

    if (nested && nested.length > 0) {
      nested.forEach(visit);

      return;
    }

    const kind = mediaKind(attachment);

    if (!kind) {
      return;
    }

    const index = n++;
    const id = attachment.target?.id ?? `${post.id}:attachment:${index}`;
    const cdnUrl = kind === 'video' ? attachment.media?.source : attachment.media?.image?.src;

    refs.push({
      kind,
      id,
      title: post.message?.trim() || (kind === 'photo' ? `Photo ${id}` : `Video ${id}`),
      pageUrl: facebookUrl(attachment.target?.url ?? attachment.url),
      cdnUrl,
      mimetype: kind === 'photo' ? 'image/jpeg' : 'video/mp4',
      createdTime: post.created_time,
      sourceData: {
        facebook_post_id: post.id,
        attachment_type: attachment.type,
        attachment_media_type: attachment.media_type,
        thumbnail_url: kind === 'video' ? attachment.media?.image?.src : undefined,
      },
    });
  };

  post.attachments?.data?.forEach(visit);

  return refs;
}

function mediaKind(attachment: FacebookPostAttachment): FacebookMediaRef['kind'] | null {
  const mediaType = attachment.media_type?.toLowerCase();
  const type = attachment.type?.toLowerCase() ?? '';

  if (mediaType === 'video' || type.startsWith('video')) {
    return 'video';
  }

  if (mediaType === 'photo' || type === 'photo' || type === 'cover_photo' || type === 'profile_media') {
    return 'photo';
  }

  // No label at all but an image was inlined — the pre-`media_type` payload
  // shape. A share/link preview also carries an image, but those come with a
  // `type`, so an unlabelled image is a photo.
  if (!mediaType && !type && attachment.media?.image?.src) {
    return 'photo';
  }

  return null;
}

/**
 * A Facebook post is something the user SAID — a communication, of type
 * `post`, outbound — not a piece of content. The photos and videos attached to
 * it are content (one row each, shared with `/me/photos` and `/me/videos` via
 * FacebookMediaService) and are linked from the communication's
 * `attachments` column in the `{ type: 'file' | 'content', id }` vocabulary
 * the import pipeline already uses (see push/inputs.ts attachmentsFor).
 *
 * Earlier versions of this transform wrote the post itself as a `ci.content`
 * row keyed on the post id (and SyncLikes, which requested `/me/posts` by
 * mistake, wrote the same posts again as `facebook_like`). Those rows are
 * removed here as each post is re-transformed, so the model change does not
 * leave a duplicate of every post behind as content.
 */
@Injectable()
export class FacebookPostsTransformService {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly contentService: ContentService,
    private readonly facebookMediaService: FacebookMediaService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FacebookPostsTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;
    this.logger.log('Starting Facebook posts transformation', {
      userId,
      connectionId: connection.id,
    });
    try {
      const posts = this.extractPosts(data);
      if (posts.length === 0) {
        this.logger.log('No Facebook posts found to transform', { userId, connectionId: connection.id });

        return;
      }

      let created = 0;
      let updated = 0;

      for (const post of posts) {
        try {
          const outcome = await this.upsertPost({ userId, connection, post });

          if (outcome === 'created') {
            created += 1;
          } else {
            updated += 1;
          }
        } catch (error) {
          this.logger.error('Error processing Facebook post', {
            postId: post.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      this.logger.log('Facebook posts transformation completed', {
        userId,
        connectionId: connection.id,
        processedCount: posts.length,
        created,
        updated,
      });
    } catch (error) {
      this.logger.error('Error transforming Facebook posts', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private async upsertPost({
    userId,
    connection,
    post,
  }: {
    userId: string;
    connection: Connection;
    post: FacebookPost;
  }): Promise<'created' | 'updated'> {
    const context = { userId };

    // Media first: the communication's attachments column points at these
    // rows, so they have to exist before the row that references them.
    const attachments: Array<{ type: 'file' | 'content'; id: string }> = [];

    for (const media of postMedia(post)) {
      const { contentId, fileId } = await this.facebookMediaService.upsertMedia({
        userId,
        connectionId: connection.id,
        media,
      });

      if (fileId) {
        attachments.push({ type: 'file', id: fileId });
      }

      attachments.push({ type: 'content', id: contentId });
    }

    const permalink = facebookUrl(post.permalink_url) ?? derivedPostUrl(post.id);
    const text = post.message?.trim() || post.story?.trim() || post.link || '';
    // Tuple identity (posted-at second + text hash), NOT the Graph post id:
    // the Meta archive carries no Graph ids, so this is the only key both
    // pipelines can compute for the same post — the archive import mints the
    // identical one (docs/design/cross-pipeline-identity.md §3.5). The Graph
    // id stays in metadata below for lookups.
    const source = {
      source_type: FACEBOOK_SOURCE_TYPE,
      ...(() => {
        const identity = facebookPostIdentity(new Date(post.created_time), text);

        return { source_system: identity.system, source_id: identity.id };
      })(),
    };

    const row: CreateCommunicationDto = {
      time: new Date(post.created_time),
      communication_type: CommunicationType.POST,
      direction: CommunicationDirection.OUTBOUND,
      content: text,
      connection_id: connection.id,
      ...source,
      participants_metadata: {
        facebook_user_id: post.from?.id,
        facebook_user_name: post.from?.name,
      },
      metadata: {
        facebook_post_id: post.id,
        permalink_url: permalink,
        link: post.link,
        post_type: post.type,
        story: post.story,
        full_picture: post.full_picture,
        created_time: post.created_time,
      },
      attachments,
    };

    const existing = await this.communicationService.findBySource(context, source);

    if (existing) {
      await this.communicationService.update(context, existing.id, {
        content: text,
        attachments,
        participants_metadata: row.participants_metadata,
        metadata: row.metadata,
      });
    } else {
      await this.communicationService.create(context, row);
    }

    await this.removeLegacyContent(userId, post.id);

    return existing ? 'updated' : 'created';
  }

  /** Drop the `ci.content` row(s) the old transforms wrote for this post. */
  private async removeLegacyContent(userId: string, postId: string): Promise<void> {
    const rows = await this.contentService.search({ userId }, { external_id: postId });

    for (const row of rows) {
      const contentType = (row.sourceData as Record<string, unknown> | null)?.contentType;

      if (typeof contentType === 'string' && LEGACY_POST_CONTENT_TYPES.has(contentType)) {
        await this.contentService.remove({ userId }, row.id);
        this.logger.log('Removed legacy Facebook post content row', {
          postId,
          contentId: row.id,
          contentType,
        });
      }
    }
  }

  private extractPosts(content: unknown): FacebookPost[] {
    if (!content || typeof content !== 'object') {
      return [];
    }

    const contentObj = content as Record<string, unknown>;
    if (Array.isArray(contentObj)) {
      return contentObj as FacebookPost[];
    }

    if ('posts' in contentObj && Array.isArray(contentObj.posts)) {
      return contentObj.posts as FacebookPost[];
    }

    return [];
  }
}
