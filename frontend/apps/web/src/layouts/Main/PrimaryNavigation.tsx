import { Portal } from '@ci/common';
import { Separator, Sidebar } from '@ci/shadcn';

import { CaptureModalToggle } from '@/components/CaptureModalToggle';
import { CaptureModal } from '@/components/modals/CaptureModal';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useModalControls, useDeviceLayout } from '@/hooks';

export function PrimaryNavigation() {
  const { isMobile } = useDeviceLayout();
  const [{ isOpen: isModalOpen }, { open: openModal, close: closeModal }] = useModalControls();

  return (
    <>
      <header
        className={`flex flex-row items-center justify-between ${isMobile ? 'pl-3 pr-4 py-3' : 'pl-2 pr-4 py-2'} border-b transition-all duration-300`}
      >
        <section className="flex flex-row items-center">
          <div className="transition-all duration-200 hover:scale-110 active:scale-95">
            <Sidebar.Trigger />
          </div>
          <Separator orientation="vertical" className="ml-2 mr-3 data-[orientation=vertical]:h-5" />
          <Portal id="breadcrumbs" />
        </section>

        <section className={`flex flex-row items-center ${isMobile ? 'gap-3' : 'gap-2'}`}>
          <div className="transition-all duration-200 hover:scale-110 active:scale-95">
            <CaptureModalToggle openModal={openModal} />
          </div>
          <div className="transition-all duration-200 hover:scale-110 active:scale-95">
            <ThemeToggle />
          </div>
          <Portal id="actions" />
        </section>
      </header>
      <CaptureModal open={isModalOpen} initialFiles={[]} onClose={closeModal} />
    </>
  );
}
