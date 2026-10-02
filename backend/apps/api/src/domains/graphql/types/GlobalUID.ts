import { BadRequestException } from '@nestjs/common';

type ResourceType =
  | 'action'
  | 'answer'
  | 'ask'
  | 'ask-grant'
  | 'household-tier'
  | 'ask-broadcast'
  | 'ask-audit'
  | 'ask-answer'
  | 'browser-activity'
  | 'communication'
  | 'concept'
  | 'connection'
  | 'connectionSyncJob'
  | 'content'
  | 'event'
  | 'file'
  | 'file-chunk'
  | 'item'
  | 'message'
  | 'note'
  | 'observation'
  | 'peer-link'
  | 'person'
  | 'place'
  | 'product'
  | 'provider'
  | 'provider-key'
  | 'question'
  | 'receipt'
  | 'receipt-line-item'
  | 'relationship'
  | 'reminder'
  | 'schedule-candidate'
  | 'summary'
  | 'saved-search'
  | 'tag'
  | 'task'
  | 'taskPendingChange'
  | 'thread'
  | 'user';

/**
 * A malformed or mistyped id is the CALLER's mistake, so it is raised as a 400
 * (`BAD_USER_INPUT` over GraphQL), not a plain `Error`. `formatError` masks every
 * non-HTTP throwable as "Internal server error" with a correlation id — which is
 * how `file(id: "<a bare uuid>")` read as a server fault in the iOS QA run
 * (MEM-06), when the id was simply not a global id. The messages are unchanged:
 * `mutationGlobalIds.test.ts` pins them, and a bare uuid is still refused.
 */
export class GlobalUID {
  static encode(type: ResourceType, id: string): string {
    return Buffer.from(`${type}:${id}`).toString('base64');
  }

  static decode(globalId: string): { type: string; id: string } {
    let decoded;

    try {
      decoded = Buffer.from(globalId, 'base64').toString('utf-8');
    } catch {
      throw new BadRequestException('Invalid global id');
    }

    const [type, id] = decoded.split(':');

    if (!type || !id) {
      throw new BadRequestException('Invalid global id format');
    }

    return {
      type,
      id,
    };
  }

  static parse(type: ResourceType, globalId: string): string {
    const { type: decodedType, id } = this.decode(globalId);

    if (decodedType !== type) {
      throw new BadRequestException('Unexpected global id type');
    }

    return id;
  }
}
