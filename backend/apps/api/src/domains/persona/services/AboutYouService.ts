import { Injectable } from '@nestjs/common';

import { type RequestContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { AnswerService, QuestionService } from '@ci/domains/intelligence';
import { UserContextService } from '@ci/domains/memory';

import { PersonaComposeService } from './PersonaComposeService';

export interface AboutYouView {
  name: string | null;
  dossier: {
    summary: string;
    tone?: string | null;
    personalityTraits?: string[] | null;
    interactionGuidelines?: string[] | null;
    preferences?: string[] | null;
    challenges?: string[] | null;
    lastUpdatedAt?: string | null;
  } | null;
  preferences: Array<{
    entityId: string;
    name: string;
    type: string;
    category: string | null;
    strength: number;
    relationship: 'PREFERS' | 'DISLIKES';
  }>;
  family: Array<{
    entityId: string;
    name: string;
    relationship: string;
    /** See `UserContext.familyMembers`: which way `relationship` points from the user. */
    direction?: 'outgoing' | 'incoming';
    age?: number;
  }>;
  recentAnswers: Array<{
    id: string;
    question: string | null;
    answer: string;
    answeredAt: Date;
  }>;
  /** Wake/sleep/work hours captured during onboarding, when set. */
  schedule: Record<string, unknown> | null;
  /** The autonomy dial ('cautious' | 'balanced' | 'hands_off') from onboarding. */
  trustMode: string | null;
  hasSignal: boolean;
}

/**
 * Read path for the About-you settings surface, plus a teach-loop correction
 * that lands as a first-person Q&A pair (consumed by the next persona pack).
 */
@Injectable()
export class AboutYouService {
  constructor(
    private readonly userContextService: UserContextService,
    private readonly questionService: QuestionService,
    private readonly answerService: AnswerService,
    private readonly personaComposeService: PersonaComposeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AboutYouService.name);
  }

  async getAboutYou(context: UserServiceContext): Promise<AboutYouView> {
    const userContext = await this.userContextService.getUserContextForLLM(context.userId);
    const planner = await this.userContextService.getSelfPlannerContext(context.userId);
    const answers = await this.answerService.findAll(context);
    const recentAnswers = [...answers]
      .sort((a, b) => new Date(b.answeredAt).getTime() - new Date(a.answeredAt).getTime())
      .slice(0, 8)
      .map((a) => ({
        id: a.id,
        question: a.question?.text ?? null,
        answer: a.answer,
        answeredAt: a.answeredAt,
      }));

    const preferences = userContext?.topPreferences ?? [];
    const dossier = userContext?.currentUser.dossier ?? null;

    return {
      name: userContext?.currentUser.name ?? null,
      dossier,
      preferences,
      family: userContext?.familyMembers ?? [],
      recentAnswers,
      schedule: planner?.schedule ?? null,
      trustMode: planner?.trustMode ?? null,
      hasSignal: Boolean(dossier?.summary) || preferences.length > 0 || recentAnswers.length > 0,
    };
  }

  async recordCorrection(
    context: UserServiceContext & RequestContext,
    text: string,
  ): Promise<{ questionId: string; answerId: string }> {
    const trimmed = text.trim();
    const question = await this.questionService.create(context, {
      text: 'What should Companion correct about how it understands you?',
      category: 'about_you',
      isSeedQuestion: false,
      createdByLlm: false,
      isActive: false,
    });

    const answer = await this.answerService.create(context, {
      text: trimmed,
      question: { id: question.id },
      answerSource: 'user_input',
      answerMethod: 'about_you_correction',
    });

    this.personaComposeService.invalidateWhoCache(context.userId);

    return { questionId: question.id, answerId: answer.id };
  }
}
