import type { TimelineJsData, TimelineSlide } from './types';

export const TIMELINE_HEIGHT_PX = 360;

/**
 * Knight Lab's TimeNav zoom ladder, truncated.
 *
 * The library ships up to 89×. At that scale it paints tens of thousands of
 * axis ticks (Knight Lab #458). 13× still lets you zoom into a day; it does
 * not try to draw every minute of the week.
 */
export const TIMELINE_ZOOM_SEQUENCE = [0.5, 1, 2, 3, 5, 8, 13] as const;
export const TIMELINE_INITIAL_ZOOM_INDEX = 5;
export const TIMELINE_MAX_ZOOM_INDEX = TIMELINE_ZOOM_SEQUENCE.length - 1;
export const TIMELINE_MAX_SCALE_FACTOR = TIMELINE_ZOOM_SEQUENCE[TIMELINE_MAX_ZOOM_INDEX];
export const TIMELINE_INITIAL_SCALE_FACTOR = TIMELINE_ZOOM_SEQUENCE[TIMELINE_INITIAL_ZOOM_INDEX];
export const MOBILE_TIMELINE_INITIAL_ZOOM_INDEX = 4;
export const MOBILE_TIMELINE_INITIAL_SCALE_FACTOR =
  TIMELINE_ZOOM_SEQUENCE[MOBILE_TIMELINE_INITIAL_ZOOM_INDEX];

type Rgb = { r: number; g: number; b: number };

type TimelineAnimators = {
  ready?: boolean;
  config?: unknown | null;
  animator_storyslider?: { stop?: () => void };
  animator_menubar?: { stop?: () => void };
};

/**
 * TimelineJS has no public destroy(). It always binds window resize and
 * document keydown. Marking the instance inert stops those handlers from
 * doing layout work after we tear the DOM down.
 */
export function inertTimeline(instance: TimelineAnimators | null | undefined): void {
  if (!instance) {
    return;
  }

  instance.ready = false;
  instance.config = null;
  instance.animator_storyslider?.stop?.();
  instance.animator_menubar?.stop?.();
}

/** Rebuild only when the slide set actually changed, not on Apollo array identity. */
export function timelineDeckKey(data: TimelineJsData, startAtSlide: number): string {
  return `${startAtSlide}:${data.events.map((event) => event.unique_id).join(',')}`;
}

/** Slides to add/remove so a live TimelineJS instance can keep a moving buffer. */
export function timelineEventDiff(
  mountedIds: readonly string[],
  nextEvents: readonly TimelineSlide[],
): { add: TimelineSlide[]; removeIds: string[] } {
  const mounted = new Set(mountedIds.filter(Boolean));
  const nextIds = new Set(nextEvents.map((event) => event.unique_id).filter(Boolean));

  return {
    add: nextEvents.filter((event) => event.unique_id && !mounted.has(event.unique_id)),
    removeIds: mountedIds.filter((id) => id && !nextIds.has(id)),
  };
}

export type AxisTickBox = { x: number; halfWidth: number };

/**
 * One left-to-right pass over two already-sorted axes (DOM order = time order).
 *
 * Keep the day (major) labels. Hide a minor label when it would overlap a major
 * label or a minor we already kept — same gap for both, so they densify together.
 */
export function minorLabelsToHide(
  majors: readonly AxisTickBox[],
  minors: readonly AxisTickBox[],
  gap = 8,
): boolean[] {
  const hide = Array.from({ length: minors.length }, () => false);
  let majorIndex = 0;
  let lastKeptRight = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < minors.length; i += 1) {
    const left = minors[i].x - minors[i].halfWidth;
    const right = minors[i].x + minors[i].halfWidth;

    while (majorIndex < majors.length && majors[majorIndex].x + majors[majorIndex].halfWidth + gap < left) {
      majorIndex += 1;
    }

    let collides = left < lastKeptRight + gap;
    if (!collides && majorIndex < majors.length) {
      const majorLeft = majors[majorIndex].x - majors[majorIndex].halfWidth;
      const majorRight = majors[majorIndex].x + majors[majorIndex].halfWidth;
      collides = left < majorRight + gap && right + gap > majorLeft;
    }

    if (collides) {
      hide[i] = true;
    } else {
      lastKeptRight = right;
    }
  }

  return hide;
}

