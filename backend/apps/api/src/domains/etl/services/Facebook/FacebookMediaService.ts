import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { FileService } from '@ci/domains/files';
import { type Content, ContentService, SOURCE_NATIVE_EXTERNAL_ID_KIND } from '@ci/domains/memory';

/** Provenance triple every Facebook connector row carries. */
export const FACEBOOK_SOURCE_TYPE = 'ETL';
export const FACEBOOK_SOURCE_SYSTEM = 'facebook';

/**
 * Largest media file this service will pull into the object store. Facebook
 * serves a personal video's `source` as one progressive MP4; anything past
 * this is left as a link rather than buffered through the API process.
 */
export const MAX_FACEBOOK_MEDIA_BYTES = 256 * 1024 * 1024;

export type FacebookMediaKind = 'photo' | 'video';

/** One Facebook photo or video, however it was reached (post attachment or `/me/photos|videos`). */
export interface FacebookMediaRef {
  kind: FacebookMediaKind;
  /**
   * The Graph id of the photo/video. A post attachment that carries no
   * `target.id` (older sync payloads requested none) gets a synthetic
   * `<post-id>:attachment:<n>` id from the caller instead, so it still has a
   * stable identity — it just cannot be matched to the standalone endpoints.
   */
  id: string;
  title: string;
  text?: string;
  /** The facebook.com page for the object — "open on Facebook", never an embed target. */
  pageUrl?: string;
  /**
   * The direct file URL on Facebook's CDN (`scontent-*.fbcdn.net` /
   * `video-*.fbcdn.net`). Signed and EXPIRING — the `oe=` query parameter is
   * the expiry — so it is only ever a download source and a fallback, never
   * the stored handle.
   */
  cdnUrl?: string;
  mimetype: string;
  createdTime?: string;
  /** Extra `source_data` keys for the row, merged under this service's own. */
  sourceData?: Record<string, unknown>;
}

export interface FacebookMediaResult {
  contentId: string;
  /** The `ci.files` id the bytes landed under, or null if they are only linked. */
  fileId: string | null;
}

