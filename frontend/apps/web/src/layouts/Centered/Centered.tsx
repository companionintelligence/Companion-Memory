import { Outlet } from 'react-router-dom';

import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { ThemeToggle } from '@/components/ThemePicker';

export function Centered() {
  return (
    <div className="safe-area-inset flex min-h-dvh w-full flex-col overflow-y-auto px-6 pb-6 md:px-10 md:pb-10">
      <div className="flex justify-end">
        <ThemeToggle />
      </div>
      <div className="flex flex-1 flex-col items-stretch justify-start sm:items-center sm:justify-center">
        {/* Login, device-connect and server settings render here, outside the
            app shell — a throw on any of them has no other boundary above it,
            and these are the screens a locked-out user needs most. */}
        <AppErrorBoundary>
          <Outlet />
        </AppErrorBoundary>
      </div>
    </div>
  );
}
