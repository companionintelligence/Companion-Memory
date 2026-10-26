import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { z } from 'zod/v3';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OllamaService } from '@ci/domains/llm/services/OllamaService';
import { EventEntity, CalendarEventService } from '@ci/domains/memory';
import { PersonalizationService } from '@ci/domains/personalization';
import { SearchService } from '@ci/domains/search-next';

import { ACTIVE_TASK_STATUSES, isClosedTaskStatus } from '../taskStatus';

import { TaskService } from './TaskService';

// 60s, not 15 — same reasoning as InboxScanService.ts's SCAN_TIMEOUT_MS. This
// was the tightest of the three planning-domain LLM budgets; a local model
// under real load needs far more than 15s for a first token, and this
// service shares that failure mode with TodoScanService and InboxScanService
// (all three independently invented their own too-tight abort budget).
//
// The budget presumes the UTILITY tier, and is headroom on top of it rather
// than a substitute for it: a single enum-shaped answer from a small model
// returns in seconds, while on the operator's chat model prompt evaluation
// alone exceeded even 60s. If this call is ever re-pointed at `PROMPT_MODEL`,
// this constant is wrong rather than generous.
export const PROCESS_TIMEOUT_MS = 60_000;

/**
 * Output cap for one suggestion (Ollama `options.num_predict`).
 *
 * A suggestion is a single small object — an enum plus a few short strings —
 * so a legitimate answer is well under this. The cap exists only so a model
 * that starts rambling cannot run until the context window fills, which is
 * generation this caller pays for and then discards.
 */
const PROCESS_MAX_OUTPUT_TOKENS = 600;

/**
 * Keep the utility model resident across the run (Ollama `keep_alive`).
 *
 * This service makes MANY sequential calls per run — one per candidate task —
 * so without this the model can be evicted mid-run and reloaded inside a later
 * call's 15s budget. An hour also spans the every-30-minutes inbox scan, which
 * shares the tier.
 */
const PROCESS_KEEP_ALIVE = '1h';

/**
 * Tasks one run reviews. Each costs an LLM call, so this is a spend cap per
 * tick and not a statement about how many tasks matter.
 */
export const PROCESS_BATCH_SIZE = 40;

/**
 * Ceiling on the pool {@link PROCESS_BATCH_SIZE} rotates through. Bounded
 * because this is still one unpaginated query; a user past this many ACTIVE
 * tasks loses the tail of the ordering, which is the old behaviour rather than
 * a new one.
 */
const PROCESS_CANDIDATE_CAP = 400;

/** The todoProcess cron's six-hour interval, used only to index the rotation. */
const PROCESS_INTERVAL_MS = 6 * 60 * 60 * 1000;

const CANCEL_PHRASES = [
  'cancelled',
  'canceled',
  "didn't make",
  'did not make',
  'could not attend',
  "couldn't attend",
] as const;

const DONE_PHRASES = ['finished', 'completed', 'done with', 'got it done', 'wrapped up'] as const;

/**
 * Words too common to attribute a recall hit to one specific block or task.
 * Without this, a one-token overlap on "the" makes every hit "about" everything.
 */
const TITLE_STOPWORDS = new Set([
  'and',
  'are',
  'for',
  'from',
  'get',
  'got',
  'has',
  'have',
  'into',
  'its',
  'not',
  'our',
  'out',
  'that',
  'the',
  'this',
  'was',
  'were',
  'with',
  'you',
  'your',
]);

/** How long before a block starts a cancellation notice can plausibly arrive. */
const CANCEL_LOOKBEHIND_MS = 24 * 60 * 60 * 1000;

/**
 * Confidence for completion evidence that names the task AND postdates the
 * block. Deliberately BELOW `PersonalizationService`'s
 * `TASK_COMPLETE_AUTO_PROMOTE_THRESHOLD_BALANCED` (0.85): balanced is the
 * default (and the fallback when no self identity exists), so a user who
 * never touched the trust dial gets a confirmation rather than a silent
 * complete + calendar overwrite. Only hands_off (0.7) auto-applies it. This is
 * a dedicated threshold, not the shared `autoPromoteThresholdBalanced` (0.55)
 * used for reflection answers — see that constant's doc comment for why.
 */
