/**
 * MemoryCompactionService
 *
 * Takes a batch of raw agent memory fragments (ci.agent_memory rows written
 * by the Hermes on_memory_write hook) for a single user, runs a local LLM
 * extraction pass to pull out entities and relationships, writes them into
 * the knowledge graph, then stamps processed_at on every fragment.
 *
 * Called by MemoryCompactionCron (periodic) and MemoryController (manual).
 *
 * Deduplication strategy:
 *   - person / concept : exact name match via PersonService / ConceptService
 *   - place / event / item / content : always create a new graph node
 *     (these types lack a reliable name-search API at this stage)
 */

import { Injectable } from '@nestjs/common';
import type { Message as OllamaMessage } from 'ollama';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { RelationshipService } from '@ci/domains/graph';
import { OllamaService, PROMPT_MODEL } from '@ci/domains/llm';
import {
  ConceptService,
  ItemService,
  PersonService,
  PlaceService,
  UserContextService,
} from '@ci/domains/memory';

import type { AgentMemory } from '../entities/AgentMemoryEntity';
import { AgentMemoryService } from '../services/AgentMemoryService';

// ---------------------------------------------------------------------------
// LLM extraction prompt
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You are a knowledge-graph extractor. From informal memory fragments, extract a graph of the entities mentioned and the relationships between them. Capture facts about the user AND about everyone and everything they mention (a friend's job, a sibling's profession, a company's location, where a relative lives) — every concrete fact is worth keeping, not only facts whose subject is the user.

Return ONLY valid JSON with no markdown, no code fences, no extra text:
{"entities":[{"type":"<type>","name":"<name>","description":"<facts about this entity>"}],"relationships":[{"fromName":"<name>","fromType":"<type>","toName":"<name>","toType":"<type>","relationshipType":"<UPPER_SNAKE_CASE>"}]}

Entity types (use ONLY these exact strings):
  person   — a human being (the user, or anyone they mention)
  concept  — a hobby, skill, topic, preference, or abstract idea
  place    — a city, building, venue, region, OR an organization/company
  event    — something that happened or will happen at a point in time
  item     — a physical object or possession
  content  — a book, film, show, article, or piece of media

Relationship types — pick the MOST SPECIFIC that applies; do NOT default to KNOWS/RELATED_TO when a specific one fits:
  Family/social: SIBLING_OF, PARENT_OF, CHILD_OF, SPOUSE, FRIENDS_WITH, WORKS_WITH, KNOWS
  Other:         LIVES_IN, WORKS_AT, INTERESTED_IN, OWNS, ATTENDED, LIKES, DISLIKES, HAS_SKILL, RELATED_TO
Relationship types: KNOWS, FRIENDS_WITH, FAMILY_MEMBER, LIVES_IN, WORKS_AT, STUDIES_AT, VISITED, OWNS, INTERESTED_IN, PREFERS, DISLIKES, PARTICIPATED_IN, ASSOCIATED_WITH

How to extract:
1. Create an entity for every person, place/organization, item, event, content, and notable concept mentioned — including third parties, not just the user.
2. Put each entity's concrete ATTRIBUTES in its "description" (e.g. a person's profession, a place's role, a thing's brand/model). Capture the attribute even when the entity is not the user — "Anita is an architect" → entity Anita, description "an architect". This is what makes the fact findable later, so be specific and complete; do not omit attributes to keep it short.
3. ALSO, when an entity is connected to the user, state that connection in its description using the explicit relation word ("the user's sister", "the user's best friend", "the company where the user works", "the city where the user currently lives", "the user's childhood hometown").
4. Promote relationships between entities to typed edges, for BOTH user↔X and X↔Y links. Examples: the user SIBLING_OF Anita; Anita WORKS_AT <firm>; the user's friend Lena WORKS_AT Stripe; Lena LIVES_IN San Francisco; the user LIVES_IN Denver. An employer/company is a "place" entity joined by WORKS_AT.
5. Only include a relationship when BOTH endpoints also appear in the entities list.
6. Refer to the user as "the user"; do not invent a separate "User" entity. Only create a person entity for the user if they state their own name.
7. SKIP code, configuration, commands, and content with no real-world facts.

