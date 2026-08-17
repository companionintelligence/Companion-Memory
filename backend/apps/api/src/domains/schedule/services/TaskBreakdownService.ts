import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { type RequestContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { RecallService } from '@ci/domains/agent';
import { OllamaService, PROMPT_MODEL } from '@ci/domains/llm';
import { UserContextService } from '@ci/domains/memory';
import { estimateActivityDurationMinutes, PlacementService } from '@ci/domains/personalization';

import { type CreateCandidateDto, USER_AUTHORED_GENERATOR_PREFIX } from '../types';

import { CandidateService } from './CandidateService';

/** How far ahead a brain-dumped task claims it could happen. */

/** Bound the model's output. A dump that yields 40 cards has not been broken down, it has been transcribed. */
const MAX_TASKS = 12;

/** Bound the input so one paste cannot blow the context window. */
const MAX_INPUT_CHARS = 4000;

/**
 * Ceiling on one brain dump's worth of generation, shared by BOTH samples.
 *
 * The same order as the 10s HbpeService allows itself, with headroom for a cold
 * model: gemma3:1b splits a dump in a second or two once resident, but the first
 * call after a restart pays the load. Past that the honest reading is that the
 * model is not coming back, and the user is better told "nothing came back" than
 * left watching a spinner on a note they just typed.
 */
const BREAKDOWN_TIMEOUT_MS = 15_000;

/** Durations outside this are the model hallucinating, not estimating. */
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 8 * 60;

/**
 * L0 classes the model may assign. Same vocabulary HBPE uses, so a card dropped
 * on the grid is coloured by the schedule's own palette rather than landing as
 * "unsorted".
 */
const L0_CLASSES = [
  'WORK',
  'EXERCISE',
  'SOCIAL',
  'ERRAND',
  'LEISURE',
  'TRANSIT',
  'SLEEP',
  'UNKNOWN',
] as const;

const L0_SET = new Set<string>(L0_CLASSES);

/**
 * `title` is deliberately NOT `.min(1)`. It was, and one task with an empty
 * title failed the whole-array parse and discarded every sibling with it —
 * measured against the live model, a generation whose FIRST task had
 * `"title": ""` and whose second was perfectly good yielded nothing at all.
 * Emptiness is a per-task question, answered in the cleaning loop, which can
 * often salvage the row from `detail`.
 */
const taskSchema = z.object({
  title: z.string(),
  detail: z.string().optional(),
  duration_minutes: z.number().optional(),
  l0_class: z.string().optional(),
});

/**
 * Items are held as `unknown` and validated ONE AT A TIME below, so a single
 * malformed task costs that task and not the batch.
 */
const responseSchema = z.object({
  tasks: z.array(z.unknown()),
});

/**
 * The response shape, as a JSON Schema handed to Ollama's structured-output
 * grammar.
 *
 * `format: 'json'` alone only guarantees the output PARSES — the model stays
 * free to invent key names, and `PROMPT_MODEL` (gemma3:1b) reliably does:
 * measured against the live model, "I want to make lunch" came back as
 * `{"tasks:**[": "  "}` and `{"tasks": {"2:": "Make lunch"}}` in 3 of 8 runs.
 * Both are valid JSON and neither survives validation, so the user saw
 * "nothing came back" about half the time. Constraining generation to this
 * schema removed every shape failure in the same test.
 *
 * Kept structurally in step with `responseSchema` above — that zod schema is
 * still the authority, because a schema-constrained model can (and does) emit
 * empty strings for required fields.
 */
const RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          duration_minutes: { type: 'integer' },
          l0_class: { type: 'string', enum: [...L0_CLASSES] },
        },
        required: ['title'],
      },
    },
  },
  required: ['tasks'],
};

type ParsedTask = z.infer<typeof taskSchema>;

/**
 * The model splits, it does not invent.
 *
 * The failure mode worth designing against is helpfulness: asked to "break this
 * down", a model will happily add the steps it thinks you forgot. That turns the
 * user's own list into the model's list, and every invented card costs a dismiss.
 * Hence the repeated instruction to stay inside the text, and the low temperature.
 */
const PROMPT_HEADER = `You split a person's rough notes into discrete, schedulable tasks.

Rules:
- Split ONLY what is written. Never invent a task the notes do not mention, and never add preparation, follow-up, or "best practice" steps of your own.
- One task per distinct thing to do. If the notes name one thing, return one task.
- title: a short imperative phrase (max 60 chars). No trailing period.
- detail: the user's own wording for this task, lightly tidied. Omit if the title already says all of it.
- duration_minutes: your estimate, 5..480. Omit if you cannot tell.
- l0_class: one of WORK, EXERCISE, SOCIAL, ERRAND, LEISURE, TRANSIT, SLEEP, UNKNOWN. Use UNKNOWN when unsure.
- Preserve the order the notes give.

Respond with STRICT JSON only, no prose and no markdown fence:
{"tasks":[{"title":"...","detail":"...","duration_minutes":30,"l0_class":"WORK"}]}

Notes:
`;