const ATTRIBUTED_DONE_CONFIDENCE = 0.8;

/** Nothing attributable — surfaced as a "did this get done?" question only. */
const UNVERIFIED_DONE_CONFIDENCE = 0.55;

const suggestionSchema = z.object({
  action: z.enum(['none', 'append', 'revise', 'reparent', 'complete']),
  confidence: z.number().optional(),
  notes: z.string().optional(),
  title: z.string().optional(),
  parentTitle: z.string().optional(),
  rationale: z.string().optional(),
});

/**
 * The same shape as {@link suggestionSchema}, sent to the backend so generation
 * is grammar-constrained rather than merely asked to be JSON.
 *
 * `format: 'json'` alone only buys syntactic validity — the model stays free to
 * invent key names or return a value outside the `action` enum, and a small
 * model reliably does. Every such answer fails `suggestionSchema.safeParse`,
 * which returns null and is indistinguishable downstream from "the model saw
 * nothing to do", so the task is silently left untouched.
 *
 * That was survivable while this call was aimed at a large model, because a
 * large model mostly guesses the keys right. It is NOT survivable now that the
 * call runs on the utility tier: the shape has to be enforced rather than
 * requested. The two must ship together — moving the model without this turns a
 * loud timeout into a silent no-op, which is strictly harder to notice.
 *
 * Kept beside `suggestionSchema` deliberately: the `action` values are the
 * contract with `applySuggestion`, so a value added there and not here is a
 * suggestion the model can never make.
 */
const SUGGESTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['none', 'append', 'revise', 'reparent', 'complete'] },
    confidence: { type: 'number' },
    notes: { type: 'string' },
    title: { type: 'string' },
    parentTitle: { type: 'string' },
    rationale: { type: 'string' },
  },
  required: ['action'],
};

type RecallHit = {
  type: string;
  title: string;
  snippet: string;
  /** Lowercased title + snippet; the only text keyword signals may look at. */
  text: string;
  occurredAt: Date | null;
};

/**
 * SearchService.search() only returns `{ id, type }` — no name/snippet — so
 * the raw hits are hydrated against `ci.entities` the same way
 * TodoScanService.memoryBlock() does. `occurred_at` comes from the CTI detail
 * row where one exists, so callers can bound evidence in time; `created_at`
 * (ingest time) is only a last resort and is not a substitute for it.
 */
async function recallHits(
  dataSource: DataSource,
  searchService: SearchService,
  context: UserServiceContext,
  query: string,
  maxResults: number,
): Promise<RecallHit[]> {
  try {
    const results = await searchService.search(context, {
      query,
      mode: 'boosted',
      maxResults,
    });

    const hits = results ?? [];

    if (hits.length === 0) {
      return [];
    }

    const ids = hits.map((hit) => hit.id);
    const rows = (await dataSource.query(
      `SELECT entity.entity_id::text AS id, entity.entity_type, entity.name,
              left(coalesce(entity.description, ''), 400) AS snippet,
              COALESCE(communication.time, event.start_time, entity.created_at) AS occurred_at
         FROM ci.entities entity
         LEFT JOIN ci.communications communication ON communication.id = entity.entity_id
         LEFT JOIN ci.events event ON event.event_id = entity.entity_id
        WHERE entity.entity_id = ANY($1::uuid[])
          AND entity.owner_user_id = $2::uuid`,
      [ids, context.userId],
    )) as Array<{
      id: string;
      entity_type: string;
      name: string | null;
      snippet: string | null;
      occurred_at: Date | string | null;
    }>;

    const byId = new Map(rows.map((row) => [row.id, row]));

    return hits
      .map((hit): RecallHit | null => {
        const row = byId.get(hit.id);
        const title = row?.name?.trim() ?? '';
        const snippet = row?.snippet?.trim() ?? '';

        if (!title && !snippet) {
          return null;
        }

        return {
          type: row?.entity_type ?? hit.type,
          title,
          snippet,
          text: `${title}\n${snippet}`.toLowerCase(),
          occurredAt: toDate(row?.occurred_at),
        };
      })
      .filter((hit): hit is RecallHit => hit != null);
  } catch {
    return [];
  }
}

