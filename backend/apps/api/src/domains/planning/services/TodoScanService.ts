import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OllamaService, UTILITY_MODEL } from '@ci/domains/llm/services/OllamaService';
import { PersonalizationService } from '@ci/domains/personalization';
import { SearchService } from '@ci/domains/search-next';

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

const MAX_SURFACED = 12;
// 60s, not 20 — see InboxScanService.ts's SCAN_TIMEOUT_MS for the full
// reasoning. Confirmed live: a bare one-word Ollama completion against the
// configured local model took over two minutes on real hardware, and the
// one production run tonight aborted with "This operation was aborted"
// before the model could respond at all — the daily todo scan had never
// once produced a proposal because of this, on every appliance running a
// large enough local model, not just under unusual load.
//
// The budget is headroom, not the cure. What made this scan actually complete
// was moving it to the utility model tier and bounding generation (the two
// constants below): on the operator's chat model, prompt evaluation alone
// exceeded even 60s, so widening this on its own only moved the abort from
// 20s to 60s.
export const SCAN_TIMEOUT_MS = 60_000;

/**
 * Output cap for the scan turn (Ollama `options.num_predict`).
 *
 * The scan asks for grammar-constrained JSON whose `items` array is bounded to
 * {@link MAX_SURFACED} entries, so a complete answer is small — a few hundred
 * tokens at most. Left uncapped, though, "bounded array" does not mean
 * "bounded generation": a model that keeps emitting still runs until the
 * context window fills, and the caller's timeout fires long before that. The
 * cap is set well above a full {@link MAX_SURFACED}-item answer so it truncates
 * only runaway generation, never a legitimate one.
 */
const SCAN_MAX_OUTPUT_TOKENS = 1_500;

/**
 * Keep the utility model resident (Ollama `keep_alive`).
 *
 * Note what this does NOT do. This scan is daily, and no keep-alive shorter
 * than a day holds a model across that gap, so the first call of a run still
 * pays whatever load is due; the value is not chosen for this scan alone.
 *
 * What an hour buys is the rest of the tier. `InboxScanService` runs every 30
 * minutes and `TodoProcessService` makes many sequential calls per run, all on
 * the same utility model — an hour keeps it warm across that traffic, and keeps
 * this scan's own pg-boss retries from each reloading it inside their budget.
 * Cold start on an otherwise idle appliance is a separate problem and wants a
 * separate fix (a warm-up outside the timed section), not a longer keep-alive.
 */
const SCAN_KEEP_ALIVE = '1h';
const MEMORY_LOOKBACK_QUERY =
  'tasks to-dos errands appointments commitments deadlines things I need to do or finish';

const itemSchema = z.object({
  title: z.string(),
  detail: z.string().optional(),
  confidence: z.number().optional(),
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
      // generation, so an array with no upper bound licenses the model to keep
      // emitting entries indefinitely. Only MAX_SURFACED of them are ever used
      // downstream; asking for more is generation the caller pays for and then
      // discards.
      //
      // Enforcement is the SERVER's, not this client's, so it was verified
      // rather than assumed: asking a model for ten items under a `maxItems: 2`
      // schema returned exactly two and stopped (`done_reason: stop`).
      maxItems: MAX_SURFACED,
      items: {
        type: 'object',
        properties: {
          // Bounded so SCAN_MAX_OUTPUT_TOKENS is provably above a full answer
          // rather than merely believed to be. MAX_SURFACED items at these
          // lengths is roughly 900 tokens against a 1,500 cap; unbounded
          // strings make that arithmetic impossible and put a legitimate
          // answer at risk of the truncation handled above. These are also
          // generous for what the UI shows — a task title and a one-line note.
          title: { type: 'string', maxLength: 120 },
          detail: { type: 'string', maxLength: 200 },
          confidence: { type: 'number' },
          sourceIndex: { type: 'integer' },
        },
        required: ['title'],
      },
    },
  },
  required: ['items'],
};

/**
 * Scans recent memory for possible to-dos, dedupes against open/done, and
 * either auto-adds or proposes based on the trust dial (`task_create`).
 *
 * Uses SearchService directly (not RecallService) so PlanningModule does not
 * import AgentModule → LLMModule → PlanningModule.
 */
@Injectable()
export class TodoScanService {
  constructor(
    private readonly taskService: TaskService,
    private readonly searchService: SearchService,
    private readonly ollamaService: OllamaService,
    private readonly personalizationService: PersonalizationService,
    private readonly plannedBlockService: PlannedBlockService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly proposedReconcile: ProposedTaskReconcileService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(TodoScanService.name);
  }

