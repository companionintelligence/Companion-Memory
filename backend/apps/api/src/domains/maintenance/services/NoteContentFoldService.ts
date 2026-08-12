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
                 AND e.linked_id = n.id::text
            )
       ),
       detail AS (
         INSERT INTO ci.content (id, type, text, user_id, created_at, updated_at, entity_type)
         SELECT c.id, 'note', COALESCE(c.content, c.title, ''), $1, c.created_at, c.updated_at, 'Content'
           FROM candidates c
         ON CONFLICT (id) DO NOTHING
         RETURNING id
       ),
       base AS (
         INSERT INTO ci.entities
           (entity_id, entity_type, name, description, owner_user_id, is_active,
            linked_table, linked_id, properties, created_at, updated_at)
         SELECT d.id, 'Content',
                COALESCE((SELECT title FROM ci.notes WHERE id = d.id), 'Note'),
                NULL, $1, TRUE, 'notes', d.id::text,
                jsonb_build_object('provenance', 'user_created', 'folded_from', 'notes'),
                NOW(), NOW()
           FROM detail d
         ON CONFLICT DO NOTHING
         RETURNING entity_id AS id
       )
       SELECT id FROM base`,
      [userId],
    );

    this.logger.log('Note→Content fold complete', { userId, notesFolded: inserted.length });

    return { notesFolded: inserted.length };
  }
}
