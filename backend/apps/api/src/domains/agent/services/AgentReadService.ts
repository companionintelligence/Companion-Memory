import fs from 'fs/promises';
import path from 'path';

import { Injectable, NotFoundException } from '@nestjs/common';

import { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { BrowserActivityService } from '@ci/domains/browser-activity';
import { MessageService, ThreadService } from '@ci/domains/conversations';
import { FileService, FileVariant, type SignedFile } from '@ci/domains/files';
import { ActionService, AnswerService } from '@ci/domains/intelligence';
import {
  CommunicationService,
  ConceptService,
  ContentService,
  EventService,
  GraphQueryService,
  ItemService,
  PersonService,
  PlaceService,
  UserContextService,
} from '@ci/domains/memory';
import { NoteService } from '@ci/domains/notes';
import { SearchService, type EntityIdentifier, type IndexableEntity } from '@ci/domains/search-next';
import { SummaryService } from '@ci/domains/summaries';

import {
  AgentCapabilities,
  AgentDocumentPayload,
  AgentDocumentQuery,
  AgentEntitySummary,
  AgentGraphEdge,
  AgentGraphNode,
  AgentGraphReadInput,
  AgentRecentActivityInput,
  AgentSearchInput,
} from '../types';

import { AgentOwnerService } from './AgentOwnerService';

const GRAPH_SCHEMA_PATHS = [
  path.join(process.cwd(), 'src', 'domains', 'graphql', '__generated__', 'schema.graphql'),
  path.join(process.cwd(), 'dist', 'src', 'domains', 'graphql', '__generated__', 'schema.graphql'),
];

const TEXT_LIKE_MIME_PREFIXES = ['text/'];
const TEXT_LIKE_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
]);

@Injectable()
export class AgentReadService {
  constructor(
    private readonly actionService: ActionService,
    private readonly answerService: AnswerService,
    private readonly browserActivityService: BrowserActivityService,
    private readonly communicationService: CommunicationService,
    private readonly conceptService: ConceptService,
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
    private readonly fileService: FileService,
    private readonly graphQueryService: GraphQueryService,
    private readonly itemService: ItemService,
    private readonly messageService: MessageService,
    private readonly noteService: NoteService,
    private readonly ownerService: AgentOwnerService,
    private readonly personService: PersonService,
    private readonly placeService: PlaceService,
    private readonly searchService: SearchService,
    private readonly summaryService: SummaryService,
    private readonly threadService: ThreadService,
    private readonly userContextService: UserContextService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AgentReadService.name);
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    const owner = await this.ownerService.resolveOwner();
    const graphqlSummary = await this.readGraphqlSummary();

