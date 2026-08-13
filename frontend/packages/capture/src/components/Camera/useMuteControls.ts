import { createHookContext } from '@ci/common';
import { useCallback, useRef, useState } from 'react';

type ReturnType = [
  {
    microphoneEnabled: boolean;
    cameraEnabled: boolean;
  },
  {
    toggleMicrophone: () => void;
    toggleCamera: () => void;
    applyMuteState: (stream: MediaStream | null) => void;
  },
];

function useMuteControls(): ReturnType {
  const [microphoneEnabled, setMicrophoneEnabled] = useState<boolean>(true);
  const [cameraEnabled, setCameraEnabled] = useState<boolean>(true);

  // Mirrors of the state above. `applyMuteState` is called from async code — right
  // after `getUserMedia` resolves, which can be hundreds of milliseconds after the
  // closure that started it was created. Reading state there would read a stale
  // value exactly when it matters most: muting while the camera is still opening
  // must not leave a live microphone behind a MicOff icon.
  const microphoneEnabledRef = useRef<boolean>(true);
  const cameraEnabledRef = useRef<boolean>(true);

  /**
   * Push the current mute state onto a stream's tracks.
   *
   * Muting flips `MediaStreamTrack.enabled` rather than stopping the track: a
   * disabled track stays in the stream but yields silence / black frames, so the
   * MediaRecorder muxing it keeps producing a valid file and un-muting is instant.
   * Stopping the track would release the device (and drop the OS capture
   * indicator) but ends the track permanently, which breaks an in-flight
   * recording and forces a full re-acquire to resume.
   */
  const applyMuteState = useCallback((stream: MediaStream | null) => {
    if (!stream) {
      return;
    }

    stream.getAudioTracks().forEach((track) => {
      track.enabled = microphoneEnabledRef.current;
    });

    stream.getVideoTracks().forEach((track) => {
      track.enabled = cameraEnabledRef.current;
    });
  }, []);

  // The ref is flipped first and the state derived from it, so the ref stays the
  // single source of truth and never disagrees with what the icons show.
  const toggleMicrophone = useCallback(() => {
    microphoneEnabledRef.current = !microphoneEnabledRef.current;
    setMicrophoneEnabled(microphoneEnabledRef.current);
  }, []);

  const toggleCamera = useCallback(() => {
    cameraEnabledRef.current = !cameraEnabledRef.current;
    setCameraEnabled(cameraEnabledRef.current);
  }, []);

  return [
    {
      microphoneEnabled,
      cameraEnabled,
    },
    {
      toggleMicrophone,
      toggleCamera,
      applyMuteState,
    },
  ];
}

const { Provider, useHookContext } = createHookContext(useMuteControls);

export { Provider as MuteControlsProvider, useHookContext as useMuteControls };
