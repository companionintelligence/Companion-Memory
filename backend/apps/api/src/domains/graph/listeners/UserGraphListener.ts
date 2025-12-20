import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { PersonService } from '@ci/domains/memory';
import { UserCreatedEvent, type UserCreatedPayload, UserService } from '@ci/domains/user';

@Injectable()
export class UserGraphListener {
  constructor(
    private readonly personService: PersonService,
    private readonly userService: UserService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(UserGraphListener.name);
  }

  @OnEvent(UserCreatedEvent)
  async handleUserCreated(payload: UserCreatedPayload) {
    const context = toServiceContext({
      userId: payload.userId,
    });

    const user = await this.userService.findById(context, payload.userId);

    if (user == null) {
      throw new Error('User could not be retrieved');
    }

    const id = uuidv7();
    const name = user.name ?? user.email;
    const [firstName, ...restName] = (user.name ?? '').trim().split(/\s+/).filter(Boolean);
    const lastName = restName.join(' ');

    const properties: Record<string, unknown> = {
      email: user.email,
    };

    if (firstName.length > 0) {
      properties.first_name = firstName;
    }

    if (restName.length > 0) {
      properties.last_name = lastName;
    }

    const person = await this.personService.create(context, {
      id,
      name,
      properties,
      description: 'This is you!',
    });

    await this.userService.update(context, user.id, {
      entityId: person.id,
    });
  }
}
