import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { SYSTEM_USER } from '@ci/common/context';
import { UserService } from '@ci/domains/user';

import { JOHN_SMITH } from './data/users';

export async function seedUsers(module: TestingModule, multibar: MultiBar) {
  const userService = module.get(UserService);

  const users = [JOHN_SMITH];

  const bar = multibar.create(users.length, 0, { task: 'Users' });

  for (const user of users) {
    if (user.password == null) {
      throw new Error(`Password not specified for user ${user.email}`);
    }

    const existingUser = await userService.findById(
      {
        userId: SYSTEM_USER,
      },
      user.id,
    );

    if (existingUser == null) {
      await userService.create(
        {
          userId: SYSTEM_USER,
        },
        {
          id: user.id,
          name: user.name,
          email: user.email,
          password: user.password!,
        },
      );

      await userService.onboard(user.id);
    }

    bar.increment();
  }

  bar.stop();
}
