import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { z } from 'zod';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OllamaService } from '@ci/domains/llm/services/OllamaService';
import { CommunicationEntity } from '@ci/domains/memory';
import { PersonalizationService } from '@ci/domains/personalization';

import {
  SCAN_DEDUP_LIMIT,
  SCAN_DEDUP_STATUSES,
  claimedSourceIds,
  findSimilarTitle,
  formatAlreadyTracked,
  newerDuplicateIds,
} from '../engine/taskTitleSimilarity';
import type { Task } from '../entities/TaskEntity';

import { PlannedBlockService } from './PlannedBlockService';
import { ProposedTaskReconcileService } from './ProposedTaskReconcileService';
import { TaskService } from './TaskService';

const MAX_MESSAGES = 30;
const MAX_SURFACED = 12;
/**
 * Width of the scan window. NOT its position — see {@link InboxScanService.scanAnchor}.
 *
 * History, because the same bug has now been "fixed" twice by widening this
 * number and it does not work: the window was 3 days, found nothing on every
 * run against a real 432k-message import (newest message over two months old),
 * and was widened to 30 days. Re-measured on the live appliance 2026-08-30 the
 * 30-day window was ALSO empty — the exact predicate this service issues
 * (`direction='inbound'`, type in email/sms/chat, not archived,
 * `time >= now() - 30d`) returned 0 rows, so ~48 scans a day short-circuited
 * before the model was ever called.
 *
 * Widening again does not fix it, and that is the whole point. A personal-data
 * export is STATIC: its newest message is whenever the export was taken and
 * never advances, while `now()` does. So `time >= now() - N` is empty for every
 * N smaller than the corpus's age, and any N you pick goes empty again on the
 * day the corpus becomes older than it. The cliff moves; it does not go away.
 * The anchor was the bug, not the width — so this constant stays 30 days (a
 * "recent inbox" triage, not a full-history scan; that is extract_graph's job)
 * and `scanAnchor` moves the window onto the corpus instead.
 */
export const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
// 60s, not 20. `PROMPT_MODEL` is whatever local model the operator configured
// — on real hardware that can be a 30B+ parameter model with no GPU
// acceleration, and 20s is not enough to reliably get a first token, let
// alone a full JSON response, from one of those. A too-tight budget doesn't
// corrupt anything (a timeout degrades to "propose nothing this cycle," see
// the docstring on surfaceItems below) but it does mean the feature can go
// quiet indefinitely on exactly the hardware most likely to need a generous
// budget. 60s is not a promise every model responds in time; it is a
// deliberately generous ceiling so a real answer is not thrown away for
// arriving in 25s instead of 20.
export const SCAN_TIMEOUT_MS = 60_000;

/**
 * Output cap for the scan turn (Ollama `options.num_predict`).
 *
 * Ported verbatim in intent from `TodoScanService`, whose comments record why
 * the 60s budget above is not on its own a budget the call can meet: a bounded
 * `items` array does not bound GENERATION, so an uncapped model runs until the
 * context window fills and the caller aborts first. Set well above a full
 * {@link MAX_SURFACED}-item answer so it truncates only runaway generation.
 */
const SCAN_MAX_OUTPUT_TOKENS = 1_500;

/**
 * Keep the utility model resident (Ollama `keep_alive`).
 *
 * `TodoScanService`'s SCAN_KEEP_ALIVE comment already picked an hour partly FOR
 * this service — "`InboxScanService` runs every 30 minutes ... an hour keeps it
 * warm across that traffic" — but this file never actually passed the value, so
 * every 30-minute run could pay a cold load inside its 60s budget. This closes
 * that gap rather than inventing a new policy; keep the two in step.
 */
const SCAN_KEEP_ALIVE = '1h';
const INBOX_TYPES = ['email', 'sms', 'chat'];

const itemSchema = z.object({
  title: z.string(),
  detail: z.string().optional(),
  confidence: z.number().optional(),
  estimatedMinutes: z.number().optional(),
  sourceIndex: z.number().int().positive().optional(),
});

const responseSchema = z.object({
  items: z.array(z.unknown()),
});

const RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      // The grammar this schema compiles to is what actually constrains
      // generation, so an unbounded array licenses the model to keep emitting
      // entries indefinitely — and only MAX_SURFACED are ever used downstream
      // (see the `.slice(0, MAX_SURFACED)` in runForUser). Enforcement is the
      // SERVER's, not this client's; `TodoScanService` verified rather than
      // assumed it (a `maxItems: 2` schema returned exactly two, then stopped
      // with `done_reason: stop`).
      maxItems: MAX_SURFACED,
      items: {
        type: 'object',
        properties: {
          // Bounded so SCAN_MAX_OUTPUT_TOKENS is provably above a full answer
          // rather than merely believed to be: MAX_SURFACED items at these
          // lengths is roughly 900 tokens against a 1,500 cap. Unbounded
          // strings make that arithmetic impossible and put a legitimate answer
          // at risk of the `done_reason === 'length'` truncation handled in
          // surfaceItems. Both are generous for what the UI shows — a task
          // title and a one-line note.
          title: { type: 'string', maxLength: 120 },
          detail: { type: 'string', maxLength: 200 },
          confidence: { type: 'number' },
          estimatedMinutes: { type: 'number' },
          sourceIndex: { type: 'integer' },
        },
        required: ['title'],
      },
    },
  },
  required: ['items'],
};

/**
 * Triage recent inbound communications into tasks (CI-Planning `ingest_gmail`
 * / possibles, but writing `ci.tasks` directly). Email stays review-gated in
 * cautious/balanced; hands-off may auto-add and auto-place.
 */
@Injectable()
export class InboxScanService {
  constructor(
    @InjectRepository(CommunicationEntity)
    private readonly communicationRepository: Repository<CommunicationEntity>,
    private readonly taskService: TaskService,
    private readonly ollamaService: OllamaService,
    private readonly personalizationService: PersonalizationService,
    private readonly plannedBlockService: PlannedBlockService,
    private readonly proposedReconcile: ProposedTaskReconcileService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(InboxScanService.name);
  }

  /**
   * Fingerprint of the candidate set this service last handed to the model, per
   * user. See the gate in {@link runForUser} for why it exists; see
   * `PersonalizationService.profileCache` for the same in-memory-per-user shape.
   *
   * Deliberately NOT persisted. It is a cost/loop damper, not a ledger: the
   * durable record of "we already looked at this message" is
   * `metadata.sourceCommunicationId` on `ci.tasks`. A restart (or a second
   * worker process) costs one extra model call per user, which is bounded and
   * harmless; a persisted gate would be a schema commitment for no extra safety.
   */
  private readonly lastSurfacedCandidates = new Map<string, string>();

