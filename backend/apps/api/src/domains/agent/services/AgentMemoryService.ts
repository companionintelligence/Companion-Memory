import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import { PersonService, UserContextService } from '@ci/domains/memory';

import {
  AGENT_MEMORY_CATEGORIES,
  AgentMemoryEntity,
  type AgentMemory,
  type AgentMemoryCategory,
  type AgentMemoryStatus,
} from '../entities/AgentMemoryEntity';
import { AgentMemoryCreatedEvent, AgentMemoryRemovedEvent } from '../events';

export interface CreateAgentMemoryDto {
  /**
   * Caller-supplied primary key. Omitted (the `POST /memory/write` path) a
   * fresh uuid7 is minted. A producer that can be replayed — the chat-turn
   * cron, which re-reads a window it may already have written — passes a
   * deterministic id instead and checks {@link AgentMemoryService.findByIds}
   * first, so a crash between read and write replays into the same row rather
   * than duplicating the fragment.
   */
  id?: string;
  content: string;
  source?: string | null;
  title?: string | null;
  sessionId?: string | null;
  /** Governed atom category (`knowl` pattern). Inferred from content when omitted. */
  category?: AgentMemoryCategory;
  /** Optional ID of a prior memory fragment that this write explicitly supersedes. */
  supersedesId?: string | null;
  /** Optional start of the memory's temporal validity window. */
  validFrom?: Date | null;
  /** Optional end of the memory's temporal validity window. */
  validUntil?: Date | null;
}

export type GovernanceRelation = 'none' | 'supersede' | 'conflict';

export interface MemoryDriftMatch {
  memory: AgentMemory;
  matchedPaths: string[];
  referencedPaths: string[];
  reason: string;
}

export interface MemoryDriftReport {
  checkedCount: number;
  driftedCount: number;
  matches: MemoryDriftMatch[];
}

const PATH_TOKEN_RE =
  /(?:`([^`\n]+?\.[a-z0-9]{1,8})`|(?:\b(?:[\w.-]+\/)+[\w.-]+(?:\.[a-z0-9]{1,8})?\b)|\b([\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|sql|py|md|yml|yaml|sh|graphql))\b)/gi;

function normalizeRepoPath(raw: string): string {
  return raw
    .trim()
    .replace(/^['"`]+|['"`.,;:!?)]+$/g, '')
    .replace(/^\.?\//, '')
    .replace(/\\/g, '/');
}

/**
 * Extract normalized file paths or module paths referenced inside a memory
 * fragment's `content` or `source` (`knowl` evidence-binding pattern).
 */
export function extractReferencedPaths(content: string, source?: string | null): string[] {
  const found = new Set<string>();

  if (source) {
    const cleanSource = normalizeRepoPath(source);
    if (cleanSource.includes('/') || /\.[a-z0-9]{1,8}$/i.test(cleanSource)) {
      found.add(cleanSource);
    }
  }

  for (const match of content.matchAll(PATH_TOKEN_RE)) {
    const candidate = normalizeRepoPath(match[1] ?? match[2] ?? match[0] ?? '');
    if (!candidate || candidate.startsWith('http://') || candidate.startsWith('https://')) {
      continue;
    }

    // Ignore version numbers like "1.0" or "v2.1"
    if (/^v?\d+(?:\.\d+)+$/i.test(candidate)) {
      continue;
    }

    found.add(candidate);
  }

  return [...found];
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'he',
  'her',
  'his',
  'i',
  'in',
  'is',
  'it',
  'its',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'that',
  'the',
  'their',
  'them',
  'they',
  'this',
  'to',
  'user',
  'was',
  'we',
  'were',
  'with',
  'you',
  'your',
]);

const TEMPORAL_PROGRESSION_RE =
  /\b(?:now|currently|moved\s+to|switched\s+(?:to|from)|changed\s+to|no\s+longer|used\s+to|formerly|instead\s+of|updated\s+to|promoted\s+to|relocated\s+to)\b/i;

