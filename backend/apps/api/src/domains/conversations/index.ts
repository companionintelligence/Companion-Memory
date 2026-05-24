/**
 * This module handles all aspects of user conversations, including threads and messages.
 * It provides the structure for storing, retrieving, and managing conversational data
 * within the application.
 *
 * ### Key Components:
 * - **Threads and Messages**: Manages the core entities of a conversation: `ThreadEntity`
 *   represents a conversation, and `MessageEntity` represents an individual message
 *   within a thread.
 * - **Services (`ThreadService`, `MessageService`)**: Contain the business logic for
 *   creating, updating, and fetching threads and messages.
 * - **Controller (`ThreadsController`)**: Exposes REST API endpoints for interacting
 *   with conversation threads.
 * - **File Integration**: Integrates with the `FilesModule` to associate files
 *   with messages, allowing for attachments.
 * - **Event Integration**: Connects with the `EventsModule` to handle or emit
 *   events related to conversation activities.
 *
 * @module ConversationsModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { FileEntity, FilesModule } from '@ci/domains/files';

import { ThreadsController } from './controllers/ThreadsController';
import { MessageEntity, type Message } from './entities/MessageEntity';
import { ThreadEntity, type Thread } from './entities/ThreadEntity';
import { MessageService } from './services/MessageService';
import { ThreadService } from './services/ThreadService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([MessageEntity, ThreadEntity, FileEntity]), EventsModule, FilesModule],
  providers: [MessageService, ThreadService],
  controllers: [ThreadsController],
  exports: [MessageService, ThreadService],
})
export class ConversationModule {}

export { MessageEntity, MessageService, ThreadEntity, ThreadService };
export type { Message, Thread };
