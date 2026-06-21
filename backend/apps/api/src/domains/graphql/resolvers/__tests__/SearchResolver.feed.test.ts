import { EXPLORER_FEED_TYPES, isExplorerTypeEnabled, resultTimestamp } from '../SearchResolver';

describe('explorer default feed (empty-query path)', () => {
  describe('EXPLORER_FEED_TYPES', () => {
    it('covers every entity type the explorer views render', () => {
      // Regression guard: the old empty-query path returned only these three,
      // which left Map (places) and Gallery (files/content) empty.
      expect(EXPLORER_FEED_TYPES).toEqual(
        expect.arrayContaining([
          'event',
          'communication',
          'browser-activity',
          'place',
          'content',
          'person',
          'item',
          'concept',
          'note',
          'file',
        ]),
      );
    });

    it('excludes answer and thread (search-only types)', () => {
      expect(EXPLORER_FEED_TYPES).not.toContain('answer');
      expect(EXPLORER_FEED_TYPES).not.toContain('thread');
    });
  });

  describe('isExplorerTypeEnabled', () => {
    it('includes all types when neither filter is set', () => {
      expect(isExplorerTypeEnabled('place')).toBe(true);
      expect(isExplorerTypeEnabled('event', [], [])).toBe(true);
    });

    it('treats includeTypes as an allow-list', () => {
      expect(isExplorerTypeEnabled('place', ['place', 'event'])).toBe(true);
      expect(isExplorerTypeEnabled('file', ['place', 'event'])).toBe(false);
    });

    it('treats excludeTypes as a deny-list', () => {
      // The old ternary `excludeTypes?.indexOf(t) < 0` mis-evaluated this case.
      expect(isExplorerTypeEnabled('place', undefined, ['event'])).toBe(true);
      expect(isExplorerTypeEnabled('event', undefined, ['event'])).toBe(false);
    });

    it('prefers includeTypes over excludeTypes when both are set', () => {
      expect(isExplorerTypeEnabled('place', ['place'], ['place'])).toBe(true);
      expect(isExplorerTypeEnabled('event', ['place'], ['event'])).toBe(false);
    });
  });

  describe('resultTimestamp', () => {
    it('prefers time, then startTime, then createdAt, then updatedAt', () => {
      expect(resultTimestamp({ time: '2024-01-03T00:00:00Z', startTime: '2020-01-01T00:00:00Z' })).toBe(
        Date.parse('2024-01-03T00:00:00Z'),
      );
      expect(resultTimestamp({ startTime: '2024-01-02T00:00:00Z' })).toBe(Date.parse('2024-01-02T00:00:00Z'));
      expect(resultTimestamp({ createdAt: '2024-01-01T00:00:00Z' })).toBe(Date.parse('2024-01-01T00:00:00Z'));
    });

    it('accepts Date instances', () => {
      const date = new Date('2024-05-05T12:00:00Z');
      expect(resultTimestamp({ createdAt: date })).toBe(date.getTime());
    });

    it('returns 0 for entities without any timestamp (so they sort last in DESC)', () => {
      // The old comparator fell back to `new Date()` here, clustering
      // timestamp-less entities at "now" and corrupting the sort order.
      expect(resultTimestamp({ id: 'x' })).toBe(0);
      expect(resultTimestamp(null)).toBe(0);
    });

    it('sorts a heterogeneous set newest-first', () => {
      const results = [
        { id: 'a', createdAt: '2024-01-01T00:00:00Z' },
        { id: 'b', time: '2024-03-01T00:00:00Z' },
        { id: 'c', startTime: '2024-02-01T00:00:00Z' },
        { id: 'd' },
      ];

      const ordered = [...results].sort((x, y) => resultTimestamp(y) - resultTimestamp(x)).map((r) => r.id);

      expect(ordered).toEqual(['b', 'c', 'a', 'd']);
    });
  });
});
