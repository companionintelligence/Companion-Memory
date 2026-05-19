/**
 * Data export / portability module (plan 11).
 *
 * Provides a single REST endpoint for GDPR Art. 20 data portability:
 *
 *   POST /me/export
 *     Assembles the authenticated user's complete personal data as a
 *     structured JSON attachment and returns it inline.
 *     Requires scope `profile:read`.
 *
 * Included data categories:
 *   - graph:           persons, concepts, relationships
 *   - communications:  threads, messages
 *   - memory:          notes
 *
 * Future work: async export jobs for large accounts; binary file export;
 * browser-activity and ETL-snapshot export.
 */

import { Module } from '@nestjs/common';

import { ConversationModule } from '@ci/domains/conversations';
import { GraphModule } from '@ci/domains/graph';
import { MemoryModule } from '@ci/domains/memory';
import { NotesModule } from '@ci/domains/notes';

import { ExportController } from './controllers/ExportController';
import { ExportService } from './services/ExportService';

@Module({
  imports: [ConversationModule, GraphModule, MemoryModule, NotesModule],
  providers: [ExportService],
  controllers: [ExportController],
})
export class ExportModule {}

// Service
export { ExportService };
export type { UserDataExport } from './services/ExportService';
