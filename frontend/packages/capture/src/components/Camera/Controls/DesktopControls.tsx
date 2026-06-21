import { Tooltip } from '@ci/shadcn';

import {
  Camera as CameraIcon,
  Circle,
  CircleStop,
  Mic,
  MicOff,
  Package,
  Settings,
  SwitchCamera,
  Video,
  VideoOff,
} from '@ci/shadcn/icons';

import { Divider } from './Divider';
import { Icon } from './Icon';

import { useFacingMode } from '../useFacingMode';
import { useInputDevices } from '../useInputDevices';
import { useMuteControls } from '../useMuteControls';
import { useRecorder } from '../useRecorder';
import { useRecordingMode } from '../useRecordingMode';

interface Props {
  onRecordingModeChange?: (mode: 'photo' | 'video' | 'inventory') => void;
}

export function DesktopControls({ onRecordingModeChange }: Props) {
  const [{ isRecording }, { captureFrame, toggleRecording }] = useRecorder();
  const [{ microphoneEnabled, cameraEnabled }, { toggleMicrophone, toggleCamera }] = useMuteControls();
  const [{ facingMode }, { swapFacingMode }] = useFacingMode();
  const [{ recordingMode }, { setPhotoMode, setVideoMode, setInventoryMode }] = useRecordingMode();
  const [{ cameras, selectedCamera, setSelectedCamera }] = useInputDevices();

  const RecordingIcon = isRecording ? CircleStop : Circle;
  const VideoIcon = cameraEnabled ? Video : VideoOff;
  const MicrophoneIcon = microphoneEnabled ? Mic : MicOff;

  function swapCamera() {
    swapFacingMode!();
    setSelectedCamera(cameras.filter((camera) => camera.id !== selectedCamera?.id)[0] || selectedCamera);
  }

  function handleToggleRecording() {
    setVideoMode();
    onRecordingModeChange?.('video');
    toggleRecording('video');
  }

  function handlePhotoCapture() {
    setPhotoMode();
    onRecordingModeChange?.('photo');
    captureFrame('photo');
  }

  function handleInventoryCapture() {
    setInventoryMode();
    onRecordingModeChange?.('inventory');
    captureFrame('inventory');
  }

  return (
    <Tooltip.Provider>
      <div className="absolute bottom-1 left-1/2 -translate-x-1/2 flex p-1 gap-1 rounded-lg bg-black/60 backdrop-blur-sm">
        <Icon
          className={
            isRecording ? 'text-red-500' : recordingMode === 'video' ? 'text-yellow-300' : 'text-white'
          }
          icon={RecordingIcon}
          tooltip={isRecording ? 'Stop recording' : 'Record video'}
          onClick={handleToggleRecording}
        />

        <Icon
          icon={CameraIcon}
          tooltip="Capture picture"
          className={recordingMode === 'photo' ? 'text-yellow-300' : 'text-white'}
          onClick={handlePhotoCapture}
        />

        <Icon
          icon={Package}
          tooltip="Capture inventory image"
          className={recordingMode === 'inventory' ? 'text-yellow-300' : 'text-white'}
          onClick={handleInventoryCapture}
        />

        <Divider />

        <Icon
          icon={VideoIcon}
          tooltip={cameraEnabled ? 'Disable video' : 'Enable video'}
          onClick={toggleCamera}
        />

        <Icon
          icon={MicrophoneIcon}
          tooltip={microphoneEnabled ? 'Disable mic' : 'Enable mic'}
          onClick={toggleMicrophone}
        />

        <Divider />

        <Icon
          icon={SwitchCamera}
          tooltip="Swap camera"
          className={
            facingMode === 'environment' ? '[transform:rotateY(180deg)]' : '[transform:rotateY(0deg)]'
          }
          onClick={swapCamera}
        />

        <Icon icon={Settings} tooltip="Settings" />
      </div>
    </Tooltip.Provider>
  );
}
