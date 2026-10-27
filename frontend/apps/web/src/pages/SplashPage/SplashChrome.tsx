import type { ReactNode } from 'react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';

import brainMarkSvg from '@/assets/companion-memory-brain.svg';
import { AnimatedBackground } from '@/components/AnimatedBackground';
import { ThemeToggle } from '@/components/ThemePicker';

// lottie-web is ~300 KB of player that only splash surfaces use, so it travels
// with the animation it plays rather than in the chunk every page pays for.
const Lottie = lazy(() => import('lottie-react'));

export const SPLASH_MARK_SIZE =
  'aspect-square w-[min(88vw,34rem)] md:w-[min(44vw,40rem)] lg:w-[min(48vw,48rem)]';
/** Compact enough on a phone that Log in sits on-screen under the wordmark. */
export const CONNECT_MARK_SIZE = 'aspect-square w-[min(72vw,20rem)]';
const MARK_GLOW = 'drop-shadow-[0_0_90px_rgba(30,207,224,0.45)]';

function usePrefersReducedMotion() {
  return useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
}

/**
 * The Companion Memory mark: the app icon's own node graph, traced off the icon
 * artwork itself, so the animation and the static fallback are the same drawing.
 * `prefers-reduced-motion` gets the SVG, which matches the animation's settled state.
 */
export function BrainMark({ sizeClass = SPLASH_MARK_SIZE }: { sizeClass?: string }) {
  const reducedMotion = usePrefersReducedMotion();
  const [animationData, setAnimationData] = useState<object | null>(null);

  // Loaded on demand rather than imported at the top of the file. Statically
  // imported, the 1.9 MB animation lands in the app's main chunk: every user
  // downloads it before the app can boot, and it pushed that chunk to 5.27 MB —
  // past vite-plugin-pwa's 2 MiB precache ceiling, which fails the production
  // build outright. As its own chunk it is fetched after first paint and only
  // by the surface that shows it.
  useEffect(() => {
    if (reducedMotion) {
      return;
    }

    let cancelled = false;

    import('@/assets/companion-memory-brain.lottie.json')
      .then((module) => {
        if (!cancelled) {
          setAnimationData(module.default);
        }
      })
      // The mark is decoration; if its chunk fails to load the hero should
      // still render its copy and its call to action.
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [reducedMotion]);

  if (reducedMotion) {
    return <img src={brainMarkSvg} alt="" className={`${sizeClass} ${MARK_GLOW}`} />;
  }

  // Nothing stands in for the animation while its chunk arrives. The loop opens
  // and closes on black by design, so an empty box IS its first frame — a poster
  // here would show the settled drawing and then cut back to black.
  if (!animationData) {
    return <div className={sizeClass} aria-hidden="true" />;
  }

  // One continuous loop that opens and closes on black, so it just repeats — no
  // intro/idle segment handoff, because starting from nothing is the point.
  return (
    <Suspense fallback={<div className={sizeClass} aria-hidden="true" />}>
      <Lottie animationData={animationData} loop autoplay className={`${sizeClass} ${MARK_GLOW}`} />
    </Suspense>
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
