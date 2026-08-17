import { useMemo, type ReactNode } from 'react';

import { Avatar, Popover, Tooltip, cn } from '@ci/shadcn';
import { LogOut, Palette, Settings2, SunMoon } from '@ci/shadcn/icons';
import { Link, useLocation } from 'react-router-dom';

import { ColorPicker, useTheme } from '@/components/ThemePicker';
import { useAuth, useCurrentUser } from '@/hooks';

import { usePowerRail } from '../PowerRailContext';

const THEME_MODES = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Auto' },
] as const;

/**
 * The account, as part of the rail rather than a menu over it.
 *
 * Settings, Theme, Colours and Log out used to live in a dropdown behind the
 * avatar — a second navigation surface, opening in a different direction, for
 * destinations no different in kind from the ones already listed above it. They
 * are rail rows now, so everywhere you can go is in one list, and the rail is
 * the only thing that has to be open to see any of it.
 *
 * Collapsed, each row is its own icon with a tooltip, exactly as the links
 * above behave; nothing is reachable only by expanding first.
 */
export function NavUser() {
  const { expanded } = usePowerRail();
  const [, { logout }] = useAuth();
  const { user } = useCurrentUser();
  const { themeState, setTheme } = useTheme();
  const location = useLocation();

  const currentUser = useMemo(
    () => ({
      name: user?.name || user?.email || 'User',
      email: user?.email || '',
      avatar: '/avatars/shadcn.jpg',
    }),
    [user],
  );

  const initials = useMemo(() => {
    const parts = currentUser.name.trim().split(/\s+/);
    const first = parts[0]?.[0] ?? '';
    const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';

    return (first + last).toUpperCase();
  }, [currentUser]);

  return (
    <div className="flex flex-col gap-1">
      {/* Identity, not a control: it opens nothing now that its menu is the
          list below it. */}
      <div
        className={cn(
          'flex items-center gap-2 rounded-md select-none',
          expanded ? 'px-2 py-1.5' : 'justify-center p-1',
        )}
      >
        <Avatar className="h-8 w-8 shrink-0 rounded-full">
          <Avatar.Image src={currentUser.avatar} alt="" />
          <Avatar.Fallback className="text-xs">{initials}</Avatar.Fallback>
        </Avatar>
        {expanded && (
          <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{currentUser.name}</span>
            <span className="truncate text-xs text-muted-foreground">{currentUser.email}</span>
          </div>
        )}
      </div>

      {/* `backgroundLocation` keeps Settings an overlay over the page you were
          on, which is what it has always been. */}
      <RailRow
        icon={<Settings2 className="h-6 w-6 shrink-0" strokeWidth={1.25} />}
        label="Settings"
        to="/settings/appearance"
        state={{ backgroundLocation: location }}
      />

      <ThemeRow mode={themeState.mode} onChange={setTheme} expanded={expanded} />

      <Popover>
        <Popover.Trigger asChild>
          <RailRow icon={<Palette className="h-6 w-6 shrink-0" strokeWidth={1.25} />} label="Colours" />
        </Popover.Trigger>
        <Popover.Content side="right" align="end" className="w-[400px] p-2 pb-0">
          <ColorPicker />
        </Popover.Content>
      </Popover>

      {/* Plain English, like every other rail label ("Feed", "Settings") —
          the rail does not route its labels through i18n. */}
      <RailRow
        icon={<LogOut className="h-6 w-6 shrink-0" strokeWidth={1.25} />}
        label="Log out"
        onClick={logout}
      />
    </div>
  );
}

interface RailRowProps {
  icon: ReactNode;
  label: string;
  /** A destination makes the row a link; otherwise it is a button. */
  to?: string;
  state?: unknown;
  onClick?: () => void;
}

/**
 * One row of the account group, shaped like the rail's own links.
 *
 * Same geometry as `NavLink` — icon-only and tooltipped when collapsed, icon
 * plus label when expanded — so the account group does not read as a different
 * kind of thing bolted to the bottom.
 */
function RailRow({ icon, label, to, state, onClick }: RailRowProps) {
  const { expanded } = usePowerRail();

  const className = cn(
    'relative flex w-full cursor-pointer items-center rounded-md border-l-2 border-transparent text-left transition will-change-transform hover:bg-accent hover:text-accent-foreground active:scale-95',
    expanded ? 'gap-3 px-2 py-2' : 'justify-center p-2',
  );

  const content = (
    <>
      {icon}
      {expanded && <span className="truncate text-sm">{label}</span>}
    </>
  );

  const row =
    to != null ? (
      <Link to={to} state={state} aria-label={label} className={className}>
        {content}
      </Link>
    ) : (
      <button type="button" onClick={onClick} aria-label={label} className={className}>
        {content}
      </button>
    );

  if (expanded) {
    return row;
  }

  return (
    <Tooltip delayDuration={600}>
      <Tooltip.Trigger asChild>{row}</Tooltip.Trigger>
      <Tooltip.Content side="right">{label}</Tooltip.Content>
    </Tooltip>
  );
}

/**
 * Theme as three visible choices rather than a submenu.
 *
 * A submenu hid which mode was active behind a hover, for a setting with three
 * options. Collapsed there is no room for a segmented control, so the row falls
 * back to a single icon that cycles — still one click per change, still no
 * hidden state once the rail is open.
 */
function ThemeRow({
  mode,
  onChange,
  expanded,
}: {
  mode: string;
  onChange: (mode: 'light' | 'dark' | 'system') => void;
  expanded: boolean;
}) {
  if (!expanded) {
    const next = () => {
      const index = THEME_MODES.findIndex((entry) => entry.value === mode);

      onChange(THEME_MODES[(index + 1) % THEME_MODES.length]!.value);
    };

    return (
      <Tooltip delayDuration={600}>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            onClick={next}
            aria-label={`Theme: ${mode}. Change theme.`}
            className="relative flex w-full cursor-pointer items-center justify-center rounded-md border-l-2 border-transparent p-2 transition hover:bg-accent hover:text-accent-foreground active:scale-95"
          >
            <SunMoon className="h-6 w-6 shrink-0" strokeWidth={1.25} />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Content side="right">Theme</Tooltip.Content>
      </Tooltip>
    );
  }

  return (
    <div className="px-2 py-1">
      <div role="radiogroup" aria-label="Theme" className="flex gap-1 rounded-md bg-muted p-1 text-xs">
        {THEME_MODES.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="radio"
            aria-checked={mode === entry.value}
            onClick={() => onChange(entry.value)}
            className={cn(
              'flex-1 cursor-pointer rounded-sm px-2 py-1 transition-colors',
              mode === entry.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>
    </div>
  );
}
