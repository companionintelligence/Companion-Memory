import { BadRequestException, UseGuards } from '@nestjs/common';
import { Args, Float, ID, Parent, Query, Mutation, Resolver, ResolveField } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { derivePlayer, resolveTargetFor, watchLinkFor } from '@ci/domains/embed';
import { CreateContentInput } from '@ci/domains/graphql/types/CreateContentInput';
import { UpdateContentInput } from '@ci/domains/graphql/types/UpdateContentInput';
import { ContentService, classifyExternalId, adoptIngestIdentity } from '@ci/domains/memory';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { type ContentFileMedia, ContentFileLoader } from '../loaders/ContentFileLoader';
import { EventLoader } from '../loaders/EventLoader';
import { TagLoader } from '../loaders/TagLoader';
import { UnfurlLoader } from '../loaders/UnfurlLoader';
import { ContentConnection } from '../types/ContentConnection';
import { ContentEdge } from '../types/ContentEdge';
import { ContentFacetsType } from '../types/ContentFacetsType';
import { ContentType } from '../types/ContentType';
import { DeleteByIdInput } from '../types/DeleteByIdInput';
import { DeleteByIdPayload } from '../types/DeleteByIdPayload';
import { EmbedPlayerType } from '../types/EmbedPlayerType';
import { EntityTagType } from '../types/EntityTagType';
import { EventType } from '../types/EventType';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { UnfurlType } from '../types/UnfurlType';
import { entityOwnerScope } from '../utils/entityOwnerScope';

/**
 * Upper bound on rows accepted by a single createContents call. The batch runs
 * as one set-based transaction (see ContentService.createMany); an unbounded
 * array would build a giant OR-list + VALUES clause and pin a connection. The
 * importer already chunks its pushes well under this, so this is a guardrail,
 * not a throttle.
 */
export const CREATE_CONTENTS_MAX_BATCH = 5000;

/**
 * Resolve an event reference to the raw uuid stored in ci.content.event_id.
 * Accepts either a relay global id (base64 "event:<uuid>", exactly what
 * createEvent returns) or a bare uuid, so a client can link content using the
 * same id it got back from createEvent.
 */
export function resolveEventId(eventId: string): string {
  try {
    const { type, id } = GlobalUID.decode(eventId);
    if (type === 'event' && id) {
      return id;
    }
  } catch {
    // Not a global id — treat the input as an already-raw uuid.
  }

  return eventId;
}

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ContentType)
export class ContentResolver {
  constructor(
    private readonly contentService: ContentService,
    private readonly tagLoader: TagLoader,
    private readonly eventLoader: EventLoader,
    private readonly contentFileLoader: ContentFileLoader,
    private readonly unfurlLoader: UnfurlLoader,
  ) {}

  /**
   * Single-record content ingest. Routed through ContentService.createMany so it
   * shares the same provenance-triple dedup + event auto-link as the batch path —
   * a re-send with the same (userId, sourceType, sourceSystem, sourceId) returns
   * the existing row instead of inserting a duplicate-without-triple. Passes
   * `emitCreated: true` so this interactive create indexes live (the batch
   * importer defers indexing to the post-load backfill sweep) — the event fires
   * only when a row is genuinely inserted, so a dedup re-send stays a no-op.
   */
  @Mutation(() => ContentType)
  // Single-record ingest routed through the same idempotent createMany as
  // createContents below: a re-send with the same provenance triple returns
  // the existing row rather than inserting or overwriting anything.
  @GraphqlPrivacy({ destructive: false })
  async createContent(
    @Context() context: RequestContext,
    @Args('input') input: CreateContentInput,
  ): Promise<ContentType> {
    const serviceContext = toServiceContext(context);

    const [entity] = await this.contentService.createMany(
      serviceContext,
      [
        {
          type: input.type,
          title: input.title,
          text: input.text,
          url: input.url,
          mimetype: input.mimetype,
          external_id: input.externalId,
          source_url: input.sourceUrl,
          source_data: input.sourceData,
          source_type: input.sourceType,
          source_system: adoptIngestIdentity(input.sourceSystem, input.sourceId).system,
          source_id: adoptIngestIdentity(input.sourceSystem, input.sourceId).id,
          event: input.eventId ? { id: resolveEventId(input.eventId) } : undefined,
        },
      ],
      { emitCreated: true },
    );

    return ContentType.toType(entity);
  }

