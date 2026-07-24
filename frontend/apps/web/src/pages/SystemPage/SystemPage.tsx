import { useMemo } from 'react';

import { useDeviceLayout, usePageTitle } from '@ci/common';
import { Avatar, Button } from '@ci/shadcn';
import { Blocks, Cable, ChartPie, ListTodo, LogOut, Settings2, User } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { PageContent } from '@/components/layout';
import { ModelSelector } from '@/components/ModelSelector';
import NotFoundPage from '@/components/NotFound';
import { ThemeToggle } from '@/components/ThemePicker';
import { useAuth, useCurrentUser } from '@/hooks';

export function SystemPage() {
  usePageTitle('System - Companion Intelligence');

  const { isMobile } = useDeviceLayout();

  if (!isMobile) {
    return <NotFoundPage />;
  }

  return (
    <PageContent>
      <div className="flex flex-col gap-4 min-h-full">
        <Header />
        <div className="flex flex-col gap-4 justify-center grow">
          <Profile />
          <Navigation />
          <Logout />
        </div>
      </div>
    </PageContent>
  );
}

function Header() {
  return (
    <div className="flex gap-2 justify-end">
      <ModelSelector />
      <ThemeToggle />
    </div>
  );
}

function Profile() {
  const { user } = useCurrentUser();

  if (!user) {
    return null;
  }

  const initials = useMemo(() => {
    const parts = user.name.trim().split(/\s+/);

    const first = parts[0][0] ?? '';
    const last = parts.length > 1 ? parts[parts.length - 1][0] : '';

    return (first + last).toUpperCase();
  }, [user]);

  return (
    <div className="flex flex-row gap-2 justify-center w-full items-center">
      <Avatar className="h-8 w-8 rounded-full">
        <Avatar.Fallback className="rounded-full">{initials}</Avatar.Fallback>
      </Avatar>
      <div className="flex flex-col text-sm leading-relaxed">
        <span className="truncate font-medium">{user.name}</span>
        <span className="truncate text-xs">{user.email}</span>
      </div>
    </div>
  );
}

function Navigation() {
  const { isFeatureEnabled } = useFeatures();

  return (
    <div className="flex flex-col justify-center">
      <div className="grid grid-cols-2 gap-4 p-3">
        <Button variant="secondary" className="w-full justify-center p-6" asChild>
          {/* TODO: The profile page doesn't exist, we will eventually create one. */}
          <Link to="/system">
            <User className="h-4 w-4" />
            Profile
          </Link>
        </Button>

        <Button variant="secondary" className="w-full justify-center p-6" asChild>
          <Link to="/settings">
            <Settings2 className="h-4 w-4" />
            Settings
          </Link>
        </Button>

        <Button variant="secondary" className="w-full justify-center p-6" asChild>
          <Link to="/knowledge">
            <ChartPie className="h-4 w-4" />
            Knowledge
          </Link>
        </Button>

        {isFeatureEnabled('jobs.page') && (
          <Button variant="secondary" className="w-full justify-center p-6" asChild>
            <Link to="/jobs">
              <ListTodo className="h-4 w-4" />
              Jobs
            </Link>
          </Button>
        )}

        <Button variant="secondary" className="w-full justify-center p-6" asChild>
          <Link to="/connections">
            <Cable className="h-4 w-4" />
            Connections
          </Link>
        </Button>

        <Button variant="secondary" className="w-full justify-center p-6" asChild>
          <Link to="/plugins">
            <Blocks className="h-4 w-4" />
            Plugins
          </Link>
        </Button>
      </div>
    </div>
  );
}

function Logout() {
  const [, { logout }] = useAuth();

  return (
    <div className="flex justify-center">
      <Button variant="destructive" className="justify-center p-6" onClick={logout} asChild>
        <Link to="/">
          <LogOut className="h-4 w-4" />
          Logout
        </Link>
      </Button>
    </div>
  );
}
