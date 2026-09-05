import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { Button } from '@ci/shadcn';
import Lottie from 'lottie-react';
import { Link } from 'react-router-dom';

import brainAnimation from '@/assets/companion-memory-brain.lottie.json';
import brainMarkSvg from '@/assets/companion-memory-brain.svg';
import { AnimatedBackground } from '@/components/AnimatedBackground';
import { ThemeToggle } from '@/components/ThemePicker';

const MARK_SIZE = 'aspect-square w-[min(88vw,34rem)] md:w-[min(44vw,40rem)] lg:w-[min(48vw,48rem)]';
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
function BrainMark() {
  const reducedMotion = usePrefersReducedMotion();

  if (reducedMotion) {
    return <img src={brainMarkSvg} alt="" className={`${MARK_SIZE} ${MARK_GLOW}`} />;
  }

  // The animation is one continuous loop that opens and closes on black, so it
  // just repeats — no intro/idle segment handoff, and no poster frame to hold,
  // because starting from nothing is the point.
  return <Lottie animationData={brainAnimation} loop autoplay className={`${MARK_SIZE} ${MARK_GLOW}`} />;
}

/** Staggered entrance for the copy — skipped entirely under reduced motion. */
function Reveal({ delay, children, className }: { delay: number; children: ReactNode; className?: string }) {
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

export function SplashPage() {
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

      <div className="absolute top-0 left-0 h-[max(0.5rem,env(safe-area-inset-top))] w-full">
        <div className="absolute top-full right-2 z-10">
          <ThemeToggle />
        </div>
      </div>

      <div className="relative z-10 flex h-full flex-col items-center justify-center gap-8 overflow-y-auto px-8 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] md:flex-row md:gap-12 lg:gap-16">
        <Reveal delay={0} className="flex shrink-0 flex-col items-center">
          <BrainMark />
          {/* The mark's box is square but the artwork inside it is an oval, so the
              wordmark is pulled up into the slack rather than sitting adrift. */}
          <p className="-mt-4 text-sm font-semibold tracking-[0.2em] text-muted-foreground uppercase md:-mt-10">
            Companion Memory
          </p>
        </Reveal>

        <div className="flex max-w-lg flex-col items-center gap-5 text-center md:items-start md:text-left lg:max-w-xl">
          <Reveal delay={120}>
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/70 px-3 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase backdrop-blur">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--aqua)] opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--aqua)]" />
              </span>
              100% local · No cloud calls
            </span>
          </Reveal>

          <Reveal delay={220}>
            <h1 className="text-3xl leading-[1.05] font-bold tracking-tight text-balance sm:text-4xl md:text-5xl">
              Supercharge your AI
              {/* Break only where the line actually fits; narrow screens wrap on their own. */}
              <br className="hidden md:block" />{' '}
              {/* Gradient stops are theme tokens, so this stays legible in both themes:
                  --primary is sage on dark and phthalo on light. */}
              <span className="bg-[linear-gradient(100deg,var(--primary),var(--aqua))] bg-clip-text text-transparent">
                with your entire life.
              </span>
            </h1>
          </Reveal>

          <Reveal delay={320} className="flex flex-col items-center gap-3 sm:flex-row md:items-center">
            <Button asChild size="lg" className="px-10 shadow-glow-ci">
              <Link to="/signup">Get Started</Link>
            </Button>
            <Button asChild variant="link" className="text-muted-foreground">
              <Link to="/login">I already have an account</Link>
            </Button>
          </Reveal>
        </div>
      </div>
    </div>
  );
}
