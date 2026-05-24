import { useMemo } from 'react';

import { GlobalUID } from '@ci/common';
import { Avatar, DropdownMenu } from '@ci/shadcn';
import {
  BadgeQuestionMark,
  ListTodo,
  LogOut,
  SunMoon,
  Settings2,
  Cable,
  Palette,
  ChartPie,
} from '@ci/shadcn/icons';
import { Link, useLocation } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { useTheme, ColorPicker } from '@/components/ThemePicker';
import { useAuth, useCurrentUser } from '@/hooks';

export function NavUser() {
  const [, { logout }] = useAuth();
  const { user } = useCurrentUser();
  const { themeState, setTheme } = useTheme();
  const location = useLocation();

  const { isFeatureEnabled } = useFeatures();

  const currentUser = useMemo(
    () => ({
      name: user?.name || user?.email || 'User',
      email: user?.email || '',
      onboarded: user?.onboarded || false,
      avatar: '/avatars/shadcn.jpg',
    }),
    [user],
  );

  const initials = useMemo(() => {
    const parts = currentUser.name.trim().split(/\s+/);

    const first = parts[0][0] ?? '';
    const last = parts.length > 1 ? parts[parts.length - 1][0] : '';

    return (first + last).toUpperCase();
  }, [currentUser]);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger asChild>
        <Avatar className="h-9 w-9 rounded-full select-none cursor-pointer">
          <Avatar.Image src={currentUser.avatar} alt={currentUser.name} />
          <Avatar.Fallback>{initials}</Avatar.Fallback>
        </Avatar>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content className="min-w-56 rounded-lg" side="bottom" align="end" sideOffset={4}>
        <DropdownMenu.Group>
          <DropdownMenu.Label className="p-0 font-normal select-none">
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
        </DropdownMenu.Group>

        <DropdownMenu.Separator />

        <DropdownMenu.Group>
          <DropdownMenu.Item asChild>
            <Link to={`/people/${user?.entity?.id ? GlobalUID.parse('person', user.entity.id) : ''}`}>
              <ChartPie />
              Knowledge
            </Link>
          </DropdownMenu.Item>

          {isFeatureEnabled('new.insights.page') && (
            <DropdownMenu.Item asChild>
              <Link to="/prompts">
                <BadgeQuestionMark />
                Prompts
              </Link>
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Group>

        <DropdownMenu.Separator />

        <DropdownMenu.Group>
          <DropdownMenu.Item asChild>
            <Link to="/settings/appearance" state={{ backgroundLocation: location }}>
              <Settings2 />
              Settings
            </Link>
          </DropdownMenu.Item>

          <DropdownMenu.Item asChild>
            <Link to="/connections">
              <Cable />
              Connections
            </Link>
          </DropdownMenu.Item>

          <DropdownMenu.Item asChild>
            <Link to="/jobs">
              <ListTodo />
              Jobs
            </Link>
          </DropdownMenu.Item>
        </DropdownMenu.Group>

        <DropdownMenu.Separator />

        <DropdownMenu.Group>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger>
              <SunMoon />
              Theme
            </DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent>
              <DropdownMenu.RadioGroup
                value={themeState.mode}
                onValueChange={(value: string) => setTheme(value as 'light' | 'dark' | 'system')}
              >
                <DropdownMenu.RadioItem value="light">Light</DropdownMenu.RadioItem>
                <DropdownMenu.RadioItem value="dark">Dark</DropdownMenu.RadioItem>
                <DropdownMenu.RadioItem value="system">System</DropdownMenu.RadioItem>
              </DropdownMenu.RadioGroup>
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>

          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger>
              <Palette />
              Colors
            </DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent className="w-[400px] p-2 pb-0">
              <ColorPicker />
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
        </DropdownMenu.Group>

        <DropdownMenu.Separator />

        <DropdownMenu.Item onClick={logout}>
          <LogOut />
          Log out
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
