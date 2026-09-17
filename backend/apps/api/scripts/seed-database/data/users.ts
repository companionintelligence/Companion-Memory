import { type CreateUserDto } from '@ci/domains/user';

type SeedUser = Optional<RequiredFields<CreateUserDto, 'id'>, 'password'>;

export const JOHN_SMITH: SeedUser = {
  id: 'b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b',
  name: 'John Smith',
  email: process.env.AUTH_DEFAULT_USER_EMAIL || 'jsmith@example.com',
  password: process.env.AUTH_DEFAULT_USER_PASSWORD,
  // Every place, person and event in this corpus is in Orange County (see
  // data/places.ts), so the persona has a home zone. Without it the row keeps
  // the 'UTC' column default and the planner puts John's workday at 02:00–10:00
  // local — `seedUsers` also marks the account onboarded, so the FTUE wizard
  // that would otherwise ask never runs.
  timezone: process.env.AUTH_DEFAULT_USER_TIMEZONE || 'America/Los_Angeles',
};
