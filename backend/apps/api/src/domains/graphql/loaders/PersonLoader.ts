import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Person, PersonService } from '@ci/domains/memory';

import { Loader } from './Loader';

@Injectable()
export class PersonLoader extends Loader<Person | null> {
  constructor(
    private readonly personService: PersonService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PersonLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    personIds: readonly string[],
  ): Promise<readonly (Person | null)[]> {
    this.logger.log(`Loading a batch of ${personIds.length} people`);

    return this.personService.findByIds(context, [...personIds]);
  }
}