/**
 * Turns a free-text brain dump into schedule candidates.
 *
 * The user types "need to book the dentist, prep Thursday's deck, and call Mum
 * back" and gets three draggable cards in Possibilities. Nothing is scheduled —
 * the cards land in exactly the same `ci.event_candidates` table the adapters
 * write to, so accept / decline / snooze, provenance, and the
 * do-not-resurrect rule all apply unchanged. Committing still means dragging a
 * card onto a day, as it does for every other suggestion.
 *
 * Deliberately NOT under the `adapter/` generator prefix: SuggestionSyncService
 * retires stale `adapter/` rows whose source action has been dismissed, and a
 * hand-written task has no upstream source to go stale. These rows are the
 * user's own words and are retired only by the user.
 */
@Injectable()
export class TaskBreakdownService {
  constructor(
    private readonly candidateService: CandidateService,
    private readonly ollamaService: OllamaService,
    private readonly userContextService: UserContextService,
    private readonly recallService: RecallService,
    private readonly placement: PlacementService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(TaskBreakdownService.name);
  }

  /**
   * Break `text` into candidates and write them to the slate.
   *
   * @param at Instant the dump was written — anchors both the plausible window
   *   and the dedupe key. Injected rather than read from the clock so the same
   *   call is reproducible in a test.
   * @param budgetMs Total time both samples may spend on the model. Injected for
   *   the same reason as `at`: a test can prove the deadline is real without
   *   sitting out the real one.
   */
  async breakDown(
    context: UserServiceContext & RequestContext,
    text: string,
    at: Date = new Date(),
    budgetMs: number = BREAKDOWN_TIMEOUT_MS,
  ): Promise<Awaited<ReturnType<CandidateService['upsert']>>> {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      throw new BadRequestException('Nothing to break down');
    }

    if (trimmed.length > MAX_INPUT_CHARS) {
      throw new BadRequestException(`Keep it under ${MAX_INPUT_CHARS} characters`);
    }

    // One retry. Even schema-constrained, a 1B model occasionally returns a
    // task whose title is the empty string and nothing to salvage it from; a
    // second sample is far cheaper than making the user retype the note.
    //
    // Both samples draw on ONE deadline rather than getting a fresh one each,
    // so the retry cannot double what the user waits: the second sample gets
    // only what the first left of the budget, and is skipped outright once that
    // budget is spent.
    const deadline = AbortSignal.timeout(budgetMs);

    let tasks = await this.extract(context, trimmed, deadline);

    if (tasks.length === 0 && !deadline.aborted) {
      tasks = await this.extract(context, trimmed, deadline);
    }

    if (tasks.length === 0) {
      this.logger.warn('Task breakdown produced nothing usable after a retry', {
        chars: trimmed.length,
      });

      return [];
    }

    const timezone = context.userId ? await this.placement.timezoneFor(context.userId) : 'UTC';
    const { windowStart, windowEnd } = this.placement.flexWindow(timezone, at);
    // One dump is one batch: the index alone would collide across dumps, and the
    // raw text alone would collide if the user submits the same list twice on
    // purpose. Together they make re-submitting the same dump idempotent within
    // a second and distinct across separate sittings.
    const batch = `${at.toISOString()}`;

    const proposals: CreateCandidateDto[] = tasks.map((task, index) => ({
      title: task.title,
      description: task.detail,
      // The because is the user's own note. Nothing on this list appears without
      // one, and for a hand-written task the honest answer is "you said so".
      rationale: task.detail ? `You wrote: ${task.detail}` : 'You wrote this down.',
      rationale_sources: [{ kind: 'answer', id: batch, note: 'typed on the schedule' }],
      window_start: windowStart,
      window_end: windowEnd,
      time_flex: 'week',
      duration_minutes: task.duration_minutes ?? estimateActivityDurationMinutes(task.title, task.detail),
      l0_class: task.l0_class,
      dedupe_key: `braindump:${batch}:${index}`,
      generator: `${USER_AUTHORED_GENERATOR_PREFIX}llm`,
      // Not a prediction — the user asked for these. High, but not 1.0: the
      // split itself is the model's guess even when the content is not.
      confidence: 0.9,
    }));

    const written = await this.candidateService.upsert(context, proposals);

    this.logger.log('Brain dump broken into candidates', {
      chars: trimmed.length,
      extracted: tasks.length,
      written: written.length,
    });

