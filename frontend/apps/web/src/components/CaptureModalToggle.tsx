import { Button } from '@ci/shadcn';
import { Camera } from '@ci/shadcn/icons';

interface Props {
  openModal: () => void;
}

export function CaptureModalToggle({ openModal }: Props) {
  return (
    <Button variant="ghost" size="icon" onClick={openModal} title="Open Capture Modal">
      <Camera className="h-4 w-4" />
    </Button>
  );
}
