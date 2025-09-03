import { Portal } from '@ci/common';
import { Separator, Sidebar } from '@ci/shadcn';

import { CaptureModalToggle } from '@/components/CaptureModalToggle';
import { CaptureModal } from '@/components/modals/CaptureModal';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useModalControls } from '@/hooks';

export function PrimaryNavigation() {
  const [{ isOpen: isModalOpen }, { open: openModal, close: closeModal }] = useModalControls();

  return (
    <>
      <header className="flex flex-row items-center justify-between pl-2 pr-4 py-2 border-b">
        <section className="flex flex-row items-center">
          <Sidebar.Trigger />
          <Separator orientation="vertical" className="ml-2 mr-3 data-[orientation=vertical]:h-5" />
          <Portal id="breadcrumbs" />
        </section>

        <section className="flex flex-row items-center gap-2">
          <CaptureModalToggle openModal={openModal} />
          <ThemeToggle />
          <Portal id="actions" />
        </section>
      </header>
      <CaptureModal open={isModalOpen} initialFiles={[]} onClose={closeModal} />
    </>
  );
}
