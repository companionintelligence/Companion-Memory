import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod/v3';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import {
  MEMORY_SCOPE,
  READ_CAPABILITY,
  RequireCapability,
  RequireScopes,
  WRITE_CAPABILITY,
} from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { AboutYouService } from '../services/AboutYouService';
import { AgentHarnessService } from '../services/AgentHarnessService';
import { PersonaComposeService, type HowYoudDoItResult } from '../services/PersonaComposeService';

const howYoudDoItSchema = z.object({
  task: z.string().min(1).max(4000),
  includeRecall: z.boolean().optional(),
  candidateId: z.string().uuid().optional(),
});

const applySchema = z.object({
  result: z.object({
    task: z.object({
      title: z.string(),
      goal: z.string().optional(),
      openQuestions: z.array(z.string()),
      constraints: z.array(z.string()),
    }),
    personaBrief: z.string(),
    approach: z.array(
      z.object({
        title: z.string(),
        detail: z.string().optional(),
        durationMinutes: z.number().optional(),
      }),
    ),
    timing: z.string().optional(),
    people: z.array(z.string()),
    evidence: z.array(
      z.object({
        kind: z.enum(['dossier', 'preference', 'answer', 'summary', 'recall', 'forecast']),
        id: z.string().optional(),
        note: z.string(),
      }),
    ),
    followUps: z.array(z.string()),
    confidence: z.number(),
    hasSignal: z.boolean(),
  }),
});

const correctionSchema = z.object({
  text: z.string().min(1).max(5000),
});

/**
 * Persona × task intelligence: how-you'd-do-it compose, apply to Possibilities,
 * and About-you read/correct.
 */
@Controller('v1/intelligence')
@UseGuards(JwtOrApiKeyAuthGuard)
@RequireScopes(MEMORY_SCOPE)
export class PersonaIntelligenceController {
  constructor(
    private readonly personaComposeService: PersonaComposeService,
    private readonly aboutYouService: AboutYouService,
    private readonly agentHarnessService: AgentHarnessService,
  ) {}

  @Get('agent-harnesses')
  @RequireCapability(READ_CAPABILITY)
  async agentHarnesses(@Context() context: RequestContext) {
    const serviceContext = toServiceContext(context);
    const harnesses = await this.agentHarnessService.getHarnesses(serviceContext);

    return { harnesses };
  }

  @Post('how-youd-do-it')
  @RequireCapability(READ_CAPABILITY)
  async howYoudDoIt(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(howYoudDoItSchema)) body: z.infer<typeof howYoudDoItSchema>,
  ): Promise<HowYoudDoItResult> {
    const serviceContext = toServiceContext(context);

    return this.personaComposeService.howYoudDoIt(serviceContext, body.task, {
      includeRecall: body.includeRecall,
      candidateId: body.candidateId,
    });
  }

  @Post('how-youd-do-it/apply')
  @RequireCapability(WRITE_CAPABILITY)
  async applyHowYoudDoIt(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(applySchema)) body: z.infer<typeof applySchema>,
  ): Promise<{ added: number }> {
    const serviceContext = toServiceContext(context);

    return this.personaComposeService.applyToPossibilities(serviceContext, body.result);
  }

  @Get('about-you')
  @RequireCapability(READ_CAPABILITY)
  async aboutYou(@Context() context: RequestContext) {
    const serviceContext = toServiceContext(context);

    return this.aboutYouService.getAboutYou(serviceContext);
  }

  @Post('about-you/correction')
  @RequireCapability(WRITE_CAPABILITY)
  async aboutYouCorrection(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(correctionSchema)) body: z.infer<typeof correctionSchema>,
  ) {
    const serviceContext = toServiceContext(context);

    return this.aboutYouService.recordCorrection(serviceContext, body.text);
  }
}
