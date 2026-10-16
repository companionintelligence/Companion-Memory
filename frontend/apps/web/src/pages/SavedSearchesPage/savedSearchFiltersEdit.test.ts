import { describe, expect, it } from 'vitest';

import {
  addListValue,
  applySortPreset,
  describeBbox,
  removeArea,
  removeListValue,
  sortPresetOf,
  toFiltersInput,
  type EditableFilters,
} from './savedSearchFiltersEdit';

describe('savedSearchFiltersEdit', () => {
  describe('addListValue', () => {
    it('appends a trimmed value to an empty field', () => {
      expect(addListValue({}, 'people', '  Alice  ')).toEqual({ people: ['Alice'] });
    });

    it('ignores blanks and duplicates', () => {
      const base: EditableFilters = { people: ['Alice'] };
      expect(addListValue(base, 'people', '   ')).toBe(base);
      expect(addListValue(base, 'people', 'Alice')).toBe(base);
    });
  });

  describe('removeListValue', () => {
    it('removes one value, leaving the rest', () => {
      expect(removeListValue({ connectors: ['gmail', 'imessage'] }, 'connectors', 'gmail')).toEqual({
        connectors: ['imessage'],
      });
    });
  });

  describe('sort presets', () => {
    it('round-trips a preset to sortBy/sortOrder and back', () => {
      const next = applySortPreset({}, 'newest');
      expect(next).toMatchObject({ sortBy: 'time', sortOrder: 'desc' });
      expect(sortPresetOf(next)).toBe('newest');
    });

    it('clears both fields for the default preset', () => {
      const next = applySortPreset({ sortBy: 'time', sortOrder: 'desc' }, 'default');
      expect(next.sortBy).toBeUndefined();
      expect(next.sortOrder).toBeUndefined();
      expect(sortPresetOf(next)).toBe('default');
    });

    it('falls back to default for an unrecognised sort', () => {
      expect(sortPresetOf({ sortBy: 'mystery', sortOrder: 'sideways' })).toBe('default');
    });
  });

  describe('toFiltersInput', () => {
    it('returns null when nothing is active', () => {
      expect(toFiltersInput({})).toBeNull();
      expect(toFiltersInput({ people: [], hasLocation: false, semantic: false })).toBeNull();
    });

    it('drops empties and false toggles, keeping active dimensions', () => {
      const input = toFiltersInput({
        people: ['Alice'],
        connectors: [],
        startTime: '2024-01-01T00:00:00.000Z',
        endTime: '',
        hasLocation: true,
        semantic: false,
        sortBy: 'time',
        sortOrder: 'desc',
      });

      expect(input).toEqual({
        people: ['Alice'],
        startTime: '2024-01-01T00:00:00.000Z',
        hasLocation: true,
        sortBy: 'time',
        sortOrder: 'desc',
      });
      expect(input).not.toHaveProperty('connectors');
      expect(input).not.toHaveProperty('semantic');
    });

    it('keeps a rolling datePreset so editing a seed does not drop When', () => {
      expect(toFiltersInput({ datePreset: 'last-week' })).toEqual({ datePreset: 'last-week' });
    });

    it('carries the map areas, view and file kinds through an edit instead of stripping them', () => {
      expect(
        toFiltersInput({ areas: [[165.5, -47.5, 179.5, -33.5]], view: 'map', fileKinds: ['image'] }),
      ).toEqual({
        areas: [[165.5, -47.5, 179.5, -33.5]],
        view: 'map',
        fileKinds: ['image'],
      });
    });

    it('does not make a search drawn with a map area located-only, since the area is ORed with the place names', () => {
      expect(toFiltersInput({ areas: [[165.5, -47.5, 179.5, -33.5]] })?.hasLocation).toBeUndefined();
      expect(toFiltersInput({ areas: [[165.5, -47.5, 179.5, -33.5]], hasLocation: true })?.hasLocation).toBe(
        true,
      );
      expect(toFiltersInput({ places: ['Paris'] })?.hasLocation).toBeUndefined();
    });

    it('rewrites a legacy single bbox as a one-entry areas list and never writes bbox back', () => {
      expect(toFiltersInput({ bbox: [165.5, -47.5, 179.5, -33.5] })).toEqual({
        areas: [[165.5, -47.5, 179.5, -33.5]],
      });
    });

    it('drops a map area that is not four finite numbers', () => {
      expect(toFiltersInput({ areas: [[1, 2, 3]] })).toBeNull();
      expect(toFiltersInput({ areas: null, bbox: null, places: ['Paris'] })).toEqual({ places: ['Paris'] });
    });

    it('removes one area by position', () => {
      const london: [number, number, number, number] = [-0.5, 51.3, 0.3, 51.7];
      const paris: [number, number, number, number] = [2.2, 48.8, 2.5, 48.9];

      expect(removeArea({ areas: [london, paris] }, 0)).toEqual({ areas: [paris], bbox: undefined });
      expect(removeArea({ bbox: london }, 0)).toEqual({ areas: [], bbox: undefined });
    });
  });

  describe('describeBbox', () => {
    it('reads as latitudes then longitudes with hemisphere letters', () => {
      expect(describeBbox([165.5, -47.5, 179.5, -33.5])).toBe('47.5°S–33.5°S, 165.5°E–179.5°E');
      expect(describeBbox([-161, 18.5, -154.5, 22.5])).toBe('18.5°N–22.5°N, 161.0°W–154.5°W');
    });
  });
});