  async runForUser(
    userId: string,
  ): Promise<{ created: number; proposed: number; appended: number; redated: number; archived: number }> {
    const context = { userId } as UserServiceContext;
    const tallies = { created: 0, proposed: 0, appended: 0, redated: 0, archived: 0 };

    const hits = await this.memoryHits(context);

    if (hits == null) {
      this.logger.log('Todo scan finished', { userId, ...tallies, skippedReconcile: true });

      return tallies;
    }

    if (hits.length === 0) {
      this.logger.debug('Todo scan found no memory hits', { userId });
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
    const claimedEntities = claimedSourceIds(tracked, 'sourceEntityId');
    const fresh = hits.filter((hit) => !claimedEntities.has(hit.id));

    if (fresh.length === 0) {
      this.logger.debug('Todo scan found no unprocessed memory hits', { userId, seen: hits.length });
      const sweep = await this.sweepStale(context, proposedTitles(tracked, 'memory_scan'));

      return { ...tallies, ...sweep };
    }

    const memoryBlock = fresh.map((hit, index) => `[${index + 1}] ${hit.text}`).join('\n---\n');

    const surfaced = await this.surfaceItems(context, memoryBlock, tracked);

    if (surfaced == null) {
      this.logger.log('Todo scan finished', { userId, ...tallies, skippedReconcile: true });

      return tallies;
    }

    const sweep = await this.sweepStale(
      context,
      surfaced.length > 0 ? surfaced.map((item) => item.title) : proposedTitles(tracked, 'memory_scan'),
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
        const sourceRef = TaskService.memoryScanSourceRef(title);
        const source = sourceOf(item.sourceIndex, fresh);
        const existing =
          (await this.taskService.findBySourceRef(context, 'memory_scan', sourceRef)) ??
          (await this.taskService.findByTitleMatch(context, title));

        if (existing) {
          if (item.detail?.trim()) {
            await this.taskService.appendNotes(context, existing.id, item.detail.trim());
            tallies.appended += 1;
          }

          continue;
        }

        if (
          findSimilarTitle(title, tracked) ||
          acceptedThisRun.some((seen) => findSimilarTitle(title, [{ title: seen }]))
        ) {
          continue;
        }

        if (source && (claimedEntities.has(source.id) || claimedThisRun.has(source.id))) {
          continue;
        }

        const decision = await this.personalizationService.decideAction(userId, {
          kind: 'task_create',
          confidence,
        });

        if (decision === 'skip') {
          continue;
        }

        const status = decision === 'auto' ? 'open' : 'proposed';
        const created = await this.taskService.create(context, {
          title,
          description: item.detail?.trim() || null,
          status,
          sourceKind: 'memory_scan',
          sourceRef,
          metadata: {
            confidence,
            generator: 'planning.todo_scan',
            ...(source ? { sourceEntityId: source.id } : {}),
          },
          ...(status === 'proposed' ? proposedWindow : {}),
        });

        if (created) {
          if (source) {
            claimedThisRun.add(source.id);
          }

          acceptedThisRun.push(title);

          if (status === 'proposed') {
            tallies.proposed += 1;
          } else {
            tallies.created += 1;
            await this.plannedBlockService.tryPlaceAfterOpen(context, created, confidence);
          }
        }
      } catch (err) {
        // One item's failure must not force pg-boss to redeliver the whole
        // job — that would re-walk every item already applied above. Items
        // are idempotent on retry (sourceRef/title lookup, appendNotes
        // content check), so it is safe to just skip this one and continue.
        this.logger.warn('Todo scan item failed; continuing with remaining items', {
          userId,
          title,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.log('Todo scan finished', { userId, ...tallies });

    return tallies;
  }

  private async memoryHits(context: UserServiceContext): Promise<Array<{ id: string; text: string }> | null> {
    try {
      const results = await this.searchService.search(context, {
        query: MEMORY_LOOKBACK_QUERY,
        mode: 'boosted',
        maxResults: 20,
      });

      const hits = results ?? [];

      if (hits.length === 0) {
        return [];
      }

      const ids = hits.map((hit) => hit.id);
      const rows = (await this.dataSource.query(
        `SELECT entity_id::text AS id, entity_type, name,
                left(coalesce(description, ''), 400) AS snippet
           FROM ci.entities
          WHERE entity_id = ANY($1::uuid[])
            AND owner_user_id = $2::uuid`,
        [ids, context.userId],
      )) as Array<{ id: string; entity_type: string; name: string | null; snippet: string | null }>;

      const byId = new Map(rows.map((row) => [row.id, row]));

      return hits.flatMap((hit) => {
        const row = byId.get(hit.id);
        const title = row?.name?.trim();
        const snippet = row?.snippet?.trim();

        if (!title && !snippet) {
          return [];
        }

        return [
          {
            id: hit.id,
            text: [`${row?.entity_type ?? hit.type}: ${title || '(untitled)'}`, snippet]
              .filter(Boolean)
              .join('\n'),
          },
        ];
      });
    } catch (err) {
      this.logger.warn('Todo scan search failed', {
        error: err instanceof Error ? err.message : String(err),
      });

      return null;
    }
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
      sourceKind: 'memory_scan',
      relevantTitles: titles,
      relevantSourceRefs: titles.map((title) => TaskService.memoryScanSourceRef(title.trim())),
    });
  }

  /**
   * `null` means the model failed — callers skip reconcile so a timeout does
   * not mass-archive still-open proposals. An empty array is a real "nothing
   * to surface" result and does sweep.
   */
  private async surfaceItems(
    context: UserServiceContext,
    memoryBlock: string,
    tracked: readonly Task[],
  ): Promise<Array<z.infer<typeof itemSchema>> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

    try {
      const alreadyTracked = formatAlreadyTracked(tracked.map((task) => task.title));
      const prompt = [
        "You extract possible to-do items from a person's recent memory.",
        'Return only concrete actionable items the person still needs to do.',
        'Skip completed work, past events with no remaining action, and vague reflections.',
        'Never propose work that is already tracked, even if the wording differs.',
        'Each memory item is numbered. Set sourceIndex to that number when the task comes from it.',
        'JSON: {"items":[{"title":"string","detail":"optional string","confidence":0.0-1.0,"sourceIndex":1}]}',
        alreadyTracked,
        '',
        'Memory:',
        memoryBlock.slice(0, 6000),
      ]
        .filter((line) => line !== '')
        .join('\n');

      const response = await this.ollamaService.chat(context as never, [{ role: 'user', content: prompt }], {
        model: UTILITY_MODEL,
        enableTools: false,
        format: RESPONSE_JSON_SCHEMA,
        signal: controller.signal,
        // Without these two the timeout above is not a budget the call can
        // actually meet: generation is otherwise unbounded (see
        // SCAN_MAX_OUTPUT_TOKENS), and a scan that runs less often than the
        // backend's 5-minute eviction window reloads the model inside the
        // budget on nearly every run.
        maxOutputTokens: SCAN_MAX_OUTPUT_TOKENS,
        keepAlive: SCAN_KEEP_ALIVE,
      });

      // A response cut off by the output cap stops mid-grammar, so its JSON is
      // unterminated and `JSON.parse` throws. Left to the generic handler that
      // reads as "the model failed", which is both wrong and unactionable: the
      // model was fine, the CAP was too low, and the operator's fix is to raise
      // SCAN_MAX_OUTPUT_TOKENS rather than to go looking at the backend. Worth
      // naming precisely because the failure is otherwise silent and permanent
      // — every subsequent run truncates in exactly the same place.
      if (response.done_reason === 'length') {
        this.logger.warn('Todo scan hit its output cap; raise SCAN_MAX_OUTPUT_TOKENS', {
          maxOutputTokens: SCAN_MAX_OUTPUT_TOKENS,
        });

        return null;
      }

      const parsed = responseSchema.safeParse(JSON.parse(response.message.content || '{}'));

      if (!parsed.success) {
        this.logger.warn('Todo scan LLM returned unparseable items; skipping reconcile');

        return null;
      }

      const items: Array<{ title: string; detail?: string; confidence?: number }> = [];

      for (const unknownItem of parsed.data.items) {
        const item = itemSchema.safeParse(unknownItem);

        if (item.success && item.data.title.trim()) {
          items.push(item.data);
        }
      }

      return items;
    } catch (err) {
      this.logger.warn('Todo scan LLM failed; skipping reconcile', {
        error: err instanceof Error ? err.message : String(err),
      });

      return null;
    } finally {
      clearTimeout(timer);
    }
  }
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
