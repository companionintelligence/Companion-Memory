import { Outlet } from 'react-router-dom';

import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { ThemeToggle } from '@/components/ThemePicker';

export function Centered() {
  return (
    // `h-dvh`, not `min-h-dvh`: the app pins the body (usePreventOverscroll), so this column is the
    // only thing that can scroll. Allowed to grow past the window, it never did, and a form taller
    // than a short window (sign-up at 125% text size) lost its last buttons below the edge.
    <div className="safe-area-inset flex h-dvh w-full flex-col overflow-y-auto px-6 pb-6 md:px-10 md:pb-10">
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
