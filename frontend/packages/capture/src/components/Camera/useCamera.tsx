import type { Device } from './types';
import { useInputDevices } from './useInputDevices';
import { useRecorder } from './useRecorder';
import { useStream } from './useStream';

type ReturnType = [
  {
    error: string | null;
    isActive: boolean;
    microphones: Device[];
    cameras: Device[];
    selectedMicrophone: Device | null;
    selectedCamera: Device | null;
    lastCapture: File | null;
  },
  {
    startCamera: () => void;
    stopCamera: () => void;
    captureFrame: () => void;
  },
];

export function useCamera(): ReturnType {
  const [{ isActive, error }, { startCamera, stopCamera }] = useStream();
  const [{ lastCapture }, { captureFrame }] = useRecorder();
  const [{ microphones, cameras, selectedMicrophone, selectedCamera }] = useInputDevices();

  return [
    {
      error,
      isActive,
      microphones,
      cameras,
      selectedMicrophone,
      selectedCamera,
      lastCapture,
    },
    {
      startCamera,
      stopCamera,
      captureFrame,
    },
  ];
}