    return written;
  }

  /** Call the model and return the tasks that survive validation. */
  private async extract(
    context: UserServiceContext & RequestContext,
    text: string,
    signal: AbortSignal,
  ): Promise<ParsedTask[]> {
    let content: string;

    let personaSection = '';
    try {
      const blocks: string[] = [];
      const userCtx = await this.userContextService.getUserContextForLLM(context.userId);
      if (userCtx) {
        blocks.push(this.userContextService.formatContextForSystemPrompt(userCtx));
      }

      const recall = await this.recallService.recall(context, {
        query: text,
        maxResults: 5,
      });
      if (recall.block.trim()) {
        blocks.push(recall.block);
      }

      if (blocks.length > 0) {
        personaSection = `\n\nAbout this person (use for duration estimates and l0_class only — do not invent tasks from this):\n${blocks.join('\n\n')}\n`;
      }
    } catch (err) {
      this.logger.warn('Task breakdown persona pack failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const response = await this.ollamaService.chat(
        context,
        [{ role: 'user', content: PROMPT_HEADER + personaSection + text }],
        // No tools: this is a pure text transform and a tool call here would only
        // be the model wandering off. The schema (not the bare 'json' string) is
        // what makes the output usable — see RESPONSE_JSON_SCHEMA.
        { model: PROMPT_MODEL, enableTools: false, format: RESPONSE_JSON_SCHEMA, signal },
      );

      content = response.message.content;
    } catch (err) {
      // Ollama unreachable, the model never pulled, or a load that outran the
      // deadline — the likeliest failure by far for a local 1B model, and none
      // of them are the user's problem. Same contract parseTasks already keeps
      // for a malformed generation: nothing came back, not a 500 on a note that
      // has just been typed and would otherwise be lost.
      this.logger.warn('Task breakdown generation failed', {
        err: err instanceof Error ? err.message : String(err),
      });

      return [];
    }

    const tasks = TaskBreakdownService.parseTasks(content);

    // Keep the evidence. Silently returning [] on a bad generation is what made
    // "nothing came back" impossible to diagnose from the logs alone.
    if (tasks.length === 0) {
      this.logger.warn('Model returned no usable tasks', { content: content?.slice(0, 500) });
    }

    return tasks;
  }

  /**
   * Parse the model's raw content into clean tasks.
   *
   * Tolerant of markdown fences and leading prose (same slice-to-outermost-braces
   * approach GraphEnrichmentService uses), and returns [] rather than throwing on
   * anything unparseable — a bad generation should surface as "nothing came back",
   * not as a 500.
   */
  static parseTasks(content: string): ParsedTask[] {
    let jsonStr = (content ?? '').replace(/```json\n?|\n?```/g, '').trim();

    const firstOpen = jsonStr.indexOf('{');
    const lastClose = jsonStr.lastIndexOf('}');

    if (firstOpen !== -1 && lastClose !== -1) {
      jsonStr = jsonStr.substring(firstOpen, lastClose + 1);
    }

    let parsed: z.infer<typeof responseSchema>;

    try {
      const result = responseSchema.safeParse(JSON.parse(jsonStr));

      if (!result.success) {
        return [];
      }

      parsed = result.data;
    } catch {
      return [];
    }

    const cleaned: ParsedTask[] = [];

    for (const item of parsed.tasks) {
      const candidate = taskSchema.safeParse(item);

      if (!candidate.success) {
        continue;
      }

      const task = candidate.data;
      const rawDetail = task.detail?.trim() ?? '';

      // A schema-constrained model still emits `"title": ""` and puts the task
      // in `detail` — measured, not hypothetical. It clearly identified the
      // task and only filed it in the wrong field, so promote the detail rather
      // than discard the row. Only a task with NEITHER is genuinely empty.
      const title = (task.title.trim() || rawDetail).replace(/\.$/, '');

      if (title.length === 0) {
        continue;
      }

      const detail = rawDetail;
      const l0 = task.l0_class?.trim().toUpperCase();
      const duration = task.duration_minutes;

      cleaned.push({
        title: title.slice(0, 60),
        // A detail that merely restates the title is noise on the card.
        ...(detail && detail.toLowerCase() !== title.toLowerCase() ? { detail } : {}),
        ...(typeof duration === 'number' &&
        Number.isFinite(duration) &&
        duration >= MIN_DURATION_MINUTES &&
        duration <= MAX_DURATION_MINUTES
          ? { duration_minutes: Math.round(duration) }
          : {}),
        // An out-of-vocabulary class is dropped rather than passed through: it
        // would colour the card as "unsorted" anyway, and this keeps whatever
        // the model invented out of ci.events.category on accept.
        ...(l0 && L0_SET.has(l0) && l0 !== 'UNKNOWN' ? { l0_class: l0 } : {}),
      });

      if (cleaned.length >= MAX_TASKS) {
        break;
      }
    }

    return cleaned;
  }
}
