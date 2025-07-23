import { createHookContext } from '@ci/common';
import { useCallback, useRef, useState } from 'react';

import { useStream } from './useStream';

interface Props {
  onFrameCaptured?: (file: File) => void;
  onRecordingFinished?: (file: File) => void;
}

type ReturnType = [
  {
    isRecording: boolean;
  },
  {
    captureFrame: () => void;
    toggleRecording: () => void;
  },
];

function useRecorder({ onFrameCaptured, onRecordingFinished }: Props): ReturnType {
  const [{ isActive, videoRef, mediaStreamRef }] = useStream();

  const [isRecording, setIsRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const toggleRecording = useCallback(() => {
    if (!mediaStreamRef.current) {
      return;
    }

    if (!isRecording) {
      chunksRef.current = [];

      const recorder = new MediaRecorder(mediaStreamRef.current, {
        mimeType: 'video/webm;codecs=vp9',
      });

      recorder.addEventListener('dataavailable', (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });

      recorder.addEventListener('stop', () => {
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        const timestamp = Date.now().toString(36).toUpperCase();
        const file = new File([blob], `VID_${timestamp}.webm`, { type: 'video/webm' });

        onRecordingFinished?.(file);
        recorderRef.current = null;
      });

      recorder.start();
      recorderRef.current = recorder;
      setIsRecording(true);
    } else {
      recorderRef.current?.stop();
      setIsRecording(false);
    }
  }, [isRecording, mediaStreamRef, onRecordingFinished]);

  const captureFrame = useCallback(() => {
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

      onFrameCaptured?.(file);
    });
  }, [isActive, videoRef, onFrameCaptured]);

  return [
    {
      isRecording,
    },
    {
      captureFrame,
      toggleRecording,
    },
  ];
}

const { Provider, useHookContext } = createHookContext(useRecorder);

export { Provider as RecorderProvider, useHookContext as useRecorder };
