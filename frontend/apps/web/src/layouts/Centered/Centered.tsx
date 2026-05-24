import { Outlet } from 'react-router-dom';

import { ThemeToggle } from '@/components/ThemePicker';

export function Centered() {
  return (
    <div className="relative flex w-full h-lvh items-center justify-center p-6 md:p-10">
      <div className="absolute top-0 left-0 h-[max(0.5rem,env(safe-area-inset-top))] w-full">
        <div className="absolute top-full right-2 z-10">
          <ThemeToggle />
        </div>
      </div>
      <Outlet />
    </div>
  );
}
