import { canonicalizeUrl } from '../canonicalizeUrl';

describe('canonicalizeUrl', () => {
  // The worked-example table from the design. Every row is a real spelling that
  // currently produces a SEPARATE ci.content row.
  describe('worked examples', () => {
    it.each([
      // input, canonical, providerRef
      [
        'https://youtu.be/dQw4w9WgXcQ?t=30',
        'https://youtube.com/watch?v=dQw4w9WgXcQ',
        'youtube:video:dQw4w9WgXcQ',
      ],
      [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx&index=3&pp=abc',
        'https://youtube.com/watch?v=dQw4w9WgXcQ',
        'youtube:video:dQw4w9WgXcQ',
      ],
      [
        'https://m.youtube.com/shorts/dQw4w9WgXcQ',
        'https://youtube.com/watch?v=dQw4w9WgXcQ',
        'youtube:video:dQw4w9WgXcQ',
      ],
      [
        'https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=xY',
        'https://youtube.com/watch?v=dQw4w9WgXcQ',
        'youtube:video:dQw4w9WgXcQ',
      ],
      [
        'https://open.spotify.com/intl-de/track/6rqhFgbbKwnb9?si=abc',
        'https://open.spotify.com/track/6rqhFgbbKwnb9',
        'spotify:track:6rqhFgbbKwnb9',
      ],
      [
        'spotify:track:6rqhFgbbKwnb9',
        'https://open.spotify.com/track/6rqhFgbbKwnb9',
        'spotify:track:6rqhFgbbKwnb9',
      ],
      ['https://twitter.com/jack/status/20?ref_src=twsrc', 'https://x.com/i/status/20', 'x:tweet:20'],
      ['https://x.com/anyone/status/20', 'https://x.com/i/status/20', 'x:tweet:20'],
      ['https://vimeo.com/76979871?share=copy', 'https://vimeo.com/76979871', 'vimeo:video:76979871'],
    ])('%s -> %s', (input, canonical, providerRef) => {
      const result = canonicalizeUrl(input);

      expect(result?.canonical).toBe(canonical);
      expect(result?.providerRef).toBe(providerRef);
    });
  });

  describe('the collapse that matters', () => {
    it('resolves every YouTube spelling of one video to a single identity', () => {
      const spellings = [
        'https://youtu.be/dQw4w9WgXcQ',
        'https://youtu.be/dQw4w9WgXcQ?t=30',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://youtube.com/watch?v=dQw4w9WgXcQ&utm_source=newsletter',
        'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=xY',
        'https://www.youtube.com/embed/dQw4w9WgXcQ',
        'https://www.youtube.com/shorts/dQw4w9WgXcQ',
        'http://youtube.com/watch?v=dQw4w9WgXcQ',
      ];

      const refs = new Set(spellings.map((s) => canonicalizeUrl(s)?.providerRef));

      expect(refs.size).toBe(1);
      expect([...refs][0]).toBe('youtube:video:dQw4w9WgXcQ');
    });
  });

  describe('generic tracking-parameter stripping', () => {
    it('strips utm_* and known click ids', () => {
      expect(canonicalizeUrl('https://blog.acme.com/p?utm_source=x&utm_medium=y&fbclid=z')?.canonical).toBe(
        'https://blog.acme.com/p',
      );
    });

    it('keeps `ref` on hosts where it is not tracking', () => {
      expect(canonicalizeUrl('https://blog.acme.com/p?ref=hn&utm_source=x')?.canonical).toBe(
        'https://blog.acme.com/p?ref=hn',
      );
    });

    it('strips `ref` only on hosts where it IS tracking', () => {
      expect(canonicalizeUrl('https://x.com/i/status/20?ref=share')?.canonical).toBe(
        'https://x.com/i/status/20',
      );
    });

    it('sorts remaining parameters so order is not identity', () => {
      const a = canonicalizeUrl('https://acme.com/p?b=2&a=1')?.canonical;
      const b = canonicalizeUrl('https://acme.com/p?a=1&b=2')?.canonical;

      expect(a).toBe(b);
      expect(a).toBe('https://acme.com/p?a=1&b=2');
    });
  });

  describe('host handling', () => {
    it('treats http and https as one identity', () => {
      expect(canonicalizeUrl('http://acme.com/p')?.canonical).toBe(
        canonicalizeUrl('https://acme.com/p')?.canonical,
      );
    });

    it('strips a leading www. and a trailing dot', () => {
      expect(canonicalizeUrl('https://www.acme.com./p')?.canonical).toBe('https://acme.com/p');
    });

    // A blanket leading-label strip would rewrite this to media-amazon.com and
    // fuse two genuinely different CDN hosts.
    it('does NOT blanket-strip a leading m. label', () => {
      expect(canonicalizeUrl('https://m.media-amazon.com/images/I/71x.jpg')?.canonical).toBe(
        'https://m.media-amazon.com/images/I/71x.jpg',
      );
    });

    it('drops default ports but keeps non-default ones', () => {
      expect(canonicalizeUrl('https://acme.com:443/p')?.canonical).toBe('https://acme.com/p');
      expect(canonicalizeUrl('https://acme.com:8443/p')?.canonical).toBe('https://acme.com:8443/p');
    });
  });

  describe('path normalization', () => {
    it('collapses duplicate slashes and resolves . / ..', () => {
      expect(canonicalizeUrl('https://acme.com//a//b/../c/./d')?.canonical).toBe('https://acme.com/a/c/d');
    });

    it('drops exactly one trailing slash but never the root', () => {
      expect(canonicalizeUrl('https://acme.com/p/')?.canonical).toBe('https://acme.com/p');
      expect(canonicalizeUrl('https://acme.com/')?.canonical).toBe('https://acme.com/');
    });
  });

  describe('shorteners', () => {
    it('returns null rather than dereferencing', () => {
      expect(canonicalizeUrl('https://bit.ly/3abc')).toBeNull();
      expect(canonicalizeUrl('https://t.co/xyz')).toBeNull();
    });

    it('still canonicalizes youtu.be, whose id is structurally present', () => {
      expect(canonicalizeUrl('https://youtu.be/abc123')?.providerRef).toBe('youtube:video:abc123');
    });
  });

  describe('rejects non-identities', () => {
    it.each(['', '   ', 'not a url', 'javascript:alert(1)', 'mailto:a@b.com', 'ftp://acme.com/f'])(
      'returns null for %s',
      (input) => {
        expect(canonicalizeUrl(input)).toBeNull();
      },
    );
  });

  describe('idempotency', () => {
    // If canonicalizing a canonical form changed it, identity would drift every
    // time a row was reprocessed.
    it.each([
      'https://youtu.be/dQw4w9WgXcQ?t=30',
      'https://www.youtube.com/watch?v=abc&utm_source=x',
      'https://open.spotify.com/intl-de/track/6rq?si=abc',
      'https://twitter.com/jack/status/20?ref_src=twsrc',
      'https://blog.acme.com/p/?ref=hn&utm_source=x',
      'https://acme.com//a//b/../c',
      'https://vimeo.com/76979871?share=copy',
    ])('is stable under re-canonicalization: %s', (input) => {
      const once = canonicalizeUrl(input);
      const twice = canonicalizeUrl(once!.canonical);

      expect(twice?.canonical).toBe(once?.canonical);
      expect(twice?.providerRef).toBe(once?.providerRef);
    });
  });

  describe('provider hosts with unrecognized paths', () => {
    it('falls through to generic normalization rather than returning null', () => {
      const result = canonicalizeUrl('https://www.youtube.com/feed/subscriptions?utm_source=x');

      expect(result?.canonical).toBe('https://youtube.com/feed/subscriptions');
      expect(result?.providerRef).toBeUndefined();
    });
  });
});
