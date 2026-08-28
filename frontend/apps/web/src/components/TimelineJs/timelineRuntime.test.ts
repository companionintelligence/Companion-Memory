import { describe, expect, it, vi } from 'vitest';

import {
  TIMELINE_INITIAL_SCALE_FACTOR,
  TIMELINE_INITIAL_ZOOM_INDEX,
  TIMELINE_MAX_SCALE_FACTOR,
  TIMELINE_MAX_ZOOM_INDEX,
  TIMELINE_OPTIMAL_TICK_WIDTH,
  TIMELINE_ZOOM_SEQUENCE,
  inertTimeline,
  minorLabelsToHide,
  timelineDeckKey,
  timelineEventDiff,
  timelineJsOptions,
} from './timelineRuntime';
import type { TimelineJsData } from './types';

function deck(ids: string[]): TimelineJsData {
  return {
    scale: 'human',
    title: {
      unique_id: 'focus-title',
      start_date: { year: '2026', month: '8', day: '18', hour: '0', minute: '0' },
      text: { headline: 'Today', text: '' },
    },
    events: ids.map((id) => ({
      unique_id: id,
      start_date: { year: '2026', month: '8', day: '18', hour: '9', minute: '0' },
      text: { headline: id, text: '' },
    })),
  };
}

describe('timelineDeckKey', () => {
  it('stays stable when only the array identity changed', () => {
    expect(timelineDeckKey(deck(['a', 'b']), 1)).toBe(timelineDeckKey(deck(['a', 'b']), 1));
  });

  it('changes when the slide set or landing index changes', () => {
    expect(timelineDeckKey(deck(['a', 'b']), 0)).not.toBe(timelineDeckKey(deck(['a', 'b']), 1));
    expect(timelineDeckKey(deck(['a']), 0)).not.toBe(timelineDeckKey(deck(['a', 'b']), 0));
  });
});

describe('timelineJsOptions', () => {
  it('turns off the 1s Knight Lab easing and analytics-adjacent extras', () => {
    const options = timelineJsOptions({
      width: 800,
      startAtSlide: 0,
      bg: { r: 1, g: 2, b: 3 },
      languageUrl: '/locale/en.json',
    });

    expect(options.duration).toBe(0);
    expect(options.trackResize).toBe(false);
    expect(options.hash_bookmark).toBe(false);
    expect(options.soundcite).toBe(false);
    expect(options.dragging).toBe(false);
    expect(options.optimal_tick_width).toBe(TIMELINE_OPTIMAL_TICK_WIDTH);
    expect(options.optimal_tick_width).toBe(48);
  });

  it('caps TimeNav zoom so it does not paint tens of thousands of ticks', () => {
    const options = timelineJsOptions({
      startAtSlide: 0,
      bg: { r: 250, g: 250, b: 248 },
      languageUrl: '/locale/en.json',
    });

    expect(TIMELINE_ZOOM_SEQUENCE[TIMELINE_MAX_ZOOM_INDEX]).toBe(13);
    expect(TIMELINE_MAX_SCALE_FACTOR).toBe(13);
    expect(options.scale_factor).toBe(TIMELINE_INITIAL_SCALE_FACTOR);
    expect(options.scale_factor).toBe(8);
    expect(options.initial_zoom).toBe(TIMELINE_INITIAL_ZOOM_INDEX);
    expect(options.zoom_sequence).toEqual([0.5, 1, 2, 3, 5, 8, 13]);
  });

  it('does not pull Knight Lab fonts, theme, or locale from their CDN', () => {
    const options = timelineJsOptions({
      startAtSlide: 2,
      bg: { r: 20, g: 28, b: 32 },
      languageUrl: '/assets/en-local.json',
    });

    expect(options.font).toBe(false);
    expect(options.theme).toBe(false);
    expect(options.soundcite).toBe(false);
    expect(options.language).toBe('/assets/en-local.json');
    expect(options.start_at_slide).toBe(3);
  });
});

describe('minorLabelsToHide', () => {
  it('keeps minors that sit in the gaps between majors', () => {
    const hide = minorLabelsToHide(
      [
        { x: 0, halfWidth: 20 },
        { x: 200, halfWidth: 20 },
      ],
      [
        { x: 80, halfWidth: 16 },
        { x: 120, halfWidth: 16 },
      ],
    );

    expect(hide).toEqual([false, false]);
  });

  it('hides a minor that overlaps a major label and packed neighbours', () => {
    const hide = minorLabelsToHide(
      [{ x: 100, halfWidth: 30 }],
      [
        { x: 100, halfWidth: 20 },
        { x: 160, halfWidth: 20 },
        { x: 175, halfWidth: 20 },
      ],
    );

    expect(hide[0]).toBe(true);
    expect(hide[1]).toBe(false);
    expect(hide[2]).toBe(true);
  });
});

describe('inertTimeline', () => {
  it('stops leftover animators and makes resize/keydown handlers no-ops', () => {
    const stopSlider = vi.fn();
    const stopMenu = vi.fn();
    const instance = {
      ready: true,
      config: { events: [] },
      animator_storyslider: { stop: stopSlider },
      animator_menubar: { stop: stopMenu },
    };

    inertTimeline(instance);

    expect(instance.ready).toBe(false);
    expect(instance.config).toBeNull();
    expect(stopSlider).toHaveBeenCalledTimes(1);
    expect(stopMenu).toHaveBeenCalledTimes(1);
  });
});

describe('timelineEventDiff', () => {
  it('adds newly appeared slides and removes ones that left the window', () => {
    const next = deck(['b', 'c', 'd']);
    const { add, removeIds } = timelineEventDiff(['a', 'b', 'c'], next.events);

    expect(add.map((event) => event.unique_id)).toEqual(['d']);
    expect(removeIds).toEqual(['a']);
  });
});
