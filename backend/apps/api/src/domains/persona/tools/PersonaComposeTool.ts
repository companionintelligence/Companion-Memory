import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { type RequestContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { BaseTool } from '@ci/domains/tools';
import type { IntentDefinition, ToolExecutionContext } from '@ci/domains/tools';

import { PersonaComposeService, type HowYoudDoItResult } from '../services/PersonaComposeService';

const inputSchema = z.object({
  task: z.string().min(1).max(4000),
  includeRecall: z.boolean().optional(),
});

type PersonaComposeInput = z.infer<typeof inputSchema>;

/**
 * MCP / intent surface for the curated persona compose pipeline.
 * Connect keys with `memory` + `intents` can call this instead of stitching L0 + recall themselves.
 */
@Injectable()
export class PersonaComposeTool extends BaseTool<PersonaComposeInput, HowYoudDoItResult> {
  readonly schema: IntentDefinition = {
    name: 'persona.compose',
    domain: 'memory',
    title: 'How you would do it',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    // Sends nothing off the appliance, yet is still not local: the compose pipeline is several
    // server-side LLM stages over the L0 dossier and L1 recall, none of which the device holds.
    localCapable: false,
    produces: ['concept'],
    phrases: ['How would I $task', 'How should I approach $task'],
    description:
      'Run the curated persona compose pipeline for a task: normalize the task, synthesize who the user is from dossier/preferences/answers/summaries/recall, then produce how they would approach it. Returns evidence-grounded steps in Companion voice.',
    category: 'persona',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task or question to personalize (max 4000 chars)',
        },
        includeRecall: {
          type: 'boolean',
          description: 'Include task-specific L1 recall in the context pack (default true)',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    examples: [
      {
        input: { task: 'Prep for Thursday board meeting' },
        output: {
          task: { title: 'Prep for Thursday board meeting', openQuestions: [], constraints: [] },
          personaBrief: 'You prefer concise decks and morning focus blocks…',
          approach: [{ title: 'Outline three talking points', detail: 'Lead with metrics' }],
          people: [],
          evidence: [{ kind: 'dossier', note: 'from your dossier' }],
          followUps: [],
          confidence: 0.72,
          hasSignal: true,
        },
        description: 'Personalized approach for a work task',
      },
    ],
  };

  constructor(
    private readonly personaComposeService: PersonaComposeService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PersonaComposeTool.name);
  }

  protected validateInput(input: unknown): PersonaComposeInput {
    return inputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PersonaComposeInput,
  ): Promise<HowYoudDoItResult> {
    if (!context.userId) {
      throw new Error('User context is required for persona compose');
    }

    const userContext = context as UserServiceContext & RequestContext;

    return this.personaComposeService.howYoudDoIt(userContext, input.task, {
      includeRecall: input.includeRecall,
    });
  }
}