function formatRecall(hits: RecallHit[]): string {
  return hits
    .map((hit) => [`${hit.type}: ${hit.title || '(untitled)'}`, hit.snippet].filter(Boolean).join('\n'))
    .join('\n---\n');
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The slice of the candidate pool this run reviews.
 *
 * `findAll` orders by `due_at ASC NULLS LAST`, then priority, then created_at,
 * and an overdue date never advances — so a bare `LIMIT 40` handed every tick
 * the SAME forty rows. A user with 45 active tasks had five that were never
 * reviewed at all: no append, no revise, no reparent, ever, for as long as the
 * forty ahead of them stayed active. Nothing said so either, because `applied`
 * and `pending` only count what the run did look at.
 *
 * The window index comes from the clock rather than from a counter on this
 * instance on purpose: the worker restarts, and a counter restarts with it back
 * at the same forty rows. Ticks six hours apart therefore land on consecutive
 * windows without any state to keep.
 *
 * Wrapping (rather than a short final window) keeps every run's batch the same
 * size, so the rotation costs no throughput.
 */
function rotateBatch<T>(candidates: T[], size: number, now: number): T[] {
  if (candidates.length <= size) {
    return candidates;
  }

  const windows = Math.ceil(candidates.length / size);
  const offset = (Math.floor(now / PROCESS_INTERVAL_MS) % windows) * size;

  return [...candidates, ...candidates].slice(offset, offset + size);
}

/**
 * Tokens distinctive enough to say a recall hit is ABOUT this title. Returning
 * `[]` (all-stopword or too short) means "not attributable" — callers must not
 * act on evidence they cannot tie to the thing they are about to mutate.
 */
function distinctiveTokens(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 3 && !TITLE_STOPWORDS.has(token)),
    ),
  ].slice(0, 8);
}

/**
 * Attribution, not retrieval: boostedKeywordSearch OR-joins its terms, so a
 * shared result set says nothing about which hit belongs to which block. A hit
 * counts only if it names every distinctive token of that one title.
 */
function mentions(hit: RecallHit, tokens: string[]): boolean {
  return tokens.length > 0 && tokens.every((token) => hit.text.includes(token));
}

function hasPhrase(hit: RecallHit, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => hit.text.includes(phrase));
}

function occurredWithin(hit: RecallHit, from: Date, to: Date): boolean {
  if (!hit.occurredAt) {
    return false;
  }

  const at = hit.occurredAt.getTime();

  return at >= from.getTime() && at <= to.getTime();
}

/**
 * Reviews open tasks against recent memory and either applies high-confidence
 * mutations or queues a Plan-page confirmation (`task_mutate` / `task_complete`).
 */
@Injectable()
export class TodoProcessService {
  constructor(
    private readonly taskService: TaskService,
    private readonly searchService: SearchService,
    private readonly ollamaService: OllamaService,
    private readonly personalizationService: PersonalizationService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(TodoProcessService.name);
  }

