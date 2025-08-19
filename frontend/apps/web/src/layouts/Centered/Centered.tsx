import { Outlet } from 'react-router-dom';

import { ThemeToggle } from '../../components/ThemeToggle';

export function Centered() {
  return (
    <div className="relative flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <Outlet />
    </div>
  );
}