    return {
      owner,
      tools: [
        {
          name: 'search_memory',
          description: 'Search across indexed personal memory with bounded results.',
        },
        {
          name: 'read_entity_graph',
          description: 'Read a bounded subgraph around one or more entities.',
        },
        {
          name: 'get_user_context',
          description: 'Fetch the current owner user context and dossier snapshot.',
        },
        {
          name: 'get_recent_activity',
          description: 'Fetch recent summaries, actions, and timeline activity.',
        },
        {
          name: 'get_thread',
          description: 'Read a conversation thread with recent messages.',
        },
        {
          name: 'get_document',
          description: 'Read file metadata and inline text when directly available.',
        },
      ],
      resources: [
        {
          uri: 'ci://capabilities/overview',
          description: 'Human-readable overview of the external CI memory surface.',
        },
        {
          uri: 'ci://user/context',
          description: 'Current owner user context and dossier snapshot.',
        },
        {
          uri: 'ci://entities/{entityId}',
          description: 'Bounded graph view for a single entity id.',
        },
        {
          uri: 'ci://threads/{threadId}',
          description: 'Thread metadata and recent messages.',
        },
        {
          uri: 'ci://schema/graphql-summary',
          description: 'Summary of the internal GraphQL schema breadth.',
        },
      ],
      graphql: graphqlSummary,
    };
  }

  async getUserContext(context: UserServiceContext) {
    const userContext = await this.userContextService.getUserContextForLLM(context.userId);

    return {
      context: userContext,
      markdown: userContext ? this.userContextService.formatContextForSystemPrompt(userContext) : null,
    };
  }

  async searchMemory(context: UserServiceContext, input: AgentSearchInput) {
    const searchOptions: Parameters<SearchService['search']>[1] =
      input.entityTypes && input.entityTypes.length > 0
        ? {
            query: input.query,
            mode: input.searchMode,
            maxResults: input.maxResults,
            includeTypes: input.entityTypes,
          }
        : {
            query: input.query,
            mode: input.searchMode,
            maxResults: input.maxResults,
          };
    const searchResults = await this.searchService.search(context, searchOptions);

    return {
      results: await this.resolveEntitySummaries(context, searchResults),
      truncated: searchResults.length >= input.maxResults,
    };
  }

  async readEntityGraph(context: UserServiceContext, input: AgentGraphReadInput) {
    const seedIds = await this.resolveSeedEntityIds(context, input);

    if (seedIds.length === 0) {
      return {
        seedEntityIds: [],
        nodes: [],
        edges: [],
        stats: {
          nodeCount: 0,
          edgeCount: 0,
          truncatedNodes: false,
          truncatedEdges: false,
        },
      };
    }

    const traversal = await this.graphQueryService.traverseGraph(context.userId, seedIds, {
      relationshipTypes: input.relationshipTypes,
      direction: input.direction,
      maxDepth: input.maxDepth,
      maxNodes: input.maxNodes,
      maxEdges: input.maxEdges,
    });

    const nodes: AgentGraphNode[] = Array.from(traversal.nodes.values()).map((node) => ({
      id: node.entity_id,
      entityType: node.entity_type,
      name: node.name,
      description: node.description,
      ...(input.includeProperties && {
        properties: node.properties ?? {},
      }),
    }));
    const edges: AgentGraphEdge[] = traversal.edges.map((edge) => ({
      id: edge.relationship_id,
      relationshipType: edge.relationship_type,
      source: edge.from_entity_id,
      target: edge.to_entity_id,
      strength: edge.strength ?? 0.5,
      bidirectional: edge.is_bidirectional ?? false,
      ...(input.includeProperties && {
        properties: edge.properties ?? {},
      }),
    }));

    return {
      seedEntityIds: seedIds,
      nodes,
      edges,
      stats: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        truncatedNodes: nodes.length >= input.maxNodes,
        truncatedEdges: edges.length >= input.maxEdges,
      },
    };
  }

  async getRecentActivity(context: UserServiceContext, input: AgentRecentActivityInput) {
    const since = input.since ? new Date(input.since) : undefined;
    const timelineEntityIds = await Promise.all([
      this.browserActivityService.getEntitiesForBrowserActivities(context, {
        limit: input.limit,
        order: { time: 'DESC' },
        startTime: since,
      }),
      this.eventService.getEntitiesForEvents(context, {
        limit: input.limit,
        order: { startTime: 'DESC' },
        startTime: since,
      }),
      this.communicationService.getEntitiesForCommunications(context, {
        limit: input.limit,
        order: { time: 'DESC' },
        startTime: since,
      }),
    ]);

    const activity = await this.resolveEntitySummaries(context, timelineEntityIds.flat());

    activity.sort((left, right) => {
      const leftTime = left.timestamp ? Date.parse(left.timestamp) : 0;
      const rightTime = right.timestamp ? Date.parse(right.timestamp) : 0;

      return rightTime - leftTime;
    });

    const summaries = await this.summaryService.findRecent(context, Math.min(input.limit, 5));
    const actions = await this.actionService.findForFeed(context, Math.min(input.limit, 5));

    return {
      activity: activity.slice(0, input.limit),
      summaries: summaries.map((summary) => ({
        id: summary.summaryId,
        title: summary.title ?? `${summary.periodType} summary`,
        summary: summary.summaryText,
        periodStart: summary.periodStart.toISOString(),
        periodEnd: summary.periodEnd.toISOString(),
      })),
      actions: actions.map((action) => ({
        id: action.id,
        title: action.title,
        text: action.text,
        priority: action.priority ?? null,
        seen: action.seen,
        dismissed: action.dismissed,
      })),
    };
  }

  async getThread(context: UserServiceContext, threadId: string, maxMessages: number) {
    const thread = await this.threadService.findById(context, threadId);

    if (!thread) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }

    const messages = await this.messageService.findByThreadId(context, threadId);
    const truncated = messages.length > maxMessages;
    const selectedMessages = truncated ? messages.slice(-maxMessages) : messages;
    const action = await this.actionService.findByThreadId(context, threadId);

    return {
      thread: {
        id: thread.id,
        name: thread.name,
        description: thread.description,
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
      },
      action: action
        ? {
            id: action.id,
            title: action.title,
            text: action.text,
            priority: action.priority ?? null,
          }
        : null,
      messages: selectedMessages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        mimetype: message.mimetype ?? null,
        createdAt: message.createdAt.toISOString(),
        toolCalls: message.toolCalls ?? null,
        files: (message.files ?? []).map((file) => ({
          id: file.id,
          filename: file.filename,
          contentType: file.contentType,
          url: 'url' in file ? file.url : null,
        })),
      })),
      truncated,
      totalMessages: messages.length,
    };
  }

  async getDocument(
    context: UserServiceContext,
    documentId: string,
    { includeText = true, maxChars = 4000 }: AgentDocumentQuery,
  ): Promise<AgentDocumentPayload> {
    const file = await this.fileService.findById(context, documentId);

    if (!file) {
      throw new NotFoundException(`Document ${documentId} not found`);
    }

    const preview = await this.fileService.findVariantByParentId(context, file.id, FileVariant.PREVIEW);
    let text: string | null = null;
    let textTruncated = false;

    if (includeText && file.key && this.isTextLike(file.contentType)) {
      const bytes = await this.fileService.getFileContent(context, file.key);
      const decodedText = new TextDecoder().decode(bytes);

      text = decodedText.slice(0, maxChars);
      textTruncated = decodedText.length > text.length;
    }

    return {
      id: file.id,
      filename: file.filename,
      title: file.title,
      description: file.description,
      contentType: file.contentType,
      size: file.size ? Number(file.size) : null,
      sourceUrl: file.url,
      previewUrl: preview?.url ?? null,
      createdAt: file.createdAt.toISOString(),
      updatedAt: file.updatedAt.toISOString(),
      text,
      textTruncated,
    };
  }

  private async resolveSeedEntityIds(
    context: UserServiceContext,
    input: AgentGraphReadInput,
  ): Promise<string[]> {
    if (input.entityId) {
      const node = await this.graphQueryService.getNode(context.userId, input.entityId);

      if (!node) {
        throw new NotFoundException(`Entity ${input.entityId} not found`);
      }

      return [node.entity_id];
    }

    if (input.filters) {
      const nodes = await this.graphQueryService.getNodes(context.userId, {
        entityType: input.filters.entityType,
        nameContains: input.filters.nameContains,
        propertyEquals: input.filters.propertyEquals,
        limit: input.filters.limit ?? 10,
      });

      return nodes.map((node) => node.entity_id);
    }

    if (!input.useCurrentUser) {
      return [];
    }

    const currentUserEntity = await this.graphQueryService.getUserEntity(context.userId);

    return currentUserEntity ? [currentUserEntity.entity_id] : [];
  }

  private async resolveEntitySummaries(
    context: UserServiceContext,
    results: EntityIdentifier<IndexableEntity>[],
  ): Promise<AgentEntitySummary[]> {
    const groupedByType = new Map<IndexableEntity, string[]>();

    for (const result of results) {
      const ids = groupedByType.get(result.type) ?? [];
      ids.push(result.id);
      groupedByType.set(result.type, ids);
    }

    const [
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
      this.answerService.findByIds(context, groupedByType.get('answer') ?? []),
      this.browserActivityService.findByIds(context, groupedByType.get('browser-activity') ?? []),
      this.communicationService.findByIds(context, groupedByType.get('communication') ?? []),
      this.conceptService.findByIds(context, groupedByType.get('concept') ?? []),
      this.contentService.findByIds(context, groupedByType.get('content') ?? []),
      this.eventService.findByIds(context, groupedByType.get('event') ?? []),
      this.fileService.findByIds(context, groupedByType.get('file') ?? []),
      this.itemService.findByIds(context, groupedByType.get('item') ?? []),
      this.noteService.findByIds(context, groupedByType.get('note') ?? []),
      this.personService.findByIds(context, groupedByType.get('person') ?? []),
      this.placeService.findByIds(context, groupedByType.get('place') ?? []),
      this.threadService.findByIds(context, groupedByType.get('thread') ?? []),
    ]);
    const signedFiles = files as Array<SignedFile | null>;

    const entities = new Map<string, AgentEntitySummary>();

    this.addEntitySummaries(entities, 'answer', answers, (entity) => ({
      title: entity.question?.text ?? 'Answer',
      summary: entity.answer,
      timestamp: entity.answeredAt.toISOString(),
      attributes: {
        answerSource: entity.answerSource,
      },
    }));
    this.addEntitySummaries(entities, 'browser-activity', browserActivities, (entity) => ({
      title: entity.title ?? entity.url,
      summary: entity.page_summary ?? entity.action_type ?? entity.url,
      timestamp: entity.time.toISOString(),
      url: entity.url,
      attributes: {
        category: entity.category ?? null,
      },
    }));
    this.addEntitySummaries(entities, 'communication', communications, (entity) => ({
      title: entity.subject ?? entity.preview ?? entity.communicationType,
      summary: entity.preview ?? entity.summary ?? entity.content,
      timestamp: entity.time.toISOString(),
      attributes: {
        direction: entity.direction,
        communicationType: entity.communicationType,
      },
    }));
    this.addEntitySummaries(entities, 'concept', concepts, (entity) => ({
      title: entity.name,
      summary: entity.description ?? entity.type ?? entity.category,
      timestamp: entity.updatedAt.toISOString(),
      attributes: {
        entityType: entity.entityType,
      },
    }));
    this.addEntitySummaries(entities, 'content', contents, (entity) => ({
      title: entity.title ?? entity.type ?? 'Content',
      summary: entity.text ?? entity.sourceUrl ?? entity.url,
      timestamp: entity.updatedAt.toISOString(),
      url: entity.url ?? entity.sourceUrl,
      attributes: {
        mimetype: entity.mimetype,
      },
    }));
    this.addEntitySummaries(entities, 'event', events, (entity) => ({
      title: entity.title,
      summary: entity.description ?? entity.locationName ?? entity.category,
      timestamp: entity.startTime.toISOString(),
      attributes: {
        eventType: entity.eventType,
      },
    }));
    this.addEntitySummaries(entities, 'file', signedFiles, (entity) => ({
      title: entity.title ?? entity.filename,
      summary: entity.description ?? entity.contentType,
      timestamp: entity.updatedAt.toISOString(),
      url: entity.url,
      attributes: {
        contentType: entity.contentType,
      },
    }));
    this.addEntitySummaries(entities, 'item', items, (entity) => ({
      title: entity.name,
      summary: entity.description ?? entity.category ?? entity.brand ?? entity.model,
      timestamp: entity.updatedAt.toISOString(),
      attributes: {
        category: entity.category ?? null,
      },
    }));
    this.addEntitySummaries(entities, 'note', notes, (entity) => ({
      title: entity.title ?? 'Untitled note',
      summary: entity.content,
      timestamp: entity.updatedAt.toISOString(),
    }));
    this.addEntitySummaries(entities, 'person', people, (entity) => ({
      title: entity.name,
      summary: entity.description ?? this.firstString(entity.properties?.occupation) ?? null,
      timestamp: entity.updatedAt.toISOString(),
      attributes: {
        familyRole: this.firstString(entity.properties?.family_role) ?? null,
      },
    }));
    this.addEntitySummaries(entities, 'place', places, (entity) => ({
      title: entity.name,
      summary: entity.description ?? entity.type ?? null,
      timestamp: entity.updatedAt.toISOString(),
    }));
    this.addEntitySummaries(entities, 'thread', threads, (entity) => ({
      title: entity.name ?? 'Conversation thread',
      summary: entity.description,
      timestamp: entity.updatedAt.toISOString(),
    }));

    return results
      .map((result) => entities.get(this.entityKey(result.type, result.id)))
      .filter((entity): entity is AgentEntitySummary => entity != null);
  }

  private addEntitySummaries<T extends { id: string }>(
    destination: Map<string, AgentEntitySummary>,
    type: IndexableEntity,
    entities: Array<T | null>,
    mapper: (entity: T) => Omit<AgentEntitySummary, 'id' | 'type'>,
  ) {
    for (const entity of entities) {
      if (!entity) {
        continue;
      }

      destination.set(this.entityKey(type, entity.id), {
        id: entity.id,
        type,
        ...mapper(entity),
      });
    }
  }

  private entityKey(type: string, id: string): string {
    return `${type}:${id}`;
  }

  private firstString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  }

  private isTextLike(contentType: string): boolean {
    const normalized = contentType.toLowerCase();

    return (
      TEXT_LIKE_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
      TEXT_LIKE_MIME_TYPES.has(normalized)
    );
  }

  private async readGraphqlSummary(): Promise<AgentCapabilities['graphql']> {
    const schemaText = await this.loadGraphqlSchema();
    const queryBlock = this.extractBlock(schemaText, 'type Query');
    const mutationBlock = this.extractBlock(schemaText, 'type Mutation');
    const queries = this.extractFieldNames(queryBlock);
    const mutations = this.extractFieldNames(mutationBlock);

    return {
      queryCount: queries.length,
      mutationCount: mutations.length,
      queries,
      mutations,
    };
  }

  private async loadGraphqlSchema(): Promise<string> {
    for (const schemaPath of GRAPH_SCHEMA_PATHS) {
      try {
        return await fs.readFile(schemaPath, 'utf8');
      } catch (error) {
        void error;
      }
    }

    this.logger.warn('Unable to locate generated GraphQL schema for agent capabilities');

    return '';
  }

  private extractBlock(source: string, blockName: string): string {
    if (!source.includes(blockName)) {
      return '';
    }

    return source.split(`${blockName} {`)[1]?.split('}')[0] ?? '';
  }

  private extractFieldNames(block: string): string[] {
    return Array.from(block.matchAll(/^\s{2}([A-Za-z0-9_]+)/gm), (match) => match[1]);
  }
}
