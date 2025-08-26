import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';

import { ThreadsController } from './controllers/ThreadsController';
import { MessageEntity } from './entities/MessageEntity';
import { ThreadEntity } from './entities/ThreadEntity';
import { MessageService } from './services/MessageService';
import { ThreadService } from './services/ThreadService';

@Module({
  imports: [TypeOrmModule.forFeature([MessageEntity, ThreadEntity]), EventsModule],
  providers: [MessageService, ThreadService],
  controllers: [ThreadsController],
  exports: [MessageService, ThreadService],
})
export class ConversationModule {}

// Entities
export { MessageEntity, ThreadEntity };

// Services
export { MessageService, ThreadService };

// Types
export type {} from './types';
