import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { stillLearning } from '@ci/domains/daily-metrics';
import { PlaceForecastService, type PlaceForecastItem } from '@ci/domains/predictions';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const InputSchema = z.object({
  k: z.number().int().min(1).max(20).optional().default(5),
  horizonHours: z.number().int().min(1).max(48).optional().default(4),
});

export type PlacesNextInput = z.infer<typeof InputSchema>;

export interface PlacesNextOutput {
  found: boolean;
  text: string;
  k: number;
  horizonHours: number;
  places: PlaceForecastItem[];
}

@Injectable()
export class PlacesNextTool extends BaseTool<PlacesNextInput, PlacesNextOutput> {
  readonly schema: IntentDefinition = {
    name: 'places.next',
    domain: 'places',
    title: 'Next places',
    description:
      'Rank where the user is likely to go next from stay-point transitions. Empty history is still-learning, never "you usually go to…".',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    localCapable: true,
    produces: ['place'],
    phrases: ['Where do I usually go next', 'What is my next place', 'Where am I likely to go'],
    parameters: {
      type: 'object',
      properties: {
        k: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'How many ranked places to return (default 5).',
        },
        horizonHours: {
          type: 'integer',
          minimum: 1,
          maximum: 48,
          description: 'Hours ahead to score (default 4).',
        },
      },
    },
  };

  constructor(
    private readonly placeForecast: PlaceForecastService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PlacesNextTool.name);
  }

  protected validateInput(input: unknown): PlacesNextInput {
    return InputSchema.parse(input ?? {});
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PlacesNextInput,
  ): Promise<PlacesNextOutput> {
    const places = await this.placeForecast.predictNext(
      toServiceContext(context),
      input.k,
      input.horizonHours,
    );
    if (places.length === 0) {
      return {
        found: false,
        text: `${stillLearning('places')} There is not enough stay history to rank where you go next.`,
        k: input.k,
        horizonHours: input.horizonHours,
        places: [],
      };
    }

    const top = places[0];
    const label = top.label?.trim() || 'an unlabeled place';

    return {
      found: true,
      text: `Most likely next is ${label} (${Math.round(top.probability * 100)}% in the next ${input.horizonHours}h).`,
      k: input.k,
      horizonHours: input.horizonHours,
      places,
    };
  }
}