  /**
   * Batch, idempotent content ingest for the importer. Each input dedupes on the
   * provenance triple (user, sourceType, sourceSystem, sourceId) so a re-sync
   * returns the existing content instead of inserting a duplicate. Each row also
   * links to its event: an explicit eventId wins, otherwise the event sharing the
   * same provenance triple is auto-linked (see ContentService.createMany). Returns
   * created-or-existing rows in input order.
   */
  @Mutation(() => [ContentType])
  // Batch, idempotent ingest: dedupes on the provenance triple, so a re-sync
  // returns the existing row instead of inserting a duplicate. No delete or
  // wholesale overwrite of unrelated data.
  @GraphqlPrivacy({ destructive: false })
  async createContents(
    @Context() context: RequestContext,
    @Args('input', { type: () => [CreateContentInput] }) input: CreateContentInput[],
  ): Promise<ContentType[]> {
    if (input.length > CREATE_CONTENTS_MAX_BATCH) {
      throw new BadRequestException(
        `createContents accepts at most ${CREATE_CONTENTS_MAX_BATCH} items per call (got ${input.length}).`,
      );
    }

    const serviceContext = toServiceContext(context);

    const contents = await this.contentService.createMany(
      serviceContext,
      input.map((item) => ({
        type: item.type,
        title: item.title,
        text: item.text,
        url: item.url,
        mimetype: item.mimetype,
        external_id: item.externalId,
        source_url: item.sourceUrl,
        source_data: item.sourceData,
        source_type: item.sourceType,
        source_system: adoptIngestIdentity(item.sourceSystem, item.sourceId).system,
        source_id: adoptIngestIdentity(item.sourceSystem, item.sourceId).id,
        event: item.eventId ? { id: resolveEventId(item.eventId) } : undefined,
      })),
    );

    return contents.map((content) => ContentType.toType(content));
  }

  @Mutation(() => ContentType, { nullable: true })
  // ContentService.update only patches fields explicitly present on this row
  // (type/title/text/url/mimetype/externalId/sourceUrl/sourceData); the row
  // stays intact and readable throughout.
  @GraphqlPrivacy({ destructive: false })
  async updateContent(
    @Context() context: RequestContext,
    @Args('input') input: UpdateContentInput,
  ): Promise<ContentType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('content', input.id);

    const entity = await this.contentService.update(serviceContext, id, {
      type: input.type,
      title: input.title,
      text: input.text,
      url: input.url,
      mimetype: input.mimetype,
      external_id: input.externalId,
      source_url: input.sourceUrl,
      source_data: input.sourceData,
    });

