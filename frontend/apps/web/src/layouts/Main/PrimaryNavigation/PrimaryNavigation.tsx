import { useCallback, useEffect, useRef, useState } from 'react';

import { Portal } from '@ci/common';
import { Button, DropdownMenu, Separator } from '@ci/shadcn';
import { Upload, Camera, Plus, Cable, Mic } from '@ci/shadcn/icons';
import { useNavigate } from 'react-router-dom';

import { useUploadFile } from '@/api';
import { CaptureModal } from '@/components/modals/CaptureModal';
import { RecordModal } from '@/components/modals/RecordModal';
import { UploadModal } from '@/components/modals/UploadModal';
import { useModalControls } from '@/hooks';

import { NavUser } from './NavUser';

export function PrimaryNavigation() {
  const navigate = useNavigate();

  const [{ isOpen: isCaptureModalOpen }, { open: openCaptureModal, close: closeCaptureModal }] =
    useModalControls();
  const [{ isOpen: isUploadModalOpen }, { open: openUploadModal, close: closeUploadModal }] =
    useModalControls();
  const [{ isOpen: isRecordModalOpen }, { open: openRecordModal, close: closeRecordModal }] =
    useModalControls();

  const [, { upload, reset: resetUploader }] = useUploadFile();

  const [hasActions, setHasActions] = useState(false);
  const observer = useRef<MutationObserver | null>(null);

  const actionsRef = useCallback((node: HTMLDivElement | null) => {
    if (observer.current) {
      observer.current.disconnect();
      observer.current = null;
    }

    if (node) {
      observer.current = new MutationObserver(() => {
        setHasActions(node.childElementCount > 0);
      });

      observer.current.observe(node, { childList: true });

      setHasActions(node.childElementCount > 0);
    }
  }, []);

  useEffect(() => {
    return () => {
      observer.current?.disconnect();
    };
  }, []);

  const handleUpload = (files: FileList) => {
    return upload(Array.from(files));
  };

  return (
    <>
      <header className="flex flex-row items-center justify-between p-2 px-4">
        <section className="flex flex-row items-center">
          <Portal id="breadcrumbs" />
        </section>

        <section className="flex flex-row items-center gap-4">
          <Portal ref={actionsRef} id="actions" className="flex flex-row items-center" />

          {hasActions && (
            <Separator orientation="vertical" className="data-[orientation=vertical]:h-8 -mr-2" />
          )}

          <div className="flex flex-row items-center gap-2">
            <DropdownMenu modal={false}>
              <DropdownMenu.Trigger asChild>
                <Button variant="ghost" size="icon" aria-label="More Options">
                  <Plus />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content className="rounded-lg p-2" side="bottom" align="end" sideOffset={4}>
                <div className="grid grid-cols-2 gap-2">
                  <DropdownMenu.Item
                    onSelect={openUploadModal}
                    className="h-16 w-16 flex flex-col items-center justify-center gap-2 cursor-pointer rounded-md p-1"
                  >
                    <Upload className="h-6! w-6!" strokeWidth={1.25} />
                    <span className="text-xs">Upload</span>
                  </DropdownMenu.Item>

                  <DropdownMenu.Item
                    onSelect={openCaptureModal}
                    className="h-16 w-16 flex flex-col items-center justify-center gap-2 cursor-pointer rounded-md p-1"
                  >
                    <Camera className="h-6! w-6!" strokeWidth={1.25} />
                    <span className="text-xs">Capture</span>
                  </DropdownMenu.Item>

                  <DropdownMenu.Item
                    onSelect={openRecordModal}
                    className="h-16 w-16 flex flex-col items-center justify-center gap-2 cursor-pointer rounded-md p-1"
                  >
                    <Mic className="h-6! w-6!" strokeWidth={1.25} />
                    <span className="text-xs">Record</span>
                  </DropdownMenu.Item>

                  <DropdownMenu.Item
                    onSelect={() => navigate('/connect')}
                    className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                  >
                    <Cable className="h-6! w-6!" strokeWidth={1.25} />
                    <span className="text-xs">Connect</span>
                  </DropdownMenu.Item>
                </div>
              </DropdownMenu.Content>
            </DropdownMenu>

            <NavUser />
          </div>
        </section>
      </header>

      <UploadModal
        open={isUploadModalOpen}
        onClose={() => {
          resetUploader();
          closeUploadModal();
        }}
        onSubmit={handleUpload}
      />

      <CaptureModal
        open={isCaptureModalOpen}
        onClose={() => {
          resetUploader();
          closeCaptureModal();
        }}
      />

      <RecordModal
        open={isRecordModalOpen}
        onClose={() => {
          resetUploader();
          closeRecordModal();
        }}
      />
    </>
  );
}
