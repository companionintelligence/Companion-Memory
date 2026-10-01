import { type ReactNode } from 'react';

/*
 * One set of row shapes for the Power Rail, at two sizes.
 *
 * The phone drawer and the desktop rail are the same component tree, so every
 * row states its phone height and overrides it with `device:` for the desktop
 * rail. That is a chrome split, not a reflow: the dock only mounts at ≥896px
 * and the drawer only below it (`MOBILE_BREAKPOINT`), so each size only ever
 * meets its own surface.
 *
 * Heights are px, not rem, because they are touch targets and the 44px
 * guidance is in CSS px — the tokens' 17px root would make `h-11` 46.75px.
 * They are minimums, so a row still grows with the reader's text size.
 */

/** Planning, Memory, Sources… — and Capture and Help, which sit beside them. */
export const RAIL_SECTION_HEIGHT = 'min-h-[44px] device:min-h-[36px]';
/** A section's own rows: Events, Tasks, Activity, Profile… */
export const RAIL_CHILD_HEIGHT = 'min-h-[40px] device:min-h-[32px]';
/** One level further down: Chat's recent threads under Memory → Chat. */
export const RAIL_LEAF_HEIGHT = 'min-h-[36px] device:min-h-[28px]';
/** The account row: the avatar beside a name over an email. */
export const RAIL_ACCOUNT_HEIGHT = 'min-h-[52px]';

/*
 * Columns, from the rail's content edge:
 *
 *   section  │pl-2.5│ icon 1.5rem │gap-3│ label …      icon 0.625–2.125rem, label 2.875rem
 *   guide    │   ┆ 1px at 1rem, under the section icon's left half
 *   child    │ml-4.5│pl-1.5│ icon 1rem │gap-2│ label …   icon 1.5rem, label 3rem
 *   leaf     │ ml-7.5          │pl-1.5│ text …   text 2.25rem, under the child's icon
 *
 * The guide sits left of the section icon's centre (1.375rem) so the children
 * can start close in: a child's icon is 0.875rem in from the section's, where
 * on the centre it could get no nearer than 1.25rem. `ml-4.5` is as close as
 * the row can start and still clear the current page's 2px bar on the guide,
 * so the row's fill never touches it. On the section's label column (`ml-9`,
 * where they began) the children read as a separate list set far in. Child
 * and leaf rows pad by `pl-1.5` and space icon from label by `gap-2`, tighter
 * than a section's `pl-2.5` and `gap-3`: their 1rem icon and small text need
 * less room than a 1.5rem icon.
 *
 * A leaf's text starts under the middle of its child's icon, not on the
 * child's label: small muted text already reads as a level down, and on the
 * label column (3rem) Chat's threads sat as far in as the children
 * themselves once did.
 *
 * A section's `pl-2.5` is where the old 2px `border-l` plus `px-2` put the
 * icon, so the drawer's header mark, which centres itself on this icon
 * column, still does. `py-1` only matters once text is scaled up past the
 * row's minimum height.
 */
export const RAIL_SECTION_INSET = 'py-1 pl-2.5 pr-2';
export const RAIL_CHILD_INSET = 'ml-4.5 py-1 pl-1.5 pr-2';
export const RAIL_LEAF_INSET = 'ml-7.5 py-1 pl-1.5 pr-2';

/**
 * Where a count sits on a collapsed rail icon: centred over the icon's top,
 * inside the row's own box.
 *
 * A collapsed row is the icon's whole lane with the icon centred in it, so the
 * row's centre is the icon's. Inside the row because the rail's
 * `overflow-y-auto` scrollport clips anything that hangs outside one — and
 * never beside the icon as a flex sibling: the pill's `ml-auto` then pushed it
 * to the lane's edge, where it was cut off, and pulled the icon off-centre.
 * `flex` so an inline pill inside it adds no line-box height.
 */
export const RAIL_COLLAPSED_BADGE = 'pointer-events-none absolute left-1/2 top-0 flex -translate-x-1/2';

/**
 * Idle and current-page fills for a row.
 *
 * The current page is a filled row, never a `border-l`: a border on a
 * `rounded-md` row follows the rounded corners and draws a "(" beside the
 * label. Hover on the current row deepens its own tint instead of swapping to
 * the accent fill every other row uses.
 */
export function railRowTone(active: boolean): string {
  return active
    ? 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'
    : 'hover:bg-accent hover:text-accent-foreground';
}

/**
 * Colours a row's icon with the row when it is the current page.
 *
 * The icons carry their own colour classes (muted, or Memory's teal in light
 * mode), which outrank a colour inherited from the row — hence the override.
 */
export const RAIL_ICON_ACTIVE = '[&_svg]:!text-primary';

/**
 * A section's opened rows, hung off a faint line under the section's icon.
 *
 * Children start at the section's label column, so the line is what ties them
 * to it; the current page's bar ({@link RailActiveBar}) sits on the same line.
 */
export function RailChildren({ children }: { children: ReactNode }) {
  return (
    <div className="relative mb-1 mt-0.5 flex min-w-0 flex-col gap-0.5">
      <span
        aria-hidden
        data-testid="rail-guide"
        className="pointer-events-none absolute inset-y-0.5 left-[calc(1rem-0.5px)] w-px bg-border"
      />
      {children}
    </div>
  );
}

/**
 * The current page's marker: a straight 2px bar on the guide line, half the
 * row's height. 2px rather than 3px so a child row can start `ml-4.5` and its
 * fill still clears the bar. Its own element rather than a border, so nothing about the
 * row's rounded shape can bend it.
 *
 * Rendered inside a `relative` box that starts at the rail's content edge (see
 * {@link RailIndentedRow}), which is why one `left` serves every depth.
 */
function RailActiveBar() {
  return (
    <span
      aria-hidden
      data-testid="rail-active-bar"
      className="pointer-events-none absolute inset-y-1/4 left-[calc(1rem-1px)] w-[2px] rounded-full bg-primary"
    />
  );
}

/**
 * A child or leaf row: the row itself, plus the bar on the guide line when it
 * is the current page.
 */
export function RailIndentedRow({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div className="relative min-w-0">
      {active ? <RailActiveBar /> : null}
      {children}
    </div>
  );
}
