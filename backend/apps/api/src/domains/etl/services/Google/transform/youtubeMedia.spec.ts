import { bestThumbnail, parseIso8601DurationSeconds } from './youtubeMedia';

describe('bestThumbnail', () => {
  it('prefers the highest rendition the provider actually returned', () => {
    expect(
      bestThumbnail({
        default: { url: 'https://i.ytimg.com/vi/X/default.jpg', width: 120, height: 90 },
        medium: { url: 'https://i.ytimg.com/vi/X/mqdefault.jpg', width: 320, height: 180 },
        maxres: { url: 'https://i.ytimg.com/vi/X/maxresdefault.jpg', width: 1280, height: 720 },
      }),
    ).toEqual({ url: 'https://i.ytimg.com/vi/X/maxresdefault.jpg', width: 1280, height: 720 });
  });

  it('falls through to the next rendition when a higher one is absent', () => {
    expect(
      bestThumbnail({
        default: { url: 'https://i.ytimg.com/vi/X/default.jpg' },
        high: { url: 'https://i.ytimg.com/vi/X/hqdefault.jpg' },
      }),
    ).toEqual({ url: 'https://i.ytimg.com/vi/X/hqdefault.jpg' });
  });

  it('skips renditions present but carrying no url', () => {
    expect(
      bestThumbnail({
        maxres: { width: 1280, height: 720 },
        high: { url: '   ' },
        medium: { url: 'https://i.ytimg.com/vi/X/mqdefault.jpg' },
      }),
    ).toEqual({ url: 'https://i.ytimg.com/vi/X/mqdefault.jpg' });
  });

  it('omits width and height when the provider did not send them', () => {
    expect(bestThumbnail({ high: { url: 'https://i.ytimg.com/vi/X/hqdefault.jpg' } })).toEqual({
      url: 'https://i.ytimg.com/vi/X/hqdefault.jpg',
    });
  });

  it.each([undefined, null, {}, { maxres: {} }])('returns null for %p', (input) => {
    expect(bestThumbnail(input as Parameters<typeof bestThumbnail>[0])).toBeNull();
  });
});

describe('parseIso8601DurationSeconds', () => {
  it.each([
    ['PT4M13S', 253],
    ['PT1H2M3S', 3723],
    ['PT59S', 59],
    ['PT2H', 7200],
    ['PT30M', 1800],
    ['P1DT1S', 86_401],
    ['PT0S', 0],
  ])('parses %s to %i seconds', (iso, expected) => {
    expect(parseIso8601DurationSeconds(iso)).toBe(expected);
  });

  it('rounds fractional seconds', () => {
    expect(parseIso8601DurationSeconds('PT1M30.6S')).toBe(91);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseIso8601DurationSeconds('  PT4M13S  ')).toBe(253);
  });

  it.each([undefined, null, '', '   ', 'garbage', '4:13', 'P', 'PT'])(
    'returns null for %p rather than throwing',
    (input) => {
      expect(parseIso8601DurationSeconds(input)).toBeNull();
    },
  );
});
