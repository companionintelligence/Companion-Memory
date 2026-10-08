import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OllamaService } from '@ci/domains/llm/services/OllamaService';
import { CommunicationEntity } from '@ci/domains/memory';
import { PersonalizationService } from '@ci/domains/personalization';

import {
  MAX_SCAN_CALLS_PER_TICK,
  SCAN_PAGE_SIZE,
  cognitiveCap,
  inputTokenBudget,
  operatingKey,
  outputTokenCap,
  packBatch,
  scanOperatingPoints,
  sourceLoad,
  startingItems,
} from '../engine/scanBatchPolicy';
import {
  confidenceForScan,
  formatInboxMessage,
  inboxBody,
  inboxHeaderLine,
  inboxMessageIsEmpty,
  isEchoTitle,
} from '../engine/scanItemQuality';
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

/**
 * One model call. 60s, not 20: a large local model can spend most of that
 * producing a first token, and a tighter budget made this scan propose nothing.
 */
export const SCAN_TIMEOUT_MS = 60_000;
const SCAN_KEEP_ALIVE = '1h';
const INBOX_TYPES = ['email', 'sms', 'chat'];
const SCAN_GENERATORS = new Set(['planning.inbox_scan', 'planning.todo_scan']);

interface ScanProfile {
  model: string;
  contextTokens: number;
  parameterBillions: number | null;
}

/**
 * Triage inbound communications into tasks. The candidate set is every
 * unprocessed inbound email, SMS, and chat, walked in batches sized for the
 * utility model. A tick stops after {@link MAX_SCAN_CALLS_PER_TICK} calls and
 * the next run continues.
 */
@Injectable()
export class InboxScanService {
  /**
   * Message ids this process has already classified as "no action" or turned
   * into a task decision. A restart asks once more; within a process an
   * unchanged inbox is not re-sent every 30 minutes.
   */
  private readonly reviewedIds = new Map<string, Set<string>>();

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

  async runForUser(
    userId: string,
  ): Promise<{ created: number; proposed: number; placed: number; redated: number; archived: number }> {
    const context = { userId } as UserServiceContext;
    const tallies = { created: 0, proposed: 0, placed: 0, redated: 0, archived: 0 };

    const tracked = await this.collapseDuplicateProposed(
      context,
      await this.taskService.findAll(context, {
        status: [...SCAN_DEDUP_STATUSES],
        limit: SCAN_DEDUP_LIMIT,
      }),
    );
    tallies.archived += await this.archiveEchoTasks(context, tracked);
    const live = tracked.filter((task) => !isScanEcho(task));
    const anchor = await this.scanAnchor(userId);

    if (anchor == null) {
      this.logger.debug('Inbox scan found no inbound messages', { userId });
      const sweep = await this.sweepStale(context, []);

      return { ...tallies, ...sweep };
    }

    const claimedComms = claimedSourceIds(live, 'sourceCommunicationId');
    const reviewed = this.reviewedIds.get(userId) ?? new Set<string>();
    const profile = await this.scanProfile();
    const cap = cognitiveCap(profile.parameterBillions);
    const key = operatingKey(profile.model, 'inbox');
    let maxItems = scanOperatingPoints.recommend(key, startingItems(profile.contextTokens, cap));
    const maxInputTokens = inputTokenBudget(profile.contextTokens);
    const alreadyTracked = formatAlreadyTracked(live.map((task) => task.title));

    const seen = new Map<string, CommunicationEntity>();
    const pending: CommunicationEntity[] = [];
    const candidates: ScanCandidate[] = [];
    const classifiedIds: string[] = [];
    let calls = 0;
    let anySuccess = false;
    let attempted = false;
    let queueDone = false;
    let pageCursor: { time: Date; id: string } | null = null;

    const fillPending = async (): Promise<void> => {
      while (pending.length === 0 && !queueDone) {
        const page = await this.loadInboxPage(userId, pageCursor);

        if (page.length === 0) {
          queueDone = true;
          break;
        }

        const last = page[page.length - 1];
        const lastTime = last?.time instanceof Date ? last.time : null;

        if (
          !last ||
          !lastTime ||
          (pageCursor != null &&
            pageCursor.id === last.id &&
            pageCursor.time.getTime() === lastTime.getTime())
        ) {
          queueDone = true;
          break;
        }

        pageCursor = { time: lastTime, id: last.id };

        if (page.length < SCAN_PAGE_SIZE) {
          queueDone = true;
        }

        for (const message of page) {
          if (claimedComms.has(message.id) || reviewed.has(message.id) || inboxMessageIsEmpty(message)) {
            continue;
          }

          pending.push(message);
          seen.set(message.id, message);
        }
      }
    };

    while (calls < MAX_SCAN_CALLS_PER_TICK) {
      await fillPending();

      if (pending.length === 0) {
        break;
      }

      const packed = packBatch(
        pending.map((message) => ({ message, ...inboxSource(message) })),
        { maxItems, maxInputTokens },
      );

      if (packed.length === 0) {
        break;
      }

      calls += 1;
      attempted = true;
      const outcome = await this.classify(
        context,
        packed.map((row) => row.message),
        alreadyTracked,
      );

      if (outcome == null) {
        maxItems = scanOperatingPoints.noteFailed(key, maxItems);
        this.logger.warn('Inbox scan classify failed; continuing with a smaller batch', {
          userId,
          batch: packed.length,
          nextItems: maxItems,
        });

        if (packed.length === 1) {
          pending.shift();
        }

        continue;
      }

      anySuccess = true;
      maxItems = scanOperatingPoints.noteClean(key, packed.length, cap);
      const consumed = new Set(packed.map((row) => row.message.id));

      for (const candidate of outcome.candidates) {
        const message = packed[candidate.sourceIndex - 1]?.message;

        if (!message) {
          continue;
        }

        candidates.push({ ...candidate, sourceIndex: candidates.length + 1, sourceId: message.id });
      }

      for (const row of packed) {
        const index = packed.indexOf(row) + 1;
        const kept = outcome.candidates.some((candidate) => candidate.sourceIndex === index);

        if (!kept) {
          classifiedIds.push(row.message.id);
        }
      }

      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (consumed.has(pending[index]?.id ?? '')) {
          pending.splice(index, 1);
        }
      }
    }

