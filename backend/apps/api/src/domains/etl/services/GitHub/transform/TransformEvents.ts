import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import {
  GithubEvent,
  GithubCreateEvent,
  GithubDiscussionEvent,
  GithubForkEvent,
  GithubCommitCommentEvent,
  GithubIssueCommentEvent,
  GithubIssueEvent,
  GithubDeleteEvent,
  GithubPullRequestEvent,
  GithubPullRequestReviewEvent,
  GithubPullRequestReviewCommentEvent,
  GithubPushEvent,
  GithubReleaseEvent,
} from '@ci/domains/etl/services/GitHub/sync/SyncEvents';
import { ContentService, EventService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

@Injectable()
export class GitHubEventsTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GitHubEventsTransformService.name);
  }

  async transform({ connection, syncJob }: { connection: Connection; syncJob: ConnectionSyncJob }) {
    const { userId, data } = syncJob;

    this.logger.log('Starting GitHub Events transformation', {
      userId,
      connectionId: connection.id,
    });

    const eventsMap = (data?.events as Record<string, GithubEvent[]>) || {};

    const combinedEvents = Object.values(eventsMap).reduce((output, events) => output.concat(events), []);

    if (combinedEvents.length === 0) {
      this.logger.log('No GitHub events found to transform', {
        userId,
        connectionId: connection.id,
      });

      return;
    }

    for (const event of combinedEvents) {
      //Only create events for things that this user did. This should be filtered in SyncEvents, but
      //adding another check just in case.
      if (event.actor?.id.toString() !== connection.externalId) {
        continue;
      }

      const existingEvent = await this.eventService.search(
        { userId },
        {
          sourceSystem: 'github_events',
          sourceId: event.id.toString(),
        },
      );

      switch (event.type) {
        case 'CommitCommentEvent': {
          const comment = (event as GithubCommitCommentEvent).payload.comment;
          const contentExternalId = `${comment.commit_id}:${comment.id}`;
          const existingContent = await this.contentService.search(
            { userId },
            { external_id: contentExternalId },
          );
          if (existingContent.length === 0) {
            await this.contentService.create(
              { userId },
              {
                type: 'github_comment',
                title: `Commented on commit ${comment.commit_id.slice(0, 8)} in repo ${event.repo.name}`,
                text: comment.body,
                url: comment.html_url,
                external_id: `${comment.commit_id}:${comment.id}`,
              },
            );
          }

          if (existingEvent.length === 0) {
            await this.eventService.create(
              { userId },
              {
                event_type: 'github_comment',
                source_id: event.id.toString(),
                start_time: new Date(event.created_at),
                title: `Commented on commit in repo ${event.repo.name}`,
                description: comment.body,
                source_system: 'github_events',
              },
            );
          }

          break;
        }

        case 'CreateEvent': {
          const thisEvent = event as GithubCreateEvent;
          if (thisEvent.payload.ref_type === 'branch' && existingEvent.length === 0) {
            await this.eventService.create(
              { userId },
              {
                event_type: 'github_branch_creation',
                source_id: thisEvent.id.toString(),
                start_time: new Date(thisEvent.created_at),
                title: `Created branch ${thisEvent.payload.ref} in repository ${thisEvent.repo.name}`,
                description: thisEvent.payload.description,
                source_system: 'github_events',
              },
            );
          } else if (thisEvent.payload.ref_type === 'tag' && existingEvent.length === 0) {
            await this.eventService.create(
              { userId },
              {
                event_type: 'github_tag_creation',
                source_id: thisEvent.id.toString(),
                start_time: new Date(thisEvent.created_at),
                title: `Created tag ${thisEvent.payload.ref} in repository ${thisEvent.repo.name}`,
                description: thisEvent.payload.description,
                source_system: 'github_events',
              },
            );
          } else if (thisEvent.payload.ref_type === 'repository' && existingEvent.length === 0) {
            await this.eventService.create(
              { userId },
              {
                event_type: 'github_repository_creation',
                source_id: thisEvent.id.toString(),
                start_time: new Date(thisEvent.created_at),
                title: `Created repository ${thisEvent.repo.name}`,
                description: thisEvent.payload.description,
                source_system: 'github_events',
              },
            );
          }

          break;
        }

        case 'DeleteEvent': {
          const thisEvent = event as GithubDeleteEvent;
          if (thisEvent.payload.ref_type === 'branch' && existingEvent.length === 0) {
            await this.eventService.create(
              { userId },
              {
                event_type: 'github_branch_deletion',
                source_id: thisEvent.id.toString(),
                start_time: new Date(thisEvent.created_at),
                title: `Deleted branch ${thisEvent.payload.ref}`,
                source_system: 'github_events',
              },
            );
          } else if (thisEvent.payload.ref_type === 'tag' && existingEvent.length === 0) {
            await this.eventService.create(
              { userId },
              {
                event_type: 'github_tag_deletion',
                source_id: thisEvent.id.toString(),
                start_time: new Date(thisEvent.created_at),
                title: `Deleted tag ${thisEvent.payload.ref} in repository ${thisEvent.repo.name}`,
                source_system: 'github_events',
              },
            );
          }

          break;
        }

        case 'DiscussionEvent':
          if (existingEvent.length === 0) {
            const thisEvent = event as GithubDiscussionEvent;
            await this.eventService.create(
              { userId },
              {
                event_type: 'github_discussion_creation',
                source_id: thisEvent.id.toString(),
                start_time: new Date(thisEvent.created_at),
                title: `Created discussion  ${thisEvent.payload.discussion.title}`,
                description: thisEvent.payload.discussion.body_text,
                source_system: 'github_events',
              },
            );
          }

          break;

        case 'ForkEvent':
          if (existingEvent.length === 0) {
            const thisEvent = event as GithubForkEvent;
            await this.eventService.create(
              { userId },
              {
                event_type: 'github_repo_fork',
                source_id: thisEvent.id.toString(),
                start_time: new Date(thisEvent.created_at),
                title: `Forked repo  ${thisEvent.payload.forkee.full_name}`,
                source_system: 'github_events',
              },
            );
          }

          break;

        case 'IssueCommentEvent': {
          const thisEvent = event as GithubIssueCommentEvent;
          const existingContent = await this.contentService.search(
            { userId },
            { external_id: thisEvent.payload.comment.id.toString() },
          );
          if (existingContent.length === 0) {
            await this.contentService.create(
              { userId },
              {
                type: 'github_comment',
                title: `Commented on issue ${thisEvent.payload.issue.number} in repo ${thisEvent.repo.name}`,
                text: thisEvent.payload.comment.body,
                url: thisEvent.payload.comment.html_url,
                external_id: thisEvent.payload.comment.id.toString(),
              },
            );
          }

          if (existingEvent.length === 0) {
            await this.eventService.create(
              { userId },
              {
                event_type: 'github_comment',
                source_id: thisEvent.id.toString(),
                start_time: new Date(thisEvent.created_at),
                title: `Commented on issue ${thisEvent.payload.issue.number} in repo ${thisEvent.repo.name}`,
                description: thisEvent.payload.comment.body,
                source_system: 'github_events',
              },
            );
          }

          break;
        }

        case 'IssuesEvent':
          if (existingEvent.length === 0) {
            const thisEvent = event as GithubIssueEvent;
            const actionCapitalized =
              String(thisEvent.payload.action).charAt(0).toUpperCase() +
              String(thisEvent.payload.action).slice(1);
            await this.eventService.create(
              { userId },
              {
                event_type: `github_issue_${thisEvent.payload.action}`,
                source_id: thisEvent.id.toString(),
                start_time: new Date(thisEvent.created_at),
                title: `${actionCapitalized} issue ${thisEvent.payload.issue.number} in repo ${thisEvent.repo.name}`,
                description: thisEvent.payload.issue.body,
                source_system: 'github_events',
              },
            );
          }

          break;

        case 'PullRequestEvent':
          if (existingEvent.length === 0) {
            const thisEvent = event as GithubPullRequestEvent;
            const actionCapitalized =
              String(thisEvent.payload.action).charAt(0).toUpperCase() +
              String(thisEvent.payload.action).slice(1);
            await this.eventService.create(
              { userId },
              {
                event_type: `github_pull_request_${thisEvent.payload.action}`,
                source_id: thisEvent.id.toString(),
                start_time: new Date(thisEvent.payload.pull_request.updated_at),
                title: `${actionCapitalized} pull request #${thisEvent.payload.pull_request.number} in repo ${thisEvent.repo.name}`,
                description: thisEvent.payload.pull_request.title,
                source_system: 'github_events',
              },
            );
          }

          break;

        case 'PullRequestReviewEvent':
          if (existingEvent.length === 0) {
            const thisEvent = event as GithubPullRequestReviewEvent;
            const actionCapitalized =
              String(thisEvent.payload.action).charAt(0).toUpperCase() +
              String(thisEvent.payload.action).slice(1);
            await this.eventService.create(
              { userId },
              {
                event_type: `github_pull_request_review_${thisEvent.payload.action}`,
                source_id: thisEvent.id.toString(),
                start_time: new Date(thisEvent.created_at),
                title: `${actionCapitalized} pull request review for ${thisEvent.payload.pull_request.number} in repo ${thisEvent.repo.name}`,
                description: thisEvent.payload.review.body,
                source_system: 'github_events',
              },
            );
          }

          break;

        case 'PullRequestReviewCommentEvent':
          if (existingEvent.length === 0) {
            const thisEvent = event as GithubPullRequestReviewCommentEvent;
            const actionCapitalized =
              String(thisEvent.payload.action).charAt(0).toUpperCase() +
              String(thisEvent.payload.action).slice(1);
            await this.eventService.create(
              { userId },
              {
                event_type: `github_pull_request_review_comment_${thisEvent.payload.action}`,
                source_id: thisEvent.id.toString(),
                start_time: new Date(thisEvent.created_at),
                title: `${actionCapitalized} pull request review comment for ${thisEvent.payload.pull_request.number} in repo ${thisEvent.repo.name}`,
                description: thisEvent.payload.comment.body,
                source_system: 'github_events',
              },
            );
          }

          break;

        case 'PushEvent': {
          const thisEvent = event as GithubPushEvent;
          if (existingEvent.length === 0) {
            await this.eventService.create(
              { userId },
              {
                event_type: `github_push`,
                source_id: thisEvent.id.toString(),
                start_time: new Date(thisEvent.created_at),
                title: `Pushed commits to branch ${thisEvent.payload.ref.replace('refs/heads/', '')} in repo ${thisEvent.repo.name}`,
                source_system: 'github_events',
              },
            );
          }

          break;
        }

        case 'ReleaseEvent':
          if (existingEvent.length === 0) {
            const thisEvent = event as GithubReleaseEvent;
            const actionCapitalized =
              String(thisEvent.payload.action).charAt(0).toUpperCase() +
              String(thisEvent.payload.action).slice(1);
            await this.eventService.create(
              { userId },
              {
                event_type: `github_release_${thisEvent.payload.action}`,
                source_id: thisEvent.id.toString(),
                start_time: new Date(thisEvent.created_at),
                title: `${actionCapitalized} release ${thisEvent.payload.release.name} in repo ${thisEvent.repo.name}`,
                description: thisEvent.payload.release.body,
                source_system: 'github_events',
              },
            );
          }

          break;

        default:
          break;
      }
    }
  }
}
