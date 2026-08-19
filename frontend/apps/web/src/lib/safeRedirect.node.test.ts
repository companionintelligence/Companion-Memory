import { describe, expect, it } from 'vitest';

import { safeRedirectPath } from './safeRedirect';

describe('safeRedirectPath', () => {
  it('accepts same-origin relative paths', () => {
    expect(safeRedirectPath('/pair')).toBe('/pair');
    expect(safeRedirectPath('/pair?token=abc123')).toBe('/pair?token=abc123');
    expect(safeRedirectPath('/memory/events?view=list&tag=a%20b')).toBe('/memory/events?view=list&tag=a%20b');
    expect(safeRedirectPath('/today/42#card')).toBe('/today/42#card');
  });

  describe('rejects open redirects', () => {
    // The case a bare `value.startsWith('/')` check lets through: a browser reads
    // a protocol-relative URL as absolute, so `//evil.com` navigates off-origin.
    it('rejects protocol-relative URLs', () => {
      expect(safeRedirectPath('//evil.com')).toBeNull();
      expect(safeRedirectPath('//evil.com/pair?token=abc')).toBeNull();
      expect(safeRedirectPath('///evil.com')).toBeNull();
      expect(safeRedirectPath('//' + 'evil.com/\\@ci.localhost')).toBeNull();
    });

    it('rejects absolute URLs', () => {
      expect(safeRedirectPath('https://evil.com')).toBeNull();
      expect(safeRedirectPath('http://evil.com/pair')).toBeNull();
      expect(safeRedirectPath('javascript:alert(1)')).toBeNull();
      expect(safeRedirectPath('data:text/html,<script>alert(1)</script>')).toBeNull();
    });

    it('rejects backslashes a browser may normalise into an origin change', () => {
      expect(safeRedirectPath('/\\evil.com')).toBeNull();
      expect(safeRedirectPath('/\\\\evil.com')).toBeNull();
      expect(safeRedirectPath('/pair\\..\\..')).toBeNull();
    });

    it('rejects control characters used to smuggle past naive parsers', () => {
      expect(safeRedirectPath('/\n//evil.com')).toBeNull();
      expect(safeRedirectPath('/\t/evil.com')).toBeNull();
      expect(safeRedirectPath('/\r\n/evil.com')).toBeNull();
      expect(safeRedirectPath('/pair\x7f')).toBeNull();
    });

    it('rejects relative paths with no leading slash', () => {
      expect(safeRedirectPath('pair')).toBeNull();
      expect(safeRedirectPath('evil.com')).toBeNull();
    });
  });

  it('rejects non-string, empty, and oversized values', () => {
    expect(safeRedirectPath(undefined)).toBeNull();
    expect(safeRedirectPath(null)).toBeNull();
    expect(safeRedirectPath(42)).toBeNull();
    expect(safeRedirectPath({ toString: () => '/pair' })).toBeNull();
    expect(safeRedirectPath('')).toBeNull();
    expect(safeRedirectPath('/' + 'a'.repeat(2048))).toBeNull();
  });
});