    if (!attempted) {
      this.logger.debug('Inbox scan found no unprocessed inbound messages', { userId });
      const sweep = await this.sweepStale(context, proposedTitles(live, 'inbox'));

      return { ...tallies, ...sweep };
    }

    if (!anySuccess) {
      this.logger.log('Inbox scan finished', { userId, ...tallies, skippedReconcile: true });

      return tallies;
    }

    let todos: ScanTodo[] = [];

    if (candidates.length > 0) {
      if (calls >= MAX_SCAN_CALLS_PER_TICK) {
        this.logger.log('Inbox scan finished', { userId, ...tallies, skippedReconcile: true });

        return tallies;
      }

      calls += 1;
      const consolidated = await this.consolidate(context, candidates);

      if (consolidated == null) {
        this.remember(userId, classifiedIds);
        this.logger.log('Inbox scan finished', { userId, ...tallies, skippedReconcile: true });

        return tallies;
      }

      todos = consolidated;
    }

    const sweep = await this.sweepStale(
      context,
      todos.length > 0 ? todos.map((item) => item.title) : proposedTitles(live, 'inbox'),
    );
    tallies.redated = sweep.redated;
    tallies.archived += sweep.archived;
    this.remember(
      userId,
      classifiedIds.concat(
        candidates.flatMap((candidate) => (candidate.sourceId ? [candidate.sourceId] : [])),
      ),
    );

    const proposedWindow = await this.proposedReconcile.windowForToday(context);
    const acceptedThisRun: string[] = [];
    const claimedThisRun = new Set<string>();

