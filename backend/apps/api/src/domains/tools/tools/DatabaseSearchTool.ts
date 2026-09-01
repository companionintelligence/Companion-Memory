import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { type UserServiceContext, toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { BrowserActivityService, type BrowserActivity } from '@ci/domains/browser-activity';
import { ThreadService, type Thread } from '@ci/domains/conversations';
import { FileService, type File } from '@ci/domains/files';
import { AnswerService, type Answer } from '@ci/domains/intelligence';
import {
  CommunicationService,
  ConceptService,
  ContentService,
  CalendarEventService,
  ItemService,
  PersonService,
  PlaceService,
  ProductModelService,
  ReceiptService,
  type Communication,
  type Concept,
  type Content,
  type Event,
  type Item,
  type Person,
  type Place,
  type ProductModel,
  type Receipt,
} from '@ci/domains/memory';
import { NoteService, type Note } from '@ci/domains/notes';
import { FileChunkService, type FileChunk } from '@ci/domains/parsing';
import {
  INDEXABLE_ENTITIES,
  SearchService,
  type EntityIdentifier,
  type IndexableEntity,
} from '@ci/domains/search-next';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const DatabaseSearchInputSchema = z.object({
  query: z.string().min(1).max(500),
  searchMode: z.enum(['semantic', 'keyword', 'hybrid', 'auto']).optional(),
  scopes: z.array(z.enum(['entities', 'documents', 'messages'])).optional(),
  entityTypes: z.array(z.string()).optional(),
  includeRelationships: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
});

export type DatabaseSearchInput = z.infer<typeof DatabaseSearchInputSchema>;

export type SearchResult =
  | Answer
  | BrowserActivity
  | Communication
  | Concept
  | Content
  | Event
  | File
  | FileChunk
  | Item
  | Note
  | Person
  | Place
  | ProductModel
  | Receipt
  | Thread;

@Injectable()
export class DatabaseSearchTool extends BaseTool<DatabaseSearchInput, SearchResult[]> {
  readonly schema: IntentDefinition = {
    name: 'knowledge.search',
    domain: 'knowledge',
    title: 'Search everything',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    // Searches only the user's own corpus. On-device the mirror is partial and there is no pgvector
    // re-ranking, so results degrade to keyword/recency — a worse answer, not an impossible one,
    // and this is the intent the offline surface exists for.
    localCapable: true,
    produces: ['event', 'content', 'person', 'place', 'note', 'file'],
    phrases: ['Search for $query', 'Find anything about $query'],
    description:
      'Search across all your personal data using natural language or keywords. ' +
      'Searches entities (people, places, concepts), documents, and conversation messages. ' +
      'Use this for broad searches like "find everything about coffee" or "when did I last visit Paris". ' +
      'For specific graph queries like "my family members", use memory.recall instead. ' +
      'For precise entity lookups, use memory.recall with filters.',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query or keywords to search for',
          minLength: 1,
          maxLength: 500,
        },
        searchMode: {
          type: 'string',
          enum: ['semantic', 'keyword', 'hybrid', 'auto'],
          description:
            'Search strategy: ' +
            'semantic (meaning-based, uses AI embeddings), ' +
            'keyword (exact text matches, good for names/IDs), ' +
            'hybrid (combines both for best results), ' +
            'or auto (automatically choose based on query). Default: auto',
        },
        entityTypes: {
          type: 'array',
          items: {
            type: 'string',
            enum: [...INDEXABLE_ENTITIES],
          },
          description:
            'When searching entities, filter to specific types: Person, Concept, Location, Object, etc.',
        },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of results to return (default: 25)',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };

  constructor(
    private readonly answerService: AnswerService,
    private readonly browserActivityService: BrowserActivityService,
    private readonly communicationService: CommunicationService,
    private readonly conceptService: ConceptService,
    private readonly contentService: ContentService,
    private readonly eventService: CalendarEventService,
    private readonly fileChunkService: FileChunkService,
    private readonly fileService: FileService,
    private readonly itemService: ItemService,
    private readonly noteService: NoteService,
    private readonly personService: PersonService,
    private readonly placeService: PlaceService,
    private readonly productModelService: ProductModelService,
    private readonly receiptService: ReceiptService,
    private readonly threadService: ThreadService,
    private readonly searchService: SearchService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(DatabaseSearchTool.name);
  }

  protected validateInput(input: unknown): DatabaseSearchInput {
    return DatabaseSearchInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: DatabaseSearchInput,
  ): Promise<SearchResult[]> {
    return this.run(context, input);
  }

  /**
   * The core search, exposed so domain-specialized search intents (people.find, places.find,
   * calendar.findEvents, media.findPhotos) can reuse it with a fixed entity-type scope instead of
   * re-implementing search. Input is assumed already validated by the caller.
   */
  async run(context: ToolExecutionContext, input: DatabaseSearchInput): Promise<SearchResult[]> {
    const serviceContext = toServiceContext(context);

    const searchResults = await this.searchService.search(serviceContext, {
      query: input.query,
      mode: input.searchMode,
      includeTypes: input.entityTypes as IndexableEntity[],
      maxResults: input.maxResults,
    });

    const resolvedEntities = await this.resolveEntities(serviceContext, searchResults);

    return resolvedEntities;
  }

  private async resolveEntities(
    context: UserServiceContext,
    results: EntityIdentifier<IndexableEntity>[],
  ): Promise<SearchResult[]> {
    const groupedByType: Map<IndexableEntity, string[]> = results.reduce((acc, result) => {
      if (!acc.has(result.type)) {
        acc.set(result.type, []);
      }

      acc.get(result.type)!.push(result.id);

      return acc;
    }, new Map());

    const answerIds = groupedByType.get('answer') || [];
    const browserActivityIds = groupedByType.get('browser-activity') || [];
    const communicationIds = groupedByType.get('communication') || [];
    const conceptIds = groupedByType.get('concept') || [];
    const contentIds = groupedByType.get('content') || [];
    const eventIds = groupedByType.get('event') || [];
    const fileChunkIds = groupedByType.get('file-chunk') || [];
    const fileIds = groupedByType.get('file') || [];
    const itemIds = groupedByType.get('item') || [];
    const noteIds = groupedByType.get('note') || [];
    const peopleIds = groupedByType.get('person') || [];
    const placeIds = groupedByType.get('place') || [];
    const productIds = groupedByType.get('product') || [];
    const receiptIds = groupedByType.get('receipt') || [];
    const threadIds = groupedByType.get('thread') || [];

    const [
      answers,
      browserActivities,
      communications,
      concepts,
      content,
      events,
      fileChunks,
      files,
      items,
      notes,
      people,
      places,
      products,
      receipts,
      threads,
    ] = await Promise.all([
      this.answerService.findByIds(context, answerIds),
      this.browserActivityService.findByIds(context, browserActivityIds),
      this.communicationService.findByIds(context, communicationIds),
      this.conceptService.findByIds(context, conceptIds),
      this.contentService.findByIds(context, contentIds),
      this.eventService.findByIds(context, eventIds),
      this.fileChunkService.findByIds(fileChunkIds),
      this.fileService.findByIds(context, fileIds),
      this.itemService.findByIds(context, itemIds),
      this.noteService.findByIds(context, noteIds),
      this.personService.findByIds(context, peopleIds),
      this.placeService.findByIds(context, placeIds),
      this.productModelService.findByIds(context, productIds),
      this.receiptService.findByIds(context, receiptIds),
      this.threadService.findByIds(context, threadIds),
    ]);

    const resultMap = new Map<string, SearchResult>();

    answers.filter((d) => d != null).forEach((d) => resultMap.set(makeCompositeKey('answer', d.id), d));

    browserActivities
      .filter((d) => d != null)
      .forEach((d) => resultMap.set(makeCompositeKey('browser-activity', d.id), d));

    communications
      .filter((d) => d != null)
      .forEach((d) => resultMap.set(makeCompositeKey('communication', d.id), d));

    concepts.filter((d) => d != null).forEach((d) => resultMap.set(makeCompositeKey('concept', d.id), d));
    content.filter((d) => d != null).forEach((d) => resultMap.set(makeCompositeKey('content', d.id), d));
    events.filter((d) => d != null).forEach((d) => resultMap.set(makeCompositeKey('event', d.id), d));
    fileChunks
      .filter((d) => d != null)
      .forEach((d) => resultMap.set(makeCompositeKey('file-chunk', d.id), d));
    files.filter((d) => d != null).forEach((d) => resultMap.set(makeCompositeKey('file', d.id), d));
    items.filter((d) => d != null).forEach((d) => resultMap.set(makeCompositeKey('item', d.id), d));
    notes.filter((d) => d != null).forEach((d) => resultMap.set(makeCompositeKey('note', d.id), d));
    people.filter((d) => d != null).forEach((d) => resultMap.set(makeCompositeKey('person', d.id), d));
    places.filter((d) => d != null).forEach((d) => resultMap.set(makeCompositeKey('place', d.id), d));
    products.filter((d) => d != null).forEach((d) => resultMap.set(makeCompositeKey('product', d.id), d));
    receipts.filter((d) => d != null).forEach((d) => resultMap.set(makeCompositeKey('receipt', d.id), d));
    threads.filter((d) => d != null).forEach((d) => resultMap.set(makeCompositeKey('thread', d.id), d));

    const orderedResults = results
      .map((result) => resultMap.get(makeCompositeKey(result.type, result.id)))
      .filter((entity): entity is SearchResult => entity != null);

    // A hit the resolvers above cannot hydrate vanishes from the answer, and
    // the caller cannot tell "nothing matched" from "everything matched was
    // dropped here" — measured live: a 25-hit browser-activity page returned
    // [] to the model before that resolver existed. Every indexable type must
    // have a resolver; this trips when the next one is added without it.
    if (orderedResults.length === 0 && results.length > 0) {
      const droppedByType: Record<string, number> = {};

      for (const result of results) {
        droppedByType[result.type] = (droppedByType[result.type] ?? 0) + 1;
      }

      this.logger.warn('Search matched entities but every hit was dropped during resolution', {
        matches: results.length,
        droppedByType,
      });
    }

    return orderedResults;
  }
}

function makeCompositeKey(type: IndexableEntity, id: string): string {
  return `${type}:${id}`;
}
