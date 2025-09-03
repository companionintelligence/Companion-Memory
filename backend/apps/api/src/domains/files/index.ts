import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';

import { FilesController } from './controllers/FilesController';
import { FileEntity } from './entities/FileEntity';
import { FileService } from './services/FileService';

@Module({
  imports: [TypeOrmModule.forFeature([FileEntity]), EventsModule],
  providers: [FileService],
  controllers: [FilesController],
  exports: [FileService],
})
export class FilesModule {}

// Entities
export { FileEntity };

// Services
export { FileService };

// Types
export type { File } from './types';
