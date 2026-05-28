import { Injectable } from '@nestjs/common';

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
  CommunicationService,
  ConceptService,
  ContentService,
  EventService,
  ItemService,
  PersonService,
  PlaceService,
} from '@ci/domains/memory';
import { type Note, NoteService } from '@ci/domains/notes';
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
  | { type: 'item'; id: string; entity: Item }
  | { type: 'note'; id: string; entity: Note }
  | { type: 'person'; id: string; entity: Person }
  | { type: 'place'; id: string; entity: Place }
  | { type: 'thread'; id: string; entity: Thread };

@Injectable()
export class EntityResolutionService {
  constructor(
    private readonly actionService: ActionService,
    private readonly answerService: AnswerService,
    private readonly browserActivityService: BrowserActivityService,
    private readonly communicationService: CommunicationService,
    private readonly conceptService: ConceptService,
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
    private readonly fileService: FileService,
    private readonly itemService: ItemService,
    private readonly noteService: NoteService,
    private readonly personService: PersonService,
    private readonly placeService: PlaceService,
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

    const [
      actions,
      answers,
      browserActivities,
      communications,
      concepts,
      contents,
      events,
      files,
      items,
      notes,
      people,
      places,
      threads,
    ] = await Promise.all([
      this.actionService.findByIds(context, grouped.get('action') ?? []),
      this.answerService.findByIds(context, grouped.get('answer') ?? []),
      this.browserActivityService.findByIds(context, grouped.get('browser-activity') ?? []),
      this.communicationService.findByIds(context, grouped.get('communication') ?? []),
      this.conceptService.findByIds(context, grouped.get('concept') ?? []),
      this.contentService.findByIds(context, grouped.get('content') ?? []),
      this.eventService.findByIds(context, grouped.get('event') ?? []),
      this.fileService.findByIds(context, grouped.get('file') ?? []),
      this.itemService.findByIds(context, grouped.get('item') ?? []),
      this.noteService.findByIds(context, grouped.get('note') ?? []),
      this.personService.findByIds(context, grouped.get('person') ?? []),
      this.placeService.findByIds(context, grouped.get('place') ?? []),
      this.threadService.findByIds(context, grouped.get('thread') ?? []),
    ]);

    const map = new Map<string, ResolvedEntity>();

    this.addToMap(map, 'action', actions);
    this.addToMap(map, 'answer', answers);
    this.addToMap(map, 'browser-activity', browserActivities);
    this.addToMap(map, 'communication', communications);
    this.addToMap(map, 'concept', concepts);
    this.addToMap(map, 'content', contents);
    this.addToMap(map, 'event', events);
    this.addToMap(map, 'file', files);
    this.addToMap(map, 'item', items);
    this.addToMap(map, 'note', notes);
    this.addToMap(map, 'person', people);
    this.addToMap(map, 'place', places);
    this.addToMap(map, 'thread', threads);

    return map;
  }

  private addToMap<T extends ResolvedEntity['type']>(
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
