import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import { type RequestContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OllamaService, PROMPT_MODEL } from '@ci/domains/llm';
import { UserContextService } from '@ci/domains/memory';
import { localDateInTZ, todayInTZ, zonedWallTimeToUTC } from '@ci/domains/planning';

import {
  calendarQuestion,
  cleanCandidateTitle,
  cleanUpcomingTitle,
  formatDayForQuestion,
  looksLikeGapNote,
  suggestPlanDay,
  upcomingEventQuestion,
} from '../calendarDay';
import {
  DEFAULT_SELECTOR_OPTIONS,
  GENERATABLE_SELECTOR_TYPES,
  SelectorSpecSchema,
  ContextPromptSourceSchema,
  parseJsonObject,
  selectorNeedsOptions,
  type ContextPromptPlace,
  type SelectorSpec,
  type SelectorType,
} from '../contextPrompt.types';
import { placeForSource, PlacementService, shiftLocalDate } from '../placement';

import { ContextPromptService } from './ContextPromptService';

const GENERATED_PROMPT_SCHEMA = z.object({
  prompt: z.string().min(8).max(400),
  selectorType: z.enum(GENERATABLE_SELECTOR_TYPES),
  hint: z.string().max(400).optional(),
  options: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  source: ContextPromptSourceSchema,
});

const GENERATED_PROMPT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    prompt: { type: 'string' },
    selectorType: { type: 'string', enum: [...GENERATABLE_SELECTOR_TYPES] },
    hint: { type: 'string' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, label: { type: 'string' } },
        required: ['id', 'label'],
      },
    },
    source: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['answer', 'question', 'entity', 'category_gap', 'event', 'candidate'],
        },
        id: { type: 'string' },
        label: { type: 'string' },
        day: { type: 'string' },
        place: { type: 'string', enum: ['future_this_week', 'last_night', 'further_back'] },
      },
      required: ['kind'],
    },
  },
  required: ['prompt', 'selectorType', 'source'],
};

type GapRow = {
  kind: string;
  id: string;
  label: string;
  day?: string;
  place?: ContextPromptPlace;
  title?: string;
};

type RecentHistory = { prompts: string[]; sourceKeys: Set<string> };

