import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import { type RequestContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  type GraphEntityInputDto,
  type GraphRelationshipInputDto,
  GraphIngestService,
} from '@ci/domains/graph';
import { OllamaService, PROMPT_MODEL } from '@ci/domains/llm';
import { GraphQueryService } from '@ci/domains/memory';
import { PersonalizationService, PromotionCandidateService } from '@ci/domains/personalization';

/**
 * Concept `properties.type` values the preference tools filter on. The graph
 * tools' CATEGORY_TYPE_MAP / MEDIA_TYPE_MAP (GetUserPreferencesTool,
 * GetEntertainmentPreferencesTool) only surface a preference whose
 * `properties.type` is in this set, so the extractor MUST emit one of these.
 * Anything the LLM returns outside this list is dropped (it would never light a
 * tool up). Kept in sync with those two maps.
 */
export const PREFERENCE_CONCEPT_TYPES = [
  // food (GetUserPreferencesTool: CATEGORY_TYPE_MAP.food)
  'food',
  'cuisine',
  'dietary_preference',
  'food_category',
  // beverage
  'beverage',
  'drink',
  // activity
  'activity',
  'sport',
  'hobby',
  // entertainment / media (GetEntertainmentPreferencesTool: MEDIA_TYPE_MAP)
  'movie_genre',
  'film_style',
  'tv_genre',
  'tv_style',
  'music_genre',
  'music_style',
  'book_genre',
  'literary_genre',
] as const;

type PreferenceConceptType = (typeof PREFERENCE_CONCEPT_TYPES)[number];

const PREFERENCE_TYPE_SET = new Set<string>(PREFERENCE_CONCEPT_TYPES);

/**
 * Family / close relationship edge types the family tools query
 * (GetFamilyMembersTool.FAMILY_RELATIONSHIP_TYPES). UPPER_SNAKE so they satisfy
 * the `relationship_type ~ '^[A-Z_][A-Z0-9_]*$'` CHECK, and members of the
 * RelationshipType enum the rest of the graph uses.
 */
export const FAMILY_RELATIONSHIP_TYPES = [
  'SPOUSE',
  'PARTNER',
  'ROMANTIC_PARTNER',
  'PARENT_OF',
  'CHILD_OF',
  'SIBLING_OF',
  'FAMILY_MEMBER',
] as const;

type FamilyRelationshipType = (typeof FAMILY_RELATIONSHIP_TYPES)[number];

const FAMILY_TYPE_SET = new Set<string>(FAMILY_RELATIONSHIP_TYPES);

export const GENERAL_RELATIONSHIP_TYPES = [
  'KNOWS',
  'WORKS_WITH',
  'WORKS_AT',
  'INTERESTED_IN',
  'OWNS',
] as const;

type GeneralRelationshipType = (typeof GENERAL_RELATIONSHIP_TYPES)[number];

const GENERAL_TYPE_SET = new Set<string>(GENERAL_RELATIONSHIP_TYPES);

/** sourceSystem stamped on Concept nodes this service creates (linked_table = `import:graph_llm`). */
const SOURCE_SYSTEM = 'graph_llm';

/** Self sentinel understood by GraphIngestService — anchors PREFERS/DISLIKES on the owner's entity. */
const SELF_KEY = 'self';

const DEFAULT_MAX_COMMUNICATIONS = 200;
const DEFAULT_MAX_EVENTS = 100;
/** How many records' content go in one LLM prompt. Bounds the prompt size. */
const SAMPLE_CHUNK_SIZE = 25;

/**
 * Cumulative running totals reported per chunk to
 * {@link GraphEnrichmentOptions.onProgress}. These are the pre-dedupe counts
 * accumulated across the chunks processed so far (the final result's
 * preferencesExtracted/familyRelationsExtracted are de-duplicated across the
 * whole run, so they may be <= these running totals).
 */
export interface GraphEnrichmentProgressCounts {
  /** Records (communications + events) sent to the LLM so far (cumulative). */
  recordsProcessed: number;
  /** Cleaned preference items extracted so far, before run-wide dedupe (cumulative). */
  preferencesExtracted: number;
  /** Cleaned family relations extracted so far, before run-wide dedupe (cumulative). */
  familyRelationsExtracted: number;
}