const NEGATION_RE =
  /\b(?:never|not|no\s+longer|don't|do\s+not|must\s+not|cannot|can't|avoid|forbid|prohibit)\b/i;

/**
 * Classify a memory fragment into one of the 8 governed `knowl` atom categories
 * when the caller does not specify one explicitly.
 */
export function inferMemoryCategory(
  content: string,
  explicit?: AgentMemoryCategory | string | null,
): AgentMemoryCategory {
  if (explicit && (AGENT_MEMORY_CATEGORIES as readonly string[]).includes(explicit)) {
    return explicit as AgentMemoryCategory;
  }

  const text = content.trim();
  if (/\b(?:must\s+not|never|do\s+not|don't|cannot|strictly\s+avoid|constraint|prohibited)\b/i.test(text)) {
    return 'constraint';
  }

  if (
    /\b(?:decided\s+to|decision\b|we\s+chose|agreed\s+to|settled\s+on|will\s+standardize\s+on)/i.test(text)
  ) {
    return 'decision';
  }

  if (/\b(?:goal\b|aims?\s+to|target(?:ing)?\s+to|working\s+toward|objective\s+is|plans?\s+to)/i.test(text)) {
    return 'goal';
  }

  if (/\b(?:prefers?|likes?\s+to|favorite|dislikes?|would\s+rather|preference\b)/i.test(text)) {
    return 'preference';
  }

  if (
    /\b(?:architecture\b|schema|microservice|database\s+table|pipeline|module\s+boundary|endpoint)/i.test(
      text,
    )
  ) {
    return 'architecture';
  }

  if (/\b(?:currently|right\s+now|status\s+is|is\s+currently|active\s+sprint|blocked\s+on)\b/i.test(text)) {
    return 'state';
  }

  if (/\b(?:noticed\s+that|observed\s+that|seems\s+to|appeared\s+to|observation\b)/i.test(text)) {
    return 'observation';
  }

  return 'fact';
}

function contentTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length > 2 && !STOP_WORDS.has(token),
  );
}

/**
 * Extract a normalized `(subject, predicate, value)` signature for slot-based
 * supersession detection (e.g. "User lives in Austin" -> predicate `lives in`,
 * value `austin`).
 */
function extractSlotSignature(text: string): { predicate: string; value: string } | null {
  const cleaned = text
    .trim()
    .replace(/^(?:the\s+user|user|i|he|she|they)\s+/i, '')
    .replace(/^(?:now|currently|still)\s+/i, '')
    .replace(/[.!?]+$/, '');

  const slotPatterns: Array<{ name: string; re: RegExp }> = [
    { name: 'lives_in', re: /^(?:lives|resides|is\s+based)\s+in\s+(.+)$/i },
    { name: 'works_at', re: /^works\s+(?:at|for)\s+(.+)$/i },
    { name: 'role_is', re: /^(?:is\s+a|is\s+an|serves\s+as|works\s+as)\s+(.+)$/i },
    { name: 'uses_primary', re: /^(?:uses|switched\s+to|moved\s+to)\s+(.+)$/i },
    { name: 'prefers', re: /^prefers\s+(.+)$/i },
  ];

  for (const { name, re } of slotPatterns) {
    const match = cleaned.match(re);
    if (match?.[1]) {
      return { predicate: name, value: match[1].trim().toLowerCase() };
    }
  }

  return null;
}

/**
 * Determine whether `incoming` supersedes or conflicts with `existing`.
 *
 * - Returns `'supersede'` when both atoms fill the same singular slot with
 *   different values (e.g. "lives in Austin" -> "now lives in Seattle") or share
 *   a high lexical overlap while `incoming` carries explicit temporal progression
 *   markers (`now`, `switched to`, `no longer`, `moved to`).
 * - Returns `'conflict'` when both atoms share high subject/topic overlap in the
 *   same governed category (`constraint`, `decision`, `fact`, `preference`) and
 *   one negates the other without temporal progression markers.
 */
