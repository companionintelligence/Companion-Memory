import { createHookContext } from '@ci/common';
import { useCallback, useState } from 'react';

export type RecordingMode = 'photo' | 'video' | 'thing';

type ReturnType = [
  {
    recordingMode: RecordingMode;
  },
  {
    setPhotoMode: () => void;
    setVideoMode: () => void;
    setThingMode: () => void;
    swapRecordingMode: () => void;
  },
];

function useRecordingMode(): ReturnType {
  const [recordingMode, setRecordingMode] = useState<RecordingMode>('photo');

  const setPhotoMode = useCallback(() => setRecordingMode('photo'), []);
  const setVideoMode = useCallback(() => setRecordingMode('video'), []);
  const setThingMode = useCallback(() => setRecordingMode('thing'), []);
  const swapRecordingMode = useCallback(
    () =>
      setRecordingMode((current) => {
        if (current === 'photo') {
          return 'video';
        }

        if (current === 'video') {
          return 'thing';
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
      setThingMode,
      swapRecordingMode,
    },
  ];
}

const { Provider, useHookContext } = createHookContext(useRecordingMode);

export { Provider as RecordingModeProvider, useHookContext as useRecordingMode };