    return entity ? ContentType.toType(entity) : entity;
  }

  /**
   * @deprecated Returns a bare boolean and takes a positional `id` argument. Use
   * {@link deleteContent}, which follows the `DeleteByIdInput`/`DeleteByIdPayload`
   * convention the rest of this family uses.
   */
  @Mutation(() => Boolean)
  // Deprecated alias for deleteContent, same ContentService.remove call below —
  // declared so deprecating it cannot quietly downgrade it.
  @GraphqlPrivacy({ access: 'delete', destructive: true })
  async removeContent(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<boolean> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('content', gid);

    return this.contentService.remove(serviceContext, id);
  }

  /**
   * Deletes content addressed by its global id. Unlike an event this is a HARD
   * delete — the row and its `ci.entities` base row are destroyed and cannot be
   * restored.
   */
  @Mutation(() => DeleteByIdPayload)
  // Confirmed HARD delete per the method's own doc comment above: the content
  // row and its `ci.entities` base row are destroyed with no restore path.
  @GraphqlPrivacy({ access: 'delete', destructive: true })
  async deleteContent(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('content', input.id);

    const success = await this.contentService.remove(serviceContext, id);

    if (!success) {
      return {
        success: false,
      };
    }

    return {
      success,
      deletedId: input.id,
    };
  }

  @Query(() => ContentFacetsType, {
    description: 'The distinct type / mimetype / source values the content library can filter by.',
  })
  async contentFacets(@Context() context: RequestContext): Promise<ContentFacetsType> {
    return this.contentService.getFacets(toServiceContext(context));
  }

  @Query(() => ContentConnection)
  async contents(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
    @Args('query', {
      type: () => String,
      nullable: true,
      description: 'Substring of the title, text or URL — the header search box on /memory/content.',
    })
    query?: string,
    @Args('types', { type: () => [String], nullable: true, description: 'Keep only these `type` values.' })
    types?: string[],
    @Args('mimetypes', { type: () => [String], nullable: true, description: 'Keep only these mimetypes.' })
    mimetypes?: string[],
    @Args('connectors', {
      type: () => [String],
      nullable: true,
      description:
        'Keep only rows delivered by these platforms (the values `contentFacets.sourceSystems` offers) — the same How filter the explorer takes.',
    })
    connectors?: string[],
  ): Promise<ContentConnection> {
    const serviceContext = toServiceContext(context);

    const { entities, hasNextPage, hasPreviousPage, totalCount } = await this.contentService.findPage(
      serviceContext,
      {
        first: pagination.first,
        last: pagination.last,
        afterId: pagination.after ? GlobalUID.decode(pagination.after).id : null,
        beforeId: pagination.before ? GlobalUID.decode(pagination.before).id : null,
      },
      {
        ...(query && query.trim() !== '' ? { query: query.trim() } : {}),
        ...(types && types.length > 0 ? { types } : {}),
        ...(mimetypes && mimetypes.length > 0 ? { mimetypes } : {}),
        ...(connectors && connectors.length > 0 ? { sourceSystems: connectors } : {}),
      },
    );

    const edges: ContentEdge[] = entities.map((entity) => {
      const node = ContentType.toType(entity);

      return {
        node,
        cursor: node.id,
      };
    });

    const pageInfo = {
      hasNextPage,
      hasPreviousPage,
      startCursor: edges.length > 0 ? edges[0].cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    };

    return {
      edges,
      pageInfo,
      totalCount,
    };
  }

  @Query(() => ContentType, { nullable: true })
  async content(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<ContentType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('content', gid);

    const entity = await this.contentService.findById(serviceContext, id);

    return entity ? ContentType.toType(entity) : null;
  }

  @ResolveField(() => EventType, { nullable: true })
  async event(@Context() context: RequestContext, @Parent() parent: ContentType): Promise<EventType | null> {
    const serviceContext = toServiceContext(context);

    if (parent.__source.event?.id == null) {
      return null;
    }

    const event = await this.eventLoader.load(serviceContext, parent.__source.event.id);

    return event ? EventType.toType(event) : null;
  }

  /**
   * Resolve the file a media content row points at (null for every other row).
   *
   * `external_id` is structurally overloaded — it holds a `ci.files.id` only
   * when `external_id_kind` says 'file'. Unclassified rows (NULL kind, written
   * before migration 20260818215331) are re-tested by shape via
   * {@link classifyExternalId} rather than assumed to be file ids, matching what
   * ContentService.findMediaFilesByEventIds does on the event side. The three
   * media fields below share this one DataLoader call, so a page of content
   * rows resolves its binaries in a single batch.
   */
  private resolveFileMedia(context: RequestContext, parent: ContentType): Promise<ContentFileMedia | null> {
    const { externalId, externalIdKind, userId } = parent.__source;

    if (!externalId) {
      return Promise.resolve(null);
    }

    const kind = externalIdKind ?? classifyExternalId(externalId);

    if (kind !== 'file') {
      return Promise.resolve(null);
    }

    return this.contentFileLoader.load(entityOwnerScope(context, userId), externalId);
  }

  /** Thumbnail (PREVIEW variant) URL of the linked file, when one exists. */
  @ResolveField(() => String, { nullable: true })
  async previewUrl(
    @Context() context: RequestContext,
    @Parent() parent: ContentType,
  ): Promise<string | null> {
    return (await this.resolveFileMedia(context, parent))?.previewUrl ?? null;
  }

  /** Full-resolution (ORIGINAL variant) URL of the linked file. */
  @ResolveField(() => String, { nullable: true })
  async mediaUrl(@Context() context: RequestContext, @Parent() parent: ContentType): Promise<string | null> {
    return (await this.resolveFileMedia(context, parent))?.mediaUrl ?? null;
  }

  /** Browser-playable (PLAYBACK variant) URL of the linked video, when one exists — see EventResolver.playbackUrl. */
  @ResolveField(() => String, { nullable: true })
  async playbackUrl(
    @Context() context: RequestContext,
    @Parent() parent: ContentType,
  ): Promise<string | null> {
    return (await this.resolveFileMedia(context, parent))?.playbackUrl ?? null;
  }

  @ResolveField(() => String, { nullable: true })
  async playbackContentType(
    @Context() context: RequestContext,
    @Parent() parent: ContentType,
  ): Promise<string | null> {
    return (await this.resolveFileMedia(context, parent))?.playbackContentType ?? null;
  }

  /** Byte size of the linked ORIGINAL. */
  @ResolveField(() => Float, { nullable: true })
  async mediaSize(@Context() context: RequestContext, @Parent() parent: ContentType): Promise<number | null> {
    return (await this.resolveFileMedia(context, parent))?.size ?? null;
  }

  /** Filename of the linked ORIGINAL. */
  @ResolveField(() => String, { nullable: true })
  async mediaFilename(
    @Context() context: RequestContext,
    @Parent() parent: ContentType,
  ): Promise<string | null> {
    return (await this.resolveFileMedia(context, parent))?.filename ?? null;
  }

  /**
   * Tier-0 embed: a pure function of the row's URL, so no loader and no I/O.
   * `externalId` is tried first because import writes the provider's native
   * handle there (`spotify:track:…`), which canonicalizes even when `url` is
   * absent; `sourceUrl` covers ETL-written rows whose `url` is a media file.
   */
  @ResolveField(() => EmbedPlayerType, { nullable: true })
  player(@Parent() parent: ContentType): EmbedPlayerType | null {
    const { externalId, externalIdKind, url, sourceUrl } = parent.__source;
    const kind = externalIdKind ?? classifyExternalId(externalId);
    const candidates = [kind === 'external_uri' ? externalId : null, url, sourceUrl];

    for (const candidate of candidates) {
      const player = derivePlayer(candidate);
      if (player) {
        return EmbedPlayerType.toType(player);
      }
    }

    return null;
  }

  /**
   * Cached link preview for the row's resolve key. The key is recomputed here
   * with the same pure function the stage used, so nothing links content to
   * `ci.unfurls` but the derivation itself.
   */
  @ResolveField(() => UnfurlType, { nullable: true })
  async unfurl(
    @Context() context: RequestContext,
    @Parent() parent: ContentType,
  ): Promise<UnfurlType | null> {
    const { sourceSystem, url, sourceUrl, externalId, externalIdKind, sourceData, userId } = parent.__source;
    const target = resolveTargetFor({
      sourceSystem,
      url,
      sourceUrl,
      externalId,
      externalIdKind,
      sourceTitle: typeof sourceData?.Title === 'string' ? sourceData.Title : null,
    });
    if (!target) {
      return null;
    }

    const cached = await this.unfurlLoader.load(entityOwnerScope(context, userId), target.key);
    if (!cached) {
      return null;
    }

    // The cache row is per WORK and shared by every source that resolved to
    // it. When Wikidata knows the provider's own page for THIS row's source
    // (embed/watchLinks.ts), that page is the row's "open" target and the
    // Wikipedia article steps aside into the payload.
    const watch = watchLinkFor(sourceSystem, cached.payload);
    const view = watch
      ? {
          ...cached,
          canonicalUrl: watch.url,
          siteName: watch.siteName,
          payload: { ...cached.payload, wikipedia_url: cached.canonicalUrl ?? undefined },
        }
      : cached;

    // Shared by every episode too; the episode coordinates are this row's
    // own, parsed from its title.
    const work = target.work;
    if (!work || (work.season == null && work.episode == null && !work.episodeTitle)) {
      return UnfurlType.toType(view);
    }

    return UnfurlType.toType({
      ...view,
      payload: {
        ...view.payload,
        season: work.season,
        episode: work.episode,
        episode_title: work.episodeTitle,
      },
    });
  }

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: ContentType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'content',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}
