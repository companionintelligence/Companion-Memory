import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService, shouldEmbedType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { type Task, TaskService } from '@ci/domains/planning';
import {
  TaskCreatedEvent,
  TaskRemovedEvent,
  TaskUpdatedEvent,
  type TaskCreatedPayload,
  type TaskRemovedPayload,
  type TaskUpdatedPayload,
} from '@ci/domains/planning/events';
import { EmbeddingService } from '@ci/domains/search-ingress/services/EmbeddingService';
import { VectorService } from '@ci/domains/search-ingress/services/VectorService';
import { type WeightedText } from '@ci/domains/search-ingress/types';

/**
 * Indexes ci.tasks into ci_search so the planner answers recall questions —
 * "what am I supposed to be doing about the Fenwick contract?" — without a tool
 * call. This is the milestone the whole planning-in-CI-Server argument rests on
 * (docs/architecture/planning-roadmap.md:14).
 *
 * Two things differ from the NoteSearchIndexListener this is modelled on.
 *
 * 1. It scopes reads with `payload.userId`, not SYSTEM_USER. TaskService is
 *    unconditionally tenant-scoped and has no SYSTEM_USER escape, so a
 *    SYSTEM_USER read returns null for every real task and the listener becomes
 *    a silent no-op that indexes nothing.
 * 2. Archiving REMOVES the row from the index rather than skipping it. An
 *    archived task should not surface in recall, and removal keeps the listener
 *    agreeing with ENTITY_SOURCE_MAP.task's backfill predicate — a skip would
 *    leave the sweep re-finding a row it can never converge on, the exact
 *    churn ci_search.index_skips exists to end.
 */
@Injectable()
export class TaskSearchIndexListener {
  constructor(
    private readonly taskService: TaskService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(TaskSearchIndexListener.name);
  }

  @OnEvent(TaskCreatedEvent, { queue: 'search-index' })
  async indexTask(payload: TaskCreatedPayload) {
    this.logger.log('Adding new task to search index', { taskId: payload.taskId });

    await this.upsertTask(payload.taskId, payload.userId);
  }

  @OnEvent(TaskUpdatedEvent, { queue: 'search-index' })
  async updateTask(payload: TaskUpdatedPayload) {
    this.logger.log('Updating task in search index', { taskId: payload.taskId });

    await this.upsertTask(payload.taskId, payload.userId);
  }

  @OnEvent(TaskRemovedEvent, { queue: 'search-index' })
  async unindexTask(payload: TaskRemovedPayload) {
    this.logger.log('Removing task from search index', { taskId: payload.taskId });

    await this.removeFromIndex(payload.taskId);
  }

  /**
   * Removal is keyed on (entity_type, entity_id) alone, so it needs no tenant
   * scope and stays correct for a task whose row is already gone.
   */
  private async removeFromIndex(taskId: string) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await this.embeddingService.remove(context, {
      entityType: 'task',
      entityId: taskId,
    });

    await this.vectorService.remove(context, {
      entityType: 'task',
      entityId: taskId,
    });

    this.logger.log('Removed task from search index');
  }

  private async upsertTask(taskId: string, userId: string | undefined) {
    // pg-boss is at-least-once and jobs queued before `userId` joined the
    // payload outlive a deploy. Skipping one is safe: the next write to that
    // task re-fires the event with the current shape.
    if (userId == null) {
      this.logger.warn('Task event carried no userId, skipping indexing', { taskId });

      return;
    }

    const task = await this.taskService.findById({ userId }, taskId);

    if (task == null) {
      this.logger.warn('Task not found, skipping indexing');

      return;
    }

    if (task.status === 'archived') {
      this.logger.log('Task is archived, removing from search index');

      await this.removeFromIndex(task.id);

      return;
    }

    const searchDocument = this.getSearchDocument(task);

    if (!shouldEmbedType('task')) {
      this.logger.log('Task type not in embed allowlist, skipping embedding');
    } else if (searchDocument == null) {
      this.logger.log('Task has no search document, skipping embedding');
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument);

      await this.embeddingService.upsert(
        {
          userId: task.userId,
        },
        {
          entityType: 'task',
          entityId: task.id,
          embedding,
        },
      );

      this.logger.log('Upserted embedding for task');
    }

    const searchContent = this.getSearchContent(task);

    if (searchContent.length === 0) {
      this.logger.log('Task has no search content, skipping vectorization');

      return;
    }

    await this.vectorService.upsert(
      {
        userId: task.userId,
      },
      {
        entityType: 'task',
        entityId: task.id,
        searchableText: searchContent,
      },
    );

    this.logger.log('Upserted tsvector for task');
  }

  /**
   * Title carries the 'A' weight band because a task's title is the phrase a
   * person actually recalls it by. Notes and description are body text; status
   * is included at the lowest band so "what's in progress" narrows usefully.
   */
  private getSearchContent(task: Task): WeightedText[] {
    const parts: WeightedText[] = [];

    if (task.title) {
      parts.push({ text: task.title, weight: 10 });
    }

    if (task.description) {
      parts.push({ text: task.description, weight: 5 });
    }

    if (task.notes) {
      parts.push({ text: task.notes, weight: 5 });
    }

    if (task.status) {
      parts.push({ text: task.status, weight: 2 });
    }

    return parts;
  }

  /**
   * Status is deliberately absent here. The embedding is a semantic
   * representation of the work; appending a status word to every document
   * pulls unrelated tasks toward each other in vector space.
   */
  private getSearchDocument(task: Task): string | null {
    const parts = [task.title, task.description, task.notes].filter(
      (part): part is string => typeof part === 'string' && part.trim().length > 0,
    );

    if (parts.length === 0) {
      return null;
    }

    const result = parts.join(' ');

    return result.length > 0 ? result : null;
  }
}