export interface GraphEnrichmentOptions {
  /** Max communications to sample (default 200). */
  maxCommunications?: number;
  /** Max events to sample (default 100). */
  maxEvents?: number;
  /** Max recent answers to sample (default 0). */
  maxAnswers?: number;
  /** Override the Ollama model (default PROMPT_MODEL). */
  model?: string;
  /**
   * Invoked once per LLM chunk with `(chunksDone, chunksTotal, partial)`, where
   * `chunksTotal = ceil(records.length / SAMPLE_CHUNK_SIZE)` and `partial` holds
   * cumulative running totals. Called on EVERY chunk including ones whose LLM
   * call failed (the bar advances so it never stalls on a transient Ollama
   * error). Optional; the synchronous result is unchanged with or without it.
   */
  onProgress?: (chunksDone: number, chunksTotal: number, partial: GraphEnrichmentProgressCounts) => void;
}

export interface GraphEnrichmentResult {
  /** Records (communications + events) whose content was sent to the LLM. */
  sampledRecords: number;
  /** Preference items the LLM returned that mapped to a known concept type. */
  preferencesExtracted: number;
  /** Family relations the LLM returned (before person resolution). */
  familyRelationsExtracted: number;
  /** Family relations whose BOTH people resolved to existing Person nodes. */
  familyRelationsResolved: number;
  /** Concept nodes written via bulkIngestGraph. */
  conceptsWritten: number;
  /** PREFERS/DISLIKES edges written. */
  preferenceEdgesWritten: number;
  /** Family edges written. */
  familyEdgesWritten: number;
  /** General relationship edges written (KNOWS, WORKS_AT, etc.). */
  generalEdgesWritten: number;
  /** Items routed to promotion review instead of auto-write. */
  reviewQueued: number;
  /** Non-fatal errors surfaced by the ingest path. */
  errors: string[];
}

/** Raw preference item shape we ask the LLM for. */
const preferenceItemSchema = z.object({
  concept: z.string().min(1),
  type: z.string().min(1),
  sentiment: z.enum(['like', 'dislike']),
});

