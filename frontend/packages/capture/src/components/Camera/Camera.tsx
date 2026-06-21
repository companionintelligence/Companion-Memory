import { type ReactNode, useEffect } from 'react';

import { cn } from '@ci/shadcn';

import { Feed } from './Feed';
import { FacingModeProvider, useFacingMode } from './useFacingMode';
import { InputDevicesProvider } from './useInputDevices';
import { MuteControlsProvider } from './useMuteControls';
import { RecorderProvider } from './useRecorder';
import { RecordingModeProvider, type RecordingMode } from './useRecordingMode';
import { StreamProvider, useStream } from './useStream';
import { DesktopControls, MobileControls } from './Controls';
import { Information } from './Information';

interface CameraProps {
  onFrameCaptured?: (file: File, mode: RecordingMode) => void;
  onRecordingFinished?: (file: File, mode: RecordingMode) => void;
  children: ReactNode;
  className?: string;
}

function Camera({ children, className }: CameraProps) {
  const [, { startCamera, stopCamera }] = useStream();
  const [{ facingMode }] = useFacingMode();

  useEffect(() => {
    startCamera();

    return () => {
      console.log('CameraFeed component unmounting. Stopping camera...');
      stopCamera();
    };
  }, [facingMode]);

  return <div className={cn('relative bg-black', className)}>{children}</div>;
}

function CameraWithContext({ children, onFrameCaptured, onRecordingFinished, ...props }: CameraProps) {
  return (
    <FacingModeProvider args={[]}>
      <RecordingModeProvider args={[]}>
        <StreamProvider args={[]}>
          <RecorderProvider args={[{ onFrameCaptured, onRecordingFinished }]}>
            <MuteControlsProvider args={[]}>
              <InputDevicesProvider args={[]}>
                <Camera {...props}>{children}</Camera>
              </InputDevicesProvider>
            </MuteControlsProvider>
          </RecorderProvider>
        </StreamProvider>
      </RecordingModeProvider>
    </FacingModeProvider>
  );
}

type CameraComponent = typeof CameraWithContext & {
  DesktopControls: typeof DesktopControls;
  Feed: typeof Feed;
  Information: typeof Information;
  MobileControls: typeof MobileControls;
};

const AugmentedCamera = CameraWithContext as CameraComponent;

AugmentedCamera.DesktopControls = DesktopControls;
AugmentedCamera.Feed = Feed;
AugmentedCamera.Information = Information;
AugmentedCamera.MobileControls = MobileControls;

export { AugmentedCamera as Camera };
