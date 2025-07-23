import { cn } from '@ci/shadcn';
import {
  Camera as CameraIcon,
  Circle,
  CircleStop,
  Mic,
  MicOff,
  Settings,
  SwitchCamera,
  Video,
  VideoIcon,
  VideoOff,
} from '@ci/shadcn/icons';
import { type ReactNode, useEffect } from 'react';

import { Controls } from './Controls';
import { FacingModeProvider, useFacingMode } from './useFacingMode';
import { InputDevicesProvider, useInputDevices } from './useInputDevices';
import { MuteControlsProvider, useMuteControls } from './useMuteControls';
import { RecorderProvider, useRecorder } from './useRecorder';
import { StreamProvider, useStream } from './useStream';

interface CameraProps {
  onFrameCaptured?: (file: File) => void;
  onRecordingFinished?: (file: File) => void;
  children: ReactNode;
}

function Camera({ children }: CameraProps) {
  const [, { startCamera, stopCamera }] = useStream();

  useEffect(() => {
    startCamera();

    return () => {
      console.log('CameraFeed component unmounting. Stopping camera...');
      stopCamera();
    };
  }, []);

  return <>{children}</>;
}

function CameraWithContext({ children, onFrameCaptured, onRecordingFinished, ...props }: CameraProps) {
  return (
    <StreamProvider args={[]}>
      <RecorderProvider args={[{ onFrameCaptured, onRecordingFinished }]}>
        <MuteControlsProvider args={[]}>
          <FacingModeProvider args={[]}>
            <InputDevicesProvider args={[]}>
              <Camera {...props}>{children}</Camera>
            </InputDevicesProvider>
          </FacingModeProvider>
        </MuteControlsProvider>
      </RecorderProvider>
    </StreamProvider>
  );
}

function CameraFeed() {
  const [{ isActive, videoRef }] = useStream();

  const [{ isRecording }, { captureFrame, toggleRecording }] = useRecorder();
  const [{ microphoneEnabled, cameraEnabled }, { toggleMicrophone, toggleCamera }] = useMuteControls();
  const [{ facingMode }, { swapFacingMode }] = useFacingMode();

  const RecordingIcon = isRecording ? CircleStop : Circle;
  const VideoIcon = cameraEnabled ? Video : VideoOff;
  const MicrophoneIcon = microphoneEnabled ? Mic : MicOff;

  return (
    <div className="relative w-full h-full">
      <video
        className={cn('w-full h-full object-contain block', isActive ? 'block' : 'hidden')}
        ref={videoRef}
        autoPlay
        playsInline
        muted
      ></video>

      {isActive && (
        <>
          <CameraInformation />

          <Controls>
            <Controls.Icon
              className={isRecording ? 'text-red-500' : 'text-white'}
              icon={RecordingIcon}
              tooltip={isRecording ? 'Stop recording' : 'Record video'}
              onClick={toggleRecording}
            />

            <Controls.Icon icon={CameraIcon} tooltip="Capture picture" onClick={captureFrame} />

            <Controls.Divider />

            <Controls.Icon
              icon={VideoIcon}
              tooltip={cameraEnabled ? 'Disable video' : 'Enable video'}
              onClick={toggleCamera}
            />

            <Controls.Icon
              icon={MicrophoneIcon}
              tooltip={microphoneEnabled ? 'Disable mic' : 'Enable mic'}
              onClick={toggleMicrophone}
            />

            <Controls.Divider />

            <Controls.Icon
              icon={SwitchCamera}
              tooltip="Swap camera"
              className={
                facingMode === 'environment' ? '[transform:rotateY(180deg)]' : '[transform:rotateY(0deg)]'
              }
              onClick={swapFacingMode}
            />

            <Controls.Icon icon={Settings} tooltip="Settings" />
          </Controls>
        </>
      )}

      {!isActive && (
        <div style={{ textAlign: 'center', padding: '20px', border: '2px dashed #ccc', borderRadius: '8px' }}>
          <p>Waiting for camera access...</p>
        </div>
      )}
    </div>
  );
}

function CameraInformation() {
  const [{ selectedMicrophone, selectedCamera }] = useInputDevices();

  return (
    <div className="absolute flex flex-row items-center justify-center top-1 left-1 flex py-1 px-2 gap-1 rounded-lg bg-black/60 backdrop-blur-sm text-gray-100 text-xs select-none">
      <VideoIcon className="w-4 h-4" />
      <div>{selectedCamera?.name ?? 'No camera'}</div>
      <Controls.Divider />
      <Mic className="w-4 h-4" />
      <div>{selectedMicrophone?.name ?? 'No mic'}</div>
    </div>
  );
}

type CameraComponent = typeof CameraWithContext & {
  Feed: typeof CameraFeed;
};

const AugmentedCamera = CameraWithContext as CameraComponent;

AugmentedCamera.Feed = CameraFeed;

export { AugmentedCamera as Camera };
