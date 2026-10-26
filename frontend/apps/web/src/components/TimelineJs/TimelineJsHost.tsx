import { useEffect, useRef, useState } from 'react';

import { cn } from '@ci/shadcn';
import timelineCssUrl from '@knight-lab/timelinejs/dist/css/timeline.css?url';
import timelineLocaleUrl from '@knight-lab/timelinejs/dist/js/locale/en.json?url';
import timelineJsUrl from '@knight-lab/timelinejs/dist/js/timeline.js?url';

import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import type { TimeFormat } from '@/lib/dateTimeFormat';

import timelineLocaleH23Url from './locale/en-h23.json?url';
import {
  TIMELINE_HEIGHT_PX,
  inertTimeline,
  syncTimeaxisLabelCollision,
  timelineDeckKey,
  timelineEventDiff,
  timelineJsOptions,
} from './timelineRuntime';
import type { TimelineJsData, TimelineSlide } from './types';
import './timelineTheme.css';

interface TimelineJsHostProps {
  data: TimelineJsData;
  startAtSlide: number;
  className?: string;
  /** Used when the host has no layout box yet (flex child before first paint). */
  fallbackHeightPx?: number;
  /**
   * When set, the instance remounts only if this identity changes. New slides
   * are added in place so an unfiltered buffer can grow without a flash.
   */
  sessionKey?: string;
  onSlideChange?: (uniqueId: string) => void;
  /** User tapped a slide or marker — not next/previous, zoom, or landing `change`. */
  onSlideOpen?: (uniqueId: string) => void;
}

type TimelineInstance = {
  ready?: boolean;
  current_id?: string;
  config?: { events?: Array<{ unique_id?: string }> } | null;
  animator_storyslider?: { stop?: () => void };
  animator_menubar?: { stop?: () => void };
  destroy?: () => void;
  on?: (event: string, callback: (payload?: { unique_id?: string }) => void) => void;
  add?: (data: unknown) => void;
  removeId?: (id: string) => void;
};

type TimelineCtor = new (
  elem: HTMLElement,
  data: unknown,
  options?: Record<string, unknown>,
) => TimelineInstance;

function mountedEventIds(instance: TimelineInstance): string[] {
  return (instance.config?.events ?? [])
    .map((event) => event.unique_id)
    .filter((id): id is string => Boolean(id));
}

function syncTimelineEvents(instance: TimelineInstance, events: readonly TimelineSlide[]): void {
  // TimelineJS parses its deck only after an asynchronous language load, and
  // `add()` dereferences `this.config` unguarded. Before that point there is
  // nothing to diff against — every slide would look new — so wait: the host
  // only flips `ready` on the library's own `loaded` event, which re-runs this.
  if (!instance.config) {
    return;
  }

  const { add, removeIds } = timelineEventDiff(mountedEventIds(instance), events);

  for (const event of add) {
    instance.add?.(event);
  }

  for (const id of [...removeIds].reverse()) {
    if (id !== instance.current_id) {
      instance.removeId?.(id);
    }
  }
}

type Rgb = { r: number; g: number; b: number };

/**
 * The locale TimelineJS writes its own slide dates and axis ticks in.
 *
 * Those labels never pass through `useDateTimeFormat()`: the library formats them from the
 * `dateformats` of a locale file, and its English one is 12-hour ("3:43 PM", "3 PM"). So 24-hour
 * loads `locale/en-h23.json` — the same patterns with the clock written 24-hour ("15:43",
 * "15:00") and everything else inherited from the built-in English. 'auto' and 12-hour keep the
 * library's own file, which is what every timeline showed before the preference existed.
 */
function timelineLocaleFor(timeFormat: TimeFormat): string {
  return timeFormat === 'h23' ? timelineLocaleH23Url : timelineLocaleUrl;
}

let timelineLoad: Promise<TimelineCtor> | null = null;

