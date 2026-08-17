import { useCallback, useEffect, useRef, useState } from 'react';

import { Portal } from '@ci/common';
import { DropdownMenu, IconButton, Separator, Tooltip, useToast } from '@ci/shadcn';
import { NotebookPen, Upload, Camera, Plus, Cable, Search, User, Lightbulb, Package } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { useUploadFile, useTriggerHbpe } from '@/api';
import { ConnectionModeIndicator, OutboxQueueIndicator } from '@/components/ConnectionModeIndicator';
import { AddPersonModal } from '@/components/modals/AddItemModal';
import { AddConceptModal } from '@/components/modals/AddItemModal/AddConceptModal.tsx';
import { CaptureModal } from '@/components/modals/CaptureModal';
import { InventoryItemModal } from '@/components/modals/InventoryItemModal';
import { UploadModal } from '@/components/modals/UploadModal';
import { GlobalSearchBox } from '@/components/SearchBox';
import { useModalControls } from '@/hooks';

export function PrimaryNavigation() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  // The global search box searches the VIEWER's own memory. On a shared-search
  // page the body shows someone else's results, so the prominent search would be
  // misleading (and navigate the viewer away). Hide it there; the page's own view
  // tabs (nav-views) still render.
  const isSharedView = location.pathname.startsWith('/shared/');
  const isMemoryExplorer = location.pathname === '/memory';
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
      <header className="flex flex-row items-center gap-2 p-2 px-4">
        {/* Memory explorer: search left (no breadcrumb); view tabs after search.
            Other pages: breadcrumb + nav-views, then search fills remaining width. */}
        <div className="relative flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:items-center md:gap-3">
          {isMemoryExplorer ? (
            <>
              {!isSharedView && (
                <div className="w-full min-w-0 flex-1">
                  <GlobalSearchBox />
                </div>
              )}
              <Portal id="nav-views" className="flex shrink-0 flex-row items-center empty:hidden" />
            </>
          ) : (
            <>
              <div className="flex min-w-0 shrink-0 flex-row flex-wrap items-center gap-2">
                <Portal id="nav-views" className="flex flex-row items-center empty:hidden" />
              </div>
              {!isSharedView && (
                <div className="w-full min-w-0 flex-1">
                  <GlobalSearchBox />
                </div>
              )}
            </>
          )}
        </div>

        {/* Right: status chips, page actions, and the primary Add control.
            Account/settings live in the left rail now. The chips sit in the
            header's flow rather than in a fixed overlay: an overlay pinned to
            the viewport's top-right lands on top of this cluster and covers
            the add button (only the mobile layout, which has no header,
            positions them that way). */}
        <div className="flex shrink-0 flex-row items-center gap-2">
          <div className="flex flex-row items-center gap-1.5 empty:hidden">
            <ConnectionModeIndicator />
            <OutboxQueueIndicator />
          </div>

          <Portal ref={actionsRef} id="actions" className="flex flex-row items-center empty:hidden" />

          {hasActions && <Separator orientation="vertical" className="data-[orientation=vertical]:h-6" />}

          <div className="flex items-center">
            <DropdownMenu modal={false}>
              <DropdownMenu.Trigger asChild>
                <IconButton variant="default" size="icon-lg" label={t('NAV_ADD')}>
                  <Plus strokeWidth={2} className="h-5 w-5" />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content className="rounded-lg p-2" side="bottom" align="end" sideOffset={4}>
                <div className="text-center text-sm font-semibold mb-3 mt-1">Add</div>
                {/* Each grid label is a single word, so the tooltip describes what the
                    entry actually does rather than repeating it. `side` points the bubble
                    out of the menu instead of over the neighbouring row, and
                    pointer-events-none keeps it from stealing hover from the items.
                    DropdownMenu.Item styles on data-[highlighted]/data-[disabled], never
                    data-state, so it is safe as the direct child of Tooltip.Trigger. */}
                <div className="grid grid-cols-4 gap-2">
                  <Tooltip delayDuration={600}>
                    <Tooltip.Content side="top" className="pointer-events-none">
                      {t('NAV_ADD_NOTE')}
                    </Tooltip.Content>
                    <Tooltip.Trigger asChild>
                      <DropdownMenu.Item
                        onSelect={() => navigate('/notes/new')}
                        className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                      >
                        <NotebookPen className="h-6! w-6!" strokeWidth={1.25} />
                        <span className="text-xs">Note</span>
                      </DropdownMenu.Item>
                    </Tooltip.Trigger>
                  </Tooltip>

                  <Tooltip delayDuration={600}>
                    <Tooltip.Content side="top" className="pointer-events-none">
                      {t('NAV_ADD_PERSON')}
                    </Tooltip.Content>
                    <Tooltip.Trigger asChild>
                      <DropdownMenu.Item
                        onSelect={openAddPersonModal}
                        className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                      >
                        <User className="h-6! w-6!" strokeWidth={1.25} />
                        <span className="text-xs text-center">Person</span>
                      </DropdownMenu.Item>
                    </Tooltip.Trigger>
                  </Tooltip>

                  <Tooltip delayDuration={600}>
                    <Tooltip.Content side="top" className="pointer-events-none">
                      {t('NAV_ADD_CONCEPT')}
                    </Tooltip.Content>
                    <Tooltip.Trigger asChild>
                      <DropdownMenu.Item
                        onSelect={openAddConceptModal}
                        className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                      >
                        <Lightbulb className="h-6! w-6!" strokeWidth={1.25} />
                        <span className="text-xs text-center">Concept</span>
                      </DropdownMenu.Item>
                    </Tooltip.Trigger>
                  </Tooltip>

                  <Tooltip delayDuration={600}>
                    <Tooltip.Content side="top" className="pointer-events-none">
                      {t('NAV_ADD_ITEM')}
                    </Tooltip.Content>
                    <Tooltip.Trigger asChild>
                      <DropdownMenu.Item
                        onSelect={openItemModal}
                        className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                      >
                        <Package className="h-6! w-6!" strokeWidth={1.25} />
                        <span className="text-xs text-center">Item</span>
                      </DropdownMenu.Item>
                    </Tooltip.Trigger>
                  </Tooltip>
                </div>
                <div className="mt-2 -mx-2 -mb-2 bg-muted/50 p-4 rounded-b-lg">
                  <div className="text-center text-sm font-semibold mb-3">Actions</div>
                  <div className="grid grid-cols-4 gap-2">
                    <Tooltip delayDuration={600}>
                      <Tooltip.Content side="bottom" className="pointer-events-none">
                        {t('NAV_ACTION_UPLOAD')}
                      </Tooltip.Content>
                      <Tooltip.Trigger asChild>
                        <DropdownMenu.Item
                          onSelect={openUploadModal}
                          className="h-16 w-16 flex flex-col items-center justify-center gap-2 cursor-pointer rounded-md p-1"
                        >
                          <Upload className="h-6! w-6!" strokeWidth={1.25} />
                          <span className="text-xs text-center">Upload</span>
                        </DropdownMenu.Item>
                      </Tooltip.Trigger>
                    </Tooltip>

                    <Tooltip delayDuration={600}>
                      <Tooltip.Content side="bottom" className="pointer-events-none">
                        {t('NAV_ACTION_CAPTURE')}
                      </Tooltip.Content>
                      <Tooltip.Trigger asChild>
                        <DropdownMenu.Item
                          onSelect={openCaptureModal}
                          className="h-16 w-16 flex flex-col items-center justify-center gap-2 cursor-pointer rounded-md p-1"
                        >
                          <Camera className="h-6! w-6!" strokeWidth={1.25} />
                          <span className="text-xs text-center">Capture</span>
                        </DropdownMenu.Item>
                      </Tooltip.Trigger>
                    </Tooltip>

                    <Tooltip delayDuration={600}>
                      <Tooltip.Content side="bottom" className="pointer-events-none">
                        {t('NAV_ACTION_CONNECT')}
                      </Tooltip.Content>
                      <Tooltip.Trigger asChild>
                        <DropdownMenu.Item
                          onSelect={() => navigate('/sources')}
                          className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                        >
                          <Cable className="h-6! w-6!" strokeWidth={1.25} />
                          <span className="text-xs text-center">Connect</span>
                        </DropdownMenu.Item>
                      </Tooltip.Trigger>
                    </Tooltip>

                    <Tooltip delayDuration={600}>
                      <Tooltip.Content side="bottom" className="pointer-events-none">
                        {t('NAV_ACTION_PREDICT')}
                      </Tooltip.Content>
                      <Tooltip.Trigger asChild>
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
                      </Tooltip.Trigger>
                    </Tooltip>
                  </div>
                </div>
              </DropdownMenu.Content>
            </DropdownMenu>
          </div>
        </div>
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
