import { createHookContext } from '@ci/common';
import { useCallback, useState } from 'react';

function useMuteControls() {
  const [microphoneEnabled, setMicrophoneEnabled] = useState<boolean>(true);
  const [cameraEnabled, setCameraEnabled] = useState<boolean>(true);

  const toggleMicrophone = useCallback(
    () => setMicrophoneEnabled((current) => !current),
    [setMicrophoneEnabled],
  );

  const toggleCamera = useCallback(() => setCameraEnabled((current) => !current), [setCameraEnabled]);

  return [
    {
      microphoneEnabled,
      cameraEnabled,
    },
    {
      toggleMicrophone,
      toggleCamera,
    },
  ];
}

const { Provider, useHookContext } = createHookContext(useMuteControls);

export { Provider as MuteControlsProvider, useHookContext as useMuteControls };
