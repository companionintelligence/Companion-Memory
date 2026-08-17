import { Injectable } from '@nestjs/common';

import { type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { Events, EventPayloads, OnEvent } from '@ci/domains/events';
import { Answer, AnswerService, QuestionService } from '@ci/domains/intelligence';
import { estimateInferredAnswerConfidence, OllamaService, PROMPT_MODEL } from '@ci/domains/llm';
import { UserContextService } from '@ci/domains/memory';
import { PersonalizationService } from '@ci/domains/personalization';
import { SearchService } from '@ci/domains/search-next';

const RELATED_ANSWER_LIMIT = 10;
const RECENT_ANSWER_FALLBACK = 5;

@Injectable()
export class AnswerInferenceListener {
  constructor(
    private readonly answerService: AnswerService,
    private readonly questionService: QuestionService,
    private readonly searchService: SearchService,
    private readonly userContextService: UserContextService,
    private readonly personalizationService: PersonalizationService,
    private readonly ollamaService: OllamaService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AnswerInferenceListener.name);
  }

  @OnEvent(Events.INFER_QUESTION_ANSWER)
  async inferQuestionAnswer(payload: EventPayloads[Events.INFER_QUESTION_ANSWER]) {
    const ownerId = payload.ownerId;
    if (!ownerId) {
      this.logger.warn('Answer inference skipped — no user owner', {
        questionId: payload.questionId,
      });

      return;
    }

    this.logger.log('Inferring answer to question', {
      userId: ownerId,
      questionId: payload.questionId,
    });

    const serviceContext = { userId: ownerId } as UserServiceContext;

    const question = await this.questionService.findById(serviceContext, payload.questionId);

    if (!question) {
      return;
    }

    const resolvedAnswers = await this.findRelatedAnswers(serviceContext, question.text, payload.questionId);

    let dossierBlock = '';
    try {
      const userCtx = await this.userContextService.getUserContextForLLM(ownerId);
      if (userCtx) {
        dossierBlock = this.userContextService.formatContextForSystemPrompt(userCtx);
      }
    } catch (err) {
      this.logger.warn('Answer inference dossier fetch failed', {
        userId: ownerId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    const ragThread = [
      {
        role: 'system',
        content: `You impersonate the user and infer a first-person answer to a question they have not answered yet.

Rules:
- 2-3 sentences max.
- Return ONLY the answer text — no preamble, no "honestly", no complimenting the question.
- Ground the answer in the dossier and related Q&A below. Never invent facts absent from context.
- If context is thin, give a plausible short answer that fits what is known.`,
      },
      ...(dossierBlock
        ? [
            {
              role: 'system',
              content: `User dossier and graph context:\n${dossierBlock}`,
            },
          ]
        : []),
      {
        role: 'system',
        content:
          resolvedAnswers.length > 0
            ? `Related questions the user already answered:\n\n${resolvedAnswers
                .map(
                  (answer) =>
                    `Question: ${answer.question?.text ?? '(unspecified)'}\nAnswer: ${answer.answer}`,
                )
                .join('\n\n')}`
            : 'No related prior answers were found — rely on the dossier only.',
      },
      {
        role: 'user',
        content: `Question to answer as the user:\n${question.text}`,
      },
    ];

    const llmResponse = await this.ollamaService.chat(serviceContext, ragThread, {
      model: PROMPT_MODEL,
    });

    const inferredText = llmResponse.message.content.trim();
    if (!inferredText) {
      this.logger.warn('Answer inference returned empty content', {
        userId: ownerId,
        questionId: payload.questionId,
      });

      return;
    }

    this.logger.log('Inferred answer to question', {
      userId: ownerId,
      questionId: payload.questionId,
      question: question.text,
      relatedAnswers: resolvedAnswers.length,
      response: inferredText,
    });

    const decision = await this.personalizationService.decideAction(ownerId, {
      kind: 'inferred_fact',
      confidence: estimateInferredAnswerConfidence(resolvedAnswers.length, dossierBlock.length > 0),
      hasUserInput: true,
    });

    if (decision === 'review') {
      this.logger.log('Inferred answer left unwritten for context prompt', {
        userId: ownerId,
        questionId: payload.questionId,
      });

      return;
    }

    if (decision === 'skip') {
      return;
    }

    const userAnswer = await this.answerService.findByQuestionId(serviceContext, payload.questionId);

    if (userAnswer) {
      await this.answerService.update(serviceContext, userAnswer.id, {
        text: inferredText,
        answerMethod: 'inferred',
        answerSource: 'inferred',
      });
    } else {
      await this.answerService.create(serviceContext, {
        text: inferredText,
        question: { id: payload.questionId },
        answerMethod: 'inferred',
        answerSource: 'inferred',
      });
    }
  }

  private async findRelatedAnswers(
    context: UserServiceContext,
    questionText: string,
    excludeQuestionId: string,
  ): Promise<Answer[]> {
    const seen = new Set<string>();
    const resolved: Answer[] = [];

    try {
      const hits = await this.searchService.search(context, {
        query: questionText,
        mode: 'boosted',
        maxResults: RELATED_ANSWER_LIMIT,
        includeTypes: ['answer'],
      });

      if (hits.length > 0) {
        const byId = await this.answerService.findByIds(
          context as ServiceContext,
          hits.map((hit) => hit.id),
        );

        for (const answer of byId) {
          if (!answer || answer.question?.id === excludeQuestionId || seen.has(answer.id)) {
            continue;
          }

          seen.add(answer.id);
          resolved.push(answer);
        }
      }
    } catch (err) {
      this.logger.warn('Answer inference semantic search failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    if (resolved.length >= 3) {
      return resolved.slice(0, RELATED_ANSWER_LIMIT);
    }

    const recent = await this.answerService.findAll(context);
    const sorted = [...recent]
      .filter((answer) => answer.question?.id !== excludeQuestionId && !seen.has(answer.id))
      .sort((a, b) => new Date(b.answeredAt).getTime() - new Date(a.answeredAt).getTime())
      .slice(0, RECENT_ANSWER_FALLBACK);

    return [...resolved, ...sorted].slice(0, RELATED_ANSWER_LIMIT);
  }
}