    for (const item of todos) {
      const title = item.title.trim();

      if (!title || isEchoTitle(title)) {
        continue;
      }

      const source = seen.get(sourceIdFor(candidates, item.sourceIndex) ?? '');

      if (!source) {
        continue;
      }

      try {
        const confidence = confidenceForScan(item.confidence);
        const sourceRef = TaskService.memoryScanSourceRef(title, 'inbox');
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
          findSimilarTitle(title, live) ||
          acceptedThisRun.some((seen) => findSimilarTitle(title, [{ title: seen }]))
        ) {
          continue;
        }

        if (claimedComms.has(source.id) || claimedThisRun.has(source.id)) {
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
            sourceCommunicationId: source.id,
          },
          ...(status === 'proposed' ? proposedWindow : {}),
        });

        if (!created) {
          continue;
        }

        claimedThisRun.add(source.id);
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
        this.logger.warn('Inbox scan item failed; continuing with remaining items', {
          userId,
          title,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.log('Inbox scan finished', { userId, ...tallies, calls });

    return tallies;
  }

  /**
   * Newest-first page. A cursor of `(time, id)` walks past mail this process
   * has already classified, so the scan is not stuck on the newest page.
   */
  private async loadInboxPage(
    userId: string,
    cursor: { time: Date; id: string } | null,
  ): Promise<CommunicationEntity[]> {
    const query = this.communicationRepository
      .createQueryBuilder('comm')
      .where('comm.user_id = :userId', { userId })
      .andWhere('comm.direction = :direction', { direction: 'inbound' })
      .andWhere('comm.communication_type IN (:...types)', { types: INBOX_TYPES })
      .andWhere('comm.is_archived = false');

    if (cursor) {
      query.andWhere('(comm.time < :cursorTime OR (comm.time = :cursorTime AND comm.id < :cursorId))', {
        cursorTime: cursor.time,
        cursorId: cursor.id,
      });
    }

    return query.orderBy('comm.time', 'DESC').addOrderBy('comm.id', 'DESC').limit(SCAN_PAGE_SIZE).getMany();
  }

  /**
   * Whether this account has any inbound mail the scan could see. An empty
   * account skips the candidate query. The old 30-day window is gone: a static
   * import used to age out of `now() - 30d` and the scan never ran.
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

  private async archiveEchoTasks(context: UserServiceContext, tracked: readonly Task[]): Promise<number> {
    let archived = 0;

    for (const task of tracked) {
      if (!isScanEcho(task)) {
        continue;
      }

      if (task.status === 'proposed') {
        await this.taskService.declineProposed(context, task.id);
        archived += 1;
      } else if (task.status === 'open') {
        await this.taskService.update(context, task.id, { status: 'archived' });
        archived += 1;
      }
    }

    if (archived > 0) {
      this.logger.log('Archived scan tasks whose titles were message headers', {
        userId: context.userId,
        archived,
      });
    }

    return archived;
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

  private async classify(
    context: UserServiceContext,
    batch: readonly CommunicationEntity[],
    alreadyTracked: string,
  ): Promise<{ candidates: ScanCandidate[] } | null> {
    const block = batch.map((message, index) => formatInboxMessage(message, index + 1)).join('\n---\n');
    const content = await this.complete(
      context,
      classifyPrompt(block, alreadyTracked),
      decisionResponseSchema(batch.length),
      batch.length,
    );

    if (content == null) {
      return null;
    }

    const outcome = interpretClassify(content, batch.length, (index) =>
      inboxHeaderLine(batch[index - 1] ?? {}),
    );

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
        this.logger.warn('Inbox scan generation hit its output cap; shrinking the batch', {
          maxOutputTokens: outputTokenCap(items),
        });

        return null;
      }

      return response.message.content || '{}';
    } catch (err) {
      this.logger.warn(
        isScanContextOverflow(err)
          ? 'Inbox scan overflowed the context window; shrinking the batch'
          : 'Inbox scan LLM failed; shrinking the batch',
        { error: err instanceof Error ? err.message : String(err) },
      );

      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async scanProfile(): Promise<ScanProfile> {
    const service = this.ollamaService as OllamaService & {
      resolveUtilityScanProfile?: () => Promise<ScanProfile>;
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

  private remember(userId: string, ids: readonly string[]): void {
    const reviewed = this.reviewedIds.get(userId) ?? new Set<string>();

    for (const id of ids) {
      reviewed.add(id);
    }

    this.reviewedIds.set(userId, reviewed);
  }
}

function inboxSource(message: CommunicationEntity): { id: string; tokens: number; complexity: number } {
  const text = `${message.subject ?? ''}\n${inboxBody(message)}`;
  const tokens = Buffer.byteLength(text, 'utf8');
  const load = sourceLoad(tokens, {
    attachment: Array.isArray(message.attachments) && message.attachments.length > 0,
    longThread: Boolean(message.threadId) && tokens > 800,
  });

  return { id: message.id, ...load };
}

function isScanEcho(task: Task): boolean {
  const generator = task.metadata?.generator;

  return (
    (task.status === 'proposed' || task.status === 'open') &&
    typeof generator === 'string' &&
    SCAN_GENERATORS.has(generator) &&
    isEchoTitle(task.title)
  );
}

function proposedTitles(tasks: readonly Task[], sourceKind: string): string[] {
  return tasks
    .filter((task) => task.status === 'proposed' && task.sourceKind === sourceKind)
    .map((task) => task.title);
}

function sourceIdFor(candidates: readonly ScanCandidate[], sourceIndex: number): string | undefined {
  return candidates.find((candidate) => candidate.sourceIndex === sourceIndex)?.sourceId;
}
