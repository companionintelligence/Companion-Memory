/**
 * @module NotesModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';

import { NoteEntity, type Note } from './entities/NoteEntity';
import { NoteService } from './services/NoteService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([NoteEntity]), EventsModule],
  providers: [NoteService],
  exports: [NoteService],
})
export class NotesModule {}

export { NoteEntity };

export { NoteService };
export type { Note };
export type { CaptureNoteDto, CaptureNoteResult, CreateNoteDto, UpdateNoteDto } from './types';
