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
 *   section  │pl-2.5│ icon 1.5rem │gap-3│ label …      icon centre 1.375rem, label 2.875rem
 *   guide    │      ┆ 1px, under the section icon's centre
 *   child    │ ml-9     │pl-2.5│ icon 1rem │gap-2.5│ label …   icon on the section's label column
 *   leaf     │ ml-18                        │pl-2.5│ text …   box on the child's label column
 *
 * `pl-2.5` is where the old 2px `border-l` plus `px-2` put the icon, so the
 * drawer's header mark, which centres itself on this icon column, still does.
 * `py-1` only matters once text is scaled up past the row's minimum height.
 */
export const RAIL_SECTION_INSET = 'py-1 pl-2.5 pr-2';
export const RAIL_CHILD_INSET = 'ml-9 py-1 pl-2.5 pr-2';
export const RAIL_LEAF_INSET = 'ml-18 py-1 pl-2.5 pr-2';

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
        className="pointer-events-none absolute inset-y-0.5 left-[calc(1.375rem-0.5px)] w-px bg-border"
      />
      {children}
    </div>
  );
}

/**
 * The current page's marker: a straight 3px bar on the guide line, half the
 * row's height. Its own element rather than a border, so nothing about the
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
      className="pointer-events-none absolute inset-y-1/4 left-[calc(1.375rem-1.5px)] w-[3px] rounded-full bg-primary"
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
