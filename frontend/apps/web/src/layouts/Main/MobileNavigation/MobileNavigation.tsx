import { type MouseEvent, useCallback } from 'react';

import { Portal } from '@ci/common';
import { Camera, Inbox, MonitorCog, Search, type LucideIcon } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import logo from '@/assets/logo.svg';
import { CaptureModal } from '@/components/modals/CaptureModal';
import { useCaptureModal } from '@/hooks';

export function MobileNavigation() {
  const [{ isOpen }, { open, close }] = useCaptureModal();

  const handleCaptureClick = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      open();
    },
    [open],
  );

  return (
    <>
      {isOpen && (
        <Portal.Slot id="content-modal">
          <CaptureModal open onClose={close} />
        </Portal.Slot>
      )}

      <div className="flex flex-col border-t bg-secondary pb-[env(safe-area-inset-bottom)]">
        <div className="flex flex-row items-center justify-between">
          <NavButton to="/feed" icon={Inbox} label="Feed" />
          <NavButton to="/search" icon={Search} label="Search" />
          <Link
            to="/chat"
            aria-label="Chat"
            className="flex self-stretch p-2 px-4 items-center justify-center"
          >
            <img src={logo} alt="" className="h-12 w-12" />
          </Link>
          <NavButton icon={Camera} label="Capture" onClick={handleCaptureClick} />
          <NavButton to="/system" icon={MonitorCog} label="System" />
        </div>
      </div>
    </>
  );
}

interface NavButtonProps {
  to?: string;
  icon: LucideIcon;
  label: string;
  onClick?: (e: MouseEvent) => void;
}

export function NavButton({ to, icon: Icon, label, onClick }: NavButtonProps) {
  return (
    <Link
      to={to ?? ''}
      className="flex flex-1 flex-col gap-0.5 justify-center items-center p-4 select-none"
      onClick={onClick}
    >
      <Icon className="h-6 w-6" strokeWidth={1} />
      <span className="text-xxs">{label}</span>
    </Link>
  );
}
