import { describe, expect, it } from 'vitest';

import { MimeTypes } from './mime_types';

describe('MimeTypes', () => {
  it('maps audio enum members to their MIME strings', () => {
    expect(MimeTypes.WAV).toBe('audio/wav');
    expect(MimeTypes.WEBM).toBe('audio/webm');
    expect(MimeTypes.MP3).toBe('audio/mpeg');
  });
});
