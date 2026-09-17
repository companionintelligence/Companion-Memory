import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, Resolver, ResolveField } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { MaxArraySizePipe } from '@ci/common/pipes';
import {
  CommunicationService,
  CommunicationType as CommunicationTypeEnum,
  adoptIngestIdentity,
} from '@ci/domains/memory';
import { type Person } from '@ci/domains/memory';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { AttachmentFileLoader } from '../loaders/AttachmentFileLoader';
import { ContentFileLoader } from '../loaders/ContentFileLoader';
import { ContentLoader } from '../loaders/ContentLoader';
import { PersonLoader } from '../loaders/PersonLoader';
import { TagLoader } from '../loaders/TagLoader';
import { CommunicationAttachmentType } from '../types/CommunicationAttachmentType';
import { CommunicationConnection } from '../types/CommunicationConnection';
import { CommunicationEdge } from '../types/CommunicationEdge';
import { CommunicationType } from '../types/CommunicationType';
import { CreateCommunicationInput } from '../types/CreateCommunicationInput';
import { DeleteByIdInput } from '../types/DeleteByIdInput';
import { DeleteByIdPayload } from '../types/DeleteByIdPayload';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { PersonConnection } from '../types/PersonConnection';
import { PersonEdge } from '../types/PersonEdge';
import { PersonType } from '../types/PersonType';
import { UpdateCommunicationInput } from '../types/UpdateCommunicationInput';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => CommunicationType)
export class CommunicationResolver {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly attachmentFileLoader: AttachmentFileLoader,
    private readonly contentLoader: ContentLoader,
    private readonly contentFileLoader: ContentFileLoader,
    private readonly personLoader: PersonLoader,
    private readonly tagLoader: TagLoader,
  ) {}

  @Query(() => CommunicationConnection)
  async communications(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<CommunicationConnection> {
    const serviceContext = toServiceContext(context);

    const { entities, hasNextPage, hasPreviousPage, totalCount } = await this.communicationService.findPage(
      serviceContext,
      {
        first: pagination.first,
        last: pagination.last,
        afterId: pagination.after ? GlobalUID.decode(pagination.after).id : null,
        beforeId: pagination.before ? GlobalUID.decode(pagination.before).id : null,
      },
    );

    const edges: CommunicationEdge[] = entities.map((entity) => {
      const node = CommunicationType.toType(entity);

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

  @Query(() => CommunicationType, { nullable: true })
  async communication(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<CommunicationType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('communication', gid);

    const entity = await this.communicationService.findById(serviceContext, id);

    return entity ? CommunicationType.toType(entity) : null;
  }

  /**
   * Batch, idempotent communication ingest for the importer (net-new write path
   * outside ETL). Each input dedupes on the provenance triple (user, sourceType,
   * sourceSystem, sourceId) so a re-sync returns the existing communication
   * instead of inserting a duplicate. Returns created-or-existing rows in input
   * order.
   */
  @Mutation(() => [CommunicationType])
  // Idempotent bulk ingest: inserts new rows, and a re-sync only self-heals a
  // fixed set of source-derived columns on conflict (INGEST_REFRESH_COLUMNS) —
  // never a delete or a wholesale overwrite of unrelated data.
  @GraphqlPrivacy({ destructive: false })
  async createCommunications(
    @Context() context: RequestContext,
    @Args('input', { type: () => [CreateCommunicationInput] }, new MaxArraySizePipe())
    input: CreateCommunicationInput[],
  ): Promise<CommunicationType[]> {
    const serviceContext = toServiceContext(context);

    const communications = await this.communicationService.createMany(
      serviceContext,
      input.map((item) => ({
        communication_type: item.communicationType as CommunicationTypeEnum,
        time: item.time,
        content: item.content,
        preview: item.preview,
        subject: item.subject,
        // `direction` is stored verbatim; the column is plain text. Default to
        // 'inbound' when the importer omits it.
        direction: (item.direction ?? 'inbound') as 'inbound' | 'outbound',
        thread_id: item.threadId,
        from_entity_id: item.fromEntityId,
        to_entity_ids: item.toEntityIds,
        participants_metadata: item.participantsMetadata,
        attachments: item.attachments,
        duration_seconds: item.durationSeconds,
        source_type: item.sourceType,
        source_system: adoptIngestIdentity(item.sourceSystem, item.sourceId).system,
        source_id: adoptIngestIdentity(item.sourceSystem, item.sourceId).id,
      })),
    );

    return communications.map((communication) => CommunicationType.toType(communication));
  }

  @Mutation(() => CommunicationType, { nullable: true })
  // CommunicationService.update only patches fields that are truthy/defined on
  // this row (subject/content here); `content: input.content ?? ''` cannot
  // blank an existing value because the service guards with `if (data.content)`,
  // which treats '' as "not provided". The row and the people on it are
  // otherwise untouched.
  @GraphqlPrivacy({ destructive: false })
  async updateCommunication(
    @Context() context: RequestContext,
    @Args('input') input: UpdateCommunicationInput,
  ): Promise<CommunicationType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('communication', input.id);

    const entity = await this.communicationService.update(serviceContext, id, {
      subject: input.subject,
      content: input.content ?? '',
    });

    return entity ? CommunicationType.toType(entity) : null;
  }

  /**
   * Deletes a message/call addressed by its global id. A HARD delete — the
   * communication and its `ci.entities` base row are destroyed and cannot be
   * restored. The people it was with are untouched.
   */
  @Mutation(() => DeleteByIdPayload)
  // Confirmed HARD delete per the method's own doc comment above: CommunicationService.remove
  // deletes the base row (FK cascade removes the detail row too), with no
  // restore path in the schema.
  @GraphqlPrivacy({ access: 'delete', destructive: true })
  async deleteCommunication(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('communication', input.id);

    const success = await this.communicationService.remove(serviceContext, id);

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

  @ResolveField(() => PersonType, { nullable: true })
  async from(
    @Context() context: RequestContext,
    @Parent() parent: CommunicationType,
  ): Promise<PersonType | null> {
    const serviceContext = toServiceContext(context);

    if (parent.__source.fromEntityId == null) {
      return null;
    }

    const person = await this.personLoader.load(serviceContext, parent.__source.fromEntityId);

    return person ? PersonType.toType(person) : null;
  }

  @ResolveField(() => PersonConnection)
  async to(
    @Context() context: RequestContext,
    @Parent() parent: CommunicationType,
    @Args() pagination: PaginationArgs,
  ): Promise<PersonConnection> {
    const serviceContext = toServiceContext(context);

    const people =
      parent.__source.toEntityIds == null
        ? []
        : await this.personLoader.loadMany(serviceContext, parent.__source.toEntityIds);

    // TODO:
    //   Report errors here somehow instead of swallowing them.
    //   Consider emitting a warning log or investigate more deeply
    //   how we might convey a single error within a list.
    const filteredPeople = people.filter(
      (person): person is Person => person != null && !(person instanceof Error),
    );

    const { slice, pageInfo, totalCount } = Paginator.paginate(filteredPeople, {
      ...pagination,
      getId: (person) => GlobalUID.encode('person', person.id),
    });

    const edges: PersonEdge[] = slice.map((person) => {
      const node = PersonType.toType(person);

      return {
        node,
        cursor: node.id,
      };
    });

    return {
      edges,
      pageInfo,
      totalCount,
    };
  }

  /**
   * The files that arrived with this message.
   *
   * Reads `ci.communications.attachments`, which holds a flat list of
   * `{ type, id }` references — every `file` ref, then every `content` ref —
   * and pairs them back into one entry per attachment. The pairing is by index,
   * which is the invariant the writer states and enforces: `MediaStage` stamps
   * `AttachmentFileIds` and `AttachmentContentIds` from the same descriptor
   * list, all-or-nothing, so attachment i is `{ file: files[i], content:
   * contents[i] }`. Any content ref beyond the file list still gets its own
   * entry rather than being dropped — the column predates the writer, and a
   * reference nobody can explain is better shown than silently swallowed.
   *
   * A content ref with no file half is not an oddity, though: it is how a
   * reddit post carries its picture. That importer attaches the post image as
   * a `ci.content` row holding the image's URL and mimetype, and stores no
   * file. Such an entry used to come back with only `contentId` set, which the
   * drawer could neither render (no url, no content type) nor list (no
   * filename), so the picture vanished. Now the content row is read too: a row
   * that points at a stored file (`external_id_kind = 'file'`) renders that
   * file's original and preview, and a row that only knows a URL renders the
   * URL with its mimetype. The file half still wins when both are present —
   * it carries dimensions, a preview and a real filename.
   *
   * Empty for every message in an import that ran before the attachment leg
   * existed: those files were deleted with the run's scratch tree, so there is
   * nothing to point at until the archive is imported again.
   */
  @ResolveField(() => [CommunicationAttachmentType])
  async attachments(
    @Context() context: RequestContext,
    @Parent() parent: CommunicationType,
  ): Promise<CommunicationAttachmentType[]> {
    const refs = parent.__source.attachments;

    // The overwhelmingly common case, and it must not cost a query: every
    // message imported before the attachment leg existed sits at `[]`.
    if (!Array.isArray(refs) || refs.length === 0) {
      return [];
    }

    const serviceContext = toServiceContext(context);
    const fileIds = attachmentRefIds(refs, 'file');
    const contentIds = attachmentRefIds(refs, 'content');

    const [files, contentMedia] = await Promise.all([
      this.attachmentFileLoader.loadMany(serviceContext, fileIds),
      this.mediaForContentRefs(serviceContext, contentIds),
    ]);
    const total = Math.max(fileIds.length, contentIds.length);
    const attachments: CommunicationAttachmentType[] = [];

    for (let i = 0; i < total; i += 1) {
      const file = files[i];
      // `loadMany` resolves a failed key to an Error rather than rejecting, so a
      // single unreadable file cannot take the whole message's list with it.
      const media = file instanceof Error || file == null ? (contentMedia[i] ?? null) : file;

      attachments.push({
        fileId: fileIds[i] ?? null,
        contentId: contentIds[i] ?? null,
        filename: media?.filename ?? null,
        contentType: media?.contentType ?? null,
        url: media?.url ?? null,
        previewUrl: media?.previewUrl ?? null,
        width: media?.width ?? null,
        height: media?.height ?? null,
        size: media?.size ?? null,
      });
    }

    return attachments;
  }

  /**
   * What each `content` reference can show, index-aligned with `contentIds`
   * (null where the row is gone or has nothing renderable). Two hops at most,
   * both batched: the content rows in one query, then the stored files behind
   * the rows that have one in another — a message with ten reddit pictures
   * costs two queries, not twenty.
   */
  private async mediaForContentRefs(
    context: ReturnType<typeof toServiceContext>,
    contentIds: string[],
  ): Promise<(AttachmentMedia | null)[]> {
    if (contentIds.length === 0) {
      return [];
    }

    const loaded = await this.contentLoader.loadMany(context, contentIds);
    const rows = loaded.map((row) => (row instanceof Error || row == null ? null : row));

    // The file id a row points at, when it points at one — see ContentFileLoader.
    const storedFileIds = rows.map((row) =>
      row?.externalIdKind === 'file' && row.externalId ? row.externalId : null,
    );
    const wanted = storedFileIds.filter((id): id is string => id != null);
    const storedFiles = wanted.length > 0 ? await this.contentFileLoader.loadMany(context, wanted) : [];

    let storedCursor = 0;

    return rows.map((row, index) => {
      if (row == null) {
        return null;
      }

      if (storedFileIds[index] != null) {
        const stored = storedFiles[storedCursor];
        storedCursor += 1;

        if (stored != null && !(stored instanceof Error)) {
          return {
            filename: stored.filename,
            contentType: stored.contentType,
            url: stored.mediaUrl,
            previewUrl: stored.previewUrl,
            width: null,
            height: null,
            size: stored.size,
          };
        }
        // A purged or unreadable file: fall through to whatever URL the row
        // itself carries, which for a stored-file row is usually nothing.
      }

      const url = row.url ?? row.sourceUrl ?? null;

      if (!url) {
        return null;
      }

      return {
        filename: filenameFromUrl(url) ?? row.title ?? null,
        contentType: row.mimetype ?? null,
        url,
        previewUrl: null,
        width: null,
        height: null,
        size: null,
      };
    });
  }

  @ResolveField(() => [EntityTagType])
  async tags(
    @Context() context: RequestContext,
    @Parent() parent: CommunicationType,
  ): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'communication',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}

/** The displayable half of an attachment, from whichever side could provide it. */
type AttachmentMedia = Pick<
  CommunicationAttachmentType,
  'filename' | 'contentType' | 'url' | 'previewUrl' | 'width' | 'height' | 'size'
>;

/**
 * The last path segment of a URL, as a display name for a picture that lives
 * only at that URL (`https://i.redd.it/wu4xdo8if75h1.png` -> `wu4xdo8if75h1.png`).
 * Null when the URL does not parse or ends in a bare host or slash.
 */
function filenameFromUrl(url: string): string | null {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop();

    return segment ? decodeURIComponent(segment) : null;
  } catch {
    return null;
  }
}

/**
 * The ids of one kind of reference in an `attachments` column.
 *
 * Defensive about the element shape on purpose: this is a `jsonb` column with no
 * constraint behind it, written by an importer and previously by nothing at all,
 * so an entry that is not an object with a string id is skipped rather than
 * allowed to throw on a message list.
 */
function attachmentRefIds(refs: unknown[], kind: 'file' | 'content'): string[] {
  const ids: string[] = [];

  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') {
      continue;
    }

    const entry = ref as { type?: unknown; id?: unknown };

    if (entry.type === kind && typeof entry.id === 'string' && entry.id.length > 0) {
      ids.push(entry.id);
    }
  }

  return ids;
}