  async runForUser(
    userId: string,
  ): Promise<{ created: number; proposed: number; placed: number; redated: number; archived: number }> {
    const context = { userId } as UserServiceContext;
    const tallies = { created: 0, proposed: 0, placed: 0, redated: 0, archived: 0 };

    // Position the window on the corpus, not on the wall clock — see LOOKBACK_MS.
    const anchor = await this.scanAnchor(userId);
    const since = anchor == null ? null : new Date(anchor.getTime() - LOOKBACK_MS);

    const messages =
      since == null
        ? []
        : await this.communicationRepository
            .createQueryBuilder('comm')
            .where('comm.user_id = :userId', { userId })
            .andWhere('comm.direction = :direction', { direction: 'inbound' })
            .andWhere('comm.communication_type IN (:...types)', { types: INBOX_TYPES })
            .andWhere('comm.time >= :since', { since })
            .andWhere('comm.is_archived = false')
            .orderBy('comm.time', 'DESC')
            // TOTAL ORDER, not cosmetics. `time DESC` alone is a PARTIAL order:
            // Postgres may return tied rows in any order, and the order it picks
            // depends on the plan (index vs seq scan vs parallel workers), which
            // ANALYZE, VACUUM or a single HOT update can change under an
            // otherwise unchanging corpus. Two consequences, both fatal to the
            // idempotency gate below:
            //
            //   - the fingerprint's input reorders, so the gate misses and the
            //     model is asked again — every 30 minutes, forever;
            //   - worse, a tie group STRADDLING `LIMIT MAX_MESSAGES` changes the
            //     candidate SET itself, so the two runs really are looking at
            //     different messages.
            //
            // Not hypothetical on this corpus: the live 30-day window holds 58
            // rows with three timestamp ties inside the top 30 (rows 5/6, 14/15,
            // 16/17), and the inbound corpus at large has tie groups up to 17
            // rows — comfortably wide enough to straddle the limit. `id` is the
            // surrogate uuid primary key, so (time, id) is unique and the order
            // is now fully determined.
            .addOrderBy('comm.id', 'DESC')
            .limit(MAX_MESSAGES)
            .getMany();

    if (messages.length === 0) {
      this.logger.debug('Inbox scan found no recent inbound messages', { userId });
      const sweep = await this.sweepStale(context, []);

      return { ...tallies, ...sweep };
    }

    const tracked = await this.collapseDuplicateProposed(
      context,
      await this.taskService.findAll(context, {
        status: [...SCAN_DEDUP_STATUSES],
        limit: SCAN_DEDUP_LIMIT,
      }),
    );
    const claimedComms = claimedSourceIds(tracked, 'sourceCommunicationId');
    const fresh = messages.filter((message) => !claimedComms.has(message.id));

    if (fresh.length === 0) {
      this.logger.debug('Inbox scan found no unprocessed inbound messages', {
        userId,
        seen: messages.length,
      });
      const sweep = await this.sweepStale(context, proposedTitles(tracked, 'inbox'));

      return { ...tallies, ...sweep };
    }

    // IDEMPOTENCY GATE. Anchoring the window (above) turns this job from "0
    // rows, no-op" into one that actually asks the model — every 30 minutes,
    // forever, with an unchanging candidate set, because a static corpus makes
    // `ORDER BY time DESC LIMIT 30` a CONSTANT. The only thing that removes a
    // message from the next run's prompt is `claimedComms`, and that is
    // populated solely from `metadata.sourceCommunicationId`, which is only
    // written when the model happens to emit a `sourceIndex`. So on the likely
    // common answer — `{"items":[]}` — nothing is claimed and the identical
    // prompt is re-sent 48 times a day forever.
    //
    // Title similarity is NOT an adequate backstop for that. `tracked` is
    // capped at SCAN_DEDUP_LIMIT and ordered `due_at ASC NULLS LAST`, so past
    // 300 rows the oldest-due tasks occupy every slot and recent proposals fall
    // OUT of the dedup set — a self-sustaining proposal loop. This gate closes
    // it structurally instead: identical question over an identical corpus, so
    // do not ask again.
    //
    // Bound: the model is consulted at most TWICE per distinct candidate set
    // per process. Run 1 asks and records the fingerprint. If items carried a
    // sourceIndex, run 2's `fresh` is strictly smaller (the claims are durable
    // in ci.tasks), so its fingerprint differs, it asks once more, and run 3
    // sees a stable set and skips. If nothing was claimed, run 2 already
    // matches and skips. A genuinely new inbound message changes the
    // fingerprint and correctly re-arms the scan.
    //
    // The gate is ARMED at the very end of this method, not here and not when
    // the model answers — see the comment at the `set()` for why the difference
    // matters. A failure anywhere in between simply costs one more model call
    // on the retry, which is the cheap side of the trade.
    const fingerprint = candidateFingerprint(fresh);

    if (this.lastSurfacedCandidates.get(userId) === fingerprint) {
      this.logger.debug('Inbox scan candidate set unchanged since last run; skipping the model', {
        userId,
        candidates: fresh.length,
      });
      // Sweep with the live proposal titles, exactly like the `fresh.length ===
      // 0` branch above. Sweeping with [] here would mass-archive the user's
      // own still-relevant proposals every 30 minutes.
      const sweep = await this.sweepStale(context, proposedTitles(tracked, 'inbox'));

      return { ...tallies, ...sweep };
    }

    const block = fresh
      .map((message, index) => formatMessage(message, index + 1))
      .join('\n---\n')
      .slice(0, 8000);

    const surfaced = await this.surfaceItems(context, block, tracked);

    if (surfaced == null) {
      this.logger.log('Inbox scan finished', { userId, ...tallies, skippedReconcile: true });

      return tallies;
    }

    const sweep = await this.sweepStale(
      context,
      surfaced.length > 0 ? surfaced.map((item) => item.title) : proposedTitles(tracked, 'inbox'),
    );
    tallies.redated = sweep.redated;
    tallies.archived = sweep.archived;

    const proposedWindow = await this.proposedReconcile.windowForToday(context);
    const acceptedThisRun: string[] = [];
    const claimedThisRun = new Set<string>();

    for (const item of surfaced.slice(0, MAX_SURFACED)) {
      const title = item.title.trim();

      if (!title) {
        continue;
      }

      try {
        const confidence = clampConfidence(item.confidence);
        const sourceRef = TaskService.memoryScanSourceRef(title, 'inbox');
        const source = sourceOf(item.sourceIndex, fresh);
        const existing =
          (await this.taskService.findBySourceRef(context, 'inbox', sourceRef)) ??
          (await this.taskService.findByTitleMatch(context, title));

        if (existing) {
          if (item.detail?.trim()) {
            await this.taskService.appendNotes(context, existing.id, item.detail.trim());
          }

          continue;
        }

        if (
          findSimilarTitle(title, tracked) ||
          acceptedThisRun.some((seen) => findSimilarTitle(title, [{ title: seen }]))
        ) {
          continue;
        }

        if (source && (claimedComms.has(source.id) || claimedThisRun.has(source.id))) {
          continue;
        }

        const decision = await this.personalizationService.decideAction(userId, {
          kind: 'task_create',
          confidence,
          hasUserInput: false,
        });

        if (decision === 'skip') {
          continue;
        }

        const status = decision === 'auto' ? 'open' : 'proposed';
        const created = await this.taskService.create(context, {
          title,
          description: item.detail?.trim() || null,
          status,
          estimatedMinutes:
            item.estimatedMinutes && item.estimatedMinutes > 0 ? Math.round(item.estimatedMinutes) : null,
          sourceKind: 'inbox',
          sourceRef,
          metadata: {
            confidence,
            generator: 'planning.inbox_scan',
            ...(source ? { sourceCommunicationId: source.id } : {}),
          },
          ...(status === 'proposed' ? proposedWindow : {}),
        });

        if (!created) {
          continue;
        }

        if (source) {
          claimedThisRun.add(source.id);
        }

        acceptedThisRun.push(title);

        if (status === 'proposed') {
          tallies.proposed += 1;
          continue;
        }

        tallies.created += 1;
        const placed = await this.plannedBlockService.tryPlaceAfterOpen(context, created, confidence);

        if (placed.status === 'placed') {
          tallies.placed += 1;
        }
      } catch (err) {
        // Same reasoning as TodoScanService: don't let one item's failure
        // force a full-batch redelivery that re-walks already-applied items.
        this.logger.warn('Inbox scan item failed; continuing with remaining items', {
          userId,
          title,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ARM THE GATE HERE — after the answer has been fully APPLIED, not when it
    // arrived. Two rules, and the placement is the only thing that satisfies
    // both:
    //
    //   1. Never arm without a real answer. `surfaceItems` returns null on an
    //      LLM timeout or outage and returns early above, so the gate is
    //      untouched and the next run asks again. One bad night must not
    //      silence this scan for the life of the process.
    //   2. Never arm on an answer that was DISCARDED. Everything between
    //      `surfaceItems` and here does unguarded DB work — `sweepStale` issues
    //      update/decline writes, `windowForToday` reads — and `runForUser` has
    //      no try/catch, nor does `PlanningJobsListener.onInboxScan`. A throw
    //      from any of it rejects the pg-boss job, which retries IN THIS
    //      PROCESS. Arming before that work meant the retry matched the gate,
    //      skipped the model, created nothing, and — since the corpus is static
    //      and the fingerprint therefore never changes — went on creating
    //      nothing forever. That is precisely the "planning proposes nothing"
    //      symptom the gate exists alongside, reintroduced by the gate itself.
    //
    // Reaching this line means the loop ran to completion, so the model's
    // answer has been applied as far as it is going to be. Per-item failures
    // inside the loop are caught and logged deliberately (see the catch above)
    // and DO arm: they are the item's problem, not a reason to re-ask an
    // unchanged question 48 times a day.
    this.lastSurfacedCandidates.set(userId, fingerprint);

    this.logger.log('Inbox scan finished', { userId, ...tallies });

    return tallies;
  }

  /**
   * Newest inbound message this scan would ever consider, or `null` if the user
   * has none at all. The scan window is `[anchor - LOOKBACK_MS, anchor]`.
   *
   * This is the actual fix for the dead scan (see {@link LOOKBACK_MS}): the
   * window follows the corpus instead of the wall clock, so a static import
   * stops falling out of it as it ages. On a live appliance being messaged
   * today `anchor ≈ now()` and the window is byte-for-byte what it was before,
   * so this is a no-op for the healthy case and only bites on a stale corpus —
   * which is the entire point.
   *
   * `time <= now()` rather than `LEAST(now(), MAX(time))`: both stop a
   * future-dated row from dragging the window forward, but this form IGNORES
   * the bad row, where `LEAST` lets one poison the anchor back down to `now()`
   * and silently restores the broken behaviour. This repo has shipped
   * future/garbage import timestamps before, so the difference is not
   * theoretical.
   *
   * Note the deliberate asymmetry: the selection query does NOT carry
   * `time <= now()`. Capping the ANCHOR is this fix; filtering future-dated
   * rows out of the candidate list is a separate behaviour change for a case
   * that does not exist in this corpus, and is not made here.
   */
  private async scanAnchor(userId: string): Promise<Date | null> {
    const row = await this.communicationRepository
      .createQueryBuilder('comm')
      .select('MAX(comm.time)', 'newest')
      .where('comm.user_id = :userId', { userId })
      .andWhere('comm.direction = :direction', { direction: 'inbound' })
      .andWhere('comm.communication_type IN (:...types)', { types: INBOX_TYPES })
      .andWhere('comm.is_archived = false')
      .andWhere('comm.time <= :now', { now: new Date() })
      .getRawOne<{ newest: Date | string | null }>();

    const newest = row?.newest;

    if (newest == null) {
      return null;
    }

    // `getRawOne` hands back whatever the driver produced — a Date for a
    // timestamptz column, but a string under some driver/column configurations.
    const anchor = newest instanceof Date ? newest : new Date(newest);

    return Number.isNaN(anchor.getTime()) ? null : anchor;
  }

  private async collapseDuplicateProposed(context: UserServiceContext, tracked: Task[]): Promise<Task[]> {
    const dropIds = newerDuplicateIds(tracked);

    if (dropIds.length === 0) {
      return tracked;
    }

    for (const id of dropIds) {
      await this.taskService.declineProposed(context, id);
    }

    this.logger.log('Collapsed duplicate proposed tasks', {
      userId: context.userId,
      archived: dropIds.length,
    });

    const dropped = new Set(dropIds);

    return tracked.filter((task) => !dropped.has(task.id));
  }

  private async sweepStale(
    context: UserServiceContext,
    titles: readonly string[],
  ): Promise<{ redated: number; archived: number }> {
    return this.proposedReconcile.reconcileStaleProposed(context, {
      sourceKind: 'inbox',
      relevantTitles: titles,
      relevantSourceRefs: titles.map((title) => TaskService.memoryScanSourceRef(title.trim(), 'inbox')),
    });
  }

  /**
   * `null` means the model failed — callers skip reconcile so a timeout does
   * not mass-archive still-open proposals. An empty array is a real "nothing
   * to surface" result and does sweep.
   */
  private async surfaceItems(
    context: UserServiceContext,
    inboxBlock: string,
    tracked: readonly Task[],
  ): Promise<Array<z.infer<typeof itemSchema>> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

    try {
      const alreadyTracked = formatAlreadyTracked(tracked.map((task) => task.title));
      const prompt = [
        "You extract possible to-do items from a person's inbound inbox (email, SMS, chat).",
        'Return only concrete actionable items the person still needs to do.',
        'Skip newsletters, receipts with no action, FYI threads, and completed work.',
        'Never propose work that is already tracked, even if the wording differs.',
        'Each inbox item is numbered. Set sourceIndex to that number when the task comes from it.',
        'JSON: {"items":[{"title":"string","detail":"optional","confidence":0.0-1.0,"estimatedMinutes":number,"sourceIndex":1}]}',
        alreadyTracked,
        '',
        'Inbox:',
        inboxBlock,
      ]
        .filter((line) => line !== '')
        .join('\n');

      const response = await this.ollamaService.chat(context as never, [{ role: 'user', content: prompt }], {
        tier: 'utility',
        enableTools: false,
        format: RESPONSE_JSON_SCHEMA,
        signal: controller.signal,
        // Without these two, SCAN_TIMEOUT_MS above is not a budget the call can
        // actually meet: generation is otherwise unbounded (see
        // SCAN_MAX_OUTPUT_TOKENS), and a 30-minute cadence is longer than the
        // backend's 5-minute eviction window, so the model reloads INSIDE the
        // budget on nearly every run.
        maxOutputTokens: SCAN_MAX_OUTPUT_TOKENS,
        keepAlive: SCAN_KEEP_ALIVE,
      });

      // A response cut off by the output cap stops mid-grammar, so its JSON is
      // unterminated and `JSON.parse` throws into the generic handler below,
      // which reads as "the model failed". That is both wrong and unactionable:
      // the model was fine and the operator's fix is to raise
      // SCAN_MAX_OUTPUT_TOKENS. Named here because the failure is otherwise
      // silent and permanent — every later run truncates in the same place.
      if (response.done_reason === 'length') {
        this.logger.warn('Inbox scan hit its output cap; raise SCAN_MAX_OUTPUT_TOKENS', {
          maxOutputTokens: SCAN_MAX_OUTPUT_TOKENS,
        });

        return null;
      }

      const parsed = responseSchema.safeParse(JSON.parse(response.message.content || '{}'));

      if (!parsed.success) {
        this.logger.warn('Inbox scan LLM returned unparseable items; skipping reconcile');

        return null;
      }

      const items: Array<z.infer<typeof itemSchema>> = [];

      for (const unknownItem of parsed.data.items) {
        const item = itemSchema.safeParse(unknownItem);

        if (item.success && item.data.title.trim()) {
          items.push(item.data);
        }
      }

      return items;
    } catch (err) {
      this.logger.warn('Inbox scan LLM failed; skipping reconcile', {
        error: err instanceof Error ? err.message : String(err),
      });

      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function formatMessage(message: CommunicationEntity, index: number): string {
  const subject = message.subject?.trim() || '(no subject)';
  const preview = (message.preview || message.summary || message.content || '').replace(/\s+/g, ' ').trim();

  return [
    `[${index}] ${message.communicationType} ${message.time.toISOString()}`,
    `Subject: ${subject}`,
    preview.slice(0, 500),
  ].join('\n');
}

/**
 * Identity of a candidate set, for the idempotency gate in `runForUser`.
 *
 * Ids only — content is irrelevant, since the question being asked is "is this
 * the same SET of messages I already showed the model?" and a message's body
 * does not change under it. Hashed rather than stored raw so the per-user map
 * stays a fixed ~64 bytes instead of ~1 KB of uuids.
 *
 * SORTED, so the fingerprint is a function of the set and not of the row order
 * the planner happened to produce. The candidate query now carries an `id`
 * tiebreaker that makes its order deterministic anyway, so this is belt and
 * braces — but the two guard different failures and neither subsumes the other:
 * the tiebreaker is what fixes candidate MEMBERSHIP across a `LIMIT` boundary
 * (sorting here cannot), and sorting here is what keeps the gate correct if a
 * later edit reorders the query (the tiebreaker cannot). 30 ids; the cost is
 * nothing.
 */
function candidateFingerprint(messages: readonly CommunicationEntity[]): string {
  const ids = messages.map((message) => message.id).sort();

  return createHash('sha256').update(ids.join('|')).digest('hex');
}

function proposedTitles(tasks: readonly Task[], sourceKind: string): string[] {
  return tasks
    .filter((task) => task.status === 'proposed' && task.sourceKind === sourceKind)
    .map((task) => task.title);
}

function sourceOf<T>(index: number | undefined, items: readonly T[]): T | undefined {
  if (index == null || index < 1 || index > items.length) {
    return undefined;
  }

  return items[index - 1];
}

function clampConfidence(value: number | undefined): number {
  if (value == null || Number.isNaN(value)) {
    return 0.75;
  }

  return Math.min(1, Math.max(0, value));
}
