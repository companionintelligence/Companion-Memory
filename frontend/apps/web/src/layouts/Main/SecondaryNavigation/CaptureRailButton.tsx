import { Tooltip, cn } from '@ci/shadcn';
import { Camera } from '@ci/shadcn/icons';

import { useCaptureModal } from '@/hooks';

import { usePowerRail } from '../PowerRailContext';

import { RAIL_SECTION_HEIGHT, RAIL_SECTION_INSET, railRowTone } from './railRow';

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
        'relative flex items-center rounded-md transition active:scale-95',
        RAIL_SECTION_HEIGHT,
        expanded ? ['w-full gap-3 text-left', RAIL_SECTION_INSET] : 'justify-center',
        railRowTone(false),
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
