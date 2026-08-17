import { describe, expect, it } from 'vitest';

import {
  addListValue,
  applySortPreset,
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
  });
});
