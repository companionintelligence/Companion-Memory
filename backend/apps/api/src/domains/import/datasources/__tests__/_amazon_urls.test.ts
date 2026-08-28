import {
  amazonMusicAlbumUrl,
  amazonMusicTrackUrl,
  asinOrUndefined,
  audibleUrl,
  kindleUrl,
} from '../_amazon_urls';

describe('_amazon_urls', () => {
  it('accepts only real 10-character ASINs', () => {
    expect(asinOrUndefined('B000FBJCJE')).toBe('B000FBJCJE');
    expect(asinOrUndefined(' b000fbjcje ')).toBe('B000FBJCJE');
    expect(asinOrUndefined('0063007800')).toBe('0063007800');
    expect(asinOrUndefined('t:16d162885166d84b')).toBeUndefined();
    expect(asinOrUndefined('6cb8e261-a9e5-4814-9b06-1d4994a9c239')).toBeUndefined();
    expect(asinOrUndefined('')).toBeUndefined();
    expect(asinOrUndefined(undefined)).toBeUndefined();
  });

  it('derives product pages per storefront', () => {
    expect(audibleUrl('B005QDO084')).toBe('https://www.audible.com/pd/B005QDO084');
    expect(kindleUrl('B000FBJCJE')).toBe('https://www.amazon.com/dp/B000FBJCJE');
    expect(amazonMusicAlbumUrl('B000SX9IXO')).toBe('https://music.amazon.com/albums/B000SX9IXO');
  });

  it('points a track at its album when the album ASIN is known', () => {
    expect(amazonMusicTrackUrl('B000SX6NYQ', 'B000SX9IXO')).toBe(
      'https://music.amazon.com/albums/B000SX9IXO?trackAsin=B000SX6NYQ',
    );
    expect(amazonMusicTrackUrl('B000SX6NYQ')).toBe('https://music.amazon.com/tracks/B000SX6NYQ');
    expect(amazonMusicTrackUrl('B000SX6NYQ', 'not-an-asin')).toBe(
      'https://music.amazon.com/tracks/B000SX6NYQ',
    );
    expect(amazonMusicTrackUrl(undefined, 'B000SX9IXO')).toBeUndefined();
  });
});