Example fragment: "My sister Anita is an architect; she works at Foster + Partners in London."
Example output: {"entities":[{"type":"person","name":"Anita","description":"the user's sister; an architect who works at Foster + Partners"},{"type":"place","name":"Foster + Partners","description":"an architecture firm in London where Anita works"},{"type":"place","name":"London","description":"city where Foster + Partners is located"}],"relationships":[{"fromName":"the user","fromType":"person","toName":"Anita","toType":"person","relationshipType":"SIBLING_OF"},{"fromName":"Anita","fromType":"person","toName":"Foster + Partners","toType":"place","relationshipType":"WORKS_AT"}]}

If there is nothing to extract, return exactly: {"entities":[],"relationships":[]}`;

/**
 * Allowed entity types.  The LLM is prompted with lowercase vocabulary
 * (`person`, `place`, …) and that's what it typically returns; the
 * `ci.entities.valid_entity_type` CHECK constraint requires PascalCase
 * (`^[A-Z][A-Za-z]*$`), so we validate case-insensitively against this set
 * and normalize to PascalCase before storage.
 */
const VALID_ENTITY_TYPES = new Set(['person', 'concept', 'place', 'event', 'item', 'content']);

/**
 * Optional external extraction backend.  When `EXTRACTION_LLM_URL` is set we
 * skip Ollama and call an OpenAI-compatible chat completions endpoint (LM
 * Studio, vLLM, llama.cpp's server, etc.) — useful when a beefier remote
 * machine on the local network is running a stronger model than the laptop
 * can host.  The endpoint must still be reachable without internet egress;
 * the platform is local-first.
 */
const EXTRACTION_LLM_URL = process.env['EXTRACTION_LLM_URL']?.replace(/\/$/, '') ?? '';
const EXTRACTION_LLM_MODEL = process.env['EXTRACTION_LLM_MODEL'] ?? 'local-model';
const EXTRACTION_LLM_API_KEY = process.env['EXTRACTION_LLM_API_KEY'] ?? '';
const EXTRACTION_LLM_TIMEOUT_MS = Number.parseInt(process.env['EXTRACTION_LLM_TIMEOUT_MS'] ?? '120000', 10);

/**
 * JSON Schema for the OpenAI structured-outputs path.  Mirrors the prompt's
 * shape so the server can constrain decoding at every token.  `additionalProperties:
 * false` is required by OpenAI's strict mode; we keep the entity-type union open
 * (just `string`) because the upstream `normalizeEntityType` validator handles
 * filtering — letting bad types through here would force the model to fight
 * its own logits.
 */
const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
        },
        required: ['type', 'name', 'description'],
        additionalProperties: false,
      },
    },
    relationships: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fromName: { type: 'string' },
          fromType: { type: 'string' },
          toName: { type: 'string' },
          toType: { type: 'string' },
          relationshipType: { type: 'string' },
        },
        required: ['fromName', 'fromType', 'toName', 'toType', 'relationshipType'],
        additionalProperties: false,
      },
    },
  },
  required: ['entities', 'relationships'],
  additionalProperties: false,
} as const;

/** Lowercased input → PascalCased storage form expected by the DB constraint. */
function normalizeEntityType(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }

  const lower = raw.toLowerCase();
  if (!VALID_ENTITY_TYPES.has(lower)) {
    return null;
  }

  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Maximum characters per fragment sent to the LLM. */
const MAX_FRAGMENT_CHARS = 600;

/**
 * Max fragments per LLM call.  Small models (1–4B) struggle with long outputs;
 * batching too many fragments at once causes truncation or empty responses.
 */
const BATCH_SIZE = 4;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ExtractedEntity {
  type: string;
  name: string;
  description?: string;
  properties?: Record<string, unknown>;
}

interface ExtractedRelationship {
  fromName: string;
  fromType: string;
  toName: string;
  toType: string;
  relationshipType: string;
  bidirectional?: boolean;
}

interface ExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class MemoryCompactionService {
  constructor(
    private readonly ollamaService: OllamaService,
    private readonly agentMemoryService: AgentMemoryService,
    private readonly personService: PersonService,
    private readonly conceptService: ConceptService,
    private readonly userContext: UserContextService,
    private readonly placeService: PlaceService,
    private readonly itemService: ItemService,
    private readonly relationshipService: RelationshipService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(MemoryCompactionService.name);
  }

  /**
   * Process a batch of agent memory fragments for one user:
   *   1. Send fragments to the LLM for structured extraction.
   *   2. Upsert extracted entities via the per-type domain services so their
   *      `*.created` events fire and downstream indexers see the new rows.
   *   3. Upsert extracted relationships.
   *   4. Stamp processed_at on every fragment regardless of outcome.
   */
  async compactForUser(context: UserServiceContext, fragments: AgentMemory[]): Promise<void> {
    if (fragments.length === 0) {
      return;
    }

    const { userId } = context;

    this.logger.log('Compacting agent memory fragments', {
      userId,
      fragmentCount: fragments.length,
    });

    // ------------------------------------------------------------------
    // 1. LLM extraction — process in small batches so a 1-4B model
    //    doesn't produce truncated or empty output for large inputs.
    // ------------------------------------------------------------------

    const entityMap = new Map<string, string>();

    // Resolve the canonical "self" node so first-person facts ("my sister",
    // "I live in…") anchor to the ONE user entity instead of minting duplicate
    // "the user"/"User"/"<name>" nodes per batch. Pre-seed the entity map with
    // every self-alias so relationships whose endpoint is the user resolve even
    // when that batch didn't emit the user as an explicit entity.
    const self = await this.userContext.getSelfIdentity(userId).catch(() => null);
    const selfAliases = new Set<string>((self?.aliases ?? []).map((a) => a.toLowerCase()));
    if (self) {
      for (const alias of selfAliases) {
        entityMap.set(this.entityKey('person', alias), self.entityId);
      }

      this.logger.log('Resolved canonical self node for compaction', {
        userId,
        selfEntityId: self.entityId,
        aliasCount: selfAliases.size,
      });
    }

    const batches: AgentMemory[][] = [];
    for (let i = 0; i < fragments.length; i += BATCH_SIZE) {
      batches.push(fragments.slice(i, i + BATCH_SIZE));
    }

    let anyBatchCompleted = false;

    for (const batch of batches) {
      const outcome = await this.extractBatch(batch, userId);

      if (outcome.completed) {
        anyBatchCompleted = true;
        await this.upsertEntities(
          outcome.result.entities,
          userId,
          context,
          entityMap,
          self?.entityId ?? null,
          selfAliases,
        );
        await this.upsertRelationships(outcome.result.relationships, userId, entityMap, context);
      }
    }

    // ------------------------------------------------------------------
    // 4. Mark fragments processed only if at least one batch actually ran
    //    the LLM without throwing.  If every call threw (e.g. Ollama down,
    //    PROMPT_MODEL missing), leave processed_at unset so the next run
    //    retries — and the failure stays loud instead of silently swallowing
    //    a whole user's worth of fragments.  Genuine empty extractions
    //    (LLM returned {entities:[]}) still count as "completed".
    // ------------------------------------------------------------------

    if (!anyBatchCompleted) {
      this.logger.warn('All extraction batches threw; leaving fragments unprocessed for retry', {
        userId,
        fragmentCount: fragments.length,
        batchCount: batches.length,
      });

      return;
    }

    await this.agentMemoryService.markProcessed(
      { userId: SYSTEM_USER } as ServiceContext,
      fragments.map((f) => f.id),
    );

    this.logger.log('Memory compaction complete', { userId, fragmentCount: fragments.length });
  }

  // ---------------------------------------------------------------------------
  // Extraction helpers (split out of compactForUser for readability)
  // ---------------------------------------------------------------------------

  private async extractBatch(
    batch: AgentMemory[],
    userId: string,
  ): Promise<{ completed: true; result: ExtractionResult } | { completed: false }> {
    const fragmentsText = batch
      .map((f, index) => {
        const label = f.title ?? (f.source ? `[${f.source}]` : `[Fragment ${index + 1}]`);
        const body = f.content;
        const truncated = body.length > MAX_FRAGMENT_CHARS ? `${body.slice(0, MAX_FRAGMENT_CHARS)}…` : body;

        return `${label}\n${truncated}`;
      })
      .join('\n\n---\n\n');

    const messages: OllamaMessage[] = [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Extract entities and relationships from these memory fragments:\n\n${fragmentsText}`,
      },
    ];

    try {
      const content = EXTRACTION_LLM_URL
        ? await this.callOpenAICompatibleChat(messages)
        : await this.callOllamaChat(messages);

      const extracted = this.parseExtractionResult(content);

      this.logger.log('Extracted knowledge from batch', {
        userId,
        batchSize: batch.length,
        backend: EXTRACTION_LLM_URL ? 'openai-compatible' : 'ollama',
        entityCount: extracted.entities.length,
        relationshipCount: extracted.relationships.length,
      });

      return { completed: true, result: extracted };
    } catch (err) {
      this.logger.error(
        'LLM extraction failed for batch',
        err instanceof Error ? err : new Error(String(err)),
      );

      return { completed: false };
    }
  }

  private async callOllamaChat(messages: OllamaMessage[]): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await this.ollamaService.chat({} as any, messages, {
      model: PROMPT_MODEL,
      format: 'json',
    });

    return response.message.content;
  }

  /**
   * Call any OpenAI-compatible /v1/chat/completions endpoint.  Used when the
   * operator points compaction at LM Studio, vLLM, llama.cpp's server, etc.
   * Stays local-first: the URL is whatever the operator configured, no
   * default cloud fallback.
   *
   * Uses OpenAI structured outputs (`response_format.type = 'json_schema'`)
   * so the server enforces the extraction shape at decode time — eliminates
   * the truncation / wrong-type-field failures we get from prompt-only JSON
   * mode on smaller models.  LM Studio rejects `json_object` outright and
   * requires schema mode, so this is also the only thing that works there.
   */
  private async callOpenAICompatibleChat(messages: OllamaMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXTRACTION_LLM_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (EXTRACTION_LLM_API_KEY) {
        headers['Authorization'] = `Bearer ${EXTRACTION_LLM_API_KEY}`;
      }

      const res = await fetch(`${EXTRACTION_LLM_URL}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: EXTRACTION_LLM_MODEL,
          messages,
          temperature: 0,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'extraction_result',
              strict: true,
              schema: EXTRACTION_JSON_SCHEMA,
            },
          },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Extraction LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
            // Reasoning models (e.g. ornstein-3.6-27b on LM Studio, DeepSeek-R1)
            // emit their schema-constrained output here when `content` ends
            // up empty.  Fall back so we don't lose perfectly good extractions.
            reasoning_content?: string;
          };
        }>;
      };
      const msg = data.choices?.[0]?.message;

      return msg?.content || msg?.reasoning_content || '';
    } finally {
      clearTimeout(timer);
    }
  }

  private async upsertEntities(
    entities: ExtractedEntity[],
    userId: string,
    context: UserServiceContext,
    entityMap: Map<string, string>,
    selfEntityId: string | null,
    selfAliases: Set<string>,
  ): Promise<void> {
    for (const entity of entities) {
      const name = entity.name?.trim();
      const type = normalizeEntityType(entity.type);

      if (!name || !type) {
        this.logger.debug('Skipping entity with missing name or invalid type', {
          type: entity.type,
          name,
        });
        continue;
      }

      // Self-anchor: if this is the user referring to themselves ("the user",
      // "Max", "me"…), point the map at the canonical node and do NOT create a
      // node or overwrite the canonical one's identity. The user's facts live
      // as edges + neighbour descriptions, not on the self node's own fields.
      if (selfEntityId && type === 'Person' && selfAliases.has(name.toLowerCase())) {
        entityMap.set(this.entityKey(type, name), selfEntityId);
        continue;
      }

      try {
        const entityId = await this.upsertEntity(context, entity.type, name, entity.description ?? null);

        if (entityId != null) {
          entityMap.set(this.entityKey(entity.type, name), entityId);
        }
      } catch (err) {
        this.logger.warn('Failed to upsert entity', {
          userId,
          name,
          type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async upsertRelationships(
    relationships: ExtractedRelationship[],
    userId: string,
    entityMap: Map<string, string>,
    context: UserServiceContext,
  ): Promise<void> {
    for (const rel of relationships) {
      if (
        !rel.fromName?.trim() ||
        !rel.fromType?.trim() ||
        !rel.toName?.trim() ||
        !rel.toType?.trim() ||
        !rel.relationshipType?.trim()
      ) {
        this.logger.debug('Skipping relationship with missing required fields', { rel });
        continue;
      }

      const fromId = entityMap.get(this.entityKey(rel.fromType, rel.fromName));
      const toId = entityMap.get(this.entityKey(rel.toType, rel.toName));

      if (!fromId || !toId) {
        this.logger.debug('Skipping relationship: endpoints not in extraction batch', {
          fromName: rel.fromName,
          toName: rel.toName,
        });
        continue;
      }

      const relType = this.relationshipService.resolveType(rel.relationshipType, rel.fromType, rel.toType);

      if (relType == null) {
        this.logger.debug('Skipping relationship with unsupported type for endpoint pair', {
          relationshipType: rel.relationshipType,
          fromType: rel.fromType,
          toType: rel.toType,
        });
        continue;
      }

      try {
        await this.relationshipService.upsert(context, {
          fromNodeId: fromId,
          fromNodeType: rel.fromType,
          toNodeId: toId,
          toNodeType: rel.toType,
          type: relType,
          isBidirectional: rel.bidirectional ?? false,
        });
      } catch (err) {
        this.logger.warn('Failed to upsert relationship', {
          userId,
          fromName: rel.fromName,
          toName: rel.toName,
          type: relType,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Dispatches to the appropriate per-type domain service so its `*.created`
   * event fires (and downstream indexers pick the row up). Returns the
   * resulting entity id, or null if this type can't be persisted from the
   * limited info the LLM emits.
   *
   * person / concept : search-by-name; reuse existing id if matched, else create.
   * place / item     : always create a new row (no name-based dedup yet).
   * event / content  : no-op for now (see TODOs below).
   */
  private async upsertEntity(
    context: UserServiceContext,
    type: string,
    name: string,
    description: string | null,
  ): Promise<string | null> {
    switch (type) {
      case 'person': {
        const matches = await this.personService.search(context, { name });
        const existing = matches.find((p) => p.name?.toLowerCase() === name.toLowerCase());

        if (existing) {
          return existing.id;
        }

        const created = await this.personService.create(context, {
          name,
          description: description ?? undefined,
        });

        return created.id;
      }

      case 'concept': {
        const matches = await this.conceptService.search(context, { name });
        const existing = matches.find((c) => c.name?.toLowerCase() === name.toLowerCase());

        if (existing) {
          return existing.id;
        }

        const created = await this.conceptService.create(context, {
          name,
          description: description ?? undefined,
        });

        return created.id;
      }

      case 'place': {
        const [created] = await this.placeService.create(context, {
          name,
          description: description ?? undefined,
        });

        return created?.id ?? null;
      }

      case 'item': {
        const created = await this.itemService.create(context, {
          name,
          description: description ?? undefined,
        });

        return created.id;
      }

      // TODO: EventService.create requires `title` and a real `start_time: Date`,
      // neither of which the extraction prompt asks for. Either extend the LLM
      // output schema to include those fields, or route events through a
      // separate extraction path.
      case 'event':
        this.logger.debug('Skipping event entity: extraction prompt does not yield start_time', {
          name,
        });

        return null;

      // TODO: ContentService.create requires a `type` subkind (book / film /
      // article / …) that the extraction prompt does not produce. Extend the
      // LLM schema before enabling this branch.
      case 'content':
        this.logger.debug('Skipping content entity: extraction prompt does not yield content type', {
          name,
        });

        return null;

      default:
        return null;
    }
  }

  private entityKey(type: string, name: string): string {
    return `${(type ?? '').toLowerCase()}:${(name ?? '').toLowerCase()}`;
  }

  private parseExtractionResult(content: string): ExtractionResult {
    const empty: ExtractionResult = { entities: [], relationships: [] };

    let text = content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    const brace = text.indexOf('{');
    if (brace > 0) {
      text = text.slice(brace);
    }

    if (!text.endsWith('}')) {
      this.logger.warn('LLM result appears truncated; skipping', {
        preview: content.slice(0, 200),
      });

      return empty;
    }

    try {
      const parsed: unknown = JSON.parse(text);

      if (typeof parsed !== 'object' || parsed === null) {
        return empty;
      }

      const obj = parsed as Record<string, unknown>;

      return {
        entities: Array.isArray(obj['entities']) ? (obj['entities'] as ExtractedEntity[]) : [],
        relationships: Array.isArray(obj['relationships'])
          ? (obj['relationships'] as ExtractedRelationship[])
          : [],
      };
    } catch {
      this.logger.warn('Failed to parse LLM extraction result as JSON', {
        preview: content.slice(0, 300),
      });

      return empty;
    }
  }
}
