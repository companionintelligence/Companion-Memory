import { Button } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import companionMemoryLogo from '@/assets/companion-memory-logo.png';
import { ThemeToggle } from '@/components/ThemePicker';

const TRUST_BADGES = ['100% Local', 'No Cloud Calls', 'Your Data Stays Yours'];

export function SplashPage() {
  return (
    <div className="relative h-lvh overflow-hidden bg-[#050a10] text-white">
      {/* Ambient brand glow — cyan/pink lifted from the app icon's own palette,
          decorative only, so it never competes with the icon it's echoing. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-1/4 -top-1/4 h-[60vmax] w-[60vmax] rounded-full bg-[#00c2c2]/20 blur-[120px]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-1/3 -right-1/4 h-[60vmax] w-[60vmax] rounded-full bg-[#ff5fae]/20 blur-[120px]"
      />

      <div className="absolute top-0 left-0 h-[max(0.5rem,env(safe-area-inset-top))] w-full">
        <div className="absolute top-full right-2 z-10 text-white">
          <ThemeToggle />
        </div>
      </div>

      <div className="relative z-10 flex h-full flex-col items-center justify-center gap-8 px-8 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] text-center">
        <img
          src={companionMemoryLogo}
          alt=""
          className="h-20 w-20 drop-shadow-[0_0_50px_rgba(0,194,194,0.35)] md:h-24 md:w-24"
        />

        <div className="flex max-w-2xl flex-col gap-4">
          <p className="text-sm font-semibold tracking-[0.2em] text-white/60 uppercase">Companion Memory</p>
          <h1 className="text-4xl font-bold md:text-6xl">Supercharge your AI with your entire life.</h1>
          <p className="mx-auto max-w-xl text-lg text-white/70 md:text-xl">
            Companion Memory is the local, private memory layer for your AI — so your agents finally know
            where home is.
          </p>
        </div>

        <ul className="flex flex-wrap items-center justify-center gap-2">
          {TRUST_BADGES.map((badge) => (
            <li
              key={badge}
              className="rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-medium tracking-wide text-white/80 uppercase"
            >
              {badge}
            </li>
          ))}
        </ul>

        <Button asChild size="lg" className="px-10">
          <Link to="/login">Log In</Link>
        </Button>
      </div>
    </div>
  );
}
