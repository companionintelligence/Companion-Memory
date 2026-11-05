import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { type BrowserActivity, BrowserActivityService } from '@ci/domains/browser-activity';
import { type Thread, ThreadService } from '@ci/domains/conversations';
import { type SignedFile, FileService } from '@ci/domains/files';
import { type Answer, type Action, ActionService, AnswerService } from '@ci/domains/intelligence';
import {
  type Communication,
  type Concept,
  type Content,
  type Event,
  type Item,
  type Person,
  type Place,
  type ProductModel,
  type Receipt,
  CommunicationService,
  ConceptService,
  ContentService,
  CalendarEventService,
  ItemService,
  PersonService,
  PlaceService,
  ProductModelService,
  ReceiptEntity,
} from '@ci/domains/memory';
import { type Note, NoteService } from '@ci/domains/notes';
import { type FileChunk, FileChunkService } from '@ci/domains/parsing';
import { type Task, TaskService } from '@ci/domains/planning';
import { type EntityIdentifier, type IndexableEntity, type TaggableEntity } from '@ci/domains/search-next';

type EntityType = IndexableEntity | TaggableEntity;

export type ResolvedEntity =
  | { type: 'action'; id: string; entity: Action }
  | { type: 'answer'; id: string; entity: Answer }
  | { type: 'browser-activity'; id: string; entity: BrowserActivity }
  | { type: 'communication'; id: string; entity: Communication }
  | { type: 'concept'; id: string; entity: Concept }
  | { type: 'content'; id: string; entity: Content }
  | { type: 'event'; id: string; entity: Event }
  | { type: 'file'; id: string; entity: SignedFile }
  // A document chunk carries its parent file, joined here so search results can
  // link back to the source document (the file is null if it was since deleted).
  | { type: 'file-chunk'; id: string; entity: { chunk: FileChunk; file: SignedFile | null } }
  | { type: 'item'; id: string; entity: Item }
  | { type: 'note'; id: string; entity: Note }
  | { type: 'person'; id: string; entity: Person }
  | { type: 'place'; id: string; entity: Place }
  | { type: 'product'; id: string; entity: ProductModel }
  | { type: 'receipt'; id: string; entity: Receipt }
  | { type: 'task'; id: string; entity: Task }
  | { type: 'thread'; id: string; entity: Thread };

/**
 * Drops the people, places and concepts the user asked Memory to forget.
 * `memory.forget` in archive mode sets their `ci.entities.is_active` false and
 * un-indexes them, and a merge tombstone is inactive too, but an index row
 * written before that, or by an update that raced it, must not bring them back.
 * Every search consumer hydrates here: the `search` query (the header box, the
 * explorer, saved searches, the Add relationship picker and the note `[[`
 * menu), chat recall, forage and the activity timeline's counts.
 */
function withoutArchived<T extends { isActive?: boolean | null }>(rows: (T | null)[]): (T | null)[] {
  return rows.map((row) => (row?.isActive === false ? null : row));
}

@Injectable()
export class EntityResolutionService {
  constructor(
    private readonly actionService: ActionService,
    private readonly answerService: AnswerService,
    private readonly browserActivityService: BrowserActivityService,
    private readonly communicationService: CommunicationService,
    private readonly conceptService: ConceptService,
    private readonly contentService: ContentService,
    private readonly eventService: CalendarEventService,
    private readonly fileService: FileService,
    private readonly fileChunkService: FileChunkService,
    private readonly itemService: ItemService,
    private readonly noteService: NoteService,
    private readonly personService: PersonService,
    private readonly placeService: PlaceService,
    private readonly productModelService: ProductModelService,
    // Read directly because `ReceiptService` has no batch id read, and the
    // alternative — one findById per result — is the N+1 this whole service
    // exists to prevent. Scoped on user_id here exactly as the service would.
    @InjectRepository(ReceiptEntity)
    private readonly receiptRepository: Repository<ReceiptEntity>,
    private readonly taskService: TaskService,
    private readonly threadService: ThreadService,
  ) {}