/** Raw family relation shape we ask the LLM for. */
const familyRelationSchema = z.object({
  person: z.string().min(1),
  relatedPerson: z.string().min(1),
  relationship: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

const generalRelationSchema = z.object({
  person: z.string().min(1),
  relatedPerson: z.string().min(1),
  relationship: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.string().optional(),
});

const llmResponseSchema = z.object({
  preferences: z.array(preferenceItemSchema).default([]),
  familyRelations: z.array(familyRelationSchema).default([]),
  generalRelations: z.array(generalRelationSchema).default([]),
});

export type LlmExtraction = z.infer<typeof llmResponseSchema>;

export interface PreferenceItem {
  concept: string;
  type: PreferenceConceptType;
  sentiment: 'like' | 'dislike';
}

export interface FamilyRelationItem {
  person: string;
  relatedPerson: string;
  relationship: FamilyRelationshipType;
  confidence: number;
}

export interface GeneralRelationItem {
  person: string;
  relatedPerson: string;
  relationship: GeneralRelationshipType;
  confidence: number;
  evidence?: string;
}

/** What {@link GraphEnrichmentService.buildPreferenceInput} produces. */
export interface PreferenceGraphInput {
  entities: GraphEntityInputDto[];
  relationships: GraphRelationshipInputDto[];
}

interface SampledRecord {
  source: 'communication' | 'event' | 'answer';
  text: string;
}

const PROMPT_HEADER = `You analyze a person's own messages and calendar events to extract their personal preferences and close relationships.

Return STRICT JSON only (no markdown, no prose) with this exact shape:
{
  "preferences": [{ "concept": string, "type": string, "sentiment": "like" | "dislike" }],
  "familyRelations": [{ "person": string, "relatedPerson": string, "relationship": string, "confidence": number }],
  "generalRelations": [{ "person": string, "relatedPerson": string, "relationship": string, "confidence": number, "evidence": string }]
}

Rules:
- "concept" is a specific thing the author likes or dislikes (e.g. "Italian", "Science Fiction", "Jazz").
- "type" MUST be one of: cuisine, food, food_category, dietary_preference, beverage, drink, activity, sport, hobby, movie_genre, film_style, tv_genre, tv_style, music_genre, music_style, book_genre, literary_genre.
- "sentiment" is "like" or "dislike".
- "familyRelations" describe close/family ties BETWEEN TWO NAMED PEOPLE. "relationship" MUST be one of: SPOUSE, PARTNER, ROMANTIC_PARTNER, PARENT_OF, CHILD_OF, SIBLING_OF, FAMILY_MEMBER.
- "generalRelations" describe professional/social ties. "relationship" MUST be one of: KNOWS, WORKS_WITH, WORKS_AT, INTERESTED_IN, OWNS. Include confidence 0-1 and a short evidence quote.
- Use full names where available. Only include relationships you are confident about. Omit anything uncertain.
- If nothing is found, return empty arrays.

Author's content:
`;

/**
 * Graph-LLM enrichment (operator-triggered via POST /api/maintenance/extract-graph).
 *
 * The importer only ever writes Person/Location/Organization/Concept nodes plus
 * KNOWS/MENTIONS edges, so the preference/family graph tools (getUserPreferences,
 * getEntertainmentPreferences, getFamilyMembers) had nothing to read on imported
 * data. This service closes that gap: it samples the user's own communications +
 * events, asks the LOCAL Ollama model to extract (a) liked/disliked concepts and
 * (b) close relationships between people, then writes them back through the
 * idempotent {@link GraphIngestService} (`bulkIngestGraph`) path so the tools
 * light up:
 *   - preferences -> a `Concept` node (properties.type set to the tool vocab) +
 *     a PREFERS/DISLIKES edge from the owner's `self` entity;
 *   - family relations -> SPOUSE/PARENT_OF/... edges between EXISTING Person
 *     nodes (resolved by name; a relation is skipped if either person is not
 *     already in the graph — this service never invents Person nodes).
 *
 * Re-runnable: the ingest upsert dedupes Concept nodes on the linked key and
 * every edge on the directed (from, to, type) unique index.
 */
@Injectable()
export class GraphEnrichmentService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ollamaService: OllamaService,
    private readonly graphIngestService: GraphIngestService,
    private readonly graphQuery: GraphQueryService,
    private readonly personalizationService: PersonalizationService,
    private readonly promotionCandidateService: PromotionCandidateService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GraphEnrichmentService.name);
  }

  async enrich(userId: string, options: GraphEnrichmentOptions = {}): Promise<GraphEnrichmentResult> {
    const maxCommunications = options.maxCommunications ?? DEFAULT_MAX_COMMUNICATIONS;
    const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    const maxAnswers = options.maxAnswers ?? 0;
    const model = options.model ?? PROMPT_MODEL;

    const records = await this.sampleRecords(userId, maxCommunications, maxEvents, maxAnswers);

    const empty: GraphEnrichmentResult = {
      sampledRecords: records.length,
      preferencesExtracted: 0,
      familyRelationsExtracted: 0,
      familyRelationsResolved: 0,
      conceptsWritten: 0,
      preferenceEdgesWritten: 0,
      familyEdgesWritten: 0,
      generalEdgesWritten: 0,
      reviewQueued: 0,
      errors: [],
    };

    if (records.length === 0) {
      return empty;
    }

    // Run the LLM over chunks of records and accumulate the (cleaned) extraction.
    const allPreferences: PreferenceItem[] = [];
    const allFamily: FamilyRelationItem[] = [];
    const allGeneral: GeneralRelationItem[] = [];

    // Denominator known up front (records.length is fixed). Emitting per chunk,
    // including the failed-chunk path below, so a transient Ollama error never
    // stalls the importer's stage-5 progress bar.
    const chunksTotal = Math.ceil(records.length / SAMPLE_CHUNK_SIZE);
    let recordsProcessed = 0;

    const emitChunkProgress = (chunkIndex: number) => {
      recordsProcessed += records.slice(chunkIndex, chunkIndex + SAMPLE_CHUNK_SIZE).length;
      options.onProgress?.(chunkIndex / SAMPLE_CHUNK_SIZE + 1, chunksTotal, {
        recordsProcessed,
        preferencesExtracted: allPreferences.length,
        familyRelationsExtracted: allFamily.length,
      });
    };

    for (let i = 0; i < records.length; i += SAMPLE_CHUNK_SIZE) {
      const chunk = records.slice(i, i + SAMPLE_CHUNK_SIZE);

      let extraction: LlmExtraction;
      try {
        extraction = await this.runExtraction({ userId }, chunk, model);
      } catch (err) {
        this.logger.warn('LLM extraction failed for chunk; skipping', {
          chunkStart: i,
          error: (err as Error).message,
        });
        // Still tick the bar so it never stalls on an Ollama error: the chunk's
        // records are "processed" (consumed) even though nothing was extracted.
        emitChunkProgress(i);
        continue;
      }

      const { preferences, family, general } = GraphEnrichmentService.cleanExtraction(extraction);
      allPreferences.push(...preferences);
      allFamily.push(...family);
      allGeneral.push(...general);

      emitChunkProgress(i);
    }

    const preferences = GraphEnrichmentService.dedupePreferences(allPreferences);
    const family = GraphEnrichmentService.dedupeFamily(allFamily);
    const general = GraphEnrichmentService.dedupeGeneral(allGeneral);

    const result: GraphEnrichmentResult = {
      ...empty,
      preferencesExtracted: preferences.length,
      familyRelationsExtracted: family.length,
    };

    const context = { userId } as import('@ci/common/context').UserServiceContext;

    // 1) Preferences: Concept nodes + self -> PREFERS/DISLIKES edges, all in batch.
    if (preferences.length > 0) {
      const input = GraphEnrichmentService.buildPreferenceInput(preferences);
      const gated = await this.ingestWithPersonalization(context, input, 0.8, 'graph_edge');
      result.conceptsWritten += gated.entitiesProcessed;
      result.preferenceEdgesWritten += gated.relationshipsProcessed;
      result.reviewQueued += gated.reviewQueued;
      result.errors.push(...gated.errors);
    }

    // 2) Family: resolve named people to EXISTING Person nodes, then write edges
    if (family.length > 0) {
      const familyInput = await this.buildFamilyInput(userId, family);
      result.familyRelationsResolved = familyInput.relationships.length;

      if (familyInput.relationships.length > 0) {
        const avgConfidence =
          family.reduce((sum, rel) => sum + rel.confidence, 0) / Math.max(family.length, 1);
        const gated = await this.ingestWithPersonalization(context, familyInput, avgConfidence, 'graph_edge');
        result.familyEdgesWritten += gated.relationshipsProcessed;
        result.reviewQueued += gated.reviewQueued;
        result.errors.push(...gated.errors);
      }
    }

    // 3) General relationships (KNOWS, WORKS_AT, etc.)
    if (general.length > 0) {
      const generalInput = await this.buildGeneralInput(userId, general);
      if (generalInput.relationships.length > 0) {
        const avgConfidence =
          general.reduce((sum, rel) => sum + rel.confidence, 0) / Math.max(general.length, 1);
        const gated = await this.ingestWithPersonalization(
          context,
          generalInput,
          avgConfidence,
          'graph_edge',
        );
        result.generalEdgesWritten += gated.relationshipsProcessed;
        result.reviewQueued += gated.reviewQueued;
        result.errors.push(...gated.errors);
      }
    }

    this.logger.log('Graph LLM enrichment complete', {
      userId,
      ...result,
    });

    return result;
  }

  /**
   * Call the local Ollama model with one chunk of sampled content and parse the
   * strict-JSON response. Isolated so it can be mocked wholesale in tests.
   */
  private async runExtraction(
    context: RequestContext,
    chunk: SampledRecord[],
    model: string,
  ): Promise<LlmExtraction> {
    const prompt = PROMPT_HEADER + chunk.map((r, idx) => `[${idx + 1}] ${r.text}`).join('\n');

    const response = await this.ollamaService.chat(context, [{ role: 'user', content: prompt }], {
      model,
      enableTools: false,
      format: 'json',
    });

    return GraphEnrichmentService.parseLlmContent(response.message.content);
  }

  /**
   * Parse the LLM's raw content into the extraction shape. Tolerant of markdown
   * fences / leading prose (mirrors InventoryListener.parseAndValidateAnalysis):
   * slices to the outermost {...} before JSON.parse, then validates with zod.
   * Returns empty arrays on any parse/validation failure rather than throwing.
   */
  static parseLlmContent(content: string): LlmExtraction {
    let jsonStr = (content ?? '').replace(/```json\n?|\n?```/g, '').trim();

    const firstOpen = jsonStr.indexOf('{');
    const lastClose = jsonStr.lastIndexOf('}');
    if (firstOpen !== -1 && lastClose !== -1) {
      jsonStr = jsonStr.substring(firstOpen, lastClose + 1);
    }

    try {
      const parsed = llmResponseSchema.safeParse(JSON.parse(jsonStr));
      if (!parsed.success) {
        return { preferences: [], familyRelations: [], generalRelations: [] };
      }

      return parsed.data;
    } catch {
      return { preferences: [], familyRelations: [], generalRelations: [] };
    }
  }

  /**
   * Filter the raw LLM extraction down to items whose type/relationship is in
   * the vocabulary the graph tools actually query. Anything else is dropped (it
   * would never surface through a tool). Normalizes type to lower-case and
   * relationship to UPPER_SNAKE.
   */
  static cleanExtraction(extraction: LlmExtraction): {
    preferences: PreferenceItem[];
    family: FamilyRelationItem[];
    general: GeneralRelationItem[];
  } {
    const preferences: PreferenceItem[] = [];
    for (const item of extraction.preferences) {
      const type = item.type.trim().toLowerCase();
      const concept = item.concept.trim();
      if (concept.length === 0 || !PREFERENCE_TYPE_SET.has(type)) {
        continue;
      }

      preferences.push({
        concept,
        type: type as PreferenceConceptType,
        sentiment: item.sentiment,
      });
    }

    const family: FamilyRelationItem[] = [];
    for (const rel of extraction.familyRelations) {
      const relationship = rel.relationship.trim().toUpperCase();
      const person = rel.person.trim();
      const relatedPerson = rel.relatedPerson.trim();
      if (
        person.length === 0 ||
        relatedPerson.length === 0 ||
        person.toLowerCase() === relatedPerson.toLowerCase() ||
        !FAMILY_TYPE_SET.has(relationship)
      ) {
        continue;
      }

      family.push({
        person,
        relatedPerson,
        relationship: relationship as FamilyRelationshipType,
        confidence: rel.confidence ?? 0.75,
      });
    }

    const general: GeneralRelationItem[] = [];
    for (const rel of extraction.generalRelations) {
      const relationship = rel.relationship.trim().toUpperCase();
      const person = rel.person.trim();
      const relatedPerson = rel.relatedPerson.trim();
      if (
        person.length === 0 ||
        relatedPerson.length === 0 ||
        person.toLowerCase() === relatedPerson.toLowerCase() ||
        !GENERAL_TYPE_SET.has(relationship)
      ) {
        continue;
      }

      general.push({
        person,
        relatedPerson,
        relationship: relationship as GeneralRelationshipType,
        confidence: rel.confidence ?? 0.7,
        evidence: rel.evidence,
      });
    }

    return { preferences, family, general };
  }

  static dedupePreferences(items: PreferenceItem[]): PreferenceItem[] {
    const byKey = new Map<string, PreferenceItem>();
    for (const item of items) {
      // (type, concept) identity; a later dislike does not overwrite an earlier
      // like for the same concept — first wins, keeping the run deterministic.
      const key = `${item.type}::${item.concept.toLowerCase()}`;
      if (!byKey.has(key)) {
        byKey.set(key, item);
      }
    }

    return [...byKey.values()];
  }

  static dedupeFamily(items: FamilyRelationItem[]): FamilyRelationItem[] {
    const byKey = new Map<string, FamilyRelationItem>();
    for (const item of items) {
      const key = `${item.person.toLowerCase()}::${item.relatedPerson.toLowerCase()}::${item.relationship}`;
      if (!byKey.has(key)) {
        byKey.set(key, item);
      }
    }

    return [...byKey.values()];
  }

  static dedupeGeneral(items: GeneralRelationItem[]): GeneralRelationItem[] {
    const byKey = new Map<string, GeneralRelationItem>();
    for (const item of items) {
      const key = `${item.person.toLowerCase()}::${item.relatedPerson.toLowerCase()}::${item.relationship}`;
      if (!byKey.has(key)) {
        byKey.set(key, item);
      }
    }

    return [...byKey.values()];
  }

  /**
   * Map cleaned preferences to a bulkIngestGraph batch:
   *   - one `Concept` entity per item (PascalCase entity_type 'Concept' so it
   *     satisfies `entity_type ~ '^[A-Z][A-Za-z]*$'`; properties.type set to the
   *     tool vocab so GraphReadService.extractConceptType / the tools' type
   *     filters match);
   *   - a `self` -> Concept PREFERS (like) or DISLIKES (dislike) edge.
   * Pure + deterministic so the parse->graph-input mapping is unit-testable.
   */
  static buildPreferenceInput(preferences: PreferenceItem[]): PreferenceGraphInput {
    const entities: GraphEntityInputDto[] = [];
    const relationships: GraphRelationshipInputDto[] = [];

    for (const pref of preferences) {
      // Stable natural key so re-runs upsert the same Concept node.
      const key = `${SOURCE_SYSTEM}:concept:${pref.type}:${pref.concept.toLowerCase()}`;

      entities.push({
        key,
        entityType: 'Concept',
        name: pref.concept,
        sourceSystem: SOURCE_SYSTEM,
        properties: {
          type: pref.type,
          extracted_by: SOURCE_SYSTEM,
        },
      });

      relationships.push({
        fromKey: SELF_KEY,
        toKey: key,
        type: pref.sentiment === 'like' ? 'PREFERS' : 'DISLIKES',
        properties: { source: SOURCE_SYSTEM },
      });
    }

    return { entities, relationships };
  }

  /**
   * Resolve the named people in each family relation to EXISTING Person nodes
   * and build a bulkIngestGraph batch of edges referencing those ids directly
   * (via the pre-resolved fromEntityId/toEntityId fields). A relation is skipped
   * when either person can't be resolved — this service never creates Person
   * nodes. No entities are emitted (both endpoints already exist).
   */
  private async buildFamilyInput(
    userId: string,
    family: FamilyRelationItem[],
  ): Promise<{ entities: GraphEntityInputDto[]; relationships: GraphRelationshipInputDto[] }> {
    const relationships: GraphRelationshipInputDto[] = [];
    const cache = new Map<string, string | null>();

    const resolve = async (name: string): Promise<string | null> => {
      const cacheKey = name.toLowerCase();
      if (cache.has(cacheKey)) {
        return cache.get(cacheKey) ?? null;
      }

      const id = await this.resolvePersonId(userId, name);
      cache.set(cacheKey, id);

      return id;
    };

    for (const rel of family) {
      const fromId = await resolve(rel.person);
      const toId = await resolve(rel.relatedPerson);

      if (fromId == null || toId == null || fromId === toId) {
        continue;
      }

      relationships.push({
        // fromKey/toKey are informational only here — the pre-resolved ids win.
        fromKey: rel.person,
        toKey: rel.relatedPerson,
        type: rel.relationship,
        fromEntityId: fromId,
        fromEntityType: 'Person',
        toEntityId: toId,
        toEntityType: 'Person',
        properties: { source: SOURCE_SYSTEM },
      });
    }

    return { entities: [], relationships };
  }

  private async buildGeneralInput(
    userId: string,
    general: GeneralRelationItem[],
  ): Promise<{ entities: GraphEntityInputDto[]; relationships: GraphRelationshipInputDto[] }> {
    const relationships: GraphRelationshipInputDto[] = [];
    const cache = new Map<string, string | null>();

    const resolve = async (name: string): Promise<string | null> => {
      const cacheKey = name.toLowerCase();
      if (cache.has(cacheKey)) {
        return cache.get(cacheKey) ?? null;
      }

      const id = await this.resolvePersonId(userId, name);
      cache.set(cacheKey, id);

      return id;
    };

    for (const rel of general) {
      const fromId = await resolve(rel.person);
      const toId = await resolve(rel.relatedPerson);

      if (fromId == null || toId == null || fromId === toId) {
        continue;
      }

      relationships.push({
        fromKey: rel.person,
        toKey: rel.relatedPerson,
        type: rel.relationship,
        fromEntityId: fromId,
        fromEntityType: 'Person',
        toEntityId: toId,
        toEntityType: 'Person',
        properties: { source: SOURCE_SYSTEM, confidence: rel.confidence, evidence: rel.evidence },
      });
    }

    return { entities: [], relationships };
  }

  private async ingestWithPersonalization(
    context: import('@ci/common/context').UserServiceContext,
    input: { entities: GraphEntityInputDto[]; relationships: GraphRelationshipInputDto[] },
    confidence: number,
    kind: import('@ci/domains/personalization').PersonalizationActionKind,
  ): Promise<{
    entitiesProcessed: number;
    relationshipsProcessed: number;
    reviewQueued: number;
    errors: string[];
  }> {
    const decision = await this.personalizationService.decideAction(context.userId!, {
      kind,
      confidence,
      hasUserInput: true,
    });

    if (decision === 'skip') {
      return { entitiesProcessed: 0, relationshipsProcessed: 0, reviewQueued: 0, errors: [] };
    }

    if (decision === 'review') {
      await this.promotionCandidateService.create(context, {
        kind: 'relationship',
        payload: input,
        confidence,
        evidence: input.relationships.map((r) => r.properties ?? {}),
        sourceJob: 'graph_enrich',
      });

      return { entitiesProcessed: 0, relationshipsProcessed: 0, reviewQueued: 1, errors: [] };
    }

    const ingest = await this.graphIngestService.ingest(context, input);

    return {
      entitiesProcessed: ingest.entitiesProcessed,
      relationshipsProcessed: ingest.relationshipsProcessed,
      reviewQueued: 0,
      errors: ingest.errors,
    };
  }

  /**
   * Find an existing Person node by name (exact case-insensitive match
   * preferred, else the first contains-match). Returns null if no Person matches
   * — the relation is then skipped.
   */
  private async resolvePersonId(userId: string, name: string): Promise<string | null> {
    const lower = name.toLowerCase();

    const candidates = await this.graphQuery.getNodes(userId, {
      entityType: 'Person',
      nameContains: name,
      limit: 5,
    });

    if (candidates.length === 0) {
      return null;
    }

    const exact = candidates.find((node) => (node.name ?? '').toLowerCase() === lower);

    return (exact ?? candidates[0]).entity_id;
  }

  /**
   * Sample the user's own communications + events (text content) to feed the
   * extractor. Bounded reads ordered newest-first. Communications live on a
   * TimescaleDB hypertable; we cap with LIMIT so it never builds an all-chunk
   * plan over a huge history.
   */
  private async sampleRecords(
    userId: string,
    maxCommunications: number,
    maxEvents: number,
    maxAnswers = 0,
  ): Promise<SampledRecord[]> {
    const records: SampledRecord[] = [];

    if (maxCommunications > 0) {
      const comms: Array<{ subject: string | null; content: string | null; summary: string | null }> =
        await this.dataSource.query(
          `SELECT subject, content, summary
             FROM ci.communications
            WHERE user_id = $1
              AND is_archived = false
              AND (content IS NOT NULL OR subject IS NOT NULL OR summary IS NOT NULL)
            ORDER BY time DESC
            LIMIT $2`,
          [userId, maxCommunications],
        );

      for (const row of comms) {
        const text = [row.subject, row.summary, row.content]
          .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          .join(' — ')
          .slice(0, 2000);
        if (text.length > 0) {
          records.push({ source: 'communication', text });
        }
      }
    }

    if (maxEvents > 0) {
      // title/description live on the event's CTI base row (ci.entities).
      const events: Array<{ title: string | null; description: string | null }> = await this.dataSource.query(
        `SELECT b.name AS title, b.description
             FROM ci.events e
             JOIN ci.entities b ON b.entity_id = e.event_id
            WHERE e.user_id = $1
              AND e.is_deleted = false
              AND (b.name IS NOT NULL OR b.description IS NOT NULL)
            ORDER BY e.start_time DESC
            LIMIT $2`,
        [userId, maxEvents],
      );

      for (const row of events) {
        const text = [row.title, row.description]
          .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          .join(' — ')
          .slice(0, 2000);
        if (text.length > 0) {
          records.push({ source: 'event', text });
        }
      }
    }

    if (maxAnswers > 0) {
      const answers: Array<{ answer_text: string | null; question_text: string | null }> =
        await this.dataSource.query(
          `SELECT a.answer_text, q.question_text
             FROM ci.answers a
             LEFT JOIN ci.questions q ON q.question_id = a.question_id
            WHERE a.user_id = $1
              AND a.answer_text IS NOT NULL
              AND TRIM(a.answer_text) <> ''
            ORDER BY a.answered_at DESC
            LIMIT $2`,
          [userId, maxAnswers],
        );

      for (const row of answers) {
        const text = [row.question_text, row.answer_text]
          .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          .join('\nA: ')
          .slice(0, 2000);
        if (text.length > 0) {
          records.push({ source: 'answer', text });
        }
      }
    }

    return records;
  }
}
