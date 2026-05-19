import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { MessageService, ThreadService } from '@ci/domains/conversations';
import { RelationshipService } from '@ci/domains/graph';
import { ConceptService, PersonService } from '@ci/domains/memory';
import { NoteService } from '@ci/domains/notes';

/**
 * The full structured export of a user's data.
 * Shape is intentionally simple and flat for portability.
 */
export interface UserDataExport {
  /** Schema version — increment when the shape changes. */
  schemaVersion: 1;
  exportedAt: string;
  userId: string;
  persons: unknown[];
  concepts: unknown[];
  relationships: unknown[];
  threads: unknown[];
  messages: unknown[];
  notes: unknown[];
}

/**
 * Plan 11 §2 — assembles a complete portable export of the user's data.
 *
 * Today the export is synchronous and in-memory. For large accounts this will
 * need to move to a background job that writes to object storage and returns a
 * signed download URL — the `POST /me/export` endpoint already returns the data
 * inline, so switching to async is a non-breaking change (the client just needs
 * to handle both a direct 200 payload and a 202 + polling flow).
 *
 * Included data categories (matching the consent schema from plan 09):
 *   - graph:           persons, concepts, relationships
 *   - communications:  threads, messages
 *   - memory:          notes
 *
 * Excluded from this initial version (follow-up PRs):
 *   - files:           raw file bytes (too large for in-memory export)
 *   - browser_activity (volume makes inline export impractical)
 *   - etl_data         (raw sync snapshots stored separately)
 *   - llm_invocations  (traces; privacy-sensitive; separate flow)
 */
@Injectable()
export class ExportService {
  constructor(
    private readonly personService: PersonService,
    private readonly conceptService: ConceptService,
    private readonly relationshipService: RelationshipService,
    private readonly threadService: ThreadService,
    private readonly messageService: MessageService,
    private readonly noteService: NoteService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ExportService.name);
  }

  /**
   * Collect and return all personal data for `userId` as a structured object.
   * The caller is responsible for serialising / compressing / streaming this
   * to the client.
   */
  async buildExport(userId: string): Promise<UserDataExport> {
    const context = toServiceContext({ userId });
    this.logger.log('Building data export', { userId });

    const [persons, concepts, relationships, threads, messages, notes] = await Promise.all([
      this.personService.findAll(context),
      this.conceptService.findAll(context),
      this.relationshipService.findAll(context),
      this.threadService.findAll(context),
      this.messageService.findAll(context),
      this.noteService.findAll(context),
    ]);

    this.logger.log('Data export assembled', {
      userId,
      counts: {
        persons: persons.length,
        concepts: concepts.length,
        relationships: relationships.length,
        threads: threads.length,
        messages: messages.length,
        notes: notes.length,
      },
    });

    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      userId,
      persons,
      concepts,
      relationships,
      threads,
      messages,
      notes,
    };
  }
}