  /**
   * Batch-fetch entities for a list of identifiers.
   *
   * Returns a `Map` keyed by `"type:id"` so callers can look up results in
   * the original search-result order.
   */
  async resolve(
    context: UserServiceContext,
    identifiers: EntityIdentifier<EntityType>[],
  ): Promise<Map<string, ResolvedEntity>> {
    const grouped = this.groupByType(identifiers);
    // A page of search hits holds a few of the seventeen types; the other
    // services are not asked at all. (`In([])` is cheap in Postgres, but it is
    // still a round trip each, on every page.)
    const idsOf = (type: EntityType): string[] => grouped.get(type) ?? [];
    const lookup = <T>(type: EntityType, fetch: (ids: string[]) => Promise<T[]>): Promise<T[]> => {
      const ids = idsOf(type);

      return ids.length === 0 ? Promise.resolve([]) : fetch(ids);
    };

    const [
      actions,
      answers,
      browserActivities,
      communications,
      concepts,
      contents,
      events,
      files,
      fileChunks,
      items,
      notes,
      people,
      places,
      products,
      receipts,
      tasks,
      threads,
    ] = await Promise.all([
      lookup('action', (ids) => this.actionService.findByIds(context, ids)),
      lookup('answer', (ids) => this.answerService.findByIds(context, ids)),
      lookup('browser-activity', (ids) => this.browserActivityService.findByIds(context, ids)),
      lookup('communication', (ids) => this.communicationService.findByIds(context, ids)),
      lookup('concept', (ids) => this.conceptService.findByIds(context, ids)),
      lookup('content', (ids) => this.contentService.findByIds(context, ids)),
      lookup('event', (ids) => this.eventService.findByIds(context, ids)),
      lookup('file', (ids) => this.fileService.findByIds(context, ids)),
      lookup('file-chunk', (ids) => this.fileChunkService.findByIds(context, ids)),
      lookup('item', (ids) => this.itemService.findByIds(context, ids)),
      lookup('note', (ids) => this.noteService.findByIds(context, ids)),
      lookup('person', (ids) => this.personService.findByIds(context, ids)),
      lookup('place', (ids) => this.placeService.findByIds(context, ids)),
      lookup('product', (ids) => this.productModelService.findByIds(context, ids)),
      lookup('receipt', (ids) => this.findReceiptsByIds(context.userId, ids)),
      lookup('task', (ids) => this.taskService.findByIds(context, ids)),
      lookup('thread', (ids) => this.threadService.findByIds(context, ids)),
    ]);

    const map = new Map<string, ResolvedEntity>();

    this.addToMap(map, 'action', actions);
    this.addToMap(map, 'answer', answers);
    this.addToMap(map, 'browser-activity', browserActivities);
    this.addToMap(map, 'communication', communications);
    this.addToMap(map, 'concept', withoutArchived(concepts));
    this.addToMap(map, 'content', contents);
    this.addToMap(map, 'event', events);
    this.addToMap(map, 'file', files);
    this.addToMap(map, 'item', items);
    this.addToMap(map, 'note', notes);
    this.addToMap(map, 'person', withoutArchived(people));
    this.addToMap(map, 'place', withoutArchived(places));
    this.addToMap(map, 'product', products);
    this.addToMap(map, 'receipt', receipts);
    this.addToMap(map, 'task', tasks);
    this.addToMap(map, 'thread', threads);

    // File chunks join their parent file so results can link back to the source
    // document. Parent files not already fetched for a 'file' identifier are
    // loaded here in a single batched call.
    if (fileChunks.length > 0) {
      const parentFileIds = [...new Set(fileChunks.map((chunk) => chunk.fileId))];
      const parentFiles = await this.fileService.findByIds(context, parentFileIds);
      const fileById = new Map(
        parentFiles.filter((file): file is SignedFile => file != null).map((file) => [file.id, file]),
      );

      for (const chunk of fileChunks) {
        map.set(`file-chunk:${chunk.id}`, {
          type: 'file-chunk',
          id: chunk.id,
          entity: { chunk, file: fileById.get(chunk.fileId) ?? null },
        });
      }
    }

    return map;
  }

  /** Batch id read for receipts, in the order asked for. */
  private async findReceiptsByIds(userId: string, ids: string[]): Promise<(Receipt | null)[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.receiptRepository.find({ where: { userId, id: In(ids) } });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return ids.map((id) => byId.get(id) ?? null);
  }

  // 'file-chunk' is excluded: its resolved entity is a { chunk, file } join with
  // no top-level `id`, so it's added to the map directly in resolve() rather than
  // through this id-keyed helper.
  private addToMap<T extends Exclude<ResolvedEntity['type'], 'file-chunk'>>(
    map: Map<string, ResolvedEntity>,
    type: T,
    entities: (Extract<ResolvedEntity, { type: T }>['entity'] | null)[],
  ): void {
    for (const entity of entities) {
      if (entity) {
        map.set(`${type}:${entity.id}`, {
          type,
          id: entity.id,
          entity,
        } as Extract<ResolvedEntity, { type: T }>);
      }
    }
  }

  private groupByType(identifiers: EntityIdentifier<EntityType>[]): Map<EntityType, string[]> {
    const map = new Map<EntityType, string[]>();

    for (const { type, id } of identifiers) {
      let ids = map.get(type);

      if (!ids) {
        ids = [];
        map.set(type, ids);
      }

      ids.push(id);
    }

    return map;
  }
}
