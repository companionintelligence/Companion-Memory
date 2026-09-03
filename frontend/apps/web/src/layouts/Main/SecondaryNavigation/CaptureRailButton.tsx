import { Tooltip, cn } from '@ci/shadcn';
import { Camera } from '@ci/shadcn/icons';

import { useCaptureModal } from '@/hooks';

import { usePowerRail } from '../PowerRailContext';

/**
 * Capture as a rail destination — first row, above Plan, mobile only.
 * Desktop already has Capture in the header Add menu; a second entry point
 * in a rail desktop keeps pinned open the whole time is one too
 * many. Opens the same modal the header Add menu uses either way — this is
 * placement, not a second capture flow.
 */
export function CaptureRailButton() {
  const { expanded, variant, closeOverlay } = usePowerRail();
  const [, { open }] = useCaptureModal();

  if (variant !== 'overlay') {
    return null;
  }

  const button = (
    <button
      type="button"
      aria-label="Capture"
      onClick={() => {
        if (variant === 'overlay') {
          closeOverlay();
        }

        open();
      }}
      className={cn(
        'relative rounded-md border-l-2 border-transparent transition hover:bg-accent hover:text-accent-foreground active:scale-95',
        expanded ? 'flex w-full items-center gap-3 px-2 py-2 text-left' : 'p-2',
      )}
    >
      <Camera className="h-6 w-6 shrink-0" strokeWidth={1.25} />
      {expanded ? <span className="truncate text-sm">Capture</span> : null}
    </button>
  );

  if (expanded) {
    return button;
  }

  return (
    <Tooltip>
      <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
      <Tooltip.Content side="right">Capture</Tooltip.Content>
    </Tooltip>
  );
}