/** Turn a Graph `permalink_url` — which Facebook returns host-relative for videos — into an absolute link. */
export function facebookUrl(pathOrUrl: string | undefined | null): string | undefined {
  if (!pathOrUrl) {
    return undefined;
  }

  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }

  return `https://www.facebook.com${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

function contentTypeFor(kind: FacebookMediaKind): string {
  return kind === 'photo' ? 'facebook_photo' : 'facebook_video';
}

function sourceIdFor(kind: FacebookMediaKind, id: string): string {
  return `${kind}:${id}`;
}

function extensionFor(mimetype: string): string {
  const [, subtype = ''] = mimetype.split('/');

  if (subtype === 'jpeg') {
    return 'jpg';
  }

  return subtype || 'bin';
}

/**
 * Puts Facebook photos and videos into the object store and catalogues each
 * one as a single `ci.content` row, whichever way the sync reached it.
 *
 * ## Why the bytes are copied
 *
 * The only URLs Facebook hands out for a media file are on its CDN, and those
 * are signed with an expiry of roughly a month. The row's `url` used to be
 * the facebook.com PAGE for the object (an HTML document — the drawer's
 * `<img>` refuses it and shows "Media couldn't be loaded"), and nothing at
 * all could play a video: the gateway's CSP is `media-src 'self'`, so a
 * remote `<video src>` is blocked before it is even fetched. The one handle
 * that renders, plays, and does not go stale is a file in our own store,
 * served under `/static` — the same shape every imported photo already has
 * (`external_id` = `ci.files` id, `external_id_kind: 'file'`; see
 * MediaStage.attachmentContentInput). So the CDN URL is used once, to fetch
 * the bytes, and kept only as `source_url` for the case where that fetch
 * fails.
 *
 * ## One row per object
 *
 * A photo that is both in `/me/photos` and attached to a post must not
 * become two rows. Identity is the provenance triple
 * `(ETL, facebook, photo:<graph-id>)`; the standalone endpoints and the post
 * transform both resolve through it, and whichever runs first creates the
 * row. Rows written before this service keyed on the Graph id in
 * `external_id` — those are claimed in place (the triple stamped, the file
 * attached) rather than duplicated.
 */
@Injectable()
export class FacebookMediaService {
  constructor(
    private readonly contentService: ContentService,
    private readonly fileService: FileService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FacebookMediaService.name);
  }

  async upsertMedia({
    userId,
    connectionId,
    media,
  }: {
    userId: string;
    connectionId: string;
    media: FacebookMediaRef;
  }): Promise<FacebookMediaResult> {
    const context = { userId };
    const source = {
      source_type: FACEBOOK_SOURCE_TYPE,
      source_system: FACEBOOK_SOURCE_SYSTEM,
      source_id: sourceIdFor(media.kind, media.id),
    };

    const existing =
      (await this.contentService.findBySource(context, source)) ?? (await this.findLegacy(userId, media));

    // Bytes already in the store: nothing to fetch. The CDN link may have
    // expired by now anyway, and the stored copy is the whole point.
    const storedFileId = existing?.externalIdKind === 'file' ? existing.externalId : null;
    const fileId = storedFileId ?? (await this.store(userId, media));

    const sourceData = {
      ...(media.sourceData ?? {}),
      contentType: contentTypeFor(media.kind),
      connection_id: connectionId,
      [media.kind === 'photo' ? 'facebook_photo_id' : 'facebook_video_id']: media.id,
      created_time: media.createdTime,
      cdn_url: media.cdnUrl,
      file_id: fileId ?? undefined,
    };

    const fields = {
      connection_id: connectionId,
      type: 'media',
      title: media.title,
      text: media.text ?? '',
      url: media.pageUrl,
      mimetype: media.mimetype,
      source_url: media.cdnUrl,
      source_data: sourceData,
      // The stored file when there is one; otherwise the Graph id, honestly
      // labelled as a source-native reference so nothing tries to resolve it
      // as a ci.files row.
      external_id: fileId ?? media.id,
      external_id_kind: fileId ? ('file' as const) : SOURCE_NATIVE_EXTERNAL_ID_KIND,
      ...source,
    };

    if (existing) {
      await this.contentService.update(context, existing.id, fields);

      return { contentId: existing.id, fileId };
    }

    const [created] = await this.contentService.create(context, { ...fields, user: { id: userId } });

    return { contentId: created.id, fileId };
  }

  /**
   * A row the previous transforms wrote for this object: `external_id` was the
   * Graph id and `source_data.contentType` said which endpoint it came from.
   */
  private async findLegacy(userId: string, media: FacebookMediaRef): Promise<Content | null> {
    const candidates = await this.contentService.search({ userId }, { external_id: media.id });
    const contentType = contentTypeFor(media.kind);

    return (
      candidates.find(
        (row) => (row.sourceData as Record<string, unknown> | null)?.contentType === contentType,
      ) ?? null
    );
  }

  /** Fetch the CDN file and upload it; null (logged) when that cannot be done. */
  private async store(userId: string, media: FacebookMediaRef): Promise<string | null> {
    if (!media.cdnUrl) {
      return null;
    }

    try {
      // Plain fetch, deliberately not the OAuth client: the CDN URL is
      // self-authorizing (signed) and our bearer token has no business there.
      const response = await fetch(media.cdnUrl);

      if (!response.ok) {
        throw new Error(`CDN responded ${response.status} ${response.statusText}`);
      }

      const declared = Number(response.headers.get('content-length') ?? 0);

      if (declared > MAX_FACEBOOK_MEDIA_BYTES) {
        throw new Error(`file is ${declared} bytes, over the ${MAX_FACEBOOK_MEDIA_BYTES}-byte limit`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      if (buffer.length > MAX_FACEBOOK_MEDIA_BYTES) {
        throw new Error(`file is ${buffer.length} bytes, over the ${MAX_FACEBOOK_MEDIA_BYTES}-byte limit`);
      }

      const { file } = await this.fileService.uploadWithDedupInfo(
        { userId },
        {
          buffer,
          filename: `facebook-${media.kind}-${media.id}.${extensionFor(media.mimetype)}`,
          contentType: media.mimetype,
          size: buffer.length,
          // The enrichment pipeline reaches stored files on its own; a
          // description here would be an Ollama round trip per photo.
          skipDescription: true,
        },
      );

      return file.id;
    } catch (error) {
      this.logger.warn('Could not store Facebook media; keeping the CDN link only', {
        kind: media.kind,
        id: media.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return null;
    }
  }
}
