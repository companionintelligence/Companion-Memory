import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { UserCreatedEvent, type UserCreatedPayload, UserService } from '@ci/domains/user';

import { ImportInboxService } from '../services/ImportInboxService';

/**
 * Creates a new account's inbox subtree the moment the user row exists, so
 * their drop folders are on the mount without waiting for an app restart
 * (which provisions every user) or their first visit to the Inbox panel
 * (which provisions on scan). Best-effort for the same reason boot is: an
 * unavailable inbox mount must not make signup fail.
 */
@Injectable()
export class InboxProvisionListener {
  constructor(
    private readonly inbox: ImportInboxService,
    private readonly users: UserService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(InboxProvisionListener.name);
  }

  // Its own queue: the events system allows one listener per event per queue,
  // and `user.created` on the default queue already belongs to the
  // saved-search seeder. NOT the import-stages queue — that one is
  // worker-role with its own queue options, and folder provisioning must not
  // wait behind a 40GB unpack.
  @OnEvent(UserCreatedEvent, { queue: 'import-inbox-provision' })
  async provisionForNewUser(payload: UserCreatedPayload): Promise<void> {
    try {
      const user = await this.users.findById({ userId: payload.userId }, payload.userId);

      if (user == null) {
        return;
      }

      await this.inbox.provisionUserInbox(user.id);
      this.logger.log('Provisioned inbox folders for new user', { userId: payload.userId });
    } catch (err: unknown) {
      this.logger.warn('Could not provision inbox folders for new user', {
        userId: payload.userId,
        error: (err as Error).message,
      });
    }
  }
}
