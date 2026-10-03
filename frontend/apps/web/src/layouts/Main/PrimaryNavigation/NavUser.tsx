import { type ReactNode, useState } from 'react';

import { AlertDialog, Collapsible, Popover, cn } from '@ci/shadcn';
import { ChevronRight, LogOut, Palette } from '@ci/shadcn/icons';

import { ColorPicker, useTheme } from '@/components/ThemePicker';
import { useAuth } from '@/hooks';

import { usePowerRail } from '../PowerRailContext';
import {
  RAIL_CHILD_HEIGHT,
  RAIL_CHILD_INSET,
  RAIL_LEAF_HEIGHT,
  RAIL_LEAF_INSET,
  railRowTone,
} from '../SecondaryNavigation/railRow';

const THEME_MODES = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Auto' },
] as const;

/**
 * Theme and log out — nested under the Self user tile.
 *
 * Settings lives with Profile / Stats / Reflections in Self's section list
 * (see selfSections.ts), not here. Repeating it under Theme would be a
 * second path to the same place.
 */
export function NavUserMenu() {
  const [, { logout }] = useAuth();
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col gap-0.5">
      <ThemeSubmenu />

      {/* Asks first. On the phone this row lands exactly where the account
          chevron that opened it was — the footer is pinned to the bottom edge
          and grows upward — so a second tap on the same spot signed two QA
          testers out by accident. Signing back in there means a trip through
          the Companion sign-in, which is not a cost to spring on a stray tap. */}
      <SubRow
        icon={<LogOut className="h-4 w-4 shrink-0" strokeWidth={1.25} />}
        label="Log out"
        onClick={() => setConfirming(true)}
      />

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>Log out?</AlertDialog.Title>
            <AlertDialog.Description>
              You will need to log in again to get back to your memory on this device.
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
            <AlertDialog.Action
              // AlertDialog.Action renders the default button variant, so the
              // destructive styling has to come from here.
              className="bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/60"
              onClick={logout}
            >
              Log out
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </div>
  );
}

interface SubRowProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}

/**
 * A row inside the opened account tile — the same child row as Profile or
 * Settings beside it (`RailSubmenuRow`), as a button.
 */
function SubRow({ icon, label, onClick }: SubRowProps) {
  const { expanded } = usePowerRail();

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      // No `w-full`: the column stretches it, less its indent. `w-full` plus
      // the indent's margin would overflow the account tile's clipped
      // collapsible, and focusing the row would scroll the whole list sideways.
      className={cn(
        'flex cursor-pointer items-center rounded-md text-left text-sm transition',
        RAIL_CHILD_HEIGHT,
        expanded ? ['gap-2', RAIL_CHILD_INSET] : 'justify-center',
        railRowTone(false),
      )}
    >
      <span className={cn('grid shrink-0 place-items-center', expanded ? 'size-4' : 'size-6')} aria-hidden>
        {icon}
      </span>
      {expanded ? <span className="truncate">{label}</span> : null}
    </button>
  );
}

/**
 * Appearance, nested one level deeper again.
 *
 * Light/Dark/Auto stays three visible choices — a submenu that hides which mode
 * is active is worse than one that shows it — but it lives under Theme rather
 * than occupying a drawer row of its own, and the colour grid opens from here
 * instead of from the rail.
 */
function ThemeSubmenu() {
  const { themeState, setTheme } = useTheme();
  const { expanded, setHoldOpen } = usePowerRail();

  return (
    // A column, so the indented trigger stretches the way SubRow does.
    <Collapsible className="flex flex-col">
      <Collapsible.Trigger
        aria-label="Theme"
        className={cn(
          'flex items-center rounded-md text-left text-sm transition [&[data-state=open]>svg:last-child]:rotate-90',
          RAIL_CHILD_HEIGHT,
          expanded ? ['gap-2', RAIL_CHILD_INSET] : 'justify-center',
          railRowTone(false),
        )}
      >
        <span className={cn('grid shrink-0 place-items-center', expanded ? 'size-4' : 'size-6')} aria-hidden>
          <Palette className="h-4 w-4 shrink-0" strokeWidth={1.25} />
        </span>
        {expanded ? <span className="flex-1 truncate">Theme</span> : null}
        {expanded ? <ChevronRight className="h-4 w-4 shrink-0 transition-transform duration-200" /> : null}
      </Collapsible.Trigger>

      <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <div className="flex flex-col gap-0.5 py-1">
          {/* One level under Theme, starting under its icon — the rail's third
              level (`RAIL_LEAF_INSET`), where Chat's threads sit under Chat.
              It runs to the rows' right edge, with tight segments, because
              that column leaves the desktop rail about 11.125rem for three
              labels; everything there is rem, so it fits at any zoom. */}
          <div className={expanded ? 'ml-7.5' : undefined}>
            <div
              role="radiogroup"
              aria-label="Theme"
              className="flex gap-0.5 rounded-md bg-muted p-1 text-xs"
            >
              {THEME_MODES.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  role="radio"
                  aria-checked={themeState.mode === entry.value}
                  onClick={() => setTheme(entry.value)}
                  className={cn(
                    'flex-1 cursor-pointer rounded-sm px-1.5 py-1 transition-colors',
                    themeState.mode === entry.value
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>

          <Popover onOpenChange={setHoldOpen}>
            <Popover.Trigger
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-md text-left text-xs text-muted-foreground transition',
                RAIL_LEAF_HEIGHT,
                expanded ? RAIL_LEAF_INSET : 'justify-center',
                railRowTone(false),
              )}
            >
              <Palette aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.25} />
              <span className="truncate">Colours</span>
            </Popover.Trigger>
            <Popover.Content side="right" align="end" className="w-[400px] p-2 pb-0">
              <ColorPicker />
            </Popover.Content>
          </Popover>
        </div>
      </Collapsible.Content>
    </Collapsible>
  );
}
