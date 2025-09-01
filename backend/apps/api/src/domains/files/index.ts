import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';

import { FilesController } from './controllers/FilesController';
import { FileEntity } from './entities/FileEntity';
import { FileService } from './services/FileService';
import { FileProcessingService } from './services/FileProcessingService';

@Module({
  imports: [TypeOrmModule.forFeature([FileEntity]), EventsModule],
  providers: [FileService, FileProcessingService],
  controllers: [FilesController],
  exports: [FileService, FileProcessingService],
})
export class FilesModule {}

// Entities
export { FileEntity };

// Services
export { FileService, FileProcessingService };

// Types
export type { File } from './types';
