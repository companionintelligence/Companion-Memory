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
}

export function MobileControls({ onSelectLastCapture }: Props) {
  const [{ isRecording, lastCapture }, { captureFrame, toggleRecording }] = useRecorder();
  const [{ facingMode }, { swapFacingMode }] = useFacingMode();
  const [{ recordingMode }, { setPhotoMode, setVideoMode }] = useRecordingMode();

  const handleRecordClick = useCallback(() => {
    if (recordingMode === 'photo') {
      captureFrame();
    } else {
      toggleRecording();
    }
  }, [captureFrame, toggleRecording, recordingMode, isRecording]);

  return (
    <div>
      <div className="flex flex-row items-center justify-center w-75 mx-auto pb-0.5">
        <div
          className={cn(
            'py-4 text-center text-sm basis-1/2',
            recordingMode === 'photo' ? 'text-yellow-300' : 'text-white',
          )}
          onClick={setPhotoMode}
        >
          PHOTO
        </div>
        <div
          className={cn(
            'py-4 text-center text-sm basis-1/2',
            recordingMode === 'video' ? 'text-yellow-300' : 'text-white',
          )}
          onClick={setVideoMode}
        >
          VIDEO
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
              recordingMode === 'photo' ? 'bg-white' : 'bg-red-500',
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
