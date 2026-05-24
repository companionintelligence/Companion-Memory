import type { CreateMessageDto } from '@ci/domains/conversations/types';

import * as threads from './threads';
import { JOHN_SMITH } from './users';

type SeedMessage = RequiredFields<CreateMessageDto, 'id'> & {
  userId: string;
};

export const MESSAGES: SeedMessage[] = [
  {
    id: '01993a4d-cc3c-4c25-ad81-078ddc6e29fe',
    model: 'qwen3:8b',
    content: 'Would you like me to help you plan a meal you will all enjoy?',
    mimetype: 'text/markdown',
    canceled: false,
    userId: JOHN_SMITH.id,
    threadId: threads.MAKE_DINNER.id,
    role: 'assistant',
  },
  {
    id: '01993a4d-cc3c-4acf-8b45-c6de38526d6a',
    model: 'qwen3:8b',
    content: 'Would you like me to help you find something to watch together?',
    mimetype: 'text/markdown',
    canceled: false,
    userId: JOHN_SMITH.id,
    threadId: threads.WATCH_MOVIE.id,
    role: 'assistant',
  },
  {
    id: '01993a4d-cc3d-4a62-891c-193b90112082',
    model: 'qwen3:8b',
    content:
      'Would you like me to help you find an activity this weekend? Perhaps something out of the ordinary?',
    mimetype: 'text/markdown',
    canceled: false,
    userId: JOHN_SMITH.id,
    threadId: threads.WEEKEND_ACTIVITY.id,
    role: 'assistant',
  },
  {
    id: '01993a4d-cc3d-429c-a7c5-c2edff908d32',
    model: 'qwen3:8b',
    content: "Let's figure out some meals for this week and then draw up a grocery list together.",
    mimetype: 'text/markdown',
    canceled: false,
    userId: JOHN_SMITH.id,
    threadId: threads.GROCERY_SHOPPING.id,
    role: 'assistant',
  },
  {
    id: '01993a4d-cc3d-4eea-9eaf-51678f1bc2dc',
    model: 'qwen3:8b',
    content: 'Would you like me to help you plan any of these options?',
    mimetype: 'text/markdown',
    canceled: false,
    userId: JOHN_SMITH.id,
    threadId: threads.ANNIVERSARY_GIFTS.id,
    role: 'assistant',
  },
  {
    id: '01993a4d-cc3e-41fa-b9bf-3ab498719a30',
    model: 'qwen3:8b',
    content:
      "Would you like me to help you find something to do together that's compatible with the weather?",
    mimetype: 'text/markdown',
    canceled: false,
    userId: JOHN_SMITH.id,
    threadId: threads.WEATHER_UPDATE.id,
    role: 'assistant',
  },
];
