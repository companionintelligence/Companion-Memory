import { useCallback, useEffect, useRef, useState } from 'react';

import { Portal } from '@ci/common';
import { Button, DropdownMenu, Separator, useToast } from '@ci/shadcn';
import {
  NotebookPen,
  Upload,
  Camera,
  Plus,
  Cable,
  Search,
  Tags,
  User,
  Lightbulb,
  Package,
} from '@ci/shadcn/icons';
import { Link, useNavigate } from 'react-router-dom';

import { useUploadFile, useTriggerHbpe } from '@/api';
import { AddPersonModal } from '@/components/modals/AddItemModal';
import { AddConceptModal } from '@/components/modals/AddItemModal/AddConceptModal.tsx';
import { CaptureModal } from '@/components/modals/CaptureModal';
import { InventoryItemModal } from '@/components/modals/InventoryItemModal';
import { UploadModal } from '@/components/modals/UploadModal';
import { GlobalSearchBox } from '@/components/SearchBox';
import { useModalControls } from '@/hooks';

import { NavUser } from './NavUser';

export function PrimaryNavigation() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [, { trigger }] = useTriggerHbpe();

  const [{ isOpen: isCaptureModalOpen }, { open: openCaptureModal, close: closeCaptureModal }] =
    useModalControls();
  const [{ isOpen: isUploadModalOpen }, { open: openUploadModal, close: closeUploadModal }] =
    useModalControls();
  const [{ isOpen: isAddPersonModalOpen }, { open: openAddPersonModal, close: closeAddPersonModal }] =
    useModalControls();
  const [{ isOpen: isAddConceptModalOpen }, { open: openAddConceptModal, close: closeAddConceptModal }] =
    useModalControls();
  const [{ isOpen: isItemModalOpen }, { open: openItemModal, close: closeItemModal }] = useModalControls();

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

          {hasActions && <Separator orientation="vertical" className="data-[orientation=vertical]:h-6" />}

          <div className="flex flex-row items-center gap-2">
            <div className="w-64">
              <GlobalSearchBox />
            </div>

            <div className="flex items-center">
              <Button variant="ghost" size="icon" aria-label="More Options">
                <Link to="/tags">
                  <Tags strokeWidth={1.5} />
                </Link>
              </Button>

              <DropdownMenu modal={false}>
                <DropdownMenu.Trigger asChild>
                  <Button variant="ghost" size="icon" aria-label="More Options">
                    <Plus strokeWidth={1.5} />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content className="rounded-lg p-2" side="bottom" align="end" sideOffset={4}>
                  <div className="text-center text-sm font-semibold mb-3 mt-1">Add</div>
                  <div className="grid grid-cols-4 gap-2">
                    <DropdownMenu.Item
                      onSelect={() => navigate('/notes/new')}
                      className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                    >
                      <NotebookPen className="h-6! w-6!" strokeWidth={1.25} />
                      <span className="text-xs">Note</span>
                    </DropdownMenu.Item>

                    <DropdownMenu.Item
                      onSelect={openAddPersonModal}
                      className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                    >
                      <User className="h-6! w-6!" strokeWidth={1.25} />
                      <span className="text-xs text-center">Person</span>
                    </DropdownMenu.Item>

                    <DropdownMenu.Item
                      onSelect={openAddConceptModal}
                      className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                    >
                      <Lightbulb className="h-6! w-6!" strokeWidth={1.25} />
                      <span className="text-xs text-center">Concept</span>
                    </DropdownMenu.Item>

                    <DropdownMenu.Item
                      onSelect={openItemModal}
                      className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                    >
                      <Package className="h-6! w-6!" strokeWidth={1.25} />
                      <span className="text-xs text-center">Item</span>
                    </DropdownMenu.Item>
                  </div>
                  <div className="mt-2 -mx-2 -mb-2 bg-muted/50 p-4 rounded-b-lg">
                    <div className="text-center text-sm font-semibold mb-3">Actions</div>
                    <div className="grid grid-cols-4 gap-2">
                      <DropdownMenu.Item
                        onSelect={openUploadModal}
                        className="h-16 w-16 flex flex-col items-center justify-center gap-2 cursor-pointer rounded-md p-1"
                      >
                        <Upload className="h-6! w-6!" strokeWidth={1.25} />
                        <span className="text-xs text-center">Upload</span>
                      </DropdownMenu.Item>

                      <DropdownMenu.Item
                        onSelect={openCaptureModal}
                        className="h-16 w-16 flex flex-col items-center justify-center gap-2 cursor-pointer rounded-md p-1"
                      >
                        <Camera className="h-6! w-6!" strokeWidth={1.25} />
                        <span className="text-xs text-center">Capture</span>
                      </DropdownMenu.Item>

                      <DropdownMenu.Item
                        onSelect={() => navigate('/connect')}
                        className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                      >
                        <Cable className="h-6! w-6!" strokeWidth={1.25} />
                        <span className="text-xs text-center">Connect</span>
                      </DropdownMenu.Item>

                      <DropdownMenu.Item
                        onSelect={async (e) => {
                          e.preventDefault();
                          const status = await trigger();
                          if (status === 'already_running') {
                            toast.info('Prediction pipeline is already running');
                          } else if (status === 'triggered') {
                            toast.success('Prediction pipeline started');
                          } else if (status === 'error' || !status) {
                            toast.error('Failed to trigger prediction pipeline');
                          } else {
                            toast.success('Prediction pipeline started');
                          }
                        }}
                        className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                      >
                        <Search className="h-6! w-6!" strokeWidth={1.25} />
                        <span className="text-xs text-center">Predict</span>
                      </DropdownMenu.Item>
                    </div>
                  </div>
                </DropdownMenu.Content>
              </DropdownMenu>
            </div>
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

      <AddPersonModal open={isAddPersonModalOpen} onClose={closeAddPersonModal} />

      <AddConceptModal open={isAddConceptModalOpen} onClose={closeAddConceptModal} />

      <InventoryItemModal open={isItemModalOpen} onClose={closeItemModal} item={null} create={true} />
    </>
  );
}
