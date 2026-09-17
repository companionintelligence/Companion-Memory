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
import { TaskService, type Task } from '@ci/domains/planning/task.module';
import {
  INDEXABLE_ENTITIES,
  SearchService,
  type EntityIdentifier,
  type IndexableEntity,
  type SearchPage,
} from '@ci/domains/search-next';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

import { booleanish } from './booleanish';

/**
 * `query` is optional ONLY for a count: "how many photos do I have" has no
 * search term, and a schema that demanded one turned that question into a
 * validation error (measured live 2026-09-16: the model sent `query: ""`). A
 * page still needs a term — there is nothing to rank without one.
 */
export function requireQueryUnlessCounting(
  input: { query?: string; countOnly?: boolean },
  ctx: z.RefinementCtx,
): void {
  if (!input.countOnly && (input.query ?? '').trim().length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['query'],
      message: 'query is required unless countOnly is true',
    });
  }
}

const DatabaseSearchInputSchema = z
  .object({
    query: z.string().max(500).optional(),
    searchMode: z.enum(['semantic', 'keyword', 'hybrid', 'auto']).optional(),
    scopes: z.array(z.enum(['entities', 'documents', 'messages'])).optional(),
    entityTypes: z.array(z.string()).optional(),
    includeRelationships: booleanish().optional(),
    maxResults: z.number().int().min(1).max(100).optional(),
    countOnly: booleanish().optional(),
  })
  .superRefine(requireQueryUnlessCounting);

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
  | Task
  | Thread;

/**
 * What every search intent hands the model: the page AND the size of the
 * match set behind it.
 *
 * A bare array was the previous shape, and it is how a full page of 100 became
 * "you have 100 photos of rabbits" — the model had no way to tell the cap from
 * the corpus. `totalMatches` / `truncated` are {@link SearchPage}'s, carried
 * through hydration; `summary` says the same thing in a sentence, because the
 * follow-up prompt is byte-bounded and a small model reads a sentence more
 * reliably than three sibling fields.
 */
export interface SearchToolResult {
  /** One sentence the model can repeat: how many were found, how many are shown, whether the count is exact. */
  summary: string;
  /** Exact size of the match set, or `null` when the mode that ran cannot count (semantic, hybrid). */
  totalMatches: number | null;
  /** `items` is not the whole match set. Report "at least", never "exactly". */
  truncated: boolean;
  /** The cap that was applied to `items`. `0` for a count-only call. */
  limit: number;
  /** The strategy that ran, or `'count'` for a count-only call. */
  mode: string;
  /** Resolved entities, best first. Empty for a count-only call. */
  items: SearchResult[];
  /**
   * Present on a count over photos: how many original images the user has and
   * how many carry a generated description. Only described photos can match a
   * subject word, so a photo count without this is a floor presented as a total.
   */
  coverage?: { images: number; described: number };
}

