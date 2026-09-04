import { describe, expect, it } from 'vitest';

import { WHAT_CATEGORIES, whatCategoriesFor } from './entityTypeCategories';

describe('whatCategoriesFor', () => {
  it('offers the full What bar everywhere but the events browse', () => {
    expect(whatCategoriesFor('/memory')).toBe(WHAT_CATEGORIES);
    expect(whatCategoriesFor('/memory/people')).toBe(WHAT_CATEGORIES);
  });

  it('offers only the happening kinds on /memory/events', () => {
    const categories = whatCategoriesFor('/memory/events');

    expect(categories.map((category) => category.id)).toEqual(['messages', 'events', 'browser', 'tag']);
    expect(categories.find((category) => category.id === 'browser')).toMatchObject({
      kind: 'standalone',
      label: 'Browser',
      entityType: 'Browser',
    });
  });
});