export function detectSupersessionOrConflict(
  existing: Pick<AgentMemory, 'content' | 'category'>,
  incoming: { content: string; category: AgentMemoryCategory },
): GovernanceRelation {
  if (existing.content.trim().toLowerCase() === incoming.content.trim().toLowerCase()) {
    return 'none';
  }

  const slotA = extractSlotSignature(existing.content);
  const slotB = extractSlotSignature(incoming.content);
  if (slotA && slotB && slotA.predicate === slotB.predicate && slotA.value !== slotB.value) {
    return 'supersede';
  }

  const tokensA = contentTokens(existing.content);
  const tokensB = contentTokens(incoming.content);
  if (tokensA.length === 0 || tokensB.length === 0) {
    return 'none';
  }

  const setB = new Set(tokensB);
  const shared = tokensA.filter((t) => setB.has(t));
  const overlap = shared.length / Math.min(tokensA.length, tokensB.length);

  if (overlap >= 0.5 && TEMPORAL_PROGRESSION_RE.test(incoming.content)) {
    return 'supersede';
  }

  const negA = NEGATION_RE.test(existing.content);
  const negB = NEGATION_RE.test(incoming.content);
  if (overlap >= 0.6 && negA !== negB && !TEMPORAL_PROGRESSION_RE.test(incoming.content)) {
    return 'conflict';
  }

  return 'none';
}

@Injectable()
export class AgentMemoryService {
  constructor(
    @InjectRepository(AgentMemoryEntity)
    private readonly repository: Repository<AgentMemoryEntity>,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
    @Optional() private readonly personService?: PersonService,
    @Optional() private readonly userContextService?: UserContextService,
  ) {
    this.logger.setContext(AgentMemoryService.name);
  }

  async create(context: UserServiceContext, data: CreateAgentMemoryDto): Promise<AgentMemory> {
    const source = data.source ?? null;
    const title = data.title ?? (source ? `[${source}]` : null);
    const category = inferMemoryCategory(data.content, data.category);
    const now = new Date();

    const entity = this.repository.create({
      id: data.id ?? uuidv7(),
      userId: context.userId,
      content: data.content,
      source,
      title,
      sessionId: data.sessionId ?? null,
      category,
      status: 'active' as AgentMemoryStatus,
      supersededById: null,
      validFrom: data.validFrom ?? now,
      validUntil: data.validUntil ?? null,
    });

    const saved = await this.repository.save(entity);

    const governanceEnabled = await this.isGovernanceEnabled(context.userId);
    if (governanceEnabled) {
      await this.applyGovernanceOnWrite(context, saved, data.supersedesId ?? null, now);
    }

    // Index the raw fragment for the recall message channel (naive-RAG half of
    // the hybrid). Async via the search-index queue; the content is carried in
    // the payload because fragments are immutable.
    await this.eventService.send(
      AgentMemoryCreatedEvent,
      {
        memoryId: saved.id,
        userId: saved.userId,
        content: saved.content,
      },
      { queue: 'search-index' },
    );

    return AgentMemoryEntity.toEgressType(saved);
  }

  /**
   * Explicitly supersede an existing memory fragment with a new one.
   */
  async supersede(
    context: UserServiceContext,
    oldMemoryId: string,
    newData: CreateAgentMemoryDto,
  ): Promise<AgentMemory> {
    return this.create(context, { ...newData, supersedesId: oldMemoryId });
  }

