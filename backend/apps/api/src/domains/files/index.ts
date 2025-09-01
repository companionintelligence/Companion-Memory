import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';

import { FilesController } from './controllers/FilesController';
import { FileEntity } from './entities/FileEntity';
import { FileService } from './services/FileService';
import { FileParsingService } from './services/FileParsingService';

@Module({
  imports: [TypeOrmModule.forFeature([FileEntity]), EventsModule],
  providers: [FileService, FileParsingService],
  controllers: [FilesController],
  exports: [FileService, FileParsingService],
})
export class FilesModule {}

// Entities
export { FileEntity };

// Services
export { FileService };
export { FileParsingService };

// Types
export type { File } from './types';
