import { EMMA_FRIENDS } from './emmaFriends';
import { FAMILY } from './family';
import { JOHN_COWORKERS } from './johnCoworkers';
import { JOHN_FRIENDS } from './johnFriends';
import { LUCAS_FRIENDS } from './lucasFriends';
import { SARAH_COWORKERS } from './sarahCoworkers';
import { SARAH_FRIENDS } from './sarahFriends';
import type { SeedPerson } from './types';

export const PEOPLE: SeedPerson[] = [
  ...FAMILY,
  ...JOHN_COWORKERS,
  ...JOHN_FRIENDS,
  ...SARAH_COWORKERS,
  ...SARAH_FRIENDS,
  ...LUCAS_FRIENDS,
  ...EMMA_FRIENDS,
];

export * from './family';
export * from './johnCoworkers';
export * from './johnFriends';
export * from './sarahFriends';
export * from './sarahCoworkers';
export * from './lucasFriends';
export * from './emmaFriends';