function ensureTimelineCss(): Promise<void> {
  const existing = document.querySelector<HTMLLinkElement>('link[data-timelinejs-css]');
  if (existing) {
    return existing.sheet
      ? Promise.resolve()
      : new Promise((resolve) => {
          existing.addEventListener('load', () => resolve(), { once: true });
          existing.addEventListener('error', () => resolve(), { once: true });
        });
  }

  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = timelineCssUrl;
    link.dataset.timelinejsCss = '1';
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });
}

/**
 * Load TimelineJS as a classic script (not an ESM import).
 *
 * The dist file is a UMD IIFE that assigns `window.TL`. Vite's ESM transform of
 * that file keeps `TL` module-local, so `globalThis.TL` stays undefined and the
 * story mounts empty.
 *
 * CSS is injected here too, instead of a static import, so the rest of Memory
 * does not wait on Knight Lab's 96kb stylesheet.
 */
function loadTimelineCtor(): Promise<TimelineCtor> {
  if (typeof window !== 'undefined' && window.TL?.Timeline) {
    const Timeline = window.TL.Timeline;

    return ensureTimelineCss().then(() => Timeline);
  }

  if (!timelineLoad) {
    timelineLoad = Promise.all([ensureTimelineCss(), loadTimelineScript()]).then(([, Timeline]) => Timeline);
  }

  return timelineLoad;
}

function loadTimelineScript(): Promise<TimelineCtor> {
  return new Promise<TimelineCtor>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-timelinejs]');
    if (existing && window.TL?.Timeline) {
      resolve(window.TL.Timeline);

      return;
    }

    // A tag left without `window.TL` is one whose load already failed (while a
    // load is in flight, `timelineLoad` keeps us from getting here). A script
    // element fetches once, when it is inserted, and setting the same `src`
    // again does nothing, so reusing it left Try again on "Loading timeline…"
    // for good. Swap in a fresh tag, which fetches again.
    existing?.remove();

    const script = document.createElement('script');
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

    document.head.appendChild(script);
  });
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
 * TimelineJS3 host — mounts Knight Lab against a JSON deck.
 *
 * Remounts when {@link TimelineJsHostProps.sessionKey} (or the slide ids, when
 * no session is given) changes. Hidden chrome and CDN extras stay off; see
 * {@link timelineJsOptions}.
 */
