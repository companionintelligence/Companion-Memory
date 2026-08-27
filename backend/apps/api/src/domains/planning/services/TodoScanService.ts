import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OllamaService, PROMPT_MODEL } from '@ci/domains/llm/services/OllamaService';
import { PersonalizationService } from '@ci/domains/personalization';
import { SearchService } from '@ci/domains/search-next';

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
export const SCAN_TIMEOUT_MS = 60_000;
const MEMORY_LOOKBACK_QUERY =
  'tasks to-dos errands appointments commitments deadlines things I need to do or finish';

const itemSchema = z.object({
  title: z.string(),
  detail: z.string().optional(),
  confidence: z.number().optional(),
});

const responseSchema = z.object({
  items: z.array(z.unknown()),
});

const RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          confidence: { type: 'number' },
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

    const memoryBlock = await this.memoryBlock(context);

    if (memoryBlock == null) {
      this.logger.log('Todo scan finished', { userId, ...tallies, skippedReconcile: true });

      return tallies;
    }

    if (!memoryBlock.trim()) {
      this.logger.debug('Todo scan found no memory hits', { userId });
      const sweep = await this.sweepStale(context, []);

      return { ...tallies, ...sweep };
    }

    const surfaced = await this.surfaceItems(context, memoryBlock);

    if (surfaced == null) {
      this.logger.log('Todo scan finished', { userId, ...tallies, skippedReconcile: true });

      return tallies;
    }

    const sweep = await this.sweepStale(context, surfaced);
    tallies.redated = sweep.redated;
    tallies.archived = sweep.archived;

    const proposedWindow = await this.proposedReconcile.windowForToday(context);

    for (const item of surfaced.slice(0, MAX_SURFACED)) {
      const title = item.title.trim();

      if (!title) {
        continue;
      }

      try {
        const confidence = clampConfidence(item.confidence);
        const sourceRef = TaskService.memoryScanSourceRef(title);
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
          metadata: { confidence, generator: 'planning.todo_scan' },
          ...(status === 'proposed' ? proposedWindow : {}),
        });

        if (created) {
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

  private async memoryBlock(context: UserServiceContext): Promise<string | null> {
    try {
      const results = await this.searchService.search(context, {
        query: MEMORY_LOOKBACK_QUERY,
        mode: 'boosted',
        maxResults: 20,
      });

      const hits = results ?? [];

      if (hits.length === 0) {
        return '';
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

      return hits
        .map((hit) => {
          const row = byId.get(hit.id);
          const title = row?.name?.trim();
          const snippet = row?.snippet?.trim();

          if (!title && !snippet) {
            return '';
          }

          return [`${row?.entity_type ?? hit.type}: ${title || '(untitled)'}`, snippet]
            .filter(Boolean)
            .join('\n');
        })
        .filter(Boolean)
        .join('\n---\n');
    } catch (err) {
      this.logger.warn('Todo scan search failed', {
        error: err instanceof Error ? err.message : String(err),
      });

      return null;
    }
  }

  private async sweepStale(
    context: UserServiceContext,
    surfaced: Array<{ title: string }>,
  ): Promise<{ redated: number; archived: number }> {
    return this.proposedReconcile.reconcileStaleProposed(context, {
      sourceKind: 'memory_scan',
      relevantTitles: surfaced.map((item) => item.title),
      relevantSourceRefs: surfaced.map((item) => TaskService.memoryScanSourceRef(item.title.trim())),
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
  ): Promise<Array<{ title: string; detail?: string; confidence?: number }> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

    try {
      const prompt = [
        "You extract possible to-do items from a person's recent memory.",
        'Return only concrete actionable items the person still needs to do.',
        'Skip completed work, past events with no remaining action, and vague reflections.',
        'JSON: {"items":[{"title":"string","detail":"optional string","confidence":0.0-1.0}]}',
        '',
        'Memory:',
        memoryBlock.slice(0, 6000),
      ].join('\n');

      const response = await this.ollamaService.chat(context as never, [{ role: 'user', content: prompt }], {
        model: PROMPT_MODEL,
        enableTools: false,
        format: RESPONSE_JSON_SCHEMA,
        signal: controller.signal,
      });

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

function clampConfidence(value: number | undefined): number {
  if (value == null || Number.isNaN(value)) {
    return 0.75;
  }

  return Math.min(1, Math.max(0, value));
}
