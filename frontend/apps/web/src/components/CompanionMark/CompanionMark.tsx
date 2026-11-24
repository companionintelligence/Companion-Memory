import { cn } from '@ci/shadcn';

import brainMarkSvg from '@/assets/companion-memory-brain.svg';

/**
 * The Companion Memory mark: a solid teal brain, a white node network and a
 * dark "M" — the same drawing the app icons, the store listing and the splash
 * hero use, so the app chrome and the FTUE are one logo.
 *
 * It is one static vector on a transparent ground, so it sits on a dark disc or
 * a light page alike (the "M" is filled, not knocked out, for exactly that
 * reason). There is no animated version of this mark. The old build streamed a
 * 1.9 MB Lottie player to loop it; that is gone, and so is the lazy chunk.
 *
 * `animated` is opt-in per placement rather than always on. A mark that moves
 * on its own reads as alive on a full-bleed hero and as a flicker in 32px of
 * persistent chrome, so chrome placements pass `animated` only while the user
 * is pointing at them. The answer is a short CSS fade-and-scale entrance, and it
 * is gated behind `motion-safe:` so `prefers-reduced-motion` gets the still mark
 * with no motion at all.
 */
export function CompanionMark({ className, animated = false }: { className?: string; animated?: boolean }) {
  return (
    <img
      src={brainMarkSvg}
      alt=""
      className={cn(
        'max-w-none',
        animated &&
          'motion-safe:animate-in motion-safe:fade-in-50 motion-safe:zoom-in-90 motion-safe:duration-300',
        className,
      )}
    />
  );
}
