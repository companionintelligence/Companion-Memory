import { Suspense, lazy, useState, type PointerEvent } from 'react';

import { useApolloClient } from '@apollo/client';
import { useDeviceLayout } from '@ci/common';
import { DropdownMenu, IconButton, Tooltip, useToast } from '@ci/shadcn';
import {
  NotebookPen,
  Upload,
  Camera,
  Plus,
  Cable,
  Search,
  User,
  Lightbulb,
  Package,
  CalendarPlus,
  MapPin,
  ScanBarcode,
} from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { useUploadFile, useTriggerHbpe } from '@/api';
import { MenuShield } from '@/components/MenuShield';
import { AddEventModal, AddPersonModal, AddPlaceModal } from '@/components/modals/AddItemModal';
import { AddConceptModal } from '@/components/modals/AddItemModal/AddConceptModal.tsx';
import { CaptureModal } from '@/components/modals/CaptureModal';
import { ScanBarcodeModal } from '@/components/modals/ScanBarcodeModal';
import { ThingModal } from '@/components/modals/ThingModal';
import { useModalControls } from '@/hooks';

/** Loaded when the dialog is first opened — see the mount site below. */
const UploadModal = lazy(() =>
  import('@/components/modals/UploadModal').then((m) => ({ default: m.UploadModal })),
);

/**
 * Primary Add control: plus button, grid menu, and the modals it opens.
 * Shared by the desktop header and the phone top bar.
 */
