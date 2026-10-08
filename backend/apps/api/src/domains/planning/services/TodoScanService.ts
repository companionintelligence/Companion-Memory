import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OllamaService } from '@ci/domains/llm/services/OllamaService';
import { PersonalizationService } from '@ci/domains/personalization';
import { SearchService } from '@ci/domains/search-next';

import {
  MAX_SCAN_CALLS_PER_TICK,
  cognitiveCap,
  inputTokenBudget,
  operatingKey,
  outputTokenCap,
  packBatch,
  scanOperatingPoints,
  sourceLoad,
  startingItems,
} from '../engine/scanBatchPolicy';
import { confidenceForScan, formatMemoryHit, isEchoTitle, memoryHitText } from '../engine/scanItemQuality';
import {
  type ScanCandidate,
  type ScanTodo,
  classifyPrompt,
  consolidatePrompt,
  decisionResponseSchema,
  interpretClassify,
  interpretConsolidate,
  isScanContextOverflow,
  todoResponseSchema,
} from '../engine/scanTurn';
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

    const profile = await this.scanProfile();
    const cap = cognitiveCap(profile.parameterBillions);
    const key = operatingKey(profile.model, 'memory');
    let maxItems = scanOperatingPoints.recommend(key, startingItems(profile.contextTokens, cap));
    const maxInputTokens = inputTokenBudget(profile.contextTokens);
    const alreadyTracked = formatAlreadyTracked(tracked.map((task) => task.title));
    const candidates: ScanCandidate[] = [];
    let calls = 0;
    let anySuccess = false;
    let cursor = 0;

    while (cursor < fresh.length && calls < MAX_SCAN_CALLS_PER_TICK) {
      const packed = packBatch(
        fresh.slice(cursor).map((hit) => ({ hit, ...memorySource(hit) })),
        { maxItems, maxInputTokens },
      );

      if (packed.length === 0) {
        break;
      }

      calls += 1;
      const outcome = await this.classify(
        context,
        packed.map((row) => row.hit),
        alreadyTracked,
      );

      if (outcome == null) {
        maxItems = scanOperatingPoints.noteFailed(key, maxItems);

        if (packed.length === 1) {
          cursor += 1;
        }

        continue;
      }

      anySuccess = true;
      maxItems = scanOperatingPoints.noteClean(key, packed.length, cap);

      for (const candidate of outcome.candidates) {
        const hit = packed[candidate.sourceIndex - 1]?.hit;

        if (!hit) {
          continue;
        }

        candidates.push({ ...candidate, sourceIndex: candidates.length + 1, sourceId: hit.id });
      }

      cursor += packed.length;
    }

    if (!anySuccess) {
      this.logger.log('Todo scan finished', { userId, ...tallies, skippedReconcile: true });

      return tallies;
    }

    let surfaced: ScanTodo[] = [];

    if (candidates.length > 0) {
      const consolidated = await this.consolidate(context, candidates);

      if (consolidated == null) {
        this.logger.log('Todo scan finished', { userId, ...tallies, skippedReconcile: true });

        return tallies;
      }

      surfaced = consolidated;
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

    for (const item of surfaced) {
      const title = item.title.trim();

      if (!title || isEchoTitle(title)) {
        continue;
      }

      try {
        const confidence = confidenceForScan(item.confidence);
        const sourceRef = TaskService.memoryScanSourceRef(title);
        const sourceId = candidates.find((candidate) => candidate.sourceIndex === item.sourceIndex)?.sourceId;
        const source = fresh.find((hit) => hit.id === sourceId);
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
        maxResults: 80,
        // `browser-activity` is indexed into ci_search.vectors for the general
        // search UI but is never projected into ci.entities the way every
        // other IndexableEntity is (Communication/Event/Content/Person/Item/
        // Location all do) — confirmed live: 0 of a real user's 254,357
        // browser-activity vectors joined to ci.entities, versus 100% for
        // every other type. The lookup below silently drops any hit that
        // doesn't resolve, so on an account with heavy browsing history a
        // browser-activity hit just burns one of this scan's 20 candidate
        // slots for nothing — over half the slots, in that measurement.
        // Excluding it here keeps the budget on hits this scan can ever use.
        excludeTypes: ['browser-activity'],
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
            text: memoryHitText(row?.entity_type ?? hit.type, title || '(untitled)', snippet ?? ''),
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

  private async classify(
    context: UserServiceContext,
    batch: readonly MemoryHit[],
    alreadyTracked: string,
  ): Promise<{ candidates: ScanCandidate[] } | null> {
    const block = batch.map((hit, index) => formatMemoryHit(hit.text, index + 1)).join('\n---\n');
    const content = await this.complete(
      context,
      classifyPrompt(block, alreadyTracked),
      decisionResponseSchema(batch.length),
      batch.length,
    );

    if (content == null) {
      return null;
    }

    const outcome = interpretClassify(content, batch.length, () => undefined);

    return outcome.ok ? { candidates: outcome.candidates } : null;
  }

  private async consolidate(
    context: UserServiceContext,
    candidates: readonly ScanCandidate[],
  ): Promise<ScanTodo[] | null> {
    const content = await this.complete(
      context,
      consolidatePrompt(candidates),
      todoResponseSchema(candidates.length),
      candidates.length,
    );

    if (content == null) {
      return null;
    }

    return interpretConsolidate(content, candidates);
  }

  private async complete(
    context: UserServiceContext,
    prompt: string,
    schema: Record<string, unknown>,
    items: number,
  ): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

    try {
      const response = await this.ollamaService.chat(context as never, [{ role: 'user', content: prompt }], {
        tier: 'utility',
        enableTools: false,
        format: schema,
        signal: controller.signal,
        maxOutputTokens: outputTokenCap(items),
        keepAlive: SCAN_KEEP_ALIVE,
      });

      if (response.done_reason === 'length') {
        this.logger.warn('Todo scan generation hit its output cap; shrinking the batch', {
          maxOutputTokens: outputTokenCap(items),
        });

        return null;
      }

      return response.message.content || '{}';
    } catch (err) {
      this.logger.warn(
        isScanContextOverflow(err)
          ? 'Todo scan overflowed the context window; shrinking the batch'
          : 'Todo scan LLM failed; shrinking the batch',
        { error: err instanceof Error ? err.message : String(err) },
      );

      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async scanProfile(): Promise<{
    model: string;
    contextTokens: number;
    parameterBillions: number | null;
  }> {
    const service = this.ollamaService as OllamaService & {
      resolveUtilityScanProfile?: () => Promise<{
        model: string;
        contextTokens: number;
        parameterBillions: number | null;
      }>;
    };

    if (typeof service.resolveUtilityScanProfile !== 'function') {
      return { model: 'utility', contextTokens: 8_192, parameterBillions: null };
    }

    try {
      return await service.resolveUtilityScanProfile();
    } catch {
      return { model: 'utility', contextTokens: 8_192, parameterBillions: null };
    }
  }
}

interface MemoryHit {
  id: string;
  text: string;
}

function memorySource(hit: MemoryHit): { id: string; tokens: number; complexity: number } {
  return { id: hit.id, ...sourceLoad(Buffer.byteLength(hit.text, 'utf8')) };
}

function proposedTitles(tasks: readonly Task[], sourceKind: string): string[] {
  return tasks
    .filter((task) => task.status === 'proposed' && task.sourceKind === sourceKind)
    .map((task) => task.title);
}
