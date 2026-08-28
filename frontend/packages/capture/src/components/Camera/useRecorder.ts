import { createHookContext } from '@ci/common';
import { useCallback, useRef, useState } from 'react';

import { useStream } from './useStream';
import type { RecordingMode } from './useRecordingMode';

function pickVideoRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }

  const candidates = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

interface Props {
  onFrameCaptured?: (file: File, mode: RecordingMode) => void;
  onRecordingFinished?: (file: File, mode: RecordingMode) => void;
}

type ReturnType = [
  {
    isRecording: boolean;
    lastCapture: File | null;
  },
  {
    captureFrame: (mode: RecordingMode) => void;
    toggleRecording: (mode: RecordingMode) => void;
  },
];

function useRecorder({ onFrameCaptured, onRecordingFinished }: Props): ReturnType {
  const [{ isActive, videoRef, mediaStreamRef }] = useStream();

  const [isRecording, setIsRecording] = useState(false);
  const [lastCapture, setLastCapture] = useState<File | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const handleFrameCaptured = useCallback(
    (file: File, mode: RecordingMode) => {
      onFrameCaptured?.(file, mode);
      setLastCapture(file);
    },
    [onFrameCaptured],
  );

  const handleRecordingFinished = useCallback(
    (file: File, mode: RecordingMode) => {
      onRecordingFinished?.(file, mode);
      setLastCapture(file);
    },
    [onRecordingFinished],
  );

  const toggleRecording = useCallback(
    (mode: RecordingMode) => {
      if (!mediaStreamRef.current) {
        return;
      }

      if (!isRecording) {
        chunksRef.current = [];

        const mimeType = pickVideoRecorderMimeType();
        const recorder = mimeType
          ? new MediaRecorder(mediaStreamRef.current, { mimeType })
          : new MediaRecorder(mediaStreamRef.current);

        recorder.addEventListener('dataavailable', (event: BlobEvent) => {
          if (event.data.size > 0) {
            chunksRef.current.push(event.data);
          }
        });

        recorder.addEventListener('stop', () => {
          const type = recorder.mimeType || mimeType || 'video/webm';
          const ext = type.includes('mp4') ? 'mp4' : 'webm';
          const blob = new Blob(chunksRef.current, { type });
          const timestamp = Date.now().toString(36).toUpperCase();
          const file = new File([blob], `VID_${timestamp}.${ext}`, { type });

          handleRecordingFinished?.(file, mode);
          recorderRef.current = null;
        });

        recorder.start();
        recorderRef.current = recorder;
        setIsRecording(true);
      } else {
        recorderRef.current?.stop();
        setIsRecording(false);
      }
    },
    [isRecording, mediaStreamRef, handleRecordingFinished],
  );

  const captureFrame = useCallback(
    (mode: RecordingMode) => {
      if (!videoRef.current || !isActive) {
        return;
      }

      const video = videoRef.current;
      const canvas = document.createElement('canvas');

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const context = canvas.getContext('2d');

      if (!context) {
        return;
      }

      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      canvas.toBlob((blob) => {
        if (!blob) {
          return;
        }

        const timestamp = Date.now().toString(36).toUpperCase();
        const file = new File([blob], `IMG_${timestamp}.png`, { type: 'image/png' });

        handleFrameCaptured?.(file, mode);
      });
    },
    [isActive, videoRef, handleFrameCaptured],
  );

  return [
    {
      isRecording,
      lastCapture,
    },
    {
      captureFrame,
      toggleRecording,
    },
  ];
}

const { Provider, useHookContext } = createHookContext(useRecorder);

export { Provider as RecorderProvider, useHookContext as useRecorder };
