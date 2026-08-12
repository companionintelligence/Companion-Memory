import { useEffect, useMemo, useRef, useState } from 'react';

import timelineJsUrl from '@knight-lab/timelinejs/dist/js/timeline.js?url';
import '@knight-lab/timelinejs/dist/css/timeline.css';

import type { ScheduleEvent } from '@/api/useScheduleService';

import { buildTodayTimelineData } from './scheduleToTimeline';
import './timelineTheme.css';

interface TodayStoryTimelineProps {
  events: readonly ScheduleEvent[];
  day: Date;
}

type TimelineCtor = new (
  elem: HTMLElement,
  data: unknown,
  options?: Record<string, unknown>,
) => {
  destroy?: () => void;
};

type Rgb = { r: number; g: number; b: number };

let timelineLoad: Promise<TimelineCtor> | null = null;

/**
 * Load TimelineJS as a classic script (not an ESM import).
 *
 * The dist file is a UMD IIFE that assigns `window.TL`. Vite's ESM transform of
 * that file keeps `TL` module-local, so `globalThis.TL` stays undefined and the
 * story strip mounts empty — which is exactly the blank panel we hit.
 */
function loadTimelineCtor(): Promise<TimelineCtor> {
  if (typeof window !== 'undefined' && window.TL?.Timeline) {
    return Promise.resolve(window.TL.Timeline);
  }

  if (!timelineLoad) {
    timelineLoad = new Promise<TimelineCtor>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-timelinejs]');
      if (existing && window.TL?.Timeline) {
        resolve(window.TL.Timeline);

        return;
      }

      const script = existing ?? document.createElement('script');
      script.dataset.timelinejs = '1';
      script.src = timelineJsUrl;
      script.async = true;
      script.onload = () => {
        if (window.TL?.Timeline) {
          resolve(window.TL.Timeline);
        } else {
          timelineLoad = null;
          reject(new Error('TimelineJS loaded without window.TL.Timeline'));
        }
      };

      script.onerror = () => {
        timelineLoad = null;
        reject(new Error('Failed to load TimelineJS script'));
      };

      if (!existing) {
        document.head.appendChild(script);
      }
    });
  }

  return timelineLoad;
}

/** Resolve a CSS color (incl. theme tokens) to RGB for TimelineJS options. */
function cssColorToRgb(cssColor: string, fallback: Rgb): Rgb {
  const probe = document.createElement('div');
  probe.style.backgroundColor = cssColor;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  document.body.removeChild(probe);

  const comma = resolved.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (comma) {
    return { r: Math.round(+comma[1]), g: Math.round(+comma[2]), b: Math.round(+comma[3]) };
  }

  const space = resolved.match(/rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
  if (space) {
    return { r: Math.round(+space[1]), g: Math.round(+space[2]), b: Math.round(+space[3]) };
  }

  return fallback;
}

function timelineBgFromTheme(): Rgb {
  const isDark = document.documentElement.classList.contains('dark');

  return cssColorToRgb('var(--card)', isDark ? { r: 20, g: 28, b: 32 } : { r: 250, g: 250, b: 248 });
}

/**
 * TimelineJS3 storytelling strip for "today" — sits above the week grid.
 *
 * Fixed height; TimelineJS owns its own internal scroll/nav. Dense capture days
 * are sampled (see `scheduleToTimeline`) so the deck stays a readable story,
 * not a dump of every browser tick.
 */
export function TodayStoryTimeline({ events, day }: TodayStoryTimelineProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const data = useMemo(() => buildTodayTimelineData(events, day), [events, day]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [themeKey, setThemeKey] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  );

  // Rebuild when light/dark flips — TimelineJS bakes default_bg_color at construct.
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setThemeKey(root.classList.contains('dark') ? 'dark' : 'light');
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || data.events.length === 0) {
      return;
    }

    let cancelled = false;
    setError(null);
    setReady(false);
    host.replaceChildren();
    const mount = document.createElement('div');
    mount.style.width = '100%';
    mount.style.height = '360px';
    host.appendChild(mount);

    void loadTimelineCtor()
      .then((Timeline) => {
        if (cancelled || !host.contains(mount)) {
          return;
        }

        // Give the browser a paint so the host has a real layout box — TimelineJS
        // measures its container on construct and can paint 0×0 if we race it.
        requestAnimationFrame(() => {
          if (cancelled || !host.contains(mount)) {
            return;
          }

          try {
            new Timeline(mount, data, {
              height: 360,
              width: mount.clientWidth || host.clientWidth || undefined,
              timenav_height: 120,
              timenav_height_percentage: 35,
              marker_height_min: 24,
              marker_padding: 3,
              start_at_slide: 0,
              hash_bookmark: false,
              default_bg_color: timelineBgFromTheme(),
              font: 'Default',
            });
            setReady(true);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'TimelineJS failed to start');
          }
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'TimelineJS failed to load');
        }
      });

    return () => {
      cancelled = true;
      host.replaceChildren();
    };
  }, [data, themeKey]);

  if (data.events.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Today as a story"
      className="schedule-today-timeline overflow-hidden rounded-lg border border-border/80 bg-card/40 shadow-sm"
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-border/60 px-3 py-2">
        <h3 className="text-sm font-semibold text-foreground">Today</h3>
        <span className="text-[11px] tabular-nums text-foreground/80">{data.events.length} slides</span>
      </div>
      {error ? (
        <p role="alert" className="px-3 py-6 text-sm text-muted-foreground">
          Could not open the story view ({error}). The week grid below still works.
        </p>
      ) : (
        <div className="relative h-[360px] w-full">
          {!ready && (
            <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
              Loading story…
            </p>
          )}
          <div ref={hostRef} className="h-full w-full [&_.tl-timeline]:h-full" />
        </div>
      )}
    </section>
  );
}
