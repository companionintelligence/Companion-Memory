import { Button, cn } from '@ci/shadcn';
import { SquareDashed, SwitchCamera } from '@ci/shadcn/icons';
import { useCallback } from 'react';

import { useFacingMode } from '../useFacingMode';
import { useRecorder } from '../useRecorder';
import { useRecordingMode } from '../useRecordingMode';

import { Icon } from './Icon';
import { MediaBackground } from './MediaBackground';

interface Props {
  onSelectLastCapture?: () => void;
  onRecordingModeChange?: (mode: 'photo' | 'video' | 'inventory') => void;
}

export function MobileControls({ onSelectLastCapture, onRecordingModeChange }: Props) {
  const [{ isRecording, lastCapture }, { captureFrame, toggleRecording }] = useRecorder();
  const [{ facingMode }, { swapFacingMode }] = useFacingMode();
  const [{ recordingMode }, { setPhotoMode, setVideoMode, setInventoryMode }] = useRecordingMode();

  const handleRecordClick = useCallback(() => {
    if (recordingMode === 'video') {
      toggleRecording();

      return;
    }

    captureFrame();
  }, [captureFrame, toggleRecording, recordingMode]);

  const handleSetPhotoMode = useCallback(() => {
    setPhotoMode();
    onRecordingModeChange?.('photo');
  }, [setPhotoMode, onRecordingModeChange]);

  const handleSetVideoMode = useCallback(() => {
    setVideoMode();
    onRecordingModeChange?.('video');
  }, [setVideoMode, onRecordingModeChange]);

  const handleSetInventoryMode = useCallback(() => {
    setInventoryMode();
    onRecordingModeChange?.('inventory');
  }, [setInventoryMode, onRecordingModeChange]);

  return (
    <div>
      <div className="flex flex-row items-center justify-center w-75 mx-auto pb-0.5">
        <div
          className={cn(
            'py-4 text-center text-sm basis-1/3',
            recordingMode === 'photo' ? 'text-yellow-300' : 'text-white',
          )}
          onClick={handleSetPhotoMode}
        >
          PHOTO
        </div>
        <div
          className={cn(
            'py-4 text-center text-sm basis-1/3',
            recordingMode === 'video' ? 'text-yellow-300' : 'text-white',
          )}
          onClick={handleSetVideoMode}
        >
          VIDEO
        </div>
        <div
          className={cn(
            'py-4 text-center text-sm basis-1/3',
            recordingMode === 'inventory' ? 'text-yellow-300' : 'text-white',
          )}
          onClick={handleSetInventoryMode}
        >
          INVENTORY
        </div>
      </div>

      <div className="w-full flex flex-row items-center pb-[max(2.5rem,env(safe-area-inset-bottom))] select-none">
        <div className="flex items-center justify-start flex-1">
          {lastCapture && (
            <div className="w-12 h-12 ml-10" onClick={onSelectLastCapture}>
              <MediaBackground file={lastCapture} />
            </div>
          )}

          {!lastCapture && <Icon icon={SquareDashed} className="ml-12" />}
        </div>

        <Button
          className="relative w-16 h-16 group focus:outline-none cursor-pointer"
          variant="ghost"
          onClick={handleRecordClick}
        >
          <div className="absolute inset-0 rounded-full border-3 border-white"></div>
          <div
            className={cn(
              'absolute inset-1.5 rounded-2xl transform transition-radius transition-transform duration-100 ease-in-out group-active:scale-[.95] will-change-transform',
              recordingMode === 'video' ? 'bg-red-500' : 'bg-white',
              recordingMode === 'video' && isRecording ? 'rounded-xl scale-[0.5]' : 'rounded-full',
            )}
          ></div>
        </Button>

        <div className="flex items-center justify-end flex-1">
          <Icon
            icon={SwitchCamera}
            className={cn(
              'mr-12',
              facingMode === 'environment' ? '[transform:rotateY(180deg)]' : '[transform:rotateY(0deg)]',
            )}
            onClick={swapFacingMode}
          />
        </div>
      </div>
    </div>
  );
}
