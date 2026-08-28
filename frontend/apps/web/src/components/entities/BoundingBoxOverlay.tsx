import { cn } from '@ci/shadcn';

/**
 * A detector box in NORMALIZED image coordinates — the same 0..1 fractions the
 * backend stores in `ci.object_observations.bbox` (BoundingBoxType). Nothing
 * here knows the pixel size of the image, which is the point: the overlay is
 * positioned in percentages so it stays correct at every thumbnail size.
 */
export interface NormalizedBoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  bbox?: NormalizedBoundingBox | null;
  /** Rendered as a small caption on the box, and as its accessible name. */
  label?: string | null;
  className?: string;
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

/**
 * A fraction as a CSS percentage, rounded.
 *
 * Without the rounding, clamping an over-wide box emits binary-float noise into
 * the DOM — `1 - 0.9` is `0.09999999999999998`, which lands in the style
 * attribute as `9.999999999999998%`. Four decimal places is sub-pixel on any
 * frame anyone will render.
 */
function percent(fraction: number): string {
  return `${Math.round(fraction * 1e6) / 1e4}%`;
}

/**
 * Draw one detector box over an image.
 *
 * The parent must be `relative` — the overlay positions itself absolutely
 * against it.
 *
 * Two defensive rules, because these numbers come from detectors and importers
 * rather than from us:
 *
 *  - every coordinate is clamped into 0..1, so a box that ran off the edge of
 *    the frame does not stretch the tile it is drawn on;
 *  - a box with no area left after clamping renders nothing at all, rather
 *    than a zero-height hairline that reads as a rendering glitch.
 */
export function BoundingBoxOverlay({ bbox, label, className }: Props) {
  if (bbox == null) {
    return null;
  }

  const x = clampFraction(bbox.x);
  const y = clampFraction(bbox.y);
  // Clamp the extent against the origin too: a box starting at 0.9 can only be
  // 0.1 wide before it leaves the frame.
  const w = Math.min(clampFraction(bbox.w), 1 - x);
  const h = Math.min(clampFraction(bbox.h), 1 - y);

  if (w <= 0 || h <= 0) {
    return null;
  }

  // Normalized once: a whitespace-only label is no label.
  const caption = label != null && label.trim() !== '' ? label : null;

  return (
    <div
      data-testid="bounding-box"
      // `role="presentation"` would take the box back OUT of the accessibility
      // tree and drop the name with it, so a labelled box is a `figure` (a
      // region with a caption, which is exactly what it is) and an unlabelled
      // one stays decorative — an unnamed `figure` is just noise to a reader.
      role={caption == null ? 'presentation' : 'figure'}
      aria-label={caption ?? undefined}
      className={cn(
        // pointer-events-none so the box never swallows a click meant for the
        // tile it sits on (confirm/reject live underneath it).
        'pointer-events-none absolute rounded-sm border-2 border-sky-400 ring-1 ring-black/40',
        className,
      )}
      style={{
        left: percent(x),
        top: percent(y),
        width: percent(w),
        height: percent(h),
      }}
    >
      {caption != null && (
        <span className="absolute left-0 top-full mt-0.5 max-w-full truncate rounded-sm bg-sky-400 px-1 text-[10px] font-medium leading-4 text-black">
          {caption}
        </span>
      )}
    </div>
  );
}
