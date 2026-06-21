import { useCallback, useEffect, useRef, useState } from 'react';

import { useMutation } from '@apollo/client';
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
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { useUploadFile, useTriggerHbpe } from '@/api';
import { AddPersonModal } from '@/components/modals/AddItemModal';
import { AddConceptModal } from '@/components/modals/AddItemModal/AddConceptModal.tsx';
import { CaptureModal } from '@/components/modals/CaptureModal';
import { InventoryItemModal } from '@/components/modals/InventoryItemModal';
import { UploadModal } from '@/components/modals/UploadModal';
import { SearchBox } from '@/components/SearchBox';
import { gql } from '@/graphql';
import { useModalControls } from '@/hooks';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';

import { NavUser } from './NavUser';

const CREATE_SAVED_SEARCH = gql(`
  mutation CreateGlobalSavedSearch($input: CreateSavedSearchInput!) {
    createSavedSearch(input: $input) {
      savedSearch {
        id
        name
        query
        entityTypes
        tags
      }
    }
  }
`);

export function PrimaryNavigation() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const [, { trigger }] = useTriggerHbpe();

  const searchInputRef = useRef<HTMLInputElement>(null);
  const [createSavedSearch] = useMutation(CREATE_SAVED_SEARCH);

  const isOnMemory = location.pathname === '/memory';

  // Single, app-wide search: write the explorer's `search` URL param. When
  // already on /memory it updates results in place; from anywhere else it routes
  // to /memory carrying any filters already set on the current URL.
  const writeSearch = useCallback(
    (query: string) => {
      const params = new URLSearchParams(searchParams);
      const trimmed = query.trim();

      if (trimmed) {
        params.set('search', trimmed);
      } else {
        params.delete('search');
      }

      if (isOnMemory) {
        setSearchParams(params);
      } else {
        navigate(`/memory?${params.toString()}`);
      }
    },
    [searchParams, setSearchParams, isOnMemory, navigate],
  );

  const handleSearch = useCallback((data: { query: string }) => writeSearch(data.query), [writeSearch]);

  const handleClearSearch = useCallback(() => {
    if (!isOnMemory) {
      return;
    }

    const params = new URLSearchParams(searchParams);
    params.delete('search');
    setSearchParams(params);
  }, [isOnMemory, searchParams, setSearchParams]);

  const handleSaveSearch = useCallback(
    async (query: string, entityTypes: string[]) => {
      await createSavedSearch({
        variables: { input: { name: '', description: '', query, entityTypes, tags: [] } },
      });
      toast.success('Search saved');
    },
    [createSavedSearch, toast],
  );

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

  useKeyboardShortcut('/', () => searchInputRef.current?.focus());

  const handleUpload = (files: FileList) => {
    return upload(Array.from(files));
  };

  return (
    <>
      <header className="flex flex-row items-center gap-4 p-2 px-4">
        <section className="flex flex-row items-center shrink-0">
          <Portal id="breadcrumbs" />
        </section>

        <div className="flex-1 min-w-0">
          <SearchBox
            ref={searchInputRef}
            variant="compact"
            placeholder="Search your memory…"
            autoSubmit={isOnMemory}
            displayDropdown
            defaultQuery={searchParams.get('search') || ''}
            onSearch={handleSearch}
            onClear={handleClearSearch}
            onSave={handleSaveSearch}
          />
        </div>

        <section className="flex flex-row items-center gap-4 shrink-0">
          <Portal ref={actionsRef} id="actions" className="flex flex-row items-center" />

          {hasActions && <Separator orientation="vertical" className="data-[orientation=vertical]:h-6" />}

          <div className="flex flex-row items-center gap-2">
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
