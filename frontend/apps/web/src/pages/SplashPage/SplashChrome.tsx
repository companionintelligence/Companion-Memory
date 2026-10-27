import type { ReactNode } from 'react';
import { useMemo } from 'react';

import brainMarkSvg from '@/assets/companion-memory-brain.svg';
import { AnimatedBackground } from '@/components/AnimatedBackground';
import { ThemeToggle } from '@/components/ThemePicker';

export const SPLASH_MARK_SIZE =
  'aspect-square w-[min(88vw,34rem)] md:w-[min(44vw,40rem)] lg:w-[min(48vw,48rem)]';
/** Compact enough on a phone that Log in sits on-screen under the wordmark. */
export const CONNECT_MARK_SIZE = 'aspect-square w-[min(72vw,20rem)]';
/** The mark's own teal (#00a9a7), as a soft halo — the logo's "glow". */
const MARK_GLOW = 'drop-shadow-[0_0_90px_rgba(0,169,167,0.5)]';
/**
 * A single fade-and-scale entrance. `motion-safe:` makes it CSS-level, so
 * `prefers-reduced-motion` gets the still mark with no animation class doing
 * anything, and nothing has to wait on a player or a chunk to arrive.
 */
const MARK_ENTRANCE =
  'motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:fill-mode-backwards motion-safe:duration-1000';

function usePrefersReducedMotion() {
  return useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
}

/**
 * The Companion Memory mark: a solid teal brain, white node network and dark
 * "M" — the same drawing as the app icons and the store listing. It is a static
 * vector with a CSS entrance; there is no animated version of this mark, so
 * there is no player to load and nothing for the hero to flash on while one
 * streams in.
 *
 * The halo is on a wrapper, not on the image. The entrance utility sets its own
 * `filter` on whatever it animates, which would replace a `drop-shadow` on the
 * image for the whole second of the entrance and then snap the glow back on.
 * Filtering the wrapper instead lets the glow fade in with the mark.
 */
export function BrainMark({ sizeClass = SPLASH_MARK_SIZE }: { sizeClass?: string }) {
  return (
    <div className={`${sizeClass} ${MARK_GLOW}`}>
      <img src={brainMarkSvg} alt="" className={`size-full ${MARK_ENTRANCE}`} />
    </div>
  );
}

/** Staggered entrance for the copy — skipped entirely under reduced motion. */
export function Reveal({
  delay,
  children,
  className,
}: {
  delay: number;
  children: ReactNode;
  className?: string;
}) {
  const reducedMotion = usePrefersReducedMotion();

  if (reducedMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div
      className={`${className ?? ''} animate-in fade-in slide-in-from-bottom-4 fill-mode-backwards duration-700`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

/** Full-viewport splash chrome: living background, brand light, theme toggle. */
export function SplashShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-lvh overflow-hidden bg-background text-foreground">
      <AnimatedBackground />

      {/* Two low, wide washes of brand light so the mark reads as lit rather than
          pasted onto a flat ground. Both sit under the content. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-1/3 -left-1/4 h-[80vmax] w-[80vmax] rounded-full bg-[radial-gradient(circle,var(--aqua)_0%,transparent_62%)] opacity-[0.13] blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-1/4 -bottom-1/3 h-[70vmax] w-[70vmax] rounded-full bg-[radial-gradient(circle,var(--info)_0%,transparent_62%)] opacity-[0.10] blur-3xl"
      />

      {/* Above the page's content layer, which is `relative z-10` and fills the screen:
          at the same z-index the later content won and swallowed every click here.
          The offset reads `--safe-area-top` rather than `env()` because WKWebView can
          report that inset as 0, which put the button under the status bar on iOS. */}
      <div className="ci-mobile-chrome-top absolute right-2 z-20">
        <ThemeToggle />
      </div>

      {children}
    </div>
  );
}