export function TimelineJsHost({
  data,
  startAtSlide,
  className,
  fallbackHeightPx = TIMELINE_HEIGHT_PX,
  sessionKey,
  onSlideChange,
  onSlideOpen,
}: TimelineJsHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<TimelineInstance | null>(null);
  const onSlideChangeRef = useRef(onSlideChange);
  onSlideChangeRef.current = onSlideChange;
  const onSlideOpenRef = useRef(onSlideOpen);
  onSlideOpenRef.current = onSlideOpen;
  const deckKey = timelineDeckKey(data, startAtSlide);
  const [generation, setGeneration] = useState(0);
  const { timeFormat } = useDateTimeFormat();
  // TimelineJS reads its locale once, at construction, so a new time format means a new instance.
  const languageUrl = timelineLocaleFor(timeFormat);
  const mountKey = `${sessionKey ?? deckKey}:${languageUrl}:${generation}`;
  const payloadRef = useRef({ data, startAtSlide, fallbackHeightPx, languageUrl });
  payloadRef.current = { data, startAtSlide, fallbackHeightPx, languageUrl };
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const {
      data: deck,
      startAtSlide: landing,
      fallbackHeightPx: minHeight,
      languageUrl: language,
    } = payloadRef.current;
    if (!host || deck.events.length === 0) {
      return;
    }

    let cancelled = false;
    setError(null);
    setReady(false);
    inertTimeline(instanceRef.current);
    instanceRef.current = null;
    host.replaceChildren();
    const mount = document.createElement('div');
    mount.style.width = '100%';
    mount.style.height = '100%';
    mount.style.minHeight = `${minHeight}px`;
    host.appendChild(mount);

    const onVisibility = () => {
      const instance = instanceRef.current;
      if (!instance) {
        return;
      }

      // Pause animators in a background tab. Do not key this off intersection:
      // a 0-height first paint (or a sheet covering the pane on a phone) used
      // to set ready=false and leave a blank host after "Loading timeline…".
      instance.ready = !document.hidden;
    };

    document.addEventListener('visibilitychange', onVisibility);

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
            const height = Math.max(mount.clientHeight || host.clientHeight || 0, minHeight);
            mount.style.height = `${height}px`;
            const instance = new Timeline(
              mount,
              deck,
              timelineJsOptions({
                width: mount.clientWidth || host.clientWidth || undefined,
                height,
                startAtSlide: landing,
                bg: timelineBgFromTheme(),
                languageUrl: language,
              }),
            );
            instanceRef.current = instance;
            const syncAxis = () => syncTimeaxisLabelCollision(mount);
            instance.on?.('zoom_in', syncAxis);
            instance.on?.('zoom_out', syncAxis);
            instance.on?.('change', (payload) => {
              const id = payload?.unique_id;
              if (id) {
                onSlideChangeRef.current?.(id);
              }
            });
            mount.addEventListener('click', (event) => {
              if (!(event.target instanceof Element)) {
                return;
              }

              if (event.target.closest('.tl-menubar-button, .tl-slidenav-next, .tl-slidenav-previous')) {
                requestAnimationFrame(syncAxis);

                return;
              }

              if (event.target.closest('.tl-slide, .tl-timemarker')) {
                const id = instance.current_id;
                if (id) {
                  onSlideOpenRef.current?.(id);
                }
              }
            });
            // The constructor returns before the timeline exists: TimelineJS
            // loads its language file first (always a promise, even when
            // cached) and only then parses the deck, sets `config`, and lays
            // out its panes. Marking the host ready here used to let the sync
            // effect call `add()` into a null `config` on a cold load — the
            // language fetch was still in flight when React ran its effects,
            // while a warm reload had it cached and resolved in a microtask
            // that beat them. `loaded` fires once both panes are built; an
            // instance that already has a config (a synchronous build in some
            // future version) is treated as loaded now, since the event may
            // already have fired.
            const markReady = () => {
              if (cancelled || instanceRef.current !== instance) {
                return;
              }

              // Pause animators in a background tab (TimelineJS sets its own
              // `ready` true during startup, so this has to come after it).
              instance.ready = !document.hidden;
              requestAnimationFrame(syncAxis);
              setReady(true);
            };

            if (instance.config || !instance.on) {
              markReady();
            } else {
              instance.on('loaded', markReady);
            }
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
      document.removeEventListener('visibilitychange', onVisibility);
      inertTimeline(instanceRef.current);
      instanceRef.current = null;
      host.replaceChildren();
    };
  }, [mountKey]);

  useEffect(() => {
    if (!sessionKey || !ready) {
      return;
    }

    const instance = instanceRef.current;
    if (!instance) {
      return;
    }

    syncTimelineEvents(instance, data.events);
  }, [data.events, ready, sessionKey]);

  if (error) {
    return (
      <div role="alert" className="flex flex-col items-center justify-center gap-3 px-3 py-6 text-center">
        <p className="text-sm text-muted-foreground">Could not open the timeline ({error}).</p>
        <button
          type="button"
          className="text-sm font-medium text-primary hover:underline"
          onClick={() => {
            setError(null);
            setGeneration((current) => current + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className={cn('ci-timeline-js relative h-full min-h-[16rem] w-full', className)}>
      {!ready && (
        <p className="absolute inset-0 z-10 flex items-center justify-center text-xs text-muted-foreground">
          Loading timeline…
        </p>
      )}
      <div ref={hostRef} className="h-full min-h-[16rem] w-full [&_.tl-timeline]:h-full" />
    </div>
  );
}
