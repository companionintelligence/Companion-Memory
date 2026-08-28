import { useEffect, useRef } from 'react';

/**
 * The page's living background — a glow that follows the pointer with weight.
 *
 * Ported from CI-Portal's `animated-background`, so the two surfaces of the
 * platform feel like one product. The physics are the point: the glow is pulled
 * toward the cursor by a spring and slowed by friction, so it arrives a beat
 * late and overshoots slightly rather than being welded to the pointer. A glow
 * pinned exactly under the cursor reads as a cursor decoration; one with mass
 * reads as the surface responding.
 *
 * This replaces the rail mark's warp core, which span a conic gradient forever
 * whether or not anyone was there — motion that cost a composited layer every
 * frame of every session and answered nothing the user did.
 *
 * Four ways it declines to run, all of them cheap to check and expensive to
 * ignore:
 *
 *  - **The Appearance toggle.** Desktop settings can turn the layer off; this
 *    component is not mounted at all in that case (see `Main`).
 *  - **Coarse pointers.** There is no cursor on a phone, so the loop would burn
 *    battery to move a glow to a position that never updates.
 *  - **`prefers-reduced-motion`.** Movement is the whole effect, so the honest
 *    response is the static gradient, not a slower spring.
 *  - **A settled spring.** The loop stops when the glow stops, and restarts on
 *    the next `mousemove`. An idle tab does no work at all.
 */

/** Below this many pixels of movement, skip the write — the frame is invisible. */
const THRESHOLD = 0.5;
/** Spring pull toward the cursor. Higher is snappier and less weighty. */
const STIFFNESS = 0.015;
/** Velocity kept per frame. Below 1 is friction; at 1 the glow would never settle. */
const DAMPING = 0.88;

export function AnimatedBackground() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;

    if (!el) {
      return;
    }

    const finePointer = window.matchMedia('(pointer: fine)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    let allowed = finePointer.matches && !reducedMotion.matches;
    let raf = 0;
    let running = false;

    // Off-screen until the pointer is first seen, so nothing flashes at 0,0.
    let targetX = -9999;
    let targetY = -9999;
    let glowX = -9999;
    let glowY = -9999;
    let velocityX = 0;
    let velocityY = 0;

    const tick = () => {
      const nextVelocityX = (velocityX + (targetX - glowX) * STIFFNESS) * DAMPING;
      const nextVelocityY = (velocityY + (targetY - glowY) * STIFFNESS) * DAMPING;
      const nextX = glowX + nextVelocityX;
      const nextY = glowY + nextVelocityY;

      if (Math.abs(nextX - glowX) <= THRESHOLD && Math.abs(nextY - glowY) <= THRESHOLD) {
        // Settled. Stop rather than spin on sub-pixel deltas nobody can see.
        running = false;

        return;
      }

      velocityX = nextVelocityX;
      velocityY = nextVelocityY;
      glowX = nextX;
      glowY = nextY;

      el.style.setProperty('--glow-x', `${Math.round(glowX)}px`);
      el.style.setProperty('--glow-y', `${Math.round(glowY)}px`);

      raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (allowed && !running) {
        running = true;
        raf = requestAnimationFrame(tick);
      }
    };

    const onMove = (event: MouseEvent) => {
      targetX = event.clientX;
      targetY = event.clientY;
      start();
    };

    // Freeze where it is when the pointer leaves, rather than letting it drift
    // to a stale target or snap off-screen.
    const onLeave = () => {
      targetX = glowX;
      targetY = glowY;
      velocityX = 0;
      velocityY = 0;
    };

    const onPreferenceChange = () => {
      allowed = finePointer.matches && !reducedMotion.matches;

      if (!allowed) {
        running = false;
        cancelAnimationFrame(raf);
      }
    };

    window.addEventListener('mousemove', onMove, { passive: true });
    document.documentElement.addEventListener('mouseleave', onLeave);
    finePointer.addEventListener('change', onPreferenceChange);
    reducedMotion.addEventListener('change', onPreferenceChange);

    return () => {
      window.removeEventListener('mousemove', onMove);
      document.documentElement.removeEventListener('mouseleave', onLeave);
      finePointer.removeEventListener('change', onPreferenceChange);
      reducedMotion.removeEventListener('change', onPreferenceChange);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="animated-bg" ref={ref} aria-hidden="true">
      <div className="animated-bg__glow" />
    </div>
  );
}
