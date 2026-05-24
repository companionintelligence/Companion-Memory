import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { PersonService } from '@ci/domains/memory';
import { UserService } from '@ci/domains/user';

import { JOHN_SMITH, PEOPLE } from './data/people';
import { JOHN_SMITH as JOHN_SMITH_USER } from './data/users';

export async function seedPeople(module: TestingModule, multibar: MultiBar) {
  const userService = module.get(UserService);
  const personService = module.get(PersonService);

  const bar = multibar.create(PEOPLE.length, 0, { task: 'People' });

  for (const person of PEOPLE) {
    const existingPerson = await personService.findById(
      {
        userId: JOHN_SMITH.id,
      },
      person.id,
    );

    if (existingPerson == null) {
      await personService.create(
        {
          userId: JOHN_SMITH_USER.id,
        },
        {
          id: person.id,
          name: person.name,
          description: person.description,
          ...(person.properties && {
            properties: person.properties,
          }),
        },
      );
    }

    bar.increment();
  }

  await userService.update(
    {
      userId: JOHN_SMITH_USER.id,
    },
    JOHN_SMITH_USER.id,
    {
      entityId: JOHN_SMITH.id,
    },
  );

  bar.stop();
}
