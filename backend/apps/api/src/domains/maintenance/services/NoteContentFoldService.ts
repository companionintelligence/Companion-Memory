import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

/**
 * Fold `ci.notes` into CTI Content nodes (#1945 Note→Content).
 *
 * Creates same-id Content entities for notes that lack a Content mirror, with
 * `properties.provenance = user_created`. Idempotent on `(linked_table, linked_id)`.
 */
@Injectable()
export class NoteContentFoldService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(NoteContentFoldService.name);
  }

  async fold(userId: string): Promise<{ notesFolded: number }> {
    // entities.linked_id is uuid — compare/insert as uuid, not text.
    // Insert the entity row first so ci.content's deferred FK is satisfied.
    const inserted: Array<{ id: string }> = await this.dataSource.query(
      `WITH candidates AS (
         SELECT n.id, n.title, n.content, n.created_at, n.updated_at
           FROM ci.notes n
          WHERE n.user_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM ci.entities e
               WHERE e.owner_user_id = $1
                 AND e.entity_type = 'Content'
                 AND e.linked_table = 'notes'
                 AND e.linked_id = n.id
            )
       ),
       base AS (
         INSERT INTO ci.entities
           (entity_id, entity_type, name, description, owner_user_id, is_active,
            linked_table, linked_id, properties, created_at, updated_at)
         SELECT c.id, 'Content',
                COALESCE(c.title, 'Note'),
                NULL, $1, TRUE, 'notes', c.id,
                jsonb_build_object('provenance', 'user_created', 'folded_from', 'notes'),
                NOW(), NOW()
           FROM candidates c
         ON CONFLICT DO NOTHING
         RETURNING entity_id AS id
       ),
       detail AS (
         INSERT INTO ci.content (id, type, text, user_id, created_at, updated_at, entity_type)
         SELECT b.id, 'note',
                COALESCE(n.content, n.title, ''),
                $1, n.created_at, n.updated_at, 'Content'
           FROM base b
           JOIN ci.notes n ON n.id = b.id
         ON CONFLICT (id) DO NOTHING
         RETURNING id
       )
       SELECT id FROM detail`,
      [userId],
    );

    this.logger.log('Note→Content fold complete', { userId, notesFolded: inserted.length });

    return { notesFolded: inserted.length };
  }
}
