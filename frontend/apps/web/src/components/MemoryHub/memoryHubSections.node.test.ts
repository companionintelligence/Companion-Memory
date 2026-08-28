import { describe, expect, it } from 'vitest';

import { MEMORY_HUB_SECTIONS, isMemoryHubPath } from './memoryHubSections';

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
