import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';

import { FileChunkEntity } from './entities/FileChunkEntity';
import { FileDocumentParseListener } from './listeners/FileDocumentParseListener';
import { DocumentChunkerService } from './services/DocumentChunkerService';
import { DocumentChunkService } from './services/DocumentChunkService';
import { DOCUMENT_EXTRACTORS } from './services/DocumentExtractor';
import { DocumentParserRegistry } from './services/DocumentParserRegistry';
import { DocumentParserService } from './services/DocumentParserService';
import { MarkItDownExtractor } from './services/MarkItDownExtractor';

@Module({
  imports: [TypeOrmModule.forFeature([FileChunkEntity]), EventsModule, FilesModule],
  providers: [
    MarkItDownExtractor,
    {
      provide: DOCUMENT_EXTRACTORS,
      useFactory: (markItDownExtractor: MarkItDownExtractor) => [markItDownExtractor],
      inject: [MarkItDownExtractor],
    },
    DocumentParserRegistry,
    DocumentParserService,
    DocumentChunkerService,
    DocumentChunkService,
    FileDocumentParseListener,
  ],
  exports: [DocumentChunkService],
})
export class ParsingModule {}

export { FileChunkEntity };
export { DocumentChunkService as FileChunkService };
export type { FileChunk } from './entities/FileChunkEntity';
export { DocumentParsedEvent, type DocumentParsedPayload } from './events';
export { ParseStatus } from './types';
