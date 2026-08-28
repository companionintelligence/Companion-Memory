import * as React from 'react';

import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

// `aria-label` is omitted so a caller cannot set it directly and split the accessible
// name from the tooltip. Use `label` for both, or `tooltip` when the bubble needs to
// read differently from the name.
interface IconButtonProps extends Omit<React.ComponentProps<typeof Button>, 'aria-label'> {
  /**
   * Accessible name for the button. Drives both the tooltip text and `aria-label`,
   * so the hover affordance and the screen-reader name can never drift apart.
   */
  label: string;
  /** Overrides the tooltip text when it needs to read differently from `aria-label`. */
  tooltip?: React.ReactNode;
  /**
   * Force the tooltip closed. Use when this button sits under a fullscreen
   * overlay: Radix portals the bubble to `document.body`, so it otherwise
   * paints on top of the page in front.
   */
  hideTooltip?: boolean;
  side?: React.ComponentProps<typeof TooltipContent>['side'];
  align?: React.ComponentProps<typeof TooltipContent>['align'];
  delayDuration?: number;
}

/**
 * An icon-only button that always carries a tooltip.
 *
 * `size="icon"` by default; every other `Button` prop (including `asChild`, to wrap
 * a router `Link`) passes straight through.
 */
function IconButton({
  label,
  tooltip,
  hideTooltip = false,
  side,
  align,
  delayDuration = 600,
  size = 'icon',
  children,
  ...props
}: IconButtonProps) {
  const button = (
    // `aria-label` goes after the spread so it wins even if one reaches the runtime
    // past the type — an untyped spread, a JS caller, a cast.
    <Button size={size} {...props} aria-label={label}>
      {children}
    </Button>
  );

  return (
    <Tooltip delayDuration={delayDuration} open={hideTooltip ? false : undefined}>
      <TooltipContent side={side} align={align}>
        {tooltip ?? label}
      </TooltipContent>
      {/* A disabled button gets `pointer-events: none` from buttonVariants, which
          swallows the hover the tooltip needs. Anchoring to a wrapper span keeps the
          tooltip working precisely when it matters most — explaining why it's off. */}
      <TooltipTrigger asChild>
        {props.disabled ? <span className="inline-flex">{button}</span> : button}
      </TooltipTrigger>
    </Tooltip>
  );
}

export { IconButton };
export type { IconButtonProps };
