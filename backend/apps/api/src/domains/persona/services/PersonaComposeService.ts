import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { type RequestContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OllamaService, PROMPT_MODEL } from '@ci/domains/llm';
import {
  CandidateService,
  USER_AUTHORED_GENERATOR_PREFIX,
  type CreateCandidateDto,
} from '@ci/domains/schedule';

import { PersonaContextPackService, type PersonaEvidence } from './PersonaContextPackService';

const MAX_INPUT_CHARS = 4000;
const COMPOSE_TIMEOUT_MS = 45_000;
const WHO_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_DURATION_MINUTES = 30;

const taskNormSchema = z.object({
  title: z.string(),
  goal: z.string().optional(),
  openQuestions: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
});

const whoSynthSchema = z.object({
  personaBrief: z.string(),
  evidenceNotes: z.array(z.string()).optional(),
});

const approachStepSchema = z.object({
  title: z.string(),
  detail: z.string().optional(),
  durationMinutes: z.number().optional(),
});

const howYouSchema = z.object({
  approach: z.array(z.unknown()),
  timing: z.string().optional(),
  people: z.array(z.string()).optional(),
  followUps: z.array(z.string()).optional(),
  confidence: z.number().optional(),
});

const TASK_NORM_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    goal: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
  },
  required: ['title'],
};

const WHO_SYNTH_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    personaBrief: { type: 'string' },
    evidenceNotes: { type: 'array', items: { type: 'string' } },
  },
  required: ['personaBrief'],
};

const HOW_YOU_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    approach: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          durationMinutes: { type: 'integer' },
        },
        required: ['title'],
      },
    },
    timing: { type: 'string' },
    people: { type: 'array', items: { type: 'string' } },
    followUps: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['approach'],
};

export interface HowYoudDoItStep {
  title: string;
  detail?: string;
  durationMinutes?: number;
}

export interface HowYoudDoItResult {
  task: {
    title: string;
    goal?: string;
    openQuestions: string[];
    constraints: string[];
  };
  personaBrief: string;
  approach: HowYoudDoItStep[];
  timing?: string;
  people: string[];
  evidence: PersonaEvidence[];
  followUps: string[];
  confidence: number;
  hasSignal: boolean;
}

interface WhoCacheEntry {
  personaBrief: string;
  evidence: PersonaEvidence[];
  hasSignal: boolean;
  expiresAt: number;
}

/**
 * Multi-prompt compose: normalize a task, synthesize who the user is, then
 * produce how they'd do the task — Companion voice, evidence-grounded.
 */
@Injectable()
export class PersonaComposeService {
  private readonly whoCache = new Map<string, WhoCacheEntry>();

