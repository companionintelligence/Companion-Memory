import { useState } from 'react';

import { Tooltip, cn } from '@ci/shadcn';
import { useTranslation } from 'react-i18next';

import { CompanionMark } from '@/components/CompanionMark';

import { usePowerRail } from './PowerRailContext';

// Glass capsule: `p-1` + a 32px disc = 40px. Max-width is what opens and
// closes it — same property both ways, so closing is the reverse of opening
// instead of unmounting the wordmark.
const CAPSULE =
  'inline-flex h-10 min-w-0 items-center overflow-hidden rounded-full border border-white/55 bg-white/30 p-1 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.7),0_1px_2px_rgba(0,0,0,0.08)] backdrop-blur-md transition-[max-width,padding,gap] duration-200 ease-in-out dark:border-white/20 dark:bg-white/10';

/**
 * Mark and name. Desktop keeps the full product name. The phone drawer
 * shares 224px with the close chevron, so it uses the short form — the
 * full string used to ellipsize.
 */
function RailMark({
  showName,
  truncateName = false,
  name = 'Companion Memory',
  opticalNudge = true,
  centerOnNavIcons = false,
  animated = false,
}: {
  showName: boolean;
  truncateName?: boolean;
  name?: string;
  /**
   * Desktop capsule only. The 1px shifts optically center the disc in that
   * pill; in the phone drawer they pull the mark left of the nav icons.
   */
  opticalNudge?: boolean;
  /**
   * Phone drawer: the disc is 32px, the nav icons 24px. Shift 4px left so
   * the icon column runs through the middle of the mark.
   */
  centerOnNavIcons?: boolean;
  animated?: boolean;
}) {
  return (
    <>
      {/* Full-size mark on a disc. The disc is near-black, not white: the mark's
          glows fall off to transparent and are drawn to sit on the splash's
          black, so a white disc washes the node graph out to nothing. */}
      <span
        className={cn(
          'grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-neutral-950',
          opticalNudge && '-translate-x-px',
          centerOnNavIcons && '-translate-x-1',
        )}
      >
        <CompanionMark animated={animated} className="size-8 rounded-full" />
      </span>
      <span
        aria-hidden={!showName}
        className={cn(
          'text-left text-sm font-semibold leading-tight',
          opticalNudge && '-translate-y-px',
          // The dock capsule animates its own max-width and wipes the name as
          // it closes; a shrinkable span would put an ellipsis in the middle of
          // that. The drawer instead has a fixed 224px to share with the close
          // chevron, so there the name is the part that gives way.
          truncateName ? 'min-w-0 truncate' : 'overflow-hidden whitespace-nowrap',
        )}
      >
        {name}
      </span>
    </>
  );
}

/**
 * The name of the app, stated, not clickable.
 *
 * For the phone drawer, where the chevron beside it already opens and closes
 * the rail — a second control with the same effect and the same accessible
 * name is one control too many. Desktop keeps the toggle below, because there
 * the mark IS the button.
 *
 * No capsule either: the drawer is already a pane of glass, and a bordered pill
 * inside it is a border drawn on a border — one that would also cost the width
 * the chevron needs.
 */
export function PowerRailWordmark() {
  return (
    // gap-2, not gap-3: the disc is 32px and the nav icons are 24px, so the
    // tighter gap keeps "Memory" on the same column as Capture / Planning.
    <span className="flex min-w-0 items-center gap-2" data-testid="power-rail-wordmark">
      <RailMark showName truncateName name="Memory" opticalNudge={false} centerOnNavIcons />
    </span>
  );
}

/**
 * The home control. It used to be a link — either to `/feed` or to the
 * marketing site — which meant the one button that looks like "this app"
 * never did the one thing the chrome needs: open and close the rail.
 */
export function PowerRailToggle() {
  const { t } = useTranslation();
  const { expanded, pinned, toggle } = usePowerRail();
  const label = expanded ? t('NAV_RAIL_COLLAPSE') : t('NAV_RAIL_EXPAND');
  // The mark animates only while the user is on it. A 32px loop running behind
  // every screen is motion the chrome never asked for; on hover it reads as the
  // control answering. Focus counts too, so keyboard users get the same answer.
  const [active, setActive] = useState(false);

  return (
    // Width matches the drawer (`w-14` / `w-56`). Vertical inset is only `px-2`
    // so this box does not grow the header; the parent cell centers it, which
    // keeps padding above and below the mark the same. Pinning must not add
    // extra padding — that used to shove the rail down.
    <div className={cn('flex items-center px-2 transition-[width] duration-200', pinned ? 'w-56' : 'w-14')}>
      <Tooltip delayDuration={600}>
        <Tooltip.Content>{label}</Tooltip.Content>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            // Pinned, not merely hover-expanded — a mouse brushing the rail
            // open must not tell assistive tech the menu was deliberately
            // opened. Only a pin (a click, persisted) is "expanded" here.
            aria-expanded={pinned}
            aria-controls="power-rail"
            onClick={toggle}
            onPointerEnter={() => setActive(true)}
            onPointerLeave={() => setActive(false)}
            onFocus={() => setActive(true)}
            onBlur={() => setActive(false)}
            // PINNED, not merely expanded. This button sits in the same `auto`
            // grid column as the rail, so a wordmark appearing here widens the
            // column and shoves the header and page content sideways — which is
            // exactly what a hover-opened drawer must never do. Pinning is the
            // one case where a reflow is intended, and permanent.
            className={cn(
              CAPSULE,
              'hover:bg-white/45 dark:hover:bg-white/20',
              pinned ? 'max-w-52 gap-2 pr-3' : 'max-w-10 gap-0',
            )}
          >
            <RailMark showName={pinned} animated={active} />
          </button>
        </Tooltip.Trigger>
      </Tooltip>
    </div>
  );
}
