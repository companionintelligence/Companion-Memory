import { createHookContext } from '@ci/common';
import { useCallback, useState } from 'react';

type RecordingMode = 'photo' | 'video' | 'inventory';

type ReturnType = [
  {
    recordingMode: RecordingMode;
  },
  {
    setPhotoMode: () => void;
    setVideoMode: () => void;
    setInventoryMode: () => void;
    swapRecordingMode: () => void;
  },
];

function useRecordingMode(): ReturnType {
  const [recordingMode, setRecordingMode] = useState<RecordingMode>('photo');

  const setPhotoMode = useCallback(() => setRecordingMode('photo'), []);
  const setVideoMode = useCallback(() => setRecordingMode('video'), []);
  const setInventoryMode = useCallback(() => setRecordingMode('inventory'), []);
  const swapRecordingMode = useCallback(
    () =>
      setRecordingMode((current) => {
        if (current === 'photo') {
          return 'video';
        }

        if (current === 'video') {
          return 'inventory';
        }

        return 'photo';
      }),
    [],
  );

  return [
    {
      recordingMode,
    },
    {
      setPhotoMode,
      setVideoMode,
      setInventoryMode,
      swapRecordingMode,
    },
  ];
}

const { Provider, useHookContext } = createHookContext(useRecordingMode);

export { Provider as RecordingModeProvider, useHookContext as useRecordingMode };