  async runForUser(userId: string): Promise<{ applied: number; pending: number }> {
    const context = { userId } as UserServiceContext;
    const tallies = { applied: 0, pending: 0 };

    const tasks = rotateBatch(
      await this.taskService.findAll(context, {
        status: [...ACTIVE_TASK_STATUSES],
        limit: PROCESS_CANDIDATE_CAP,
      }),
      PROCESS_BATCH_SIZE,
      Date.now(),
    );

    for (const task of tasks) {
      try {
        const block = formatRecall(
          await recallHits(
            this.dataSource,
            this.searchService,
            context,
            `${task.title} ${task.description ?? ''}`.trim(),
            8,
          ),
        );

        if (!block.trim()) {
          continue;
        }

        const suggestion = await this.suggest(context, task.title, block);

        if (!suggestion || suggestion.action === 'none') {
          continue;
        }

        const confidence = clampConfidence(suggestion.confidence);
        const kind = suggestion.action === 'complete' ? 'task_complete' : 'task_mutate';
        const decision = await this.personalizationService.decideAction(userId, { kind, confidence });

        if (decision === 'skip') {
          continue;
        }

        if (suggestion.action === 'complete') {
          if (decision === 'auto') {
            await this.taskService.complete(context, task.id);
            tallies.applied += 1;
          } else {
            await this.taskService.createPendingChange(context, {
              taskId: task.id,
              kind: 'complete',
              patch: {},
              rationale: suggestion.rationale ?? 'Looks like this may be done.',
              confidence,
            });
            tallies.pending += 1;
          }

          continue;
        }

        const patch: Record<string, unknown> = {};

        if (suggestion.action === 'append' && suggestion.notes?.trim()) {
          patch.appendNotes = suggestion.notes.trim();
        }

        if (suggestion.action === 'revise' && suggestion.title?.trim()) {
          patch.title = suggestion.title.trim();
        }

        if (suggestion.action === 'reparent' && suggestion.parentTitle?.trim()) {
          const parent = await this.taskService.findByTitleMatch(context, suggestion.parentTitle);

          if (parent && parent.id !== task.id) {
            patch.parentId = parent.id;
          }
        }

        if (Object.keys(patch).length === 0) {
          continue;
        }

        if (decision === 'auto') {
          if (typeof patch.appendNotes === 'string') {
            await this.taskService.appendNotes(context, task.id, patch.appendNotes);
          }

          const { appendNotes: _a, ...rest } = patch;

          if (Object.keys(rest).length > 0) {
            await this.taskService.update(context, task.id, rest);
          }

          tallies.applied += 1;
        } else {
          await this.taskService.createPendingChange(context, {
            taskId: task.id,
            kind: 'mutate',
            patch,
            rationale: suggestion.rationale ?? 'Suggested update from memory.',
            confidence,
          });
          tallies.pending += 1;
        }
      } catch (err) {
        // Same reasoning as TodoScanService: one task's failure must not force
        // pg-boss to redeliver the whole job and re-walk the tasks already
        // reviewed above. A reparent whose target was deleted between
        // findByTitleMatch and update throws NotFoundException out of the loop,
        // and the remaining tasks would then wait a full 6-hour tick.
        this.logger.warn('Todo process task failed; continuing with remaining tasks', {
          userId,
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.log('Todo process finished', { userId, ...tallies });

    return tallies;
  }

  private async suggest(
    context: UserServiceContext,
    title: string,
    memoryBlock: string,
  ): Promise<z.infer<typeof suggestionSchema> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROCESS_TIMEOUT_MS);

    try {
      const prompt = [
        `Task: ${title}`,
        'Given the memory below, decide one action: none | append | revise | reparent | complete.',
        'Return JSON: {"action":"...","confidence":0-1,"notes":"...","title":"...","parentTitle":"...","rationale":"..."}',
        '',
        memoryBlock.slice(0, 4000),
      ].join('\n');

      const response = await this.ollamaService.chat(context as never, [{ role: 'user', content: prompt }], {
        tier: 'utility',
        enableTools: false,
        format: SUGGESTION_JSON_SCHEMA,
        signal: controller.signal,
        maxOutputTokens: PROCESS_MAX_OUTPUT_TOKENS,
        keepAlive: PROCESS_KEEP_ALIVE,
      });

      const parsed = suggestionSchema.safeParse(JSON.parse(response.message.content || '{}'));

      return parsed.success ? parsed.data : null;
    } catch (err) {
      this.logger.warn('Todo process LLM failed', {
        error: err instanceof Error ? err.message : String(err),
      });

      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * When planned blocks enter "the now", propose revising them from stream
 * evidence (cancel / rewrite) under `event_revise` trust gates.
 *
 * This pass never cancels a block itself, in any trust mode. Recall is keyword
 * retrieval over a shared corpus: it can show that SOMETHING was cancelled near
 * this block's words, never that THIS block was — "the meeting about the
 * cancelled project" reads identically to "the meeting was cancelled". A
 * wrongly cancelled block disappears from the calendar silently, so the
 * strongest evidence available here only earns a Plan-page confirmation.
 */
@Injectable()
export class EventNowService {
  constructor(
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    private readonly eventService: CalendarEventService,
    private readonly taskService: TaskService,
    private readonly searchService: SearchService,
    private readonly personalizationService: PersonalizationService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EventNowService.name);
  }

  async runForUser(userId: string): Promise<{ proposed: number }> {
    const context = { userId } as UserServiceContext;
    const tallies = { proposed: 0 };
    const now = new Date();
    const windowStart = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const blocks = await this.eventRepository
      .createQueryBuilder('event')
      .where('event.user_id = :userId', { userId })
      .andWhere('event.event_type = :type', { type: 'planned_block' })
      .andWhere('event.is_deleted = false')
      .andWhere('event.status IN (:...statuses)', { statuses: ['planned', 'tentative', 'confirmed'] })
      .andWhere('event.start_time BETWEEN :windowStart AND :windowEnd', { windowStart, windowEnd })
      .orderBy('event.start_time', 'ASC')
      .limit(20)
      .getMany();

    if (blocks.length === 0) {
      return tallies;
    }

    // A block's title lives on the CTI base row (ci.entities.name) — EventEntity
    // has no title column, and PlannedBlockService.placeAt writes metadata as
    // exactly { generator, taskId }.
    const events = await this.eventService.findByIds(
      context,
      blocks.map((block) => block.id),
    );
    const titles = new Map(
      events
        .filter((event): event is NonNullable<typeof event> => event != null)
        .map((event) => [event.id, event.title?.trim() ?? '']),
    );

    for (const block of blocks) {
      if (!block.taskId) {
        continue;
      }

      try {
        const title = titles.get(block.id) ?? '';
        const tokens = distinctiveTokens(title);

        if (tokens.length === 0) {
          continue;
        }

        const hits = await recallHits(this.dataSource, this.searchService, context, title, 6);
        const from = new Date(block.startTime.getTime() - CANCEL_LOOKBEHIND_MS);
        const evidence = hits.filter(
          (hit) => hasPhrase(hit, CANCEL_PHRASES) && mentions(hit, tokens) && occurredWithin(hit, from, now),
        );

        if (evidence.length === 0) {
          continue;
        }

        const confidence = evidence.length > 1 ? 0.75 : 0.6;
        const decision = await this.personalizationService.decideAction(userId, {
          kind: 'event_revise',
          confidence,
        });

        if (decision === 'skip') {
          continue;
        }

        // Same reasoning as VerifyDoneService's `complete` guard: a declined
        // row leaves the `pending` set createPendingChange de-dupes against, so
        // without this the ±2h window re-files the identical "was this
        // cancelled?" prompt on every hourly tick it still covers. Bounded by
        // `from` — the earliest moment a cancellation notice for THIS block
        // could have arrived — so it is the same window the evidence is drawn
        // from, and a later block asks again.
        if (await this.taskService.hasDeclinedChangeSince(context, block.taskId, 'event_revise', from)) {
          continue;
        }

        await this.taskService.createPendingChange(context, {
          taskId: block.taskId,
          kind: 'event_revise',
          patch: { eventStatus: 'cancelled', eventId: block.id },
          rationale: `Memory suggests "${title}" may have been cancelled: ${describeEvidence(evidence[0])}`,
          confidence,
        });
        tallies.proposed += 1;
      } catch (err) {
        // Same reasoning as TodoScanService: one block's failure must not force
        // pg-boss to redeliver the whole job and re-walk the blocks above.
        // createPendingChange is idempotent per (task, kind), so the skipped
        // block is simply picked up by the next hourly tick.
        this.logger.warn('Event-now block failed; continuing with remaining blocks', {
          userId,
          eventId: block.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.log('Event-now pass finished', { userId, ...tallies });

    return tallies;
  }
}

/**
 * After a scheduled block ends, look for completion evidence and ask on Plan
 * (`task_complete`) — or auto-close, but only for evidence that names the task
 * and postdates the block, and only under a trust mode that auto-applies below
 * {@link ATTRIBUTED_DONE_CONFIDENCE}.
 */
@Injectable()
export class VerifyDoneService {
  constructor(
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    private readonly taskService: TaskService,
    private readonly searchService: SearchService,
    private readonly personalizationService: PersonalizationService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(VerifyDoneService.name);
  }

  async runForUser(userId: string): Promise<{ completed: number; pending: number }> {
    const context = { userId } as UserServiceContext;
    const tallies = { completed: 0, pending: 0 };
    const now = new Date();
    const lookback = new Date(now.getTime() - 36 * 60 * 60 * 1000);

    const blocks = await this.eventRepository
      .createQueryBuilder('event')
      .where('event.user_id = :userId', { userId })
      .andWhere('event.task_id IS NOT NULL')
      .andWhere('event.is_deleted = false')
      // COALESCE for the same reason dailyAggregateSql.ts does it on this
      // column: `status NOT IN (...)` is three-valued, so a NULL-status row
      // evaluates to NULL and WHERE discards it. A block written before
      // `ci.events.status` was backfilled would then never be verified — and
      // "no status" is the one value that certainly does not mean done.
      .andWhere("COALESCE(event.status, '') NOT IN (:...doneStatuses)", {
        doneStatuses: ['cancelled', 'completed', 'skipped', 'no_show'],
      })
      .andWhere('COALESCE(event.end_time, event.start_time) < :now', { now })
      .andWhere('COALESCE(event.end_time, event.start_time) > :lookback', { lookback })
      .orderBy('event.start_time', 'DESC')
      .limit(30)
      .getMany();

    for (const block of blocks) {
      if (!block.taskId) {
        continue;
      }

      try {
        const task = await this.taskService.findById(context, block.taskId);

        if (!task || isClosedTaskStatus(task.status)) {
          continue;
        }

        // The query is the task's own words ONLY. Asking memory for "did I finish
        // or complete X" retrieves entities BECAUSE they contain finish/complete,
        // so a doneSignal over those hits is circular — it re-reads the terms the
        // retrieval selected for, and any "your order has been completed" mail
        // satisfies it.
        const tokens = distinctiveTokens(task.title);
        const hits = tokens.length
          ? await recallHits(this.dataSource, this.searchService, context, task.title, 6)
          : [];
        const evidence = hits.filter(
          (hit) =>
            hasPhrase(hit, DONE_PHRASES) &&
            mentions(hit, tokens) &&
            occurredWithin(hit, block.startTime, now),
        );
        const doneSignal = evidence.length > 0;

        const confidence = doneSignal ? ATTRIBUTED_DONE_CONFIDENCE : UNVERIFIED_DONE_CONFIDENCE;
        const decision = await this.personalizationService.decideAction(userId, {
          kind: 'task_complete',
          confidence,
        });

        if (decision === 'auto' && doneSignal) {
          await this.taskService.complete(context, task.id);
          block.status = 'completed';
          await this.eventRepository.save(block);
          tallies.completed += 1;
        } else if (decision === 'review' || (decision === 'auto' && !doneSignal)) {
          // A dismissal has to outlive the tick that produced the prompt.
          // `createPendingChange` de-dupes only against a row that is still
          // `pending`, so declining moved the row OUT of the set that was
          // suppressing it and the next tick filed the identical question —
          // roughly 36 more times before the block aged out of the lookback.
          // Reading the declined history here is the same discipline
          // PersonLinkStage applies to a `rejected` disposition: the producer
          // honours the verdict rather than the writer remembering to.
          //
          // Bounded by the block's own end so this suppresses this occurrence
          // only; a later block for the same task asks again.
          const blockEnd = block.endTime ?? block.startTime;

          if (await this.taskService.hasDeclinedChangeSince(context, task.id, 'complete', blockEnd)) {
            continue;
          }

          await this.taskService.createPendingChange(context, {
            taskId: task.id,
            kind: 'complete',
            patch: { eventId: block.id },
            rationale: doneSignal
              ? `Looks like this got done — confirm to mark complete? ${describeEvidence(evidence[0])}`
              : 'This scheduled item passed. Did it get done?',
            confidence,
          });
          tallies.pending += 1;
        }
      } catch (err) {
        // Same reasoning as TodoScanService: one block's failure must not force
        // pg-boss to redeliver the whole job and re-walk the blocks above. Both
        // outcomes here are idempotent on a later tick (complete() keeps the
        // original instant, createPendingChange upserts per (task, kind)).
        this.logger.warn('Verify-done block failed; continuing with remaining blocks', {
          userId,
          eventId: block.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.log('Verify-done pass finished', { userId, ...tallies });

    return tallies;
  }
}

function describeEvidence(hit: RecallHit): string {
  const detail = hit.title || hit.snippet;

  return `"${detail.length > 120 ? `${detail.slice(0, 119)}…` : detail}"`;
}

function clampConfidence(value: number | undefined): number {
  if (value == null || Number.isNaN(value)) {
    return 0.75;
  }

  return Math.min(1, Math.max(0, value));
}
