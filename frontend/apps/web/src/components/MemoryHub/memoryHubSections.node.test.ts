import { describe, expect, it } from 'vitest';

import { MEMORY_HUB_SECTIONS, isLiveSearchPath, isMemoryHubPath } from './memoryHubSections';

/**
 * Notes used to be write-only from the shell: reachable to create (Add ▸
 * Note) or open from search, but never browsable. Folded into the hub the
 * same way Things/Receipts/Content were — a MEMORY_HUB_SECTIONS entry whose
 * matcher keeps the tab lit on the detail page too, which stays at its own
 * top-level /notes/:id path (same as /people/:id, /receipts/:id).
 */
describe('MEMORY_HUB_SECTIONS — Notes', () => {
  const notes = MEMORY_HUB_SECTIONS.find((section) => section.label === 'Notes');

  it('is registered at /memory/notes', () => {
    expect(notes?.to).toBe('/memory/notes');
  });

  it('stays lit on the list route and on an individual note detail page', () => {
    expect(notes?.match('/memory/notes')).toBe(true);
    expect(notes?.match('/notes/abc123')).toBe(true);
    expect(notes?.match('/memory/events')).toBe(false);
  });

  it('counts a note detail route as a Memory hub path', () => {
    expect(isMemoryHubPath('/notes/abc123')).toBe(true);
  });
});

/**
 * Where the header search writes `?search=` in place instead of jumping to the
 * explorer. A standalone detail page lights its section's tab but shows no list,
 * so a query committed there had nothing to filter and the tap looked dead.
 */
describe('isLiveSearchPath', () => {
  it('counts the explorer, the hub lists, and detail routes nested under a list', () => {
    for (const path of [
      '/memory',
      '/memory/events',
      '/memory/people',
      '/memory/places',
      '/memory/places/42',
      '/memory/things',
      '/memory/content/42',
      '/memory/tags',
    ]) {
      expect(isLiveSearchPath(path), path).toBe(true);
    }
  });

  it('treats standalone detail pages as launchers, like pages with no list at all', () => {
    for (const path of [
      '/people/42',
      '/places/42',
      '/items/42',
      '/notes/42',
      '/plan/tasks',
      '/memory/notes',
    ]) {
      expect(isLiveSearchPath(path), path).toBe(false);
    }
  });

  it("still lights the section's tab on its standalone detail page", () => {
    expect(MEMORY_HUB_SECTIONS.find((section) => section.to === '/memory/people')?.match('/people/42')).toBe(
      true,
    );
  });
});
