import { afterEach, describe, expect, it, vi } from 'vitest';

import { canRecordAudio, pickAudioRecorderMimeType } from './recordAudio';

describe('recordAudio', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports unavailable when MediaRecorder is missing', () => {
    vi.stubGlobal('MediaRecorder', undefined);

    expect(pickAudioRecorderMimeType()).toBeUndefined();
    expect(canRecordAudio()).toBe(false);
  });

  it('prefers audio/mp4 when the runtime supports it (iOS)', () => {
    class FakeRecorder {
      static isTypeSupported(type: string) {
        return type === 'audio/mp4';
      }
    }

    vi.stubGlobal('MediaRecorder', FakeRecorder);

    expect(pickAudioRecorderMimeType()).toBe('audio/mp4');
  });
});
