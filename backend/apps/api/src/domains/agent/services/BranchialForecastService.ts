import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { type RequestContext, toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OllamaService, UTILITY_MODEL } from '@ci/domains/llm';
import { UserContextService } from '@ci/domains/memory';
import { HbpeService } from '@ci/domains/predictions';
import { UserService } from '@ci/domains/user';

import { buildOccupancyTree, emptyOccupancyTree, mergeGuess, type BranchialTree } from './branchialOccupancy';
import { ForecastContextService } from './ForecastContextService';
import { RecallService } from './RecallService';

const GUESS_TIMEOUT_MS = 20_000;

const permutationSchema = z.object({
  id: z.string(),
  title: z.string(),
  mass: z.number(),
});

const branchSchema = z.object({
  id: z.string(),
  title: z.string(),
  l0: z.string(),
  mass: z.number(),
  why: z.string().optional(),
  permutations: z.array(permutationSchema).optional(),
});

const stepSchema = z.object({
  id: z.string(),
  branches: z.array(branchSchema),
});

const guessSchema = z.object({
  question: z.string().optional(),
  steps: z.array(stepSchema),
});

const GUESS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          branches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                l0: {
                  type: 'string',
                  enum: ['WORK', 'EXERCISE', 'SOCIAL', 'ERRAND', 'LEISURE', 'TRANSIT', 'SLEEP'],
                },
                mass: { type: 'number' },
                why: { type: 'string' },
                permutations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      title: { type: 'string' },
                      mass: { type: 'number' },
                    },
                    required: ['id', 'title', 'mass'],
                  },
                },
              },
              required: ['id', 'title', 'l0', 'mass'],
            },
          },
        },
        required: ['id', 'branches'],
      },
    },
  },
  required: ['steps'],
};

@Injectable()
export class BranchialForecastService {
  constructor(
    private readonly hbpeService: HbpeService,
    private readonly userService: UserService,
    private readonly ollamaService: OllamaService,
    private readonly userContextService: UserContextService,
    private readonly recallService: RecallService,
    private readonly forecastContext: ForecastContextService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(BranchialForecastService.name);
  }

  async occupancy(context: RequestContext): Promise<BranchialTree> {
    const service = toServiceContext(context);
    const user = await this.userService.findById(service, service.userId);
    const timezone = user?.timezone ?? 'UTC';
    const [forecast, week] = await Promise.all([
      this.hbpeService.getForecast(service, '24h').catch(() => null),
      this.hbpeService.getWeekForecast(service, true, timezone).catch(() => null),
    ]);

    return buildOccupancyTree({
      buckets: forecast?.buckets ?? [],
      week,
      timezone,
      ready: forecast?.system_status === 'READY' || Boolean(forecast?.system_status?.includes(':')),
      stillLearning: Boolean(forecast?.still_learning),
    });
  }

  async guess(context: RequestContext): Promise<BranchialTree> {
    const occupancy = await this.occupancy(context);
    if (occupancy.steps.length === 0) {
      return emptyOccupancyTree();
    }

    const guessed = await this.askModel(context, occupancy);
    if (!guessed) {
      return occupancy;
    }

    return mergeGuess(occupancy, guessed);
  }

  private async askModel(context: RequestContext, occupancy: BranchialTree): Promise<BranchialTree | null> {
    const service = toServiceContext(context);
    const blocks: string[] = [];

    try {
      const userCtx = await this.userContextService.getUserContextForLLM(service.userId);
      if (userCtx) {
        blocks.push(this.userContextService.formatContextForSystemPrompt(userCtx));
      }
    } catch (err) {
      this.logger.warn('Branchial persona pack failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const recall = await this.recallService.recall(service, {
        query: 'what I usually do next and who I see',
        maxResults: 8,
      });
      if (recall.block.trim()) {
        blocks.push(recall.block);
      }
    } catch (err) {
      this.logger.warn('Branchial recall failed', { err: err instanceof Error ? err.message : String(err) });
    }

    try {
      const rest = await this.forecastContext.getRestOfDayBlock(service);
      if (rest.trim()) {
        blocks.push(rest);
      }
    } catch (err) {
      this.logger.warn('Branchial rest-of-day failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    const prompt = [
      "Rename each gated occupancy title into a short named stretch of this person's remaining day.",
      'Examples: morning standup, beach with Jerry. Keep every step id exactly.',
      'Do not add branches. Do not use UNKNOWN. Do not invent people who are not in memory.',
      'If you cannot name a branch, keep its occupancy title. mass is a probability in 0–1.',
      '',
      blocks.join('\n\n').slice(0, 6000),
      '',
      'Occupancy spine (rename these, keep step ids):',
      JSON.stringify({ question: occupancy.question, steps: occupancy.steps }),
    ].join('\n');

    try {
      const response = await this.ollamaService.chat(
        { userId: service.userId },
        [{ role: 'user', content: prompt }],
        {
          model: UTILITY_MODEL,
          enableTools: false,
          format: GUESS_JSON_SCHEMA,
          signal: AbortSignal.timeout(GUESS_TIMEOUT_MS),
        },
      );

      return BranchialForecastService.parseGuess(response.message.content);
    } catch (err) {
      this.logger.warn('Branchial guess generation failed', {
        err: err instanceof Error ? err.message : String(err),
      });

      return null;
    }
  }

  static parseGuess(content: string): BranchialTree | null {
    let jsonStr = (content ?? '').replace(/```json\n?|\n?```/g, '').trim();
    const firstOpen = jsonStr.indexOf('{');
    const lastClose = jsonStr.lastIndexOf('}');
    if (firstOpen !== -1 && lastClose !== -1) {
      jsonStr = jsonStr.substring(firstOpen, lastClose + 1);
    }

    let parsed: z.infer<typeof guessSchema>;
    try {
      const result = guessSchema.safeParse(JSON.parse(jsonStr));
      if (!result.success) {
        return null;
      }

      parsed = result.data;
    } catch {
      return null;
    }

    return {
      question: parsed.question ?? 'What happens next',
      guessed: true,
      steps: parsed.steps.map((step) => ({
        id: step.id,
        label: step.id,
        startTime: '',
        branches: step.branches.map((branch) => ({
          id: branch.id,
          title: branch.title,
          l0: branch.l0,
          mass: branch.mass,
          why: branch.why ?? '',
          permutations: (branch.permutations ?? []).map((row) => ({
            id: row.id,
            title: row.title,
            mass: row.mass,
          })),
        })),
      })),
    };
  }
}
