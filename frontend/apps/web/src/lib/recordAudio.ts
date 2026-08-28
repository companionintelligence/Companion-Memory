/**
 * In-page microphone recording. iOS Safari's MediaRecorder supports audio/mp4
 * (not webm). Falls apart gracefully when MediaRecorder or getUserMedia is missing
 * — callers should offer the Files picker as a backup.
 */

export function pickAudioRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }

  const candidates = ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

export function canRecordAudio(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  );
}

export interface AudioRecordingSession {
  stop: () => Promise<File>;
  cancel: () => void;
}

export async function startAudioRecording(): Promise<AudioRecordingSession> {
  if (!canRecordAudio()) {
    throw new Error('Audio recording is not available on this device');
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickAudioRecorderMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];

  recorder.addEventListener('dataavailable', (event: BlobEvent) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  recorder.start();

  const stopTracks = () => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  };

  return {
    stop: () =>
      new Promise<File>((resolve, reject) => {
        recorder.addEventListener(
          'stop',
          () => {
            stopTracks();

            const type = recorder.mimeType || mimeType || 'audio/mp4';
            const ext = type.includes('webm') ? 'webm' : 'm4a';
            const blob = new Blob(chunks, { type });

            if (blob.size === 0) {
              reject(new Error('Recording was empty'));

              return;
            }

            resolve(new File([blob], `AUD_${Date.now()}.${ext}`, { type }));
          },
          { once: true },
        );

        try {
          recorder.stop();
        } catch (error) {
          stopTracks();
          reject(error);
        }
      }),
    cancel: () => {
      try {
        recorder.stop();
      } catch {
        /* already stopped */
      }

      stopTracks();
    },
  };
}
