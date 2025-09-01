import { Outlet } from 'react-router-dom';

import { ThemeToggle } from '../../components/ThemeToggle';

export function Centered() {
  return (
    <div className="relative flex min-h-svh w-full items-center justify-center p-6 md:p-10 ios-safe-area-top ios-safe-area-bottom ios-safe-area-left ios-safe-area-right">
      <div className="absolute top-4 right-4 ios-safe-area-top ios-safe-area-right">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        <Outlet />
      </div>
    </div>
  );
}