function tickBox(el: HTMLElement, minWidth: number): AxisTickBox {
  const text = el.querySelector<HTMLElement>('.tl-timeaxis-tick-text');
  const x = Number.parseFloat(el.style.left);
  const width = Math.max(text?.offsetWidth ?? 0, el.offsetWidth, minWidth);

  return {
    x: Number.isFinite(x) ? x : el.offsetLeft,
    halfWidth: width / 2,
  };
}

/** Apply {@link minorLabelsToHide} to a TimelineJS TimeAxis already in the DOM. */
export function syncTimeaxisLabelCollision(root: ParentNode): void {
  const majors = [
    ...root.querySelectorAll<HTMLElement>(
      '.tl-timeaxis-major .tl-timeaxis-tick:not(.tl-timeaxis-tick-hidden)',
    ),
  ];
  const minors = [
    ...root.querySelectorAll<HTMLElement>(
      '.tl-timeaxis-minor .tl-timeaxis-tick:not(.tl-timeaxis-tick-hidden)',
    ),
  ];
  const hide = minorLabelsToHide(
    majors.map((el) => tickBox(el, 48)),
    minors.map((el) => tickBox(el, 36)),
  );

  for (let i = 0; i < minors.length; i += 1) {
    const text = minors[i].querySelector<HTMLElement>('.tl-timeaxis-tick-text');
    if (text) {
      text.style.visibility = hide[i] ? 'hidden' : '';
    }
  }
}

/**
 * Construct options: day-scale, local assets, and cheap.
 *
 * `duration: 0` skips Knight Lab's 1s RAF easing. Local `language` avoids
 * cdn.knightlab.com. `font`/`theme` false skips Google Fonts CSS.
 * Do not start at 89× — that TimeNav canvas is the remaining CPU cost.
 *
 * `optimal_tick_width` drives both the major/minor unit ladder and label
 * densify. Smaller → more minor ticks (ruler marks); labels still cull when
 * crowded. 280px was wider than an hour at 8× and wiped hour labels.
 */
/** Target px between labeled ticks; densified ticks stay as short ruler marks. */
export const TIMELINE_OPTIMAL_TICK_WIDTH = 48;
/** Phones need fewer labels and a larger tap target between adjacent moments. */
export const MOBILE_TIMELINE_OPTIMAL_TICK_WIDTH = 64;
export const MOBILE_TIMELINE_NAV_PERCENT = 48;
/** Keep runtime layout on the same side of the app-wide 896px device breakpoint. */
const MOBILE_TIMELINE_MAX_WIDTH = 895;

export function timelineJsOptions({
  width,
  height,
  startAtSlide,
  bg,
  languageUrl,
}: {
  width?: number;
  height?: number;
  startAtSlide: number;
  bg: Rgb;
  languageUrl: string;
}): Record<string, unknown> {
  const mobile = width != null && width <= MOBILE_TIMELINE_MAX_WIDTH;
  const resolvedHeight = height ?? TIMELINE_HEIGHT_PX;
  const initialZoom = mobile ? MOBILE_TIMELINE_INITIAL_ZOOM_INDEX : TIMELINE_INITIAL_ZOOM_INDEX;

  return {
    height: resolvedHeight,
    width,
    timenav_height: mobile ? Math.round(resolvedHeight * (MOBILE_TIMELINE_NAV_PERCENT / 100)) : 72,
    timenav_height_percentage: mobile ? MOBILE_TIMELINE_NAV_PERCENT : 22,
    timenav_mobile_height_percentage: mobile ? MOBILE_TIMELINE_NAV_PERCENT : 40,
    marker_height_min: mobile ? 32 : 24,
    marker_padding: mobile ? 6 : 3,
    start_at_slide: startAtSlide + 1,
    hash_bookmark: false,
    default_bg_color: bg,
    duration: 0,
    dragging: mobile,
    trackResize: false,
    soundcite: false,
    font: false,
    theme: false,
    language: languageUrl,
    optimal_tick_width: mobile ? MOBILE_TIMELINE_OPTIMAL_TICK_WIDTH : TIMELINE_OPTIMAL_TICK_WIDTH,
    scale_factor: mobile ? MOBILE_TIMELINE_INITIAL_SCALE_FACTOR : TIMELINE_INITIAL_SCALE_FACTOR,
    initial_zoom: initialZoom,
    zoom_sequence: [...TIMELINE_ZOOM_SEQUENCE],
  };
}

/** @deprecated Use timelineJsOptions — kept so existing option tests keep compiling. */
export const timelineStoryOptions = timelineJsOptions;
