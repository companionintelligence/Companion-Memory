import { type CreatePersonDto } from '@ci/domains/memory/types';

export type SeedPerson = RequiredFields<
  Pick<CreatePersonDto, 'id' | 'name' | 'description' | 'properties'>,
  'id'
>;
