import { useCallback } from 'react';

import { Button, Dialog } from '@ci/shadcn';
import { X } from '@ci/shadcn/icons';
import { useVoiceVisualizer, VoiceVisualizer } from 'react-voice-visualizer';

interface Props {
  open?: boolean;
  onClose?: (open?: boolean) => void;
}

export function RecordModal({ open, onClose }: Props) {
  const recorderControls = useVoiceVisualizer();

  // const {
  //   startRecording,
  //   stopRecording,
  //   togglePauseResume,
  //   saveAudioFile,
  //   isRecordingInProgress,
  //   isPausedRecording,
  //   recordedBlob,
  // } = recorderControls;

  const handleClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <Dialog.Content className="p-0 flex flex-col gap-0" showCloseButton={false}>
        <Dialog.Header className="flex flex-row items-center justify-between border-b bg-stone-50 dark:bg-secondary rounded-t-lg gap-2 p-2 pl-4">
          <Dialog.Title>Record audio</Dialog.Title>
          <Dialog.Description className="hidden">Record audio to upload</Dialog.Description>

          <div className="flex items-center justify-end">
            <Button variant="ghost" size="icon" onClick={handleClose}>
              <X />
            </Button>
          </div>
        </Dialog.Header>

        <div className="bg-gray-800">
          <VoiceVisualizer
            controls={recorderControls}
            // isControlPanelShown={false} // Hides the built-in control buttons and timer
            // isDefaultUIShown={false} // Optional: Hides the default "Start Recording" placeholder UI
          />
        </div>
      </Dialog.Content>
    </Dialog>
  );
}
