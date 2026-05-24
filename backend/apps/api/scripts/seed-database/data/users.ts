import { type CreateUserDto } from '@ci/domains/user';

type SeedUser = Optional<RequiredFields<CreateUserDto, 'id'>, 'password'>;

export const JOHN_SMITH: SeedUser = {
  id: 'b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b',
  name: 'John Smith',
  email: process.env.AUTH_DEFAULT_USER_EMAIL || 'jsmith@example.com',
  password: process.env.AUTH_DEFAULT_USER_PASSWORD,
};
