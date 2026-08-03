import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { GlobalUID } from '@ci/common/ids';
import { LoggerService } from '@ci/common/logging';
import { PersonService } from '@ci/domains/memory';
import { PersonMergeService } from '@ci/domains/people';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const PeopleMergeInputSchema = z.object({
  winnerId: z.string().min(1),
  loserId: z.string().min(1),
});

export type PeopleMergeInput = z.infer<typeof PeopleMergeInputSchema>;

export interface PeopleMergeResult {
  merged: boolean;
  /** Why the merge was skipped, when merged=false. */
  skippedReason?: string;
  /** GlobalUID of the surviving person. */
  personId: string;
  personName: string | null;
}

/**
 * Accept a person id in either GlobalUID form (the contract every people.*
 * intent and GraphQL uses) or a raw UUID, so agents can pass ids straight
 * back from any read tool.
 */
function parsePersonId(id: string): string {
  try {
    return GlobalUID.parse('person', id);
  } catch {
    return id;
  }
}

/**
 * Merge two Person records into one (issue #1810). Destructive and
 * capability-gated: the intent's privacy label (`destructive: true`) makes
 * every dispatcher (MCP destructiveHint, agent confirmation flows) require
 * explicit user confirmation before running it.
 */
@Injectable()
export class PeopleMergeTool extends BaseTool<PeopleMergeInput, PeopleMergeResult> {
  readonly schema: IntentDefinition = {
    name: 'people.merge',
    domain: 'people',
    title: 'Merge two people',
    description:
      'Merge two person records that are the same real person: every reference ' +
      '(profiles, identifiers, relationships, communications, events) moves to the ' +
      'winner and the loser becomes a tombstone whose id keeps resolving. ' +
      'DESTRUCTIVE and irreversible — only run after the user explicitly confirms ' +
      'the two records are the same person (e.g. from a people.duplicates suggestion).',
    privacy: { access: 'write', sensitivity: 'personal', destructive: true, external: false },
    consumes: ['person'],
    produces: ['person'],
    phrases: ['Merge $personA and $personB', 'Those two contacts are the same person'],
    parameters: {
      type: 'object',
      properties: {
        winnerId: {
          type: 'string',
          description: 'Id of the person to KEEP (GlobalUID from people.lookup/find, or raw UUID).',
        },
        loserId: {
          type: 'string',
          description: 'Id of the person to merge away (GlobalUID or raw UUID).',
        },
      },
      required: ['winnerId', 'loserId'],
    },
  };

  constructor(
    private readonly personMergeService: PersonMergeService,
    private readonly personService: PersonService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PeopleMergeTool.name);
  }

  protected validateInput(input: unknown): PeopleMergeInput {
    return PeopleMergeInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PeopleMergeInput,
  ): Promise<PeopleMergeResult> {
    if (context.userId == null) {
      throw new Error('people.merge requires an authenticated user');
    }

    const userId = context.userId;
    const winnerId = parsePersonId(input.winnerId);
    const loserId = parsePersonId(input.loserId);

    const result = await this.personMergeService.merge(userId, winnerId, loserId, {
      initiator: 'user',
    });

    const survivor = await this.personService.findById({ userId }, result.winnerEntityId);

    return {
      merged: result.merged,
      skippedReason: result.skippedReason,
      personId: GlobalUID.encode('person', result.winnerEntityId),
      personName: survivor?.name ?? null,
    };
  }
}
