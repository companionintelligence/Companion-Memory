import type { CreateActionDto } from '@ci/domains/intelligence/types';

import * as threads from './threads';
import { JOHN_SMITH } from './users';

type SeedAction = RequiredFields<CreateActionDto, 'id'> & {
  userId: string;
  tags: string[];
};

export const ACTIONS: SeedAction[] = [
  {
    id: '01993a46-5475-4d58-b2c7-78809e7e75ee',
    title: 'Make family dinner tonight',
    text: "Because you haven't made a home-cooked meal yet this week, I am recommending you plan something together with the family.",
    imageUrl: '/actions/dinner.jpg',
    threadId: threads.MAKE_DINNER.id,
    tags: ['Culinary', 'Family'],
    userId: JOHN_SMITH.id,
  },
  {
    id: '01993a46-5475-42f2-8a63-4f3e9eafe02b',
    title: 'Watch a movie together',
    text: "Why don't you invite your family to watch a movie together tonight? It's a simple way for you to relax and enjoy some quality time with them.",
    imageUrl: '/actions/movie_night.jpg',
    threadId: threads.WATCH_MOVIE.id,
    tags: ['Entertainment', 'Movies', 'Family Time'],
    userId: JOHN_SMITH.id,
  },
  {
    id: '01993a46-5475-48e2-8401-c204e89d5890',
    title: 'Take a break this weekend',
    text: 'The weekend is a perfect opportunity to step away from routine and recharge in a different environment. Taking time outside the usual surroundings can bring a refreshing change of pace and perspective.',
    imageUrl: '/actions/woods.jpg',
    threadId: threads.WEEKEND_ACTIVITY.id,
    tags: ['Weekend', 'Activities', 'Family'],
    userId: JOHN_SMITH.id,
  },
  {
    id: '01993a46-5475-4b54-951b-c66207825b24',
    title: 'Shop for this week’s groceries',
    text: 'A grocery trip this weekend will help ensure everything needed for the week ahead is stocked and ready. Restocking supplies now can make the coming days smoother and less stressful.',
    imageUrl: '/actions/groceries.jpg',
    threadId: threads.GROCERY_SHOPPING.id,
    tags: ['Shopping', 'Groceries', 'Planning'],
    userId: JOHN_SMITH.id,
  },
  {
    id: '01993a46-5475-416f-9e84-fd4950eb49da',
    title: 'Anniversary gift ideas',
    text: 'Your anniversary is coming up! Here are some thoughtful gift ideas based on your preferences:\n\n* Weekend getaway to that mountain cabin you mentioned\n* A photo album of your favorite memories\n* Cooking class for two at the local culinary school\n* Personalized jewelry with your anniversary date',
    imageUrl: '/actions/gift.jpg',
    threadId: threads.ANNIVERSARY_GIFTS.id,
    tags: ['Anniversary', 'Gift Ideas', 'Planning'],
    userId: JOHN_SMITH.id,
  },
  {
    id: '01993a46-5476-4d6f-8f69-00d7f52adea4',
    title: 'Weather update',
    text: "Today's weather forecast for your area:\n\n* **Current:** 72°F, Sunny\n* **Tonight:** 65°F, Clear\n* **Tomorrow:** 75°F, Partly Cloudy\n\nPerfect weather for outdoor activities this weekend!",
    imageUrl: '/actions/weather.jpg',
    threadId: threads.WEATHER_UPDATE.id,
    tags: ['Weather', 'Forecast', 'Planning'],
    userId: JOHN_SMITH.id,
  },
];
