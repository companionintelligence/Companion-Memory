import { Suspense, lazy, useMemo, type ComponentType } from 'react';

import { cn } from '@ci/shadcn';

import brainMarkSvg from '@/assets/companion-memory-brain.svg';

/**
 * The player and the 1.9 MB animation are fetched only when something actually
 * animates.
 *
 * Both used to be static imports on the splash page, which put them in the
 * initial bundle for every route — including native, which never sees the
 * splash. They are also unloadable under jsdom: `lottie-web` reaches for a
 * canvas 2D context at import time and throws on `fillStyle` when there is
 * none, so a static import here would take out the test suite of every page
 * that renders the mark.
 */
const LottieMark = lazy(async () => {
  const [{ default: Lottie }, animation] = await Promise.all([
    import('lottie-react'),
    import('@/assets/companion-memory-brain.lottie.json'),
  ]);

  const Mark: ComponentType<{ className?: string }> = ({ className }) => (
    <Lottie animationData={animation.default} loop autoplay className={className} />
  );

  return { default: Mark };
});

function usePrefersReducedMotion() {
  return useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
}

/**
 * The Companion Memory mark — the same node graph the splash hero and the app
 * icons use, so the app chrome and the FTUE are one drawing.
 *
 * `animated` is opt-in per placement rather than always on. The animation is a
 * continuous loop that opens and closes on black, which reads as alive on a
 * full-bleed hero and as a flicker in 32px of persistent chrome, so chrome
 * placements pass `animated` only while the user is pointing at them.
 *
 * Under `prefers-reduced-motion` this is always the SVG, which is the
 * animation's settled state — the same drawing, at rest.
 */
export function CompanionMark({ className, animated = false }: { className?: string; animated?: boolean }) {
  const reducedMotion = usePrefersReducedMotion();
  const still = <img src={brainMarkSvg} alt="" className={cn('max-w-none', className)} />;

  if (reducedMotion || !animated) {
    return still;
  }

  // The still frame is the fallback, so the mark is never a blank hole while
  // the player streams in — it just starts moving when it arrives.
  return (
    <Suspense fallback={still}>
      <LottieMark className={cn('max-w-none', className)} />
    </Suspense>
  );
}
