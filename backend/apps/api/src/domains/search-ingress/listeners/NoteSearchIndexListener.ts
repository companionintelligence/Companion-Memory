import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { type Note, NoteService } from '@ci/domains/notes';
import {
  NoteCreatedEvent,
  NoteRemovedEvent,
  NoteUpdatedEvent,
  type NoteCreatedPayload,
  type NoteRemovedPayload,
  type NoteUpdatedPayload,
} from '@ci/domains/notes/events';
import { EmbeddingService } from '@ci/domains/search-ingress/services/EmbeddingService';
import { VectorService } from '@ci/domains/search-ingress/services/VectorService';
import { type WeightedText } from '@ci/domains/search-ingress/types';

@Injectable()
export class NoteSearchIndexListener {
  constructor(
    private readonly notesService: NoteService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(NoteSearchIndexListener.name);
  }

  @OnEvent(NoteCreatedEvent, { queue: 'search-index' })
  async indexNote(payload: NoteCreatedPayload) {
    this.logger.log('Adding new note to search index', {
      noteId: payload.noteId,
    });

    await this.upsertNote(payload.noteId);
  }

  @OnEvent(NoteUpdatedEvent, { queue: 'search-index' })
  async updateNote(payload: NoteUpdatedPayload) {
    this.logger.log('Updating note in search index', {
      noteId: payload.noteId,
    });

    await this.upsertNote(payload.noteId);
  }

  @OnEvent(NoteRemovedEvent, { queue: 'search-index' })
  async unindexNote(payload: NoteRemovedPayload) {
    this.logger.log('Removing note in search index', {
      noteId: payload.noteId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await this.embeddingService.remove(context, {
      entityType: 'note',
      entityId: payload.noteId,
    });

    this.logger.log('Removed embedding for note');

    await this.vectorService.remove(context, {
      entityType: 'note',
      entityId: payload.noteId,
    });

    this.logger.log('Removed tsvector for note');
  }

  private async upsertNote(noteId: string) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const note = await this.notesService.findById(context, noteId);

    if (note == null) {
      this.logger.warn('Note not found, skipping indexing');

      return;
    }

    const searchDocument = this.getSearchDocument(note);

    if (searchDocument == null) {
      this.logger.log('Note has no search document, skipping embedding');
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument);

      await this.embeddingService.upsert(
        {
          userId: note.userId,
        },
        {
          entityType: 'note',
          entityId: note.id,
          embedding,
        },
      );

      this.logger.log('Upserted embedding for note');
    }

    const searchContent = this.getSearchContent(note);

    if (searchContent.length === 0) {
      this.logger.log('Note has no search content, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: note.userId,
        },
        {
          entityType: 'note',
          entityId: note.id,
          searchableText: searchContent,
        },
      );
    }

    this.logger.log('Upserted tsvector for note');
  }

  private getSearchContent(note: Note): WeightedText[] {
    const parts: WeightedText[] = [];

    if (note.title) {
      parts.push({ text: note.title, weight: 10 });
    }

    if (note.content) {
      parts.push({ text: note.content, weight: 5 });
    }

    return parts;
  }

  private getSearchDocument(note: Note): string | null {
    const parts = [];

    if (note.title) {
      parts.push(note.title);
    }

    if (note.content) {
      parts.push(note.content);
    }

    if (parts.length === 0) {
      return null;
    }

    const result = Array.from(parts).join(' ');

    return result.length > 0 ? result : null;
  }
}
