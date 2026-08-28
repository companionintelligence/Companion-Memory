import { describe, expect, it } from 'vitest';

import { shareUrl } from './shareLink';

describe('shareLink', () => {
  it('builds the /shared/<token> capability URL against a given origin', () => {
    expect(shareUrl('abc123', 'https://ci.example')).toBe('https://ci.example/shared/abc123');
  });

  it('falls back to a relative path when no origin is available (SSR safety)', () => {
    expect(shareUrl('abc123', '')).toBe('/shared/abc123');
  });
});
