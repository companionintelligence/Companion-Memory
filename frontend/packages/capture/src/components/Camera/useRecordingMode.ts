import { createHookContext } from '@ci/common';
import { useCallback, useState } from 'react';

type RecordingMode = 'photo' | 'video';

type ReturnType = [
  {
    recordingMode: RecordingMode;
  },
  {
    setPhotoMode: () => void;
    setVideoMode: () => void;
    swapRecordingMode: () => void;
  },
];

function useRecordingMode(): ReturnType {
  const [recordingMode, setRecordingMode] = useState<RecordingMode>('photo');

  const setPhotoMode = useCallback(() => setRecordingMode('photo'), []);
  const setVideoMode = useCallback(() => setRecordingMode('video'), []);
  const swapRecordingMode = useCallback(
    () => setRecordingMode((current) => (current === 'photo' ? 'video' : 'photo')),
    [],
  );

  return [
    {
      recordingMode,
    },
    {
      setPhotoMode,
      setVideoMode,
      swapRecordingMode,
    },
  ];
}

const { Provider, useHookContext } = createHookContext(useRecordingMode);

export { Provider as RecordingModeProvider, useHookContext as useRecordingMode };