@Injectable()
export class ContextPromptGenerateService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly contextPromptService: ContextPromptService,
    private readonly userContextService: UserContextService,
    private readonly placement: PlacementService,
    private readonly ollamaService: OllamaService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ContextPromptGenerateService.name);
  }

  async generateIfEmpty(userId: string): Promise<boolean> {
    if (await this.contextPromptService.hasPending(userId)) {
      return false;
    }

    let gaps: GapRow[] = [];
    try {
      gaps = await this.collectGaps(userId);
    } catch (error) {
      this.logger.warn('Context prompt gap collection failed; generating without gaps', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const recent = await this.recentHistory(userId);
    gaps = gaps.filter((gap) => !this.gapBlocked(gap, recent));

    const userContext = await this.userContextService.getUserContextForLLM(userId);
    const dossier = userContext ? this.userContextService.formatContextForSystemPrompt(userContext) : '';
    const timezone = await this.placement.timezoneFor(userId);

    const prompt = [
      "You are me, the user's memory companion. Write ONE short question I will ask you (the user) out loud.",
      'The JSON "prompt" field is spoken to the user. I = the assistant. You = the user.',
      'Always address the user as you. Never say they, them, this person, or "ask what they did".',
      'Never paste a gap note as the question. Turn the note into something I would actually say.',
      'Bad: "HBPE predicted WORK yesterday evening with no actual. Ask what they did."',
      'Good: "I thought you were working last night — what did you actually do?"',
      'Ask about plans, last night, people, places, preferences, or anything I am missing.',
      'Keep it specific, one tap or one line. Do not ask "should I remember this" or confirm something I already know.',
      'Prefer a concrete unused gap (open schedule card, unanswered question, thin person/place) over a generic check-in.',
      'Never repeat a recent prompt or reuse a recent source id.',
      'If the note is a schedule suggestion, ask a yes/no (selectorType yes_no) that names the day: "for Thursday" this week, or "for July 31st" if further out. Never paste a clock time.',
      'If the note is an upcoming calendar event, ask a real question about it. Never paste "You have coming up" or a clock time.',
      '',
      'Selector types (pick the one that matches the decision):',
      '- yes_no / yes_no_not_sure / segmented_truth: confirm or qualify one claim',
      '- radio_list / a_b / tag_cloud / checklist: choose among concrete options you supply',
      '- feeling_grid: mood or reaction',
      '- one_line / paragraph / sentence_stem: you need to name something I cannot list',
      '- intensity_1_5: strength of a preference or habit',
      '- day_chips / recurrence / pick_a_day: when something happens or which day to place a plan',
      '- accept_slot: accept or pick among real schedule suggestions (only if candidates are listed)',
      '- person_picker / relationship: a known person (only if people are listed below)',
      '- home_work_other / what_did_you_do_here: a known place',
      '- connection_type: how two known things relate',
      '',
      'For radio_list, a_b, tag_cloud, and checklist you MUST supply 2–6 short options with stable ids.',
      'For "what did you do" questions, options may be WORK, EXERCISE, SOCIAL, ERRAND, LEISURE, TRANSIT, SLEEP, or use one_line.',
      'Name the source you are using (copy its kind and id from Useful gaps, or kind "category_gap").',
      'Set source.place: future_this_week for a plan this week, last_night for last night, further_back for an older evening.',
      'Reply with ONLY a JSON object, no prose. Shape:',
      '{"prompt":"Who is someone you want to see more of?","selectorType":"one_line","source":{"kind":"category_gap","id":"people"}}',
      dossier ? `Known context:\n${dossier.slice(0, 2500)}` : 'Known context: (thin)',
      gaps.length > 0
        ? `Notes for me (do not show these to you; rewrite as something I would ask you):\n${gaps.map((gap) => `- ${gap.kind} ${gap.id}: ${gap.label}${gap.day ? ` [offer ${formatDayForQuestion(gap.day, timezone)}]` : ''}`).join('\n')}`
        : 'Notes: none listed — ask a useful preference or identity question that is not in the recent list.',
      recent.prompts.length > 0
        ? `Do not repeat these recent prompts:\n${recent.prompts.map((item) => `- ${item}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const llmContext = { userId } as RequestContext;
    let parsed: z.infer<typeof GENERATED_PROMPT_SCHEMA>;

    try {
      const response = await this.ollamaService.chat(llmContext, [{ role: 'user', content: prompt }], {
        model: PROMPT_MODEL,
        enableTools: false,
        format: GENERATED_PROMPT_JSON_SCHEMA,
      });
      parsed = GENERATED_PROMPT_SCHEMA.parse(parseJsonObject(response.message.content));
    } catch (error) {
      this.logger.warn('Context prompt generation failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return false;
    }

    if (this.isRepeat(parsed, recent)) {
      const fallback = this.fallbackFromGaps(gaps, recent, timezone);
      if (!fallback) {
        this.logger.warn('Context prompt discarded — model repeated a recent prompt', {
          userId,
          prompt: parsed.prompt,
          source: parsed.source,
        });

        return false;
      }

      this.logger.warn('Context prompt replaced a repeated last-night/recent ask', {
        userId,
        repeated: parsed.prompt,
        replacement: fallback.prompt,
      });
      parsed = fallback;
    }

    parsed = this.normalizeParsed(parsed, gaps, timezone);

    const selector = await this.hydrateSelector(userId, parsed);
    if (!selector) {
      this.logger.warn('Context prompt discarded — selector had no usable options', {
        userId,
        selectorType: parsed.selectorType,
      });

      return false;
    }

    const context = { userId } as UserServiceContext;
    const created = await this.contextPromptService.createPending(context, {
      selector,
      source: parsed.source,
    });

    this.logger.log('Context prompt generated', {
      userId,
      promptId: created?.id,
      selectorType: selector.type,
    });

    return Boolean(created);
  }

  private async hydrateSelector(
    userId: string,
    parsed: z.infer<typeof GENERATED_PROMPT_SCHEMA>,
  ): Promise<SelectorSpec | null> {
    let type: SelectorType = parsed.selectorType;
    let options = parsed.options;

    if (type === 'person_picker') {
      const people = await this.loadEntities(userId, 'Person');
      if (people.length === 0) {
        type = 'one_line';
        options = undefined;
      } else {
        options = people;
      }
    }

    if (type === 'home_work_other' || type === 'what_did_you_do_here') {
      const places = await this.loadEntities(userId, 'Place');
      if (type === 'home_work_other' && places.length > 0) {
        options = places;
      }
    }

    if (parsed.source.kind === 'candidate') {
      type = 'yes_no';
      options = DEFAULT_SELECTOR_OPTIONS.yes_no;
    }

    if (type === 'accept_slot') {
      const slots = await this.loadOpenCandidates(userId);
      if (slots.length === 0) {
        type = 'yes_no';
        options = DEFAULT_SELECTOR_OPTIONS.yes_no;
      } else {
        options = slots;
      }
    }

    if (type === 'pick_a_day' && !options?.length) {
      options = this.nextDays(7);
    }

    if (!options?.length) {
      options = DEFAULT_SELECTOR_OPTIONS[type];
    }

    if (selectorNeedsOptions(type) && !options?.length) {
      return null;
    }

    return SelectorSpecSchema.parse({
      type,
      prompt: parsed.prompt,
      hint: parsed.hint,
      options,
    });
  }

  private async loadEntities(
    userId: string,
    entityType: string | null,
  ): Promise<Array<{ id: string; label: string }>> {
    const rows = (await this.dataSource.query(
      `
      SELECT entity_id::text AS id, COALESCE(name, entity_type) AS label
      FROM ci.entities
      WHERE owner_user_id = $1
        AND merged_into_entity_id IS NULL
        AND COALESCE(linked_table, '') <> 'import:self'
        AND ($2::text IS NULL OR entity_type = $2)
      ORDER BY updated_at DESC
      LIMIT 12
      `,
      [userId, entityType],
    )) as Array<{ id: string; label: string }>;

    return rows;
  }

  private async recentHistory(userId: string): Promise<RecentHistory> {
    const rows = (await this.dataSource.query(
      `
      SELECT selector->>'prompt' AS prompt,
             source->>'kind' AS kind,
             source->>'id' AS id,
             source->>'day' AS day,
             response,
             status
      FROM ci.context_prompts
      WHERE user_id = $1
        AND status IN ('pending', 'answered', 'skipped', 'written', 'failed')
      ORDER BY created_at DESC
      LIMIT 12
      `,
      [userId],
    )) as Array<{
      prompt: string | null;
      kind: string | null;
      id: string | null;
      day: string | null;
      response: unknown;
      status: string;
    }>;

    const sourceKeys = new Set<string>();
    for (const row of rows) {
      if (!row.kind || !row.id) {
        continue;
      }

      if (row.kind === 'candidate') {
        const deferred =
          row.status === 'skipped' ||
          row.status === 'failed' ||
          row.response === 'no' ||
          row.response === 'not_sure';
        if (deferred && row.day) {
          sourceKeys.add(this.sourceKey(row.kind, row.id, row.day));
        } else {
          sourceKeys.add(this.sourceKey(row.kind, row.id));
          if (row.day) {
            sourceKeys.add(this.sourceKey(row.kind, row.id, row.day));
          }
        }
      } else {
        sourceKeys.add(this.sourceKey(row.kind, row.id));
      }
    }

    return {
      prompts: rows.map((row) => row.prompt).filter((prompt): prompt is string => Boolean(prompt)),
      sourceKeys,
    };
  }

  private sourceKey(kind: string, id: string, day?: string | null): string {
    return day ? `${kind}:${id}:${day}` : `${kind}:${id}`;
  }

  private gapBlocked(gap: GapRow, recent: RecentHistory): boolean {
    if (gap.kind === 'candidate') {
      if (recent.sourceKeys.has(this.sourceKey(gap.kind, gap.id))) {
        return true;
      }

      return Boolean(gap.day && recent.sourceKeys.has(this.sourceKey(gap.kind, gap.id, gap.day)));
    }

    return recent.sourceKeys.has(this.sourceKey(gap.kind, gap.id));
  }

  private normalizePrompt(prompt: string): string {
    return prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private isRepeat(parsed: z.infer<typeof GENERATED_PROMPT_SCHEMA>, recent: RecentHistory): boolean {
    const prompt = this.normalizePrompt(parsed.prompt);
    if (recent.prompts.some((item) => this.normalizePrompt(item) === prompt)) {
      return true;
    }

    if (parsed.source.id && this.gapBlocked({ ...parsed.source, id: parsed.source.id, label: '' }, recent)) {
      return true;
    }

    if (
      looksLikeGapNote(parsed.prompt) ||
      /\b(they|them|this person|hbpe predicted|ask what they|no actual)\b/i.test(parsed.prompt)
    ) {
      return true;
    }

    return false;
  }

  private fallbackFromGaps(
    gaps: GapRow[],
    recent: RecentHistory,
    timezone: string,
  ): z.infer<typeof GENERATED_PROMPT_SCHEMA> | null {
    const gap = gaps.find((item) => !this.gapBlocked(item, recent));
    if (!gap) {
      const generic = [
        'What are you looking forward to this week?',
        'Who have you been thinking about lately?',
        'What is one habit you want to keep?',
        'Where do you feel most like yourself?',
      ].find(
        (item) =>
          !recent.prompts.some((prompt) => this.normalizePrompt(prompt) === this.normalizePrompt(item)),
      );

      return generic
        ? {
            prompt: generic,
            selectorType: 'one_line',
            source: { kind: 'category_gap', id: 'context' },
          }
        : null;
    }

    const kind = ContextPromptSourceSchema.shape.kind.safeParse(gap.kind);
    if (!kind.success) {
      return null;
    }

    return {
      prompt: this.questionFromGap(gap, timezone),
      selectorType: gap.kind === 'candidate' ? 'yes_no' : 'one_line',
      source: {
        kind: kind.data,
        id: gap.id,
        label: gap.label,
        day: gap.day,
        place: gap.place ?? placeForSource({ kind: kind.data, id: gap.id, day: gap.day }),
      },
    };
  }

  private normalizeParsed(
    parsed: z.infer<typeof GENERATED_PROMPT_SCHEMA>,
    gaps: GapRow[],
    timezone: string,
  ): z.infer<typeof GENERATED_PROMPT_SCHEMA> {
    const gap = gaps.find((item) => item.kind === parsed.source.kind && item.id === parsed.source.id);
    const place = parsed.source.place ?? gap?.place ?? placeForSource(parsed.source);

    if (this.isUpcomingEvent(parsed, gap)) {
      const title = gap?.title ?? parsed.source.label ?? parsed.prompt;
      const day = gap?.day ?? parsed.source.day;
      const dayPhrase = day ? formatDayForQuestion(day, timezone) : undefined;

      return {
        ...parsed,
        selectorType: 'one_line',
        prompt: upcomingEventQuestion(title, dayPhrase),
        source: { ...parsed.source, label: cleanUpcomingTitle(title), day, place },
      };
    }

    if (parsed.source.kind !== 'candidate') {
      if (looksLikeGapNote(parsed.prompt) && gap) {
        return {
          ...parsed,
          prompt: this.questionFromGap(gap, timezone),
          source: { ...parsed.source, place, day: gap.day, label: gap.title ?? parsed.source.label },
        };
      }

      return place ? { ...parsed, source: { ...parsed.source, place } } : parsed;
    }

    const title = cleanCandidateTitle(gap?.title ?? gap?.label ?? parsed.source.label ?? parsed.prompt);
    const day = gap?.day ?? parsed.source.day;
    const dayPhrase = day ? formatDayForQuestion(day, timezone) : undefined;

    return {
      ...parsed,
      selectorType: 'yes_no',
      prompt: calendarQuestion(title, dayPhrase),
      source: { ...parsed.source, label: title, day, place: place ?? 'future_this_week' },
    };
  }

  private isUpcomingEvent(parsed: z.infer<typeof GENERATED_PROMPT_SCHEMA>, gap: GapRow | undefined): boolean {
    if (gap?.kind === 'event' && gap.title && gap.day && !gap.place) {
      return true;
    }

    return /you have coming up/i.test(parsed.prompt) || /you have coming up/i.test(gap?.label ?? '');
  }

  private questionFromGap(gap: GapRow, timezone: string): string {
    if (
      gap.id === 'last-night' ||
      gap.place === 'last_night' ||
      /yesterday evening|last night/i.test(gap.label)
    ) {
      return 'I thought I knew what you were doing last night — what did you actually do?';
    }

    if (gap.id === 'night-2') {
      return 'What were you up to the night before last? I have a gap there.';
    }

    if (gap.place === 'further_back' || /^night-\d+$/.test(gap.id)) {
      return 'What were you doing a few nights ago? I am missing that evening.';
    }

    if (gap.kind === 'candidate') {
      const dayPhrase = gap.day ? formatDayForQuestion(gap.day, timezone) : undefined;

      return calendarQuestion(gap.title ?? gap.label, dayPhrase);
    }

    if (gap.kind === 'event' && (gap.title || /coming up/i.test(gap.label))) {
      const dayPhrase = gap.day ? formatDayForQuestion(gap.day, timezone) : undefined;

      return upcomingEventQuestion(gap.title ?? gap.label, dayPhrase);
    }

    if (gap.kind === 'entity' && /how you know/i.test(gap.label)) {
      return gap.label.replace(/^I do not know how you know\s+/i, 'How do you know ').replace(/\.$/, '?');
    }

    if (gap.kind === 'entity' && /what you do at/i.test(gap.label)) {
      return gap.label
        .replace(/^I do not know what you do at\s+/i, 'What do you usually do at ')
        .replace(/\.$/, '?');
    }

    return gap.label.replace(/\.$/, '?');
  }

  private async collectGaps(userId: string): Promise<GapRow[]> {
    const thinPeople = (await this.dataSource.query(
      `
      SELECT 'entity' AS kind, e.entity_id::text AS id,
             'I do not know how you know ' || COALESCE(e.name, 'this person') || '.' AS label
      FROM ci.entities e
      WHERE e.owner_user_id = $1
        AND e.merged_into_entity_id IS NULL
        AND e.entity_type = 'Person'
        AND COALESCE(e.linked_table, '') <> 'import:self'
        AND NOT EXISTS (
          SELECT 1
          FROM ci.relationships r
          WHERE r.owner_user_id = $1
            AND (r.from_entity_id = e.entity_id OR r.to_entity_id = e.entity_id)
            AND r.relationship_type IN ('KNOWS', 'FRIEND_OF', 'FAMILY', 'SPOUSE', 'PARENT_OF', 'CHILD_OF', 'COLLEAGUE')
        )
      ORDER BY e.updated_at DESC
      LIMIT 6
      `,
      [userId],
    )) as GapRow[];

    const thinPlaces = (await this.dataSource.query(
      `
      SELECT 'entity' AS kind, e.entity_id::text AS id,
             'I do not know what you do at ' || COALESCE(e.name, 'this place') || '.' AS label
      FROM ci.entities e
      WHERE e.owner_user_id = $1
        AND e.merged_into_entity_id IS NULL
        AND e.entity_type = 'Place'
        AND COALESCE(e.properties->>'whatIDoHere', e.properties->>'role') IS NULL
      ORDER BY e.updated_at DESC
      LIMIT 6
      `,
      [userId],
    )) as GapRow[];

    const questions = (await this.dataSource.query(
      `
      SELECT 'question' AS kind, q.question_id::text AS id,
             COALESCE(q.question_category || ': ', '') || LEFT(q.question_text, 140) AS label
      FROM ci.questions q
      WHERE q.is_active = TRUE
        AND (q.is_private_to IS NULL OR q.is_private_to = $1)
        AND NOT EXISTS (
          SELECT 1 FROM ci.answers a
          WHERE a.question_id = q.question_id AND a.user_id = $1
            AND a.answer_text IS NOT NULL AND TRIM(a.answer_text) <> ''
        )
      ORDER BY q.created_at ASC
      LIMIT 5
      `,
      [userId],
    )) as GapRow[];

    const weakestCategory = (await this.dataSource.query(
      `
      WITH category_coverage AS (
        SELECT
          q.question_category AS category,
          COUNT(DISTINCT a.answer_id)::int AS answered_count
        FROM ci.questions q
        LEFT JOIN ci.answers a
          ON a.question_id = q.question_id
          AND a.user_id = $1
          AND a.answer_text IS NOT NULL
          AND TRIM(a.answer_text) <> ''
        WHERE q.is_active = TRUE
          AND (q.is_private_to IS NULL OR q.is_private_to = $1)
        GROUP BY q.question_category
      )
      SELECT category
      FROM category_coverage
      ORDER BY answered_count ASC, category ASC NULLS LAST
      LIMIT 1;
      `,
      [userId],
    )) as Array<{ category: string | null }>;

    const categoryGaps: GapRow[] = weakestCategory[0]?.category
      ? [
          {
            kind: 'category_gap',
            id: weakestCategory[0].category,
            label: `I still know little about your ${weakestCategory[0].category}.`,
          },
        ]
      : [];

    const timezone = await this.placement.timezoneFor(userId);
    const eveningGaps = await this.collectEveningGaps(userId, timezone);
    const candidateRows = (await this.dataSource.query(
      `
      SELECT c.candidate_id::text AS id,
             LEFT(c.title, 80) AS title,
             c.rationale,
             c.window_end
      FROM ci.event_candidates c
      WHERE c.user_id = $1
        AND c.status = 'open'
        AND c.window_end >= NOW()
      ORDER BY c.fit_score DESC NULLS LAST, c.created_at DESC
      LIMIT 6
      `,
      [userId],
    )) as Array<{ id: string; title: string; rationale: string | null; window_end: Date }>;
    const candidates: GapRow[] = candidateRows.map((row) => {
      const day = suggestPlanDay(timezone, new Date(row.window_end), `${row.title} ${row.rationale ?? ''}`);
      const dayPhrase = day ? formatDayForQuestion(day, timezone) : undefined;

      return {
        kind: 'candidate',
        id: row.id,
        label: dayPhrase
          ? `I have a plan for you for ${dayPhrase}: ${row.title}`
          : `I have a plan for you this week: ${row.title}`,
        day,
        place: 'future_this_week' as const,
        title: row.title,
      };
    });

    const upcomingRows = (await this.dataSource.query(
      `
      SELECT e.event_id::text AS id,
             LEFT(COALESCE(ent.name, 'untitled'), 80) AS title,
             e.start_time
      FROM ci.events e
      LEFT JOIN ci.entities ent ON ent.entity_id = e.event_id
      WHERE e.user_id = $1
        AND COALESCE(e.is_deleted, FALSE) = FALSE
        AND e.start_time >= NOW()
        AND e.start_time < NOW() + INTERVAL '7 days'
      ORDER BY e.start_time ASC
      LIMIT 6
      `,
      [userId],
    )) as Array<{ id: string; title: string; start_time: Date }>;
    const upcoming: GapRow[] = upcomingRows.map((row) => {
      const day = localDateInTZ(new Date(row.start_time), timezone);

      return {
        kind: 'event',
        id: row.id,
        title: row.title,
        day,
        label: `You have coming up: ${row.title}`,
      };
    });

    const lastNightOpen = eveningGaps.some((gap) => gap.id === 'last-night');
    const hbpeGaps = lastNightOpen
      ? (await this.collectHbpeActualGaps(userId)).map((gap) => ({ ...gap, place: 'last_night' as const }))
      : [];

    const followUps = (await this.dataSource.query(
      `
      SELECT 'answer' AS kind, a.answer_id::text AS id,
             'You recently said (follow up, do not just confirm): ' || LEFT(a.answer_text, 120) AS label
      FROM ci.answers a
      WHERE a.user_id = $1
        AND a.answer_text IS NOT NULL
        AND char_length(trim(a.answer_text)) BETWEEN 1 AND 40
      ORDER BY a.answered_at DESC NULLS LAST
      LIMIT 4
      `,
      [userId],
    )) as GapRow[];

    return [
      ...eveningGaps,
      ...hbpeGaps,
      ...candidates,
      ...upcoming,
      ...thinPeople,
      ...thinPlaces,
      ...questions,
      ...categoryGaps,
      ...followUps,
    ];
  }

  private async collectEveningGaps(userId: string, timezone: string): Promise<GapRow[]> {
    const gaps: GapRow[] = [];
    for (const offset of [1, 2, 3]) {
      if (await this.eveningHasContext(userId, timezone, offset)) {
        continue;
      }

      const id = offset === 1 ? 'last-night' : `night-${offset}`;
      const place: ContextPromptPlace = offset === 1 ? 'last_night' : 'further_back';
      const when = offset === 1 ? 'last night' : offset === 2 ? 'the night before last' : 'a few nights ago';
      gaps.push({
        kind: 'event',
        id,
        label: `I have nothing useful on your calendar ${when}. I should ask what you actually did.`,
        place,
      });
    }

    return gaps;
  }

  private async eveningHasContext(userId: string, timezone: string, offset: number): Promise<boolean> {
    const day = shiftLocalDate(todayInTZ(timezone), -offset);
    const start = zonedWallTimeToUTC(day, '18:00', timezone);
    const end = zonedWallTimeToUTC(shiftLocalDate(day, 1), '04:00', timezone);
    const nightId = offset === 1 ? 'last-night' : `night-${offset}`;

    const events = (await this.dataSource.query(
      `
      SELECT 1
      FROM ci.events e
      LEFT JOIN ci.entities ent ON ent.entity_id = e.event_id
      WHERE e.user_id = $1
        AND COALESCE(e.is_deleted, FALSE) = FALSE
        AND COALESCE(e.is_predicted, FALSE) = FALSE
        AND e.start_time >= $2
        AND e.start_time < $3
        AND char_length(trim(COALESCE(ent.name, ''))) >= 12
      LIMIT 1
      `,
      [userId, start, end],
    )) as unknown[];
    if (events.length > 0) {
      return true;
    }

    const answers = (await this.dataSource.query(
      `
      SELECT 1
      FROM ci.answers a
      WHERE a.user_id = $1
        AND a.session_context->'source'->>'id' = $2
        AND char_length(trim(COALESCE(a.answer_text, ''))) >= 12
      LIMIT 1
      `,
      [userId, nightId],
    )) as unknown[];
    if (answers.length > 0) {
      return true;
    }

    const prompts = (await this.dataSource.query(
      `
      SELECT 1
      FROM ci.context_prompts
      WHERE user_id = $1
        AND source->>'id' = $2
        AND status IN ('answered', 'written')
      LIMIT 1
      `,
      [userId, nightId],
    )) as unknown[];

    return prompts.length > 0;
  }

  private async collectHbpeActualGaps(userId: string): Promise<GapRow[]> {
    try {
      return (await this.dataSource.query(
        `
        SELECT 'event' AS kind, pl.id::text AS id,
               'I predicted you were doing ' || dominant || ' yesterday evening, but I never heard what you actually did.' AS label
        FROM (
          SELECT
            pl.id,
            (
              SELECT key
              FROM jsonb_each_text(pl.l0_probs)
              ORDER BY value::double precision DESC NULLS LAST
              LIMIT 1
            ) AS dominant
          FROM hbpe.prediction_log pl
          WHERE pl.user_id = $1
            AND pl.actual_l0 IS NULL
            AND (pl.horizon_start AT TIME ZONE 'UTC')::date = (NOW() AT TIME ZONE 'UTC')::date - 1
            AND pl.bucket_index BETWEEN 36 AND 47
          ORDER BY pl.predicted_at DESC
          LIMIT 1
        ) pl
        WHERE dominant IS NOT NULL
        `,
        [userId],
      )) as GapRow[];
    } catch (error) {
      this.logger.warn('HBPE actuals gap query skipped', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return [];
    }
  }

  private async loadOpenCandidates(userId: string): Promise<Array<{ id: string; label: string }>> {
    return (await this.dataSource.query(
      `
      SELECT candidate_id::text AS id,
             LEFT(title, 80) || ' · this week' AS label
      FROM ci.event_candidates
      WHERE user_id = $1
        AND status = 'open'
        AND window_end >= NOW()
      ORDER BY fit_score DESC NULLS LAST, created_at DESC
      LIMIT 8
      `,
      [userId],
    )) as Array<{ id: string; label: string }>;
  }

  private nextDays(count: number): Array<{ id: string; label: string }> {
    return Array.from({ length: count }, (_, index) => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() + index);
      const id = date.toISOString().slice(0, 10);

      return {
        id,
        label: date.toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        }),
      };
    });
  }
}