@Injectable()
export class DatabaseSearchTool extends BaseTool<DatabaseSearchInput, SearchToolResult> {
  readonly schema: IntentDefinition = {
    name: 'knowledge.search',
    domain: 'knowledge',
    title: 'Search everything',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    // Searches only the user's own corpus. On-device the mirror is partial and there is no pgvector
    // re-ranking, so results degrade to keyword/recency — a worse answer, not an impossible one,
    // and this is the intent the offline surface exists for.
    localCapable: true,
    produces: ['event', 'content', 'person', 'place', 'note', 'file', 'task'],
    phrases: ['Search for $query', 'Find anything about $query'],
    description:
      'Search across all your personal data using natural language or keywords. ' +
      'Searches entities (people, places, concepts), documents, and conversation messages. ' +
      'Use this for broad searches like "find everything about coffee" or "when did I last visit Paris". ' +
      'For specific graph queries like "my family members", use memory.recall instead. ' +
      'For precise entity lookups, use memory.recall with filters. ' +
      'The result reports totalMatches and truncated alongside items: when truncated is true, ' +
      'items is only the top of the match set, so say "at least N", never "N". ' +
      'To answer "how many ..." set countOnly: true — it returns the exact number of matching ' +
      'entries without paging them, so prefer it over counting items. With countOnly you may omit ' +
      'query to count everything of the given entityTypes (e.g. all files). ' +
      'A multi-word query matches entries containing ANY of its words; for a count, use the ' +
      'single most specific word (e.g. "rabbit", not "photos of rabbits").',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural language search query or keywords to search for. Required unless countOnly is true, ' +
            'when omitting it counts everything in scope.',
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
        countOnly: {
          type: 'boolean',
          description:
            'Return only the exact number of entries matching the query (keyword match, no cap) ' +
            'and no items. Use for "how many" questions. Omit query to count all entries of the given types.',
        },
      },
      required: [],
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
    private readonly taskService: TaskService,
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
  ): Promise<SearchToolResult> {
    return this.run(context, input);
  }

  /**
   * The core search, exposed so domain-specialized search intents (people.find, places.find,
   * calendar.findEvents, media.findPhotos) can reuse it with a fixed entity-type scope instead of
   * re-implementing search. Input is assumed already validated by the caller.
   */
  async run(context: ToolExecutionContext, input: DatabaseSearchInput): Promise<SearchToolResult> {
    const serviceContext = toServiceContext(context);
    const includeTypes = input.entityTypes as IndexableEntity[];

    if (input.countOnly) {
      // A count is a `count(*)` against the full-text index: no cap, no rows,
      // nothing for the context budget to drop. It is the same predicate the
      // page below would run, so the two numbers agree by construction. A
      // blank query counts the whole scope.
      const query = input.query?.trim() || undefined;

      // A photo can only match a subject word through its generated
      // description, so a count over files is only as complete as that pass.
      // Say how complete, or the model presents a floor as a total.
      const [totalMatches, coverage] = await Promise.all([
        this.searchService.count(serviceContext, { query, includeTypes }),
        includeTypes?.includes('file') ? this.fileService.describedImageCoverage(serviceContext) : undefined,
      ]);

      return {
        summary: describeCount(totalMatches, query, includeTypes, coverage),
        totalMatches,
        truncated: false,
        limit: 0,
        mode: 'count',
        items: [],
        ...(coverage ? { coverage } : {}),
      };
    }

    // The refinement guarantees a term here; a page cannot rank without one.
    const page = await this.searchService.searchPage(serviceContext, {
      query: input.query ?? '',
      mode: input.searchMode,
      includeTypes,
      maxResults: input.maxResults,
    });

    const items = await this.resolveEntities(serviceContext, page.items);

    return {
      summary: describePage(page, items.length),
      totalMatches: page.totalMatches,
      truncated: page.truncated,
      limit: page.limit,
      mode: page.modeTaken,
      items,
    };
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
    const taskIds = groupedByType.get('task') || [];
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
      tasks,
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
      this.taskService.findByIds(context, taskIds),
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
    tasks.filter((d) => d != null).forEach((d) => resultMap.set(makeCompositeKey('task', d.id), d));
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

function scopeLabel(includeTypes: IndexableEntity[] | undefined): string {
  return includeTypes && includeTypes.length > 0 ? `${includeTypes.join('/')} entries` : 'entries';
}

/**
 * The one sentence a count-only call hands the model. It names the query and
 * the scope so a model that ran several counts in one turn cannot mix them up,
 * and — for photos — how many of them a subject search can see at all.
 */
export function describeCount(
  totalMatches: number,
  query: string | undefined,
  includeTypes?: IndexableEntity[],
  coverage?: { images: number; described: number },
): string {
  const what = query
    ? `${totalMatches} ${scopeLabel(includeTypes)} match "${query}"`
    : `${totalMatches} ${scopeLabel(includeTypes)} in Memory`;
  const base = `${what} (exact count from the search index; no items returned).`;

  if (!coverage) {
    return base;
  }

  return (
    `${base} ${coverage.described} of ${coverage.images} photos have a generated description, ` +
    'and only described photos can match a subject word — treat subject counts as a floor.'
  );
}

/**
 * The one sentence a page hands the model, written so the number it repeats is
 * the right one. `shown` is the HYDRATED count — a hit the resolvers could not
 * load is not on the page — while `page.totalMatches` is the index's count.
 */
export function describePage(page: SearchPage, shown: number): string {
  if (page.totalMatches != null) {
    if (page.totalMatches <= shown) {
      return `${page.totalMatches} matches; all shown.`;
    }

    return (
      `Showing the top ${shown} of ${page.totalMatches} matches (exact count). ` +
      'Report the total, not the number shown.'
    );
  }

  if (page.truncated) {
    return (
      `Showing ${shown} results; the page came back full (cap ${page.limit}), so there may be more. ` +
      'Say "at least" — or call again with countOnly: true for an exact count.'
    );
  }

  return `${shown} results; the search was not cut off.`;
}
