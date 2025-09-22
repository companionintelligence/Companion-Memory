import { Portal } from '@ci/common';
import { Button, Separator, Sidebar } from '@ci/shadcn';
import { Plus } from '@ci/shadcn/icons';

import { CaptureModalToggle } from '@/components/CaptureModalToggle';
import { AddMemoryModal } from '@/components/modals/AddMemoryModal';
import { CaptureModal } from '@/components/modals/CaptureModal';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useModalControls, useAddMemoryModal } from '@/hooks';

export function PrimaryNavigation() {
  const [{ isOpen: isModalOpen }, { open: openModal, close: closeModal }] = useModalControls();
  const [{ isOpen: isAddMemoryModalOpen }, { open: openAddMemoryModal, close: closeAddMemoryModal }] =
    useAddMemoryModal();

  return (
    <>
      <header className="flex flex-row items-center justify-between pl-2 pr-4 py-2 border-b">
        <section className="flex flex-row items-center">
          <Sidebar.Trigger />
          <Separator orientation="vertical" className="ml-2 mr-3 data-[orientation=vertical]:h-5" />
          <Portal id="breadcrumbs" />
        </section>

        <section className="flex flex-row items-center gap-2">
          <Portal id="actions" className="flex flex-row items-center" />

          <div className="flex flex-row items-center gap-2">
            <Button variant="ghost" size="icon" onClick={openAddMemoryModal} title="Add Memory">
              <Plus className="h-5 w-5" />
            </Button>
            <CaptureModalToggle openModal={openModal} />
            <ThemeToggle />
          </div>
        </section>
      </header>
      <CaptureModal open={isModalOpen} initialFiles={[]} onClose={closeModal} />
      <AddMemoryModal open={isAddMemoryModalOpen} onClose={closeAddMemoryModal} />
    </>
  );
}
