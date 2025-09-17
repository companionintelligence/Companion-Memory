import { Mic, VideoIcon } from '@ci/shadcn/icons';

import { Divider } from './Controls';
import { useInputDevices } from './useInputDevices';

export function Information() {
  const [{ selectedMicrophone, selectedCamera }] = useInputDevices();

  return (
    <div className="absolute flex flex-row items-center justify-center top-1 left-1 z-10 flex py-1 px-2 gap-1 rounded-lg bg-black/60 backdrop-blur-sm text-gray-100 text-xs select-none">
      <VideoIcon className="w-4 h-4" />
      <div>{selectedCamera?.name ?? 'No camera'}</div>
      <Divider />
      <Mic className="w-4 h-4" />
      <div>{selectedMicrophone?.name ?? 'No mic'}</div>
    </div>
  );
}