  /**
   * Retrieve active (non-superseded) memories for the user, optionally filtered
   * by category and/or evaluated at a point-in-time `asOf` timestamp.
   */
  async findActive(
    context: ServiceContext,
    options: { category?: AgentMemoryCategory; asOf?: Date; take?: number } = {},
  ): Promise<AgentMemory[]> {
    const { category, asOf, take = 50 } = options;

    const rows = await this.repository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
        ...(category ? { category } : {}),
      },
      order: { createdAt: 'DESC' },
      take,
    });

    return rows
      .filter((row) => {
        if (asOf) {
          const fromOk = row.validFrom == null || row.validFrom <= asOf;
          const untilOk = row.validUntil == null || row.validUntil > asOf;

          return fromOk && untilOk;
        }

        return (row.status ?? 'active') !== 'superseded';
      })
      .map(AgentMemoryEntity.toEgressType);
  }

  /**
   * Retrieve memory fragments flagged as `conflicted` so agents or users can
   * reconcile contradictory claims.
   */
  async findConflicts(context: ServiceContext): Promise<AgentMemory[]> {
    const rows = await this.repository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
        status: 'conflicted',
      },
      order: { createdAt: 'DESC' },
    });

    return rows.map(AgentMemoryEntity.toEgressType);
  }

  /**
   * Detect staleness drift between active governed memories and a list of
   * modified repository paths (`knowl` blast-radius / drift verification).
   *
   * Inspects active memory atoms for path or filename references overlapping
   * `changedPaths`. Optionally marks drifted memories as `conflicted` so they
   * appear in the governance review queue (`GET /memory/conflicts`).
   */
  async detectDrift(
    context: ServiceContext,
    changedPaths: string[],
    options: { markConflicted?: boolean } = {},
  ): Promise<MemoryDriftReport> {
    const normalizedChanges = changedPaths.map(normalizeRepoPath).filter((p) => p.length > 0);

    const active = await this.findActive(context, { take: 200 });
    if (normalizedChanges.length === 0 || active.length === 0) {
      return {
        checkedCount: active.length,
        driftedCount: 0,
        matches: [],
      };
    }

    const matches: MemoryDriftMatch[] = [];

    for (const memory of active) {
      const referencedPaths = extractReferencedPaths(memory.content, memory.source);
      if (referencedPaths.length === 0) {
        continue;
      }

      const matchedPaths = normalizedChanges.filter((changed) => {
        const changedLower = changed.toLowerCase();
        const changedBase = changedLower.split('/').pop() ?? changedLower;

        return referencedPaths.some((ref) => {
          const refLower = ref.toLowerCase();
          const refBase = refLower.split('/').pop() ?? refLower;

          return (
            changedLower === refLower ||
            changedLower.endsWith(`/${refLower}`) ||
            refLower.endsWith(`/${changedLower}`) ||
            (changedBase.includes('.') && changedBase === refBase)
          );
        });
      });

      if (matchedPaths.length > 0) {
        matches.push({
          memory,
          matchedPaths,
          referencedPaths,
          reason: `Referenced path(s) modified: ${matchedPaths.join(', ')}`,
        });
      }
    }

    if (options.markConflicted && matches.length > 0 && typeof this.repository.update === 'function') {
      const ids = matches.map((m) => m.memory.id);
      await this.repository.update(
        {
          id: In(ids),
          ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
        },
        { status: 'conflicted' },
      );
      for (const match of matches) {
        match.memory = { ...match.memory, status: 'conflicted' };
      }
    }

    return {
      checkedCount: active.length,
      driftedCount: matches.length,
      matches,
    };
  }

  private async isGovernanceEnabled(userId: string): Promise<boolean> {
    if (!this.userContextService || !this.personService || !userId || typeof userId !== 'string') {
      return true;
    }

    try {
      const selfIdentity = await this.userContextService.getSelfIdentity(userId);
      if (!selfIdentity) {
        return true;
      }

      const self = await this.personService.findById({ userId }, selfIdentity.entityId);
      const planner = (self?.properties?.planner ?? {}) as Record<string, unknown>;

      return planner.memory_governance_enabled !== false;
    } catch {
      return true;
    }
  }

  private async applyGovernanceOnWrite(
    context: UserServiceContext,
    saved: AgentMemoryEntity,
    explicitSupersedesId: string | null,
    now: Date,
  ): Promise<void> {
    if (typeof this.repository.find !== 'function' || typeof this.repository.update !== 'function') {
      return;
    }

    const supersededIds = new Set<string>();
    const conflictedIds = new Set<string>();

    if (explicitSupersedesId && explicitSupersedesId !== saved.id) {
      supersededIds.add(explicitSupersedesId);
    }

    const candidates = await this.repository.find({
      where: {
        userId: context.userId,
        status: 'active',
      },
      order: { createdAt: 'DESC' },
      take: 100,
    });

    for (const candidate of candidates ?? []) {
      if (candidate.id === saved.id || supersededIds.has(candidate.id)) {
        continue;
      }

      const relation = detectSupersessionOrConflict(candidate, {
        content: saved.content,
        category: saved.category ?? 'fact',
      });
      if (relation === 'supersede') {
        supersededIds.add(candidate.id);
      } else if (relation === 'conflict') {
        conflictedIds.add(candidate.id);
      }
    }

    if (supersededIds.size > 0) {
      const ids = [...supersededIds];
      await this.repository.update(
        { id: In(ids), userId: context.userId },
        {
          status: 'superseded',
          supersededById: saved.id,
          validUntil: now,
        },
      );
      for (const id of ids) {
        await this.eventService.send(
          AgentMemoryRemovedEvent,
          { memoryId: id, userId: context.userId },
          { queue: 'search-index' },
        );
      }
    }

    if (conflictedIds.size > 0) {
      const ids = [...conflictedIds];
      await this.repository.update({ id: In(ids), userId: context.userId }, { status: 'conflicted' });
    }
  }

  /**
   * Deletes a single memory fragment (owner-scoped unless SYSTEM_USER is
   * passed) and emits {@link AgentMemoryRemovedEvent} so the search-index
   * listener can reap its 'message' embedding.
   *
   * Fragments have no DB-level FK into ci_search.embeddings, so the embedding
   * is cascade-deleted through this event rather than ON DELETE CASCADE — the
   * delete-side mirror of {@link AgentMemoryService.create}'s created-event.
   * Returns false (and emits nothing) when no matching row exists.
   */
  async remove(context: ServiceContext, memoryId: string): Promise<boolean> {
    const existing = await this.repository.findOne({
      where: {
        id: memoryId,
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
      },
    });

    if (existing == null) {
      return false;
    }

    await this.repository.delete({ id: existing.id });

    await this.eventService.send(
      AgentMemoryRemovedEvent,
      {
        memoryId: existing.id,
        userId: existing.userId,
      },
      { queue: 'search-index' },
    );

    return true;
  }

  /**
   * Most recent fragments for the current user, newest first.
   * Used by the Agent Memory settings UI.
   */
  async findRecent(context: ServiceContext, options: { take?: number } = {}): Promise<AgentMemory[]> {
    const { take = 50 } = options;

    const rows = await this.repository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
      },
      order: { createdAt: 'DESC' },
      take,
    });

    return rows.map(AgentMemoryEntity.toEgressType);
  }

  /**
   * Fragments that have not yet been processed by the compaction cron.
   * Skips very recent writes so burst-written fragments settle before LLM extraction.
   * Pass SYSTEM_USER context to query across all users (cron use case).
   */
  async findUnprocessed(
    context: ServiceContext,
    options: { limit?: number; minAgeMinutes?: number } = {},
  ): Promise<AgentMemory[]> {
    const { limit = 50, minAgeMinutes = 2 } = options;
    const cutoff = new Date(Date.now() - minAgeMinutes * 60 * 1000);

    const rows = await this.repository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
        processedAt: IsNull(),
        createdAt: LessThan(cutoff),
      },
      order: { createdAt: 'ASC' },
      take: limit,
    });

    return rows.map(AgentMemoryEntity.toEgressType);
  }

  /**
   * Stamps processed_at on a batch of memory IDs.
   * Scoped to the context user unless SYSTEM_USER is passed.
   */
  async markProcessed(context: ServiceContext, ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.repository.update(
      {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
      },
      { processedAt: new Date() },
    );
  }

  /**
   * Fetch a batch of memory fragments by id (owner-scoped). Used by the recall
   * message channel to turn message-embedding hits back into their raw text.
   */
  async findByIds(context: ServiceContext, ids: string[]): Promise<AgentMemory[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.repository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
      },
    });

    return rows.map(AgentMemoryEntity.toEgressType);
  }
}