export function AddMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [, { trigger }] = useTriggerHbpe();
  const client = useApolloClient();
  // Modal on a phone: a modal menu swallows the tap that closes it, so tapping
  // away cannot also press whatever was under the finger — a map control, a
  // list row. Desktop keeps the non-modal menu (no scroll lock, no scrollbar
  // jump), the same split the Memory filter menus make.
  const { isMobile } = useDeviceLayout();
  const [menuOpen, setMenuOpen] = useState(false);

  const [{ isOpen: isCaptureModalOpen }, { open: openCaptureModal, close: closeCaptureModal }] =
    useModalControls();
  const [{ isOpen: isUploadModalOpen }, { open: openUploadModal, close: closeUploadModal }] =
    useModalControls();
  const [{ isOpen: isAddPersonModalOpen }, { open: openAddPersonModal, close: closeAddPersonModal }] =
    useModalControls();
  const [{ isOpen: isAddConceptModalOpen }, { open: openAddConceptModal, close: closeAddConceptModal }] =
    useModalControls();
  const [{ isOpen: isItemModalOpen }, { open: openItemModal, close: closeItemModal }] = useModalControls();
  const [{ isOpen: isAddEventModalOpen }, { open: openAddEventModal, close: closeAddEventModal }] =
    useModalControls();
  const [{ isOpen: isAddPlaceModalOpen }, { open: openAddPlaceModal, close: closeAddPlaceModal }] =
    useModalControls();
  const [{ isOpen: isScanModalOpen }, { open: openScanModal, close: closeScanModal }] = useModalControls();

  const [, { upload, reset: resetUploader }] = useUploadFile();

  // Choosing an entry closes the menu and opens its form in the same click, and
  // the form's dialog then slides under the pointer. Radix reads that as the
  // pointer leaving the item and focuses the closing menu, which takes focus
  // off the field the form had just focused (`autoFocus`), and the dialog has
  // nothing to return it to: Person, Place, Event and Scan opened with nothing
  // focused. Once the menu is closed, a pointer leaving an item is not a reason
  // to move focus anywhere.
  const keepFormFocus = (event: PointerEvent<HTMLDivElement>) => {
    if (!menuOpen) {
      event.preventDefault();
    }
  };

  const overlayOpen =
    isCaptureModalOpen ||
    isUploadModalOpen ||
    isAddPersonModalOpen ||
    isAddConceptModalOpen ||
    isItemModalOpen ||
    isAddEventModalOpen ||
    isAddPlaceModalOpen ||
    isScanModalOpen;

  const handleUpload = (files: FileList) => {
    return upload(Array.from(files));
  };

  return (
    <>
      <div className="flex items-center">
        <DropdownMenu modal={isMobile === true} open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <IconButton variant="default" size="icon-lg" label={t('NAV_ADD')} hideTooltip={overlayOpen}>
              <Plus strokeWidth={2} className="h-5 w-5" />
            </IconButton>
          </DropdownMenu.Trigger>
          <MenuShield open={menuOpen} />
          <DropdownMenu.Content className="rounded-lg p-2" side="bottom" align="end" sideOffset={4}>
            <div className="text-center text-sm font-semibold mb-3 mt-1">Add</div>
            {/* Each grid label is a single word, so the tooltip describes what the
                entry actually does rather than repeating it. `side` points the bubble
                out of the menu instead of over the neighbouring row, and
                pointer-events-none keeps it from stealing hover from the items.
                DropdownMenu.Item styles on data-[highlighted]/data-[disabled], never
                data-state, so it is safe as the direct child of Tooltip.Trigger. */}
            <Tooltip.Provider>
              <div className="grid grid-cols-4 gap-2">
                <Tooltip delayDuration={600}>
                  <Tooltip.Content side="top" className="pointer-events-none">
                    {t('NAV_ADD_NOTE')}
                  </Tooltip.Content>
                  <Tooltip.Trigger asChild>
                    <DropdownMenu.Item
                      onPointerLeave={keepFormFocus}
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
                      onPointerLeave={keepFormFocus}
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
                      onPointerLeave={keepFormFocus}
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
                    {t('NAV_ADD_THING')}
                  </Tooltip.Content>
                  <Tooltip.Trigger asChild>
                    <DropdownMenu.Item
                      onPointerLeave={keepFormFocus}
                      onSelect={openItemModal}
                      className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                    >
                      <Package className="h-6! w-6!" strokeWidth={1.25} />
                      <span className="text-xs text-center">Thing</span>
                    </DropdownMenu.Item>
                  </Tooltip.Trigger>
                </Tooltip>

                <Tooltip delayDuration={600}>
                  <Tooltip.Content side="top" className="pointer-events-none">
                    {t('NAV_ADD_EVENT')}
                  </Tooltip.Content>
                  <Tooltip.Trigger asChild>
                    <DropdownMenu.Item
                      onPointerLeave={keepFormFocus}
                      onSelect={openAddEventModal}
                      className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                    >
                      <CalendarPlus className="h-6! w-6!" strokeWidth={1.25} />
                      <span className="text-xs text-center">Event</span>
                    </DropdownMenu.Item>
                  </Tooltip.Trigger>
                </Tooltip>

                <Tooltip delayDuration={600}>
                  <Tooltip.Content side="top" className="pointer-events-none">
                    {t('NAV_ADD_PLACE')}
                  </Tooltip.Content>
                  <Tooltip.Trigger asChild>
                    <DropdownMenu.Item
                      onPointerLeave={keepFormFocus}
                      onSelect={openAddPlaceModal}
                      className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                    >
                      <MapPin className="h-6! w-6!" strokeWidth={1.25} />
                      <span className="text-xs text-center">Place</span>
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
                        onPointerLeave={keepFormFocus}
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
                        onPointerLeave={keepFormFocus}
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
                      {t('NAV_ACTION_SCAN')}
                    </Tooltip.Content>
                    <Tooltip.Trigger asChild>
                      <DropdownMenu.Item
                        onPointerLeave={keepFormFocus}
                        onSelect={openScanModal}
                        className="h-16 w-16 flex flex-col items-center justify-center cursor-pointer rounded-md p-1"
                      >
                        <ScanBarcode className="h-6! w-6!" strokeWidth={1.25} />
                        <span className="text-xs text-center">Scan</span>
                      </DropdownMenu.Item>
                    </Tooltip.Trigger>
                  </Tooltip>

                  <Tooltip delayDuration={600}>
                    <Tooltip.Content side="bottom" className="pointer-events-none">
                      {t('NAV_ACTION_CONNECT')}
                    </Tooltip.Content>
                    <Tooltip.Trigger asChild>
                      <DropdownMenu.Item
                        onPointerLeave={keepFormFocus}
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
                        onPointerLeave={keepFormFocus}
                        onSelect={async (e) => {
                          e.preventDefault();
                          const status = await trigger();
                          if (status === 'already_running') {
                            toast.info('Prediction pipeline is already running');
                          } else if (status === 'disabled') {
                            // `ForecastResolver.triggerHbpe` returns this literal
                            // when the `hbpe` flag is off. It used to fall into
                            // the unconditional `else` below and report success,
                            // so on an appliance with HBPE turned off this told
                            // the owner a one-hour pipeline was running and to
                            // watch Forecast. Nothing was enqueued, Forecast
                            // never changes, and they wait an hour to find out.
                            toast.info('Prediction is turned off on this Companion.');
                          } else if (status === 'triggered') {
                            // Deliberately does not name Forecast: `forecast.page`
                            // ships false, so on a stock appliance /forecast is not
                            // a registered route and "Watch Forecast" sent the owner
                            // to a 404. Wording that holds either way beats making
                            // this toast read the flag.
                            toast.success('Prediction started — this can take about an hour.');
                          } else if (status === 'error' || !status) {
                            toast.error('Failed to trigger prediction pipeline');
                          } else {
                            toast.success('Prediction started — this can take about an hour.');
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
            </Tooltip.Provider>
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>

      {/* Same reasoning as CaptureModal below, plus a bundle cost: UploadModal
          calls `useDropzone` unconditionally in its body, so an always-mounted
          copy ran that hook on every authenticated page load AND pulled
          react-dropzone + file-selector (~63 KB) into the chunk served before
          first paint. AddMenu sits in the desktop header and the phone top bar,
          so everyone paid for a dialog nobody had opened. */}
      {isUploadModalOpen && (
        <Suspense fallback={null}>
          <UploadModal
            open
            onClose={() => {
              resetUploader();
              closeUploadModal();
            }}
            onSubmit={handleUpload}
          />
        </Suspense>
      )}

      {/* Rendered conditionally, not merely `open={false}`. `open` guards the
          modal's OUTPUT, not its hooks: DesktopCaptureModal mounts
          `useChatRequester` and runs a vision-capability effect that fetches
          /api/llm/models/capabilities as soon as it exists. AddMenu is in the
          desktop header AND the phone top bar, so every authenticated page load
          was paying for a dialog nobody opened — and repeating it whenever the
          selected model changed. SecondaryNavigation already does it this way. */}
      {isCaptureModalOpen && (
        <CaptureModal
          open
          onClose={() => {
            resetUploader();
            closeCaptureModal();
          }}
        />
      )}

      <AddPersonModal open={isAddPersonModalOpen} onClose={closeAddPersonModal} />

      {/* The Memory explorer used to carry its own "New event" button, which
          passed the page's `refetch` straight in. That button is gone — this
          entry is the only way to create an event now — so the refresh has to
          happen from here. It cannot reuse that `refetch`: AddMenu renders in
          the layout header, ABOVE `EntityServiceProvider` (mounted in
          MemoryPage), so `useOptionalEntityService` is null here on every page.

          Hence the same eviction the Thing modal below uses: the explorer reads
          a `search` connection the server composes per query, and the map reads
          `mapPins`, so neither has a cache entry a new event could be appended
          to. Evicting the two root fields and letting `refetchQueries` re-run
          whichever were active keeps the nav from having to know which surface
          the user is looking at. */}
      <AddEventModal
        open={isAddEventModalOpen}
        onClose={closeAddEventModal}
        onCreated={() =>
          client.refetchQueries({
            updateCache: (cache) => {
              cache.evict({ id: 'ROOT_QUERY', fieldName: 'search' });
              cache.evict({ id: 'ROOT_QUERY', fieldName: 'mapPins' });
              cache.gc();
            },
          })
        }
      />
      <AddPlaceModal open={isAddPlaceModalOpen} onClose={closeAddPlaceModal} />

      <AddConceptModal open={isAddConceptModalOpen} onClose={closeAddConceptModal} />

      {/* Unlike the modals above, this one MUST refresh: a thing created here
          used to be spliced into every cached `items` field by the modal's own
          `cache.modify`, and without a replacement it stays invisible until a
          manual reload — on the Things browse the user was just looking at.
          Evicting the root `items` field rather than naming the queries keeps
          the nav from having to know which pages list things; `refetchQueries`
          re-runs exactly the active ones the eviction touched. */}
      <ThingModal
        open={isItemModalOpen}
        onClose={closeItemModal}
        item={null}
        create={true}
        onSaved={() =>
          client.refetchQueries({
            updateCache: (cache) => {
              cache.evict({ id: 'ROOT_QUERY', fieldName: 'items' });
              cache.gc();
            },
          })
        }
      />

      <ScanBarcodeModal open={isScanModalOpen} onClose={closeScanModal} />
    </>
  );
}
