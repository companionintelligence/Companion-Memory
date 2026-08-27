import { Injectable } from '@nestjs/common';

import { type RequestContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { fenceUntrusted, untrustedBlock } from '@ci/common/prompt/untrustedBlock';
import { ForecastContextService, RecallService } from '@ci/domains/agent';
import { AnswerService } from '@ci/domains/intelligence';
import { UserContextService } from '@ci/domains/memory';
import { SummaryService } from '@ci/domains/summaries';

const RECENT_ANSWERS = 5;
const RECENT_SUMMARIES = 3;

export interface PersonaEvidence {
  kind: 'dossier' | 'preference' | 'answer' | 'summary' | 'recall' | 'forecast';
  id?: string;
  note: string;
}

export interface PersonaContextPack {
  /** Markdown block for LLM prompts (L0 + answers + summaries + optional recall/HBPE). */
  markdown: string;
  evidence: PersonaEvidence[];
  /** True when dossier/prefs/answers give something substantive to personalize from. */
  hasSignal: boolean;
}

/**
 * Assembles the "who you are" context pack for persona compose.
 *
 * Extends the existing L0 UserContext markdown with recent first-person answers,
 * latest summary headlines, optional L1 recall, and optional HBPE rest-of-day.
 */
@Injectable()
export class PersonaContextPackService {
  constructor(
    private readonly userContextService: UserContextService,
    private readonly answerService: AnswerService,
    private readonly summaryService: SummaryService,
    private readonly forecastContextService: ForecastContextService,
    private readonly recallService: RecallService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PersonaContextPackService.name);
  }

  async assemble(
    context: UserServiceContext & RequestContext,
    options: { taskQuery?: string; includeRecall?: boolean } = {},
  ): Promise<PersonaContextPack> {
    const evidence: PersonaEvidence[] = [];
    const sections: string[] = [];

    const userContext = await this.userContextService.getUserContextForLLM(context.userId);
    if (userContext) {
      sections.push(this.userContextService.formatContextForSystemPrompt(userContext));

      if (userContext.currentUser.dossier?.summary) {
        evidence.push({
          kind: 'dossier',
          note: 'from your dossier',
        });
      }

      for (const pref of userContext.topPreferences.slice(0, 5)) {
        evidence.push({
          kind: 'preference',
          id: pref.entityId,
          note: `${pref.relationship === 'DISLIKES' ? 'dislike' : 'preference'}: ${pref.name}`,
        });
      }
    } else {
      sections.push('# User Context\n\nNo graph profile is available yet.');
    }

    const answers = await this.answerService.findAll(context);
    const recentAnswers = [...answers]
      .sort((a, b) => new Date(b.answeredAt).getTime() - new Date(a.answeredAt).getTime())
      .slice(0, RECENT_ANSWERS);

    if (recentAnswers.length > 0) {
      // Question text is curated, but the answer is free text the user typed or
      // a model inferred from imported mail, so both go through the fence.
      const lines: string[] = [];
      for (const answer of recentAnswers) {
        const questionText = answer.question?.text?.trim();
        lines.push(questionText ? `Q: ${fenceUntrusted(questionText)}` : 'Q: (unspecified)');
        lines.push(`A: ${fenceUntrusted(answer.answer)}`);
        lines.push('');
        evidence.push({
          kind: 'answer',
          id: answer.id,
          note: questionText ? `from your answer about “${truncate(questionText, 48)}”` : 'from your answer',
        });
      }

      sections.push(untrustedBlock(lines.join('\n'), '## Recent answers (first-person)'));
    }

    const summaries = await this.summaryService.findRecent(context, RECENT_SUMMARIES);
    const dailyOrWeekly = summaries.filter((s) => s.periodType === 'daily' || s.periodType === 'weekly');
    const summaryPick = (dailyOrWeekly.length > 0 ? dailyOrWeekly : summaries).slice(0, 2);

    if (summaryPick.length > 0) {
      const lines: string[] = [];
      for (const summary of summaryPick) {
        const headline = summary.title?.trim() || summary.summaryText?.trim() || '(untitled)';
        lines.push(`- [${summary.periodType}] ${fenceUntrusted(truncate(headline, 160))}`);
        evidence.push({
          kind: 'summary',
          id: summary.summaryId,
          note: `from ${summary.periodType} summary`,
        });
      }

      sections.push(untrustedBlock(lines.join('\n'), '## Recent period summaries'));
    }

    if (options.includeRecall !== false && options.taskQuery?.trim()) {
      try {
        const recall = await this.recallService.recall(context, {
          query: options.taskQuery.trim(),
          maxResults: 5,
        });
        if (recall.block.trim() && recall.resultCount > 0) {
          sections.push(`## Task-relevant recall\n\n${recall.block}`);
          evidence.push({
            kind: 'recall',
            note: `from memory recall (${recall.resultCount} hits)`,
          });
        }
      } catch (err) {
        this.logger.warn(`recall failed during persona pack: ${String(err)}`);
      }
    }

    try {
      const forecast = await this.forecastContextService.getRestOfDayBlock(context);
      if (forecast.trim()) {
        sections.push(forecast);
        evidence.push({ kind: 'forecast', note: 'from predicted rest of day' });
      }
    } catch (err) {
      this.logger.warn(`forecast block failed during persona pack: ${String(err)}`);
    }

    const hasSignal =
      Boolean(userContext?.currentUser.dossier?.summary) ||
      (userContext?.topPreferences.length ?? 0) > 0 ||
      recentAnswers.length > 0 ||
      summaryPick.length > 0;

    return {
      markdown: sections.join('\n\n'),
      evidence,
      hasSignal,
    };
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