  constructor(
    private readonly contextPackService: PersonaContextPackService,
    private readonly ollamaService: OllamaService,
    private readonly candidateService: CandidateService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PersonaComposeService.name);
  }

  async howYoudDoIt(
    context: UserServiceContext & RequestContext,
    task: string,
    options: { includeRecall?: boolean; candidateId?: string } = {},
  ): Promise<HowYoudDoItResult> {
    const trimmed = task.trim();
    if (!trimmed) {
      throw new BadRequestException('task is required');
    }

    if (trimmed.length > MAX_INPUT_CHARS) {
      throw new BadRequestException(`task must be at most ${MAX_INPUT_CHARS} characters`);
    }

    const deadline = Date.now() + COMPOSE_TIMEOUT_MS;
    const signal = AbortSignal.timeout(Math.max(1_000, deadline - Date.now()));

    const normalized = await this.normalizeTask(context, trimmed, signal);
    const who = await this.synthesizeWho(context, {
      taskQuery: normalized.title || trimmed,
      includeRecall: options.includeRecall,
      signal,
    });

    if (!who.hasSignal) {
      const result: HowYoudDoItResult = {
        task: normalized,
        personaBrief:
          who.personaBrief || 'Companion does not know enough about you yet to personalize this confidently.',
        approach: [],
        people: [],
        evidence: who.evidence,
        followUps:
          normalized.openQuestions.length > 0
            ? normalized.openQuestions
            : [
                'What usually matters most to you when doing something like this?',
                'Who do you typically involve, if anyone?',
                'When do you prefer to tackle tasks like this?',
              ],
        confidence: 0.15,
        hasSignal: false,
      };

      if (options.candidateId) {
        await this.candidateService.savePersonalization(
          context,
          options.candidateId,
          result as unknown as Record<string, unknown>,
        );
      }

      return result;
    }

    const how = await this.composeHow(context, normalized, who.personaBrief, signal);

    const result: HowYoudDoItResult = {
      task: normalized,
      personaBrief: who.personaBrief,
      approach: how.approach,
      timing: how.timing,
      people: how.people,
      evidence: who.evidence,
      followUps: how.followUps.length > 0 ? how.followUps : normalized.openQuestions,
      confidence: how.confidence,
      hasSignal: true,
    };

    if (options.candidateId) {
      await this.candidateService.savePersonalization(
        context,
        options.candidateId,
        result as unknown as Record<string, unknown>,
      );
    }

    return result;
  }

  /**
   * Write approach steps onto the Possibilities slate. Nothing is scheduled.
   */
  async applyToPossibilities(
    context: UserServiceContext & RequestContext,
    result: HowYoudDoItResult,
    at = new Date(),
  ): Promise<{ added: number }> {
    if (result.approach.length === 0) {
      return { added: 0 };
    }

    const windowStart = at;
    const windowEnd = new Date(at.getTime() + DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const dayKey = at.toISOString().slice(0, 10);

    const proposals: CreateCandidateDto[] = result.approach.map((step, index) => ({
      title: step.title.slice(0, 120),
      description: step.detail,
      rationale: [result.personaBrief.slice(0, 240), result.timing ? `Timing: ${result.timing}` : null]
        .filter(Boolean)
        .join('\n'),
      rationale_sources: [
        { kind: 'insight' as const, id: 'persona-compose', note: 'how you’d do it' },
        ...result.evidence.slice(0, 3).map((e) => ({
          kind: (e.kind === 'answer' ? 'answer' : e.kind === 'summary' ? 'summary' : 'insight') as
            'answer' | 'summary' | 'insight',
          id: e.id ?? e.kind,
          note: e.note,
        })),
      ],
      window_start: windowStart,
      window_end: windowEnd,
      duration_minutes: clampDuration(step.durationMinutes),
      dedupe_key: `persona/${dayKey}/${slug(result.task.title)}/${index}/${slug(step.title)}`,
      generator: `${USER_AUTHORED_GENERATOR_PREFIX}persona`,
      confidence: result.confidence,
    }));

    const written = await this.candidateService.upsert(context, proposals);

    return { added: written.length };
  }

  /** Invalidate cached who-synthesis after a teach-loop correction. */
  invalidateWhoCache(userId: string): void {
    this.whoCache.delete(userId);
  }

  private async normalizeTask(
    context: UserServiceContext & RequestContext,
    task: string,
    signal: AbortSignal,
  ): Promise<HowYoudDoItResult['task']> {
    let personaContext = '';
    try {
      const pack = await this.contextPackService.assemble(context, {
        includeRecall: false,
      });
      if (pack.markdown.trim()) {
        personaContext = `\n\nUser context (ground constraints and openQuestions in this — do not invent facts):\n${pack.markdown}\n`;
      }
    } catch (err) {
      this.logger.warn(`normalizeTask persona pack failed: ${String(err)}`);
    }

    const prompt = `Normalize a person's task into a clear title and goal. Do not invent steps.

Rules:
- title: short imperative phrase (max 80 chars)
- goal: one sentence on what done looks like
- openQuestions: questions you need answered to personalize (0-3)
- constraints: constraints from the task text OR explicit in user context (prefs, challenges, schedule hints)

Respond with STRICT JSON only.
${personaContext}
Task:
${task}
`;

    try {
      const response = await this.ollamaService.chat(context, [{ role: 'user', content: prompt }], {
        model: PROMPT_MODEL,
        enableTools: false,
        format: TASK_NORM_JSON_SCHEMA,
        signal,
      });
      const parsed = taskNormSchema.safeParse(JSON.parse(stripFences(response.message.content)));
      if (parsed.success && parsed.data.title.trim()) {
        return {
          title: parsed.data.title.trim().slice(0, 120),
          goal: parsed.data.goal?.trim() || undefined,
          openQuestions: (parsed.data.openQuestions ?? [])
            .map((q) => q.trim())
            .filter(Boolean)
            .slice(0, 5),
          constraints: (parsed.data.constraints ?? [])
            .map((c) => c.trim())
            .filter(Boolean)
            .slice(0, 5),
        };
      }
    } catch (err) {
      this.logger.warn(`task normalize failed: ${String(err)}`);
    }

    return {
      title: task.slice(0, 120),
      openQuestions: [],
      constraints: [],
    };
  }

  private async synthesizeWho(
    context: UserServiceContext & RequestContext,
    options: { taskQuery: string; includeRecall?: boolean; signal: AbortSignal },
  ): Promise<{ personaBrief: string; evidence: PersonaEvidence[]; hasSignal: boolean }> {
    const cached = this.whoCache.get(context.userId);
    // Cache only the task-agnostic who-brief when recall is off; with recall the pack is task-specific.
    if (options.includeRecall === false && cached && cached.expiresAt > Date.now()) {
      return {
        personaBrief: cached.personaBrief,
        evidence: cached.evidence,
        hasSignal: cached.hasSignal,
      };
    }

    const pack = await this.contextPackService.assemble(context, {
      taskQuery: options.taskQuery,
      includeRecall: options.includeRecall,
    });

    if (!pack.hasSignal) {
      const empty = {
        personaBrief:
          'Little personal signal yet — preferences, answers, and summaries will make this sharper.',
        evidence: pack.evidence,
        hasSignal: false,
      };
      if (options.includeRecall === false) {
        this.whoCache.set(context.userId, { ...empty, expiresAt: Date.now() + WHO_CACHE_TTL_MS });
      }

      return empty;
    }

    const prompt = `Synthesize a short "who this person is" brief for personalizing how they approach tasks.

Rules:
- 3-6 sentences max. Second person ("you…").
- Ground ONLY in the context pack. Never invent personality traits.
- Mention tone, preferences, constraints/challenges, and relevant people when present.
- If signal is thin, say what is known and what is missing.
- evidenceNotes: short citations like "from preferences" / "from your answer about X".

Respond with STRICT JSON only.

Context pack:
${pack.markdown}
`;

    let personaBrief = '';
    try {
      const response = await this.ollamaService.chat(context, [{ role: 'user', content: prompt }], {
        model: PROMPT_MODEL,
        enableTools: false,
        format: WHO_SYNTH_JSON_SCHEMA,
        signal: options.signal,
      });
      const parsed = whoSynthSchema.safeParse(JSON.parse(stripFences(response.message.content)));
      if (parsed.success) {
        personaBrief = parsed.data.personaBrief.trim();
      }
    } catch (err) {
      this.logger.warn(`who synthesis failed: ${String(err)}`);
    }

    if (!personaBrief) {
      personaBrief = fallbackPersonaBrief(pack.markdown);
    }

    const result = {
      personaBrief,
      evidence: pack.evidence,
      hasSignal: pack.hasSignal,
    };

    if (options.includeRecall === false) {
      this.whoCache.set(context.userId, { ...result, expiresAt: Date.now() + WHO_CACHE_TTL_MS });
    }

    return result;
  }

  private async composeHow(
    context: UserServiceContext & RequestContext,
    task: HowYoudDoItResult['task'],
    personaBrief: string,
    signal: AbortSignal,
  ): Promise<{
    approach: HowYoudDoItStep[];
    timing?: string;
    people: string[];
    followUps: string[];
    confidence: number;
  }> {
    const prompt = `Given who this person is and a task, describe how THEY would do it.

Voice: Companion coaching the user ("Given how you usually…"). Not first-person impersonation.

Rules:
- approach: 2-6 ordered steps in THEIR style (prefs, constraints, tone). Do not invent facts about them.
- If unsure, prefer fewer steps and put questions in followUps.
- timing: optional hint from rest-of-day / habits
- people: names from context only
- confidence: 0..1
- Never schedule — steps are suggestions only.

Respond with STRICT JSON only.

Who they are:
${personaBrief}

Task title: ${task.title}
Goal: ${task.goal ?? '(unspecified)'}
Constraints: ${(task.constraints ?? []).join('; ') || '(none)'}
Open questions: ${(task.openQuestions ?? []).join('; ') || '(none)'}
`;

    try {
      const response = await this.ollamaService.chat(context, [{ role: 'user', content: prompt }], {
        model: PROMPT_MODEL,
        enableTools: false,
        format: HOW_YOU_JSON_SCHEMA,
        signal,
      });
      const parsed = howYouSchema.safeParse(JSON.parse(stripFences(response.message.content)));
      if (parsed.success) {
        const approach: HowYoudDoItStep[] = [];
        for (const raw of parsed.data.approach) {
          const step = approachStepSchema.safeParse(raw);
          if (!step.success || !step.data.title.trim()) {
            continue;
          }

          approach.push({
            title: step.data.title.trim().slice(0, 120),
            detail: step.data.detail?.trim() || undefined,
            durationMinutes: clampDuration(step.data.durationMinutes),
          });
          if (approach.length >= 8) {
            break;
          }
        }

        return {
          approach,
          timing: parsed.data.timing?.trim() || undefined,
          people: (parsed.data.people ?? [])
            .map((p) => p.trim())
            .filter(Boolean)
            .slice(0, 8),
          followUps: (parsed.data.followUps ?? [])
            .map((q) => q.trim())
            .filter(Boolean)
            .slice(0, 5),
          confidence: clampConfidence(parsed.data.confidence),
        };
      }
    } catch (err) {
      this.logger.warn(`how-youd-do-it compose failed: ${String(err)}`);
    }

    return {
      approach: [{ title: task.title, detail: task.goal }],
      people: [],
      followUps: task.openQuestions,
      confidence: 0.35,
    };
  }
}

function stripFences(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  return fenced ? fenced[1].trim() : trimmed;
}

function clampDuration(value: number | undefined): number | undefined {
  if (value == null || Number.isNaN(value)) {
    return DEFAULT_DURATION_MINUTES;
  }

  return Math.min(8 * 60, Math.max(5, Math.round(value)));
}

function clampConfidence(value: number | undefined): number {
  if (value == null || Number.isNaN(value)) {
    return 0.5;
  }

  return Math.min(1, Math.max(0, value));
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

function fallbackPersonaBrief(markdown: string): string {
  const summary = markdown.match(/- Summary:\s*(.+)/)?.[1];
  if (summary) {
    return `You tend to operate like this: ${summary.trim()}`;
  }

  return 'Companion has some graph preferences for you, but the dossier is still thin.';
}
