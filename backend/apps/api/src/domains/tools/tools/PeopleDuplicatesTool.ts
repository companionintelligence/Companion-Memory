import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { GlobalUID } from '@ci/common/ids';
import { LoggerService } from '@ci/common/logging';
import { PersonService } from '@ci/domains/memory';
import { PersonDuplicateSuggestionService } from '@ci/domains/people';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const PeopleDuplicatesInputSchema = z.object({
  maxResults: z.number().int().min(1).max(100).optional(),
});

export type PeopleDuplicatesInput = z.infer<typeof PeopleDuplicatesInputSchema>;

export interface PeopleDuplicateSuggestion {
  /** Suggestion id — pass to people.merge (as winner/loser confirmation) or the GraphQL accept/reject mutations. */
  suggestionId: string;
  /** GlobalUID of the person that would survive an accepted merge. */
  personAId: string;
  personAName: string | null;
  /** GlobalUID of the person that would merge away. */
  personBId: string;
  personBName: string | null;
  confidence: number;
  /** Why the pair was suggested (e.g. exact-name collision, name variant). */
  signals: Record<string, unknown>;
}

/**
 * Pending weak-signal duplicate suggestions — name collisions and variants
 * the system will NOT merge on its own. The agent surfaces these for the user
 * to confirm (people.merge) or dismiss.
 */
@Injectable()
export class PeopleDuplicatesTool extends BaseTool<PeopleDuplicatesInput, PeopleDuplicateSuggestion[]> {
  readonly schema: IntentDefinition = {
    name: 'people.duplicates',
    domain: 'people',
    title: 'List possible duplicate people',
    description:
      'List pending "these might be the same person" suggestions (name collisions ' +
      'and variants like "Priya" vs "Priya Sharma"), highest confidence first. ' +
      'These are weak-signal candidates that require user confirmation — ' +
      'use people.merge to combine a confirmed pair.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    produces: ['person'],
    phrases: ['Do I have duplicate contacts', 'Show possible duplicate people'],
    parameters: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', description: 'Max suggestions (default 50).', minimum: 1, maximum: 100 },
      },
      required: [],
    },
  };

  constructor(
    private readonly suggestionService: PersonDuplicateSuggestionService,
    private readonly personService: PersonService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PeopleDuplicatesTool.name);
  }

  protected validateInput(input: unknown): PeopleDuplicatesInput {
    return PeopleDuplicatesInputSchema.parse(input ?? {});
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PeopleDuplicatesInput,
  ): Promise<PeopleDuplicateSuggestion[]> {
    if (context.userId == null) {
      return [];
    }

    const userId = context.userId;
    const { suggestions } = await this.suggestionService.listPending(userId, {
      limit: input.maxResults,
    });

    return Promise.all(
      suggestions.map(async (suggestion) => {
        const [personA, personB] = await Promise.all([
          this.personService.findById({ userId }, suggestion.entityIdA),
          this.personService.findById({ userId }, suggestion.entityIdB),
        ]);

        return {
          suggestionId: suggestion.id,
          personAId: GlobalUID.encode('person', suggestion.entityIdA),
          personAName: personA?.name ?? null,
          personBId: GlobalUID.encode('person', suggestion.entityIdB),
          personBName: personB?.name ?? null,
          confidence: Number(suggestion.confidence),
          signals: suggestion.signals ?? {},
        };
      }),
    );
  }
}
