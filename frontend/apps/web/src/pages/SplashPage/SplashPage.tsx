import { Button } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { BrainMark, Reveal, SplashShell } from './SplashChrome';

export function SplashPage() {
  return (
    <SplashShell>
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
    </SplashShell>
  );
}
