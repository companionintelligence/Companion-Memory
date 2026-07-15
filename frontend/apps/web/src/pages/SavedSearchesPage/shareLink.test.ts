import { describe, expect, it } from 'vitest';

import { iframeSnippet, shareUrl } from './shareLink';

describe('shareLink', () => {
  it('builds the /shared/<token> capability URL against a given origin', () => {
    expect(shareUrl('abc123', 'https://ci.example')).toBe('https://ci.example/shared/abc123');
  });

  it('falls back to a relative path when no origin is available (SSR safety)', () => {
    expect(shareUrl('abc123', '')).toBe('/shared/abc123');
  });

  it('wraps the share URL in a sized, borderless iframe', () => {
    const snippet = iframeSnippet('abc123', 'https://ci.example');

    expect(snippet).toContain('src="https://ci.example/shared/abc123"');
    expect(snippet).toContain('width="100%"');
    expect(snippet).toContain('height="600"');
    expect(snippet).toContain('frameborder="0"');
  });
});
