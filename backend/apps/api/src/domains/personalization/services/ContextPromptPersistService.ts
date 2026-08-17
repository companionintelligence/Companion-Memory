import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import { type RequestContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { GraphIngestService } from '@ci/domains/graph';
import { AnswerService, QuestionService } from '@ci/domains/intelligence';
import { OllamaService, PROMPT_MODEL } from '@ci/domains/llm';
import { EventService } from '@ci/domains/memory';
import { todayInTZ } from '@ci/domains/planning';

import {
  parseJsonObject,
  type ContextPromptSource,
  type ContextPromptWritePlan,
  type SelectorSpec,
} from '../contextPrompt.types';
import {
  isDayDeferral,
  isNegativeResponse,
  nightOffsetFromSource,
  placeForSource,
  PlacementService,
  resolveActualStart,
  resolveEnd,
  resolvePlanStart,
  shiftLocalDate,
  splitActivities,
  writerFor,
} from '../placement';

import { ContextPromptService } from './ContextPromptService';

const TimesSchema = z.object({
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  durationMinutes: z.number().optional(),
  title: z.string().optional(),
  category: z.string().optional(),
  events: z
    .array(
      z.object({
        title: z.string().min(1),
        startTime: z.string().optional(),
        durationMinutes: z.number().optional(),
        category: z.string().optional(),
      }),
    )
    .optional(),
});

const TIMES_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    startTime: { type: 'string' },
    endTime: { type: 'string' },
    durationMinutes: { type: 'number' },
    title: { type: 'string' },
    category: { type: 'string' },
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          startTime: { type: 'string' },
          durationMinutes: { type: 'number' },
          category: { type: 'string' },
        },
        required: ['title'],
      },
    },
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class ContextPromptPersistService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly contextPromptService: ContextPromptService,
    private readonly answerService: AnswerService,
    private readonly questionService: QuestionService,
    private readonly graphIngestService: GraphIngestService,
    private readonly eventService: EventService,
    private readonly placement: PlacementService,
    private readonly ollamaService: OllamaService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ContextPromptPersistService.name);
  }

  async persist(userId: string, promptId: string): Promise<void> {
    const row = await this.contextPromptService.findById(promptId, userId);
    if (!row || (row.status !== 'answered' && row.status !== 'failed')) {
      return;
    }

    const context = { userId } as UserServiceContext;
    const timezone = await this.placement.timezoneFor(userId);
    const writer =
      isDayDeferral(row.response, row.source) || isNegativeResponse(row.response)
        ? 'skip_write'
        : writerFor(row.source);
    let plan: ContextPromptWritePlan = { writer, properties: {} };

    try {
      const questionId = await this.writeLinkedQa(context, row);
      plan = { ...plan, questionId };

      if (writer === 'write_event_actual' || writer === 'write_schedule_accept') {
        plan = { ...plan, ...(await this.fillTimes(userId, row, timezone, writer)) };
        await this.execute(context, plan, row.selector, row.response, row.source, timezone);
      }

      await this.contextPromptService.markWritten(promptId, plan);
    } catch (error) {
      this.logger.error('Context prompt write failed', {
        userId,
        promptId,
        writer: plan.writer,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.contextPromptService.markFailed(promptId, plan);
    }
  }

  /**
   * Every selector response becomes a real `ci.questions` + `ci.answers` pair
   * so the question text is stored with the answer, not only on the prompt row.
   */
  private async writeLinkedQa(
    context: UserServiceContext,
    row: { id: string; selector: SelectorSpec; response: unknown; source: ContextPromptSource },
  ): Promise<string> {
    const text = this.responseText(row.response, row.selector);
    const already = (await this.dataSource.query(
      `
      SELECT a.answer_id::text AS id, a.question_id::text AS question_id
      FROM ci.answers a
      WHERE a.user_id = $1
        AND a.session_context->>'contextPromptId' = $2
      LIMIT 1
      `,
      [context.userId, row.id],
    )) as Array<{ id: string; question_id: string }>;
    if (already[0]?.question_id) {
      return already[0].question_id;
    }

    const questionId =
      row.source.kind === 'question' && this.isUuid(row.source.id)
        ? row.source.id
        : await this.ensurePromptQuestion(context, row.selector.prompt, row.source);

    await this.answerService.create(context, {
      text,
      question: { id: questionId },
      answerMethod: 'user',
      answerSource: 'user_input',
      sessionContext: {
        contextPromptId: row.id,
        selectorType: row.selector.type,
        source: row.source,
      },
    });

    return questionId;
  }

  private async ensurePromptQuestion(
    context: UserServiceContext,
    prompt: string,
    source: ContextPromptSource,
  ): Promise<string> {
    const existing = (await this.dataSource.query(
      `
      SELECT question_id::text AS id
      FROM ci.questions
      WHERE question_text = $1
        AND is_private_to = $2
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [prompt, context.userId],
    )) as Array<{ id: string }>;

    if (existing[0]?.id) {
      return existing[0].id;
    }

    const created = await this.questionService.create(context, {
      text: prompt,
      category: this.questionCategory(source),
      isSeedQuestion: false,
      createdByLlm: true,
      isActive: false,
      isPrivateTo: context.userId,
    });

    return created.id;
  }

  private questionCategory(source: ContextPromptSource): string {
    if (source.kind === 'category_gap' && source.id) {
      return source.id;
    }

    if (source.kind === 'event' || source.kind === 'candidate') {
      return 'schedule';
    }

    if (source.kind === 'entity') {
      return 'people';
    }

    return 'context';
  }

  private isUuid(value: string | undefined): value is string {
    return Boolean(value && UUID_RE.test(value));
  }

  private responseText(response: unknown, spec: SelectorSpec): string {
    const options = spec.options ?? [];
    const labelFor = (id: string) => options.find((option) => option.id === id)?.label ?? id;

    if (typeof response === 'string') {
      return labelFor(response);
    }

    if (typeof response === 'number') {
      return String(response);
    }

    if (Array.isArray(response)) {
      return response.map((item) => labelFor(String(item))).join(', ');
    }

    return JSON.stringify(response);
  }

  private async execute(
    context: UserServiceContext,
    plan: ContextPromptWritePlan,
    spec: SelectorSpec,
    response: unknown,
    source: ContextPromptSource,
    timezone: string,
  ): Promise<void> {
    const text = this.responseText(response, spec);
    const properties = { ...plan.properties, userResponse: response, responseText: text };

    switch (plan.writer) {
      case 'skip_write':
        return;
      case 'write_answer':
      case 'write_inferred_fact': {
        const questionId = this.isUuid(plan.questionId)
          ? plan.questionId
          : source.kind === 'question' && this.isUuid(source.id)
            ? source.id
            : undefined;
        if (!questionId) {
          await this.writeConcept(context, plan, text, properties);

          return;
        }

        await this.answerService.create(context, {
          text,
          question: { id: questionId },
          answerMethod: plan.writer === 'write_inferred_fact' ? 'inferred' : 'user',
          answerSource: plan.writer === 'write_inferred_fact' ? 'inferred' : 'user_input',
        });

        return;
      }

      case 'write_graph_entity':
        await this.writeConcept(context, plan, text, properties);

        return;
      case 'write_graph_relationship': {
        if (!this.isUuid(plan.fromEntityId) || !this.isUuid(plan.toEntityId) || !plan.relationshipType) {
          throw new Error('write_graph_relationship requires fromEntityId, toEntityId, relationshipType');
        }

        await this.graphIngestService.ingest(context, {
          entities: [],
          relationships: [
            {
              fromKey: 'from',
              toKey: 'to',
              type: plan.relationshipType,
              fromEntityId: plan.fromEntityId,
              fromEntityType: plan.entityType ?? 'Person',
              toEntityId: plan.toEntityId,
              toEntityType: plan.entityType ?? 'Person',
              properties,
            },
          ],
        });

        return;
      }

      case 'write_person_properties':
      case 'write_place_properties': {
        const entityId = this.isUuid(plan.entityId)
          ? plan.entityId
          : source.kind === 'entity' && this.isUuid(source.id)
            ? source.id
            : undefined;
        if (!entityId) {
          throw new Error('property write requires entityId');
        }

        const merged =
          plan.writer === 'write_place_properties'
            ? { ...properties, whatIDoHere: text }
            : { ...properties, role: text };
        const result = (await this.dataSource.query(
          `
          UPDATE ci.entities
          SET properties = COALESCE(properties, '{}'::jsonb) || $2::jsonb,
              updated_at = NOW()
          WHERE entity_id = $1 AND owner_user_id = $3
          RETURNING entity_id
          `,
          [entityId, JSON.stringify(merged), context.userId],
        )) as Array<{ entity_id: string }>;
        if (result.length === 0) {
          throw new Error('property write matched no entity');
        }

        return;
      }

      case 'write_event_actual': {
        await this.writeActualEvents(context, plan, text, source, response, timezone);

        return;
      }

      case 'write_schedule_accept': {
        const selected = typeof response === 'string' && this.isUuid(response) ? response : undefined;
        const candidateId =
          selected ??
          (this.isUuid(plan.entityId) ? plan.entityId : undefined) ??
          (source.kind === 'candidate' && this.isUuid(source.id) ? source.id : undefined);
        if (!candidateId) {
          throw new Error('write_schedule_accept requires a candidate id');
        }

        const start = resolvePlanStart(timezone, source.day, plan.startTime);
        await this.placement.acceptCandidate(context, candidateId, start, {
          durationMinutes: plan.durationMinutes,
          endTime: plan.endTime,
        });

        return;
      }

      default:
        throw new Error(`Unknown writer: ${String(plan.writer)}`);
    }
  }

  private async writeConcept(
    context: UserServiceContext,
    plan: ContextPromptWritePlan,
    text: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    const name = plan.name?.trim() || text || 'Untitled';
    const entityType = plan.entityType ?? 'Concept';
    const relationshipType = plan.relationshipType ?? 'INTERESTED_IN';

    await this.graphIngestService.ingest(context, {
      entities: [
        {
          key: `context-prompt:${entityType}:${name}`,
          entityType,
          name,
          sourceSystem: 'context_prompt',
          properties,
        },
      ],
      relationships: [
        {
          fromKey: 'self',
          toKey: `context-prompt:${entityType}:${name}`,
          type: relationshipType,
          properties,
        },
      ],
    });
  }

  private async fillTimes(
    userId: string,
    row: { selector: SelectorSpec; response: unknown; source: ContextPromptSource },
    timezone: string,
    writer: 'write_event_actual' | 'write_schedule_accept',
  ): Promise<Partial<ContextPromptWritePlan>> {
    const text = this.responseText(row.response, row.selector);
    const today = todayInTZ(timezone);
    const place = placeForSource(row.source);
    const nightOffset = nightOffsetFromSource(row.source);
    const evening = shiftLocalDate(today, -nightOffset);
    const offered = row.source.day ?? shiftLocalDate(today, 1);

    const prompt = [
      'Fill start and duration only. Do not choose a writer.',
      `User timezone: ${timezone}. Today is ${today}.`,
      writer === 'write_event_actual'
        ? `This is a recalled evening (${place ?? 'last_night'}). Default startTime to ${evening} around 20:00 in ${timezone}.`
        : `This is accepting a plan. startTime must be on ${offered} around 10:00 in ${timezone} unless the answer names a time.`,
      'Never use the current moment.',
      'durationMinutes: 15–480. Soccer ~90, movie ~150, dinner ~90, coffee ~45, planning ~45.',
      writer === 'write_event_actual'
        ? 'If they named more than one activity, return events: [{title, startTime, durationMinutes}]. Short titles. Split "Venice and then Griffin\'s" into two events.'
        : '',
      `Question: ${row.selector.prompt}`,
      `Answer: ${JSON.stringify(row.response)}`,
      `Source: ${JSON.stringify(row.source)}`,
      'Return JSON only.',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const response = await this.ollamaService.chat(
        { userId } as RequestContext,
        [{ role: 'user', content: prompt }],
        {
          model: PROMPT_MODEL,
          enableTools: false,
          format: TIMES_JSON_SCHEMA,
        },
      );
      const times = TimesSchema.parse(parseJsonObject(response.message.content));
      if (writer === 'write_event_actual' && !times.events?.length) {
        return { ...times, events: splitActivities(text).map((title) => ({ title })) };
      }

      return times;
    } catch (error) {
      this.logger.warn('Context prompt time fill fell back to placement defaults', {
        userId,
        writer,
        error: error instanceof Error ? error.message : String(error),
      });

      return writer === 'write_event_actual'
        ? { events: splitActivities(text).map((title) => ({ title })) }
        : {};
    }
  }

  private async writeActualEvents(
    context: UserServiceContext,
    plan: ContextPromptWritePlan,
    text: string,
    source: ContextPromptSource,
    response: unknown,
    timezone: string,
  ): Promise<void> {
    const items: Array<{
      title: string;
      startTime?: string;
      durationMinutes?: number;
      category?: string;
    }> =
      plan.events && plan.events.length > 0
        ? plan.events
        : splitActivities(plan.title?.trim() || text).map((title) => ({ title }));
    const place = placeForSource(source);
    const nightOffset = nightOffsetFromSource(source);
    let cursor = resolveActualStart(timezone, place, plan.startTime, nightOffset);

    for (const item of items) {
      const start = resolveActualStart(timezone, place, item.startTime ?? plan.startTime, nightOffset);
      const at = item.startTime ? start : cursor;
      const end = resolveEnd(at, {
        durationMinutes: item.durationMinutes ?? plan.durationMinutes,
        endTime: plan.endTime,
        hints: [item.title, text],
      });
      const category =
        item.category ?? plan.category ?? this.activityClass(item.title) ?? this.activityClass(text);
      await this.eventService.create(context, {
        title: item.title.trim() || 'Activity',
        start_time: at,
        end_time: end,
        category,
        status: 'confirmed',
        is_predicted: false,
        created_by: 'context_prompt',
        inference_sources: { source, response, part: item.title },
      });
      cursor = end;
    }
  }

  private activityClass(text: string): string | undefined {
    const normalized = text.trim().toUpperCase();
    const classes = ['WORK', 'EXERCISE', 'SOCIAL', 'ERRAND', 'LEISURE', 'TRANSIT', 'SLEEP', 'UNKNOWN'];

    return classes.includes(normalized) ? normalized : undefined;
  }
}
