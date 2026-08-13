import { createHookContext } from '@ci/common';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import { useFacingMode } from './useFacingMode';
import { useMuteControls } from './useMuteControls';

type ReturnType = [
  {
    isActive: boolean;
    error: string | null;
    videoRef: RefObject<HTMLVideoElement | null>;
    mediaStreamRef: RefObject<MediaStream | null>;
  },
  {
    startCamera: () => void;
    stopCamera: () => void;
    setError: (message: string) => void;
  },
];

function useStream(): ReturnType {
  const [{ facingMode }] = useFacingMode();
  const [{ microphoneEnabled, cameraEnabled }, { applyMuteState }] = useMuteControls();

  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  const [isActive, setIsActive] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    console.log('Attempting to stop camera...');

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;

      if (videoRef.current) {
        videoRef.current.srcObject = null;

        console.log('Video element srcObject cleared and loaded.');
      }

      console.log('Camera successfully stopped.');
    } else {
      console.log('No active camera stream to stop.');
    }

    setIsActive(false);
  }, [setIsActive]);

  const startCamera = useCallback(async () => {
    if (isActive && mediaStreamRef.current) {
      console.log('Camera is already active. Skipping new start request.');

      return;
    }

    setError(null);

    console.log('Attempting to get user media (camera access)...');

    try {
      const stream: MediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 960 },
          frameRate: { ideal: 30, max: 60 },
          facingMode,
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100,
          channelCount: 2,
          autoGainControl: true,
        },
      });

      // Honour the mute toggles *before* the stream reaches the video element or
      // the recorder. The user may have muted while `getUserMedia` was in flight,
      // so this reads the live refs rather than this closure's captured state.
      applyMuteState(stream);

      mediaStreamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        console.log('Stream assigned to video element. Attempting to play...');

        await videoRef.current.play().catch((playError) => {
          console.error('Video play failed:', playError);

          if (playError.name === 'AbortError') {
            console.warn(
              'Play request was aborted. This often happens if srcObject was set again quickly. The video might still start correctly.',
            );
          } else {
            setError(`Failed to play video stream: ${playError.message || playError.name}`);
            stopCamera();
          }
        });

        console.log('Camera started successfully and video playing.');

        setIsActive(true);
      } else {
        setError('Video element reference is null. Cannot attach stream.');
        stopCamera();
      }
    } catch (err) {
      console.error('Error accessing camera:', err);

      if (err instanceof Error) {
        if (err.name === 'NotAllowedError') {
          setError('Camera access denied. Please grant permission in your browser settings.');
        } else if (err.name === 'NotFoundError') {
          setError('No camera found. Please ensure you have a camera connected and enabled.');
        } else if (err.name === 'NotReadableError') {
          setError(
            'Camera is in use by another application or device. Please close other camera-using apps.',
          );
        } else if (err.name === 'OverconstrainedError') {
          setError('Camera not available with requested constraints (e.g., resolution).');
        } else {
          setError(`Failed to access camera: ${err.message || err.name}`);
        }
      }

      stopCamera();
    }
  }, [facingMode, isActive, stopCamera, setIsActive, applyMuteState]);

  // Covers the other direction: toggling while the camera is already open. The
  // stream lives in a ref, so this effect keys off the mute state that changed.
  useEffect(() => {
    applyMuteState(mediaStreamRef.current);
  }, [applyMuteState, microphoneEnabled, cameraEnabled]);

  return [
    {
      isActive,
      error,
      videoRef,
      mediaStreamRef,
    },
    {
      startCamera,
      stopCamera,
      setError,
    },
  ];
}

const { Provider, useHookContext } = createHookContext(useStream);

export { Provider as StreamProvider, useHookContext as useStream };
