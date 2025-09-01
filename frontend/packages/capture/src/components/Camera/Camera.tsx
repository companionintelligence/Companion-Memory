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
        className={cn(
          'w-full h-full object-contain block transition-opacity duration-300 ease-in-out',
          isActive ? 'opacity-100' : 'opacity-0',
        )}
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
              className={cn('transition-colors duration-200', isRecording ? 'text-red-500' : 'text-white')}
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
              className={cn(
                'transition-transform duration-300 ease-in-out',
                facingMode === 'environment' ? '[transform:rotateY(180deg)]' : '[transform:rotateY(0deg)]',
              )}
              onClick={swapFacingMode}
            />

            <Controls.Icon icon={Settings} tooltip="Settings" />
          </Controls>
        </>
      )}

      {!isActive && (
        <div className="absolute inset-0 flex items-center justify-center bg-stone-100 animate-pulse">
          <div className="text-center p-8 border-2 border-dashed border-stone-300 rounded-lg bg-white/50 backdrop-blur-sm">
            <CameraIcon className="w-12 h-12 mx-auto mb-4 text-stone-400" />
            <p className="text-stone-600 font-medium">Waiting for camera access...</p>
            <p className="text-sm text-stone-500 mt-1">Please allow camera permissions</p>
          </div>
        </div>
      )}
    </div>
  );
}

function CameraInformation() {
  const [{ selectedMicrophone, selectedCamera }] = useInputDevices();

  return (
    <div className="absolute flex flex-row items-center justify-center top-4 left-4 flex py-2 px-3 gap-2 rounded-full bg-black/80 backdrop-blur-md text-gray-100 text-sm select-none border border-white/20 shadow-lg animate-in slide-in-from-top-4 duration-300 ease-out">
      <VideoIcon className="w-4 h-4 text-green-400" />
      <div className="font-medium">{selectedCamera?.name ?? 'No camera'}</div>
      <div className="w-px h-4 bg-white/40 mx-1" />
      <Mic className="w-4 h-4 text-blue-400" />
      <div className="font-medium">{selectedMicrophone?.name ?? 'No mic'}</div>
    </div>
  );
}

type CameraComponent = typeof CameraWithContext & {
  Feed: typeof CameraFeed;
};

const AugmentedCamera = CameraWithContext as CameraComponent;

AugmentedCamera.Feed = CameraFeed;

export { AugmentedCamera as Camera };
