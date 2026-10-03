import { afterEach, describe, expect, it } from 'vitest';

import { enterNativeShell, NATIVE_MEMORY_ORIGIN } from '@/test/nativeShell';

import { shareUrl } from './shareLink';

describe('shareLink', () => {
  it('builds the /shared/<token> capability URL against a given origin', () => {
    expect(shareUrl('abc123', 'https://ci.example')).toBe('https://ci.example/shared/abc123');
  });

  it('falls back to a relative path when no origin is available (SSR safety)', () => {
    expect(shareUrl('abc123', '')).toBe('/shared/abc123');
  });

  it('defaults to the page origin on web, where that origin IS the Memory', () => {
    expect(shareUrl('abc123')).toBe(`${window.location.origin}/shared/abc123`);
  });

  describe('on the native shell', () => {
    let leaveNativeShell: () => void = () => undefined;

    afterEach(() => leaveNativeShell());

    // The bundled app's page origin is capacitor://localhost (iOS) or
    // https://localhost (Android): a link built from it opens nowhere else.
    it('defaults to the paired Memory origin, never the WebView origin', () => {
      leaveNativeShell = enterNativeShell();

      expect(shareUrl('abc123')).toBe(`${NATIVE_MEMORY_ORIGIN}/shared/abc123`);
      expect(shareUrl('abc123')).not.toContain(window.location.origin);
    });

    it('still honours an explicit origin', () => {
      leaveNativeShell = enterNativeShell();

      expect(shareUrl('abc123', 'https://other.example')).toBe('https://other.example/shared/abc123');
    });
  });
});
