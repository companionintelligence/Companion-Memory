import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { LoggerService } from '@ci/common/logging';
import { INDEXABLE_ENTITIES, type IndexableEntity } from '@ci/domains/search-next';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

import { ENTRY_WINDOW_CHARACTERS, type EntryWindow } from './compactSearchHit';
import { DatabaseSearchTool } from './DatabaseSearchTool';

const KnowledgeGetInputSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(INDEXABLE_ENTITIES as unknown as [IndexableEntity, ...IndexableEntity[]]),
  offset: z.number().int().min(0).optional(),
});

export type KnowledgeGetInput = z.infer<typeof KnowledgeGetInputSchema>;

export interface KnowledgeGetResult {
  found: boolean;
  /** One sentence on what came back and how to read the rest. */
  summary: string;
  entry?: EntryWindow<IndexableEntity>;
}

/**
 * One entry, read whole: the full body of an email, a note, a document chunk. A search hit cuts
 * every string to share a page's budget and says how much it cut; this is how a caller reads the
 * rest. Without it an agent asked for "the full body of that email" had no tool to call: OpenClaw
 * (2026-11-13) tried `memory_get`, then spent 20 shell calls finding an API key and the REST route,
 * and overflowed a 64k window before it read the email.
 *
 * The text comes {@link ENTRY_WINDOW_CHARACTERS} characters at a time, from `offset`, so one call
 * can never fill a small window. A delegate of {@link DatabaseSearchTool}, so an entry reads here
 * exactly as it resolves as a hit: same ownership checks, same forgotten-entity filter.
 */
@Injectable()
export class KnowledgeGetTool extends BaseTool<KnowledgeGetInput, KnowledgeGetResult> {
  readonly schema: IntentDefinition = {
    name: 'knowledge.get',
    domain: 'knowledge',
    title: 'Read one entry',
    description:
      'Read one entry from knowledge_search (or another search intent) in full: the whole body of an email, ' +
      "message, note or document. Pass the hit's id and type. Use it when a search hit says " +
      '"more characters", or when the user asks for the full text. The text comes ' +
      `${ENTRY_WINDOW_CHARACTERS.toLocaleString('en-US')} characters at a time: when the result has ` +
      'nextOffset, call again with offset set to it for the next part.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    // The device mirror has these rows, but the phone has no handler for this intent yet.
    localCapable: false,
    produces: ['event', 'content', 'person', 'place', 'note', 'file', 'task'],
    phrases: ['Show me the full email', 'Read the whole message', 'Open that note'],
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id of a search hit.', maxLength: 36 },
        type: {
          type: 'string',
          enum: [...INDEXABLE_ENTITIES],
          description:
            'The type of that hit, as the search returned it (communication, note, file-chunk...).',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: "Where to start reading the text: the previous result's nextOffset. Default 0.",
        },
      },
      required: ['id', 'type'],
      additionalProperties: false,
    },
  };

  constructor(
    private readonly search: DatabaseSearchTool,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(KnowledgeGetTool.name);
  }

  protected validateInput(input: unknown): KnowledgeGetInput {
    return KnowledgeGetInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: KnowledgeGetInput,
  ): Promise<KnowledgeGetResult> {
    const entry = await this.search.readEntry(context, input.type, input.id, input.offset);

    if (!entry) {
      return {
        found: false,
        summary: `No ${input.type} with id ${input.id}. Check the id and type against the search hit.`,
      };
    }

    return { found: true, summary: describeWindow(entry), entry };
  }
}

function describeWindow(entry: EntryWindow): string {
  if (!entry.textField || entry.textLength == null || entry.offset == null) {
    return 'The whole entry; it has no long text.';
  }

  const end = entry.nextOffset ?? entry.textLength;

  if (entry.offset === 0 && entry.nextOffset == null) {
    return `The whole entry; ${entry.textField} is complete (${entry.textLength} characters).`;
  }

  const range = `characters ${entry.offset}–${end} of ${entry.textLength} of ${entry.textField}`;

  return entry.nextOffset == null
    ? `${range}: the end of the text.`
    : `${range}. Call again with offset ${entry.nextOffset} for the next part.`;
}
