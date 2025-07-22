import { useMemo } from 'react';

import { Avatar, DropdownMenu, Sidebar, useSidebar } from '@ci/shadcn';
import { BadgeCheck, Bell, ChevronsUpDown, CreditCard, LogOut, Settings2, Sparkles } from '@ci/shadcn/icons';

import { useAuth } from '@/hooks';

export function NavUser() {
  const { isMobile } = useSidebar();
  const [{ user }, { logout }] = useAuth();

  const currentUser = useMemo(
    () => ({
      name: user?.name || user?.email || 'User',
      email: user?.email || '',
      avatar: '/avatars/shadcn.jpg',
    }),
    ['user'],
  );

  const initials = useMemo(() => {
    const parts = currentUser.name.trim().split(/\s+/);

    const first = parts[0][0] ?? '';
    const last = parts.length > 1 ? parts[parts.length - 1][0] : '';

    return (first + last || 'JD').toUpperCase();
  }, [currentUser]);

  return (
    <Sidebar.Menu>
      <Sidebar.MenuItem>
        <DropdownMenu>
          <DropdownMenu.Trigger asChild>
            <Sidebar.MenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="h-8 w-8 rounded-lg">
                <Avatar.Image src={currentUser.avatar} alt={currentUser.name} />
                <Avatar.Fallback className="rounded-lg">{initials}</Avatar.Fallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{currentUser.name}</span>
                <span className="truncate text-xs">{currentUser.email}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </Sidebar.MenuButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenu.Label className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="h-8 w-8 rounded-lg">
                  <Avatar.Image src={currentUser.avatar} alt={currentUser.name} />
                  <Avatar.Fallback className="rounded-lg">{initials}</Avatar.Fallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{currentUser.name}</span>
                  <span className="truncate text-xs">{currentUser.email}</span>
                </div>
              </div>
            </DropdownMenu.Label>
            <DropdownMenu.Separator />
            <DropdownMenu.Group>
              <DropdownMenu.Item>
                <Sparkles />
                Upgrade to Pro
              </DropdownMenu.Item>
            </DropdownMenu.Group>
            <DropdownMenu.Separator />
            <DropdownMenu.Group>
              <DropdownMenu.Item>
                <BadgeCheck />
                Account
              </DropdownMenu.Item>
              <DropdownMenu.Item>
                <Settings2 />
                Settings
              </DropdownMenu.Item>
              <DropdownMenu.Item>
                <CreditCard />
                Billing
              </DropdownMenu.Item>
              <DropdownMenu.Item>
                <Bell />
                Notifications
              </DropdownMenu.Item>
            </DropdownMenu.Group>
            <DropdownMenu.Separator />
            <DropdownMenu.Item onClick={logout}>
              <LogOut />
              Log out
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
  );
}
