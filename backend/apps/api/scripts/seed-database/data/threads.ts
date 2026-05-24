import type { CreateThreadDto } from '@ci/domains/conversations/types';

import { JOHN_SMITH } from './users';

type SeedThread = RequiredFields<CreateThreadDto, 'id'> & {
  userId: string;
};

export const MAKE_DINNER: SeedThread = {
  id: '01993a4b-6bbf-4bf0-8bc8-59ecb3b768ad',
  name: 'Make family dinner tonight',
  model: 'qwen3:8b',
  description: '',
  userId: JOHN_SMITH.id,
};

export const WATCH_MOVIE: SeedThread = {
  id: '01993a4b-6bc0-48c7-be52-42b9cd6200b9',
  name: 'Watch a movie together',
  model: 'qwen3:8b',
  description: '',
  userId: JOHN_SMITH.id,
};

export const WEEKEND_ACTIVITY: SeedThread = {
  id: '01993a4b-6bc1-4c30-8cdc-520c35c5090c',
  name: 'Take a break this weekend',
  model: 'qwen3:8b',
  description: '',
  userId: JOHN_SMITH.id,
};

export const GROCERY_SHOPPING: SeedThread = {
  id: '01993a4b-6bc1-435b-9a36-b119d2a4f9a1',
  name: "Shop for this week's groceries",
  model: 'qwen3:8b',
  description: '',
  userId: JOHN_SMITH.id,
};

export const ANNIVERSARY_GIFTS: SeedThread = {
  id: '01993a4b-6bc1-44ab-976b-9367130f1555',
  name: 'Anniversary gift ideas',
  model: 'qwen3:8b',
  description: '',
  userId: JOHN_SMITH.id,
};

export const WEATHER_UPDATE: SeedThread = {
  id: '01993a4b-6bc2-4f40-b6b1-00c733f20846',
  name: 'Weekend weather planning',
  model: 'qwen3:8b',
  description: '',
  userId: JOHN_SMITH.id,
};

export const THREADS: SeedThread[] = [
  MAKE_DINNER,
  WATCH_MOVIE,
  WEEKEND_ACTIVITY,
  GROCERY_SHOPPING,
  ANNIVERSARY_GIFTS,
  WEATHER_UPDATE,
];
