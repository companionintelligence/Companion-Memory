import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { GlobalUID } from '@ci/common/ids';
import { LoggerService } from '@ci/common/logging';
import { PeopleService } from '@ci/domains/people';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const PeopleLookupInputSchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(50).optional(),
});

export type PeopleLookupInput = z.infer<typeof PeopleLookupInputSchema>;

export interface PeopleLookupHit {
  /** GlobalUID — the same id GraphQL and the other people.* intents use. */
  id: string;
  name: string | null;
  description: string | null;
  /** How the hit was found: 'email' | 'phone' | 'handle' | 'name'. */
  matchedVia: string;
  /** The identifier/handle/name value that matched. */
  matchedValue: string;
  emails: string[];
  phones: string[];
}

/**
 * Identifier-aware person lookup (issue #1810): resolves "who is
 * liam@x.com?" through the identifier index, profile handles, and names —
 * following merge tombstones so answers always land on the canonical person.
 * Complements people.find, which is a semantic/keyword search.
 */
@Injectable()
export class PeopleLookupTool extends BaseTool<PeopleLookupInput, PeopleLookupHit[]> {
  readonly schema: IntentDefinition = {
    name: 'people.lookup',
    domain: 'people',
    title: 'Look up a person by identifier',
    description:
      'Resolve a person by email address, phone number, handle, or name. ' +
      'Matches against the identifier index and connected source profiles ' +
      '(Discord handle, Google contact, ...), so "who is liam@x.com?" or ' +
      '"who is @hegemon?" lands on the one canonical person. ' +
      'Use people.find for fuzzy/semantic search instead.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    produces: ['person'],
    phrases: ['Who is $identifier', 'Look up $identifier', 'Whose number is $identifier'],
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'An email address, phone number, handle, or (partial) name.',
        },
        maxResults: { type: 'integer', description: 'Max results (default 10).', minimum: 1, maximum: 50 },
      },
      required: ['query'],
    },
  };

  constructor(
    private readonly peopleService: PeopleService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PeopleLookupTool.name);
  }

  protected validateInput(input: unknown): PeopleLookupInput {
    return PeopleLookupInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PeopleLookupInput,
  ): Promise<PeopleLookupHit[]> {
    if (context.userId == null) {
      return [];
    }

    const userId = context.userId;
    const hits = await this.peopleService.lookup({ userId }, input.query, {
      limit: input.maxResults,
    });

    return Promise.all(
      hits.map(async (hit) => {
        const identifiers = await this.peopleService.getIdentifiersForPerson(userId, hit.person.id);

        return {
          id: GlobalUID.encode('person', hit.person.id),
          name: hit.person.name,
          description: hit.person.description,
          matchedVia: hit.matchedVia,
          matchedValue: hit.matchedValue,
          emails: identifiers.emails,
          phones: identifiers.phones,
        };
      }),
    );
  }
}
