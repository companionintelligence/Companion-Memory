import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, EventService } from '@ci/domains/memory';

import type { ConnectionSyncJob } from '../../../types';
import type {
  GitHubCommentSummary,
  GitHubEvent,
  GitHubIssueSummary,
  GitHubPullRequestSummary,
  GitHubRepositoryEvents,
} from '../types';

@Injectable()
export class GitHubRepositoryEventsTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GitHubRepositoryEventsTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { userId, data } = syncJob;
    const context = toServiceContext({ userId });
    const repoEvents = (data.repoEvents as GitHubRepositoryEvents[] | undefined) ?? [];

    this.logger.log('Starting GitHub Repository Events transformation', {
      userId,
      connectionId: connection.id,
      repositoryCount: repoEvents.length,
    });

    for (const repositoryEvents of repoEvents) {
      for (const event of repositoryEvents.events) {
        try {
          const existingEvents = await this.eventService.search(context, {
            sourceId: event.id,
          });

          if (existingEvents.length > 0) {
            continue;
          }

          await this.upsertContentForEvent(context, event);

          const eventRecord = this.buildEventRecord(event);

          if (!eventRecord) {
            continue;
          }

          await this.eventService.create(context, {
            ...eventRecord,
            category: 'development',
            source_type: 'ETL',
            source_system: 'GitHub',
            source_id: event.id,
            metadata: {
              actor: event.actor,
              payload: event.payload,
              repo: repositoryEvents.repository,
              public: event.public,
            },
          });
        } catch (error) {
          this.logger.error('Failed to transform GitHub event', {
            connectionId: connection.id,
            eventId: event.id,
            eventType: event.type,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }
  }

  private async upsertContentForEvent(context: { userId: string }, event: GitHubEvent): Promise<void> {
    if (event.type === 'PullRequestEvent' && event.payload.pull_request) {
      await this.ensureContent(context, {
        type: 'pull_request',
        external_id: `github:pull_request:${event.payload.pull_request.id}`,
        title: event.payload.pull_request.title,
        text: event.payload.pull_request.body ?? '',
        url: event.payload.pull_request.html_url,
        source_url: event.payload.pull_request.html_url,
        source_data: {
          number: event.payload.pull_request.number,
          state: event.payload.pull_request.state,
          merged: event.payload.pull_request.merged,
        },
      });

      return;
    }

    if (event.type === 'IssuesEvent' && event.payload.issue) {
      await this.ensureContent(context, {
        type: 'issue',
        external_id: `github:issue:${event.payload.issue.id}`,
        title: event.payload.issue.title,
        text: event.payload.issue.body ?? '',
        url: event.payload.issue.html_url,
        source_url: event.payload.issue.html_url,
        source_data: {
          number: event.payload.issue.number,
          state: event.payload.issue.state,
        },
      });

      return;
    }

    if (event.type === 'IssueCommentEvent' && event.payload.comment) {
      await this.ensureContent(context, {
        type: 'issue_comment',
        external_id: `github:issue_comment:${event.payload.comment.id}`,
        text: event.payload.comment.body ?? '',
        url: event.payload.comment.html_url,
        source_url: event.payload.comment.html_url,
        source_data: {
          issueNumber: event.payload.issue?.number,
        },
      });

      return;
    }

    if (event.type === 'PullRequestReviewEvent' && event.payload.review) {
      await this.ensureContent(context, {
        type: 'pull_request_review',
        external_id: `github:pull_request_review:${event.payload.review.id}`,
        text: event.payload.review.body ?? '',
        url: event.payload.review.html_url,
        source_url: event.payload.review.html_url,
        source_data: {
          pullRequestNumber: event.payload.pull_request?.number,
          state: event.payload.review.state,
        },
      });

      return;
    }

    if (event.type === 'PullRequestReviewCommentEvent' && event.payload.review_comment) {
      await this.ensureContent(context, {
        type: 'pull_request_review_comment',
        external_id: `github:pull_request_review_comment:${event.payload.review_comment.id}`,
        text: event.payload.review_comment.body ?? '',
        url: event.payload.review_comment.html_url,
        source_url: event.payload.review_comment.html_url,
        source_data: {
          pullRequestNumber: event.payload.pull_request?.number,
        },
      });
    }
  }

  private async ensureContent(
    context: { userId: string },
    content: {
      type: string;
      external_id: string;
      title?: string;
      text?: string;
      url: string;
      source_url: string;
      source_data: Record<string, unknown>;
    },
  ): Promise<void> {
    const existingContent = await this.contentService.search(context, {
      type: content.type,
      external_id: content.external_id,
    });

    if (existingContent.length > 0) {
      return;
    }

    await this.contentService.create(context, content);
  }

  private buildEventRecord(
    event: GitHubEvent,
  ): { title: string; description: string; event_type: string; start_time: Date } | null {
    const start_time = new Date(event.created_at);

    switch (event.type) {
      case 'PushEvent': {
        const branch = this.getBranchName(event.payload.ref);
        const commitCount = event.payload.size ?? event.payload.commits?.length ?? 0;

        return {
          title: `Pushed ${commitCount} commit${commitCount === 1 ? '' : 's'} to ${branch} in ${event.repo.name}`,
          description: `Push event in ${event.repo.name}`,
          event_type: 'github_push',
          start_time,
        };
      }

      case 'PullRequestEvent':
        return this.buildActionEvent({
          event,
          entity: event.payload.pull_request,
          noun: 'pull request',
          prefix: 'github_pull_request',
          fallbackTitle: 'GitHub pull request activity',
        });
      case 'IssuesEvent':
        return this.buildActionEvent({
          event,
          entity: event.payload.issue,
          noun: 'issue',
          prefix: 'github_issue',
          fallbackTitle: 'GitHub issue activity',
        });
      case 'IssueCommentEvent':
        return this.buildCommentEvent(
          event,
          event.payload.issue,
          event.payload.comment,
          'issue',
          'github_issue_comment',
        );

      case 'PullRequestReviewEvent':
        return this.buildCommentEvent(
          event,
          event.payload.pull_request,
          event.payload.review,
          'pull request review',
          'github_pull_request_review',
        );
      case 'PullRequestReviewCommentEvent':
        return this.buildCommentEvent(
          event,
          event.payload.pull_request,
          event.payload.review_comment,
          'pull request review comment',
          'github_pull_request_review_comment',
        );
      default:
        return null;
    }
  }

  private buildActionEvent({
    event,
    entity,
    noun,
    prefix,
    fallbackTitle,
  }: {
    event: GitHubEvent;
    entity?: GitHubIssueSummary | GitHubPullRequestSummary;
    noun: string;
    prefix: string;
    fallbackTitle: string;
  }) {
    const action = (event.payload.action ?? 'updated').toString().toLowerCase();
    const title = entity?.number ? `${this.toSentenceCase(action)} ${noun} #${entity.number}` : fallbackTitle;

    return {
      title,
      description: entity?.title ? `${title}: ${entity.title}` : title,
      event_type: `${prefix}_${action}`,
      start_time: new Date(event.created_at),
    };
  }

  private buildCommentEvent(
    event: GitHubEvent,
    entity: GitHubIssueSummary | GitHubPullRequestSummary | undefined,
    comment:
      | GitHubCommentSummary
      | { id: number; body?: string | null; html_url: string; state?: string }
      | undefined,
    noun: string,
    prefix: string,
  ) {
    const reviewState = comment && 'state' in comment ? comment.state : undefined;
    const action = (event.payload.action ?? reviewState ?? 'created').toString().toLowerCase();
    const target = entity?.number ? `${noun} for #${entity.number}` : noun;
    const title = `${this.toSentenceCase(action)} ${target}`;

    return {
      title,
      description: comment?.body ? `${title}: ${comment.body}` : title,
      event_type: `${prefix}_${action.replace(/\s+/g, '_')}`,
      start_time: new Date(event.created_at),
    };
  }

  private toSentenceCase(value: string): string {
    if (value.length === 0) {
      return value;
    }

    return `${value[0].toUpperCase()}${value.slice(1)}`;
  }

  private getBranchName(ref: string | undefined): string {
    if (!ref) {
      return 'unknown branch';
    }

    return ref.replace('refs/heads/', '');
  }
}
