import { describe, expect, it } from 'vitest';

import type { ScheduleEvent } from '@/api/useScheduleService';
import {
  ACTIVITY_CLASSES,
  classifyEvent,
  eventColor,
  normalizeClass,
  sourceColor,
  sourceOf,
  LOCAL_SOURCE,
} from '@/lib/activityPalette';

function event(overrides: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    id: 'e1',
    title: 'Standup',
    description: null,
    startTime: new Date(2026, 7, 3, 9, 0).toISOString(),
    endTime: new Date(2026, 7, 3, 9, 30).toISOString(),
    isAllDay: false,
    status: 'confirmed',
    category: null,
    locationName: null,
    ...overrides,
  };
}

describe('classifyEvent — which activity class a committed event belongs to', () => {
  it('takes an already-classified category at its word', () => {
    expect(classifyEvent(event({ category: 'EXERCISE' }))).toBe('EXERCISE');
  });

  it('accepts a class name in any casing', () => {
    expect(classifyEvent(event({ category: 'transit' }))).toBe('TRANSIT');
  });

  it('infers from a specific category before falling back to the title', () => {
    // Title says work; the category is the more reliable signal and wins.
    expect(classifyEvent(event({ category: 'gym_workout', title: 'Sprint review' }))).toBe('EXERCISE');
  });

  it('infers from the title when no category is set', () => {
    expect(classifyEvent(event({ title: 'Backlog Grooming' }))).toBe('WORK');
    expect(classifyEvent(event({ title: 'Flight → SFO' }))).toBe('TRANSIT');
    expect(classifyEvent(event({ title: 'Dinner with Liam' }))).toBe('SOCIAL');
    expect(classifyEvent(event({ title: 'Dentist appointment' }))).toBe('ERRAND');
  });

  it('falls back to UNKNOWN rather than guessing', () => {
    expect(classifyEvent(event({ title: 'Zqx', category: null }))).toBe('UNKNOWN');
  });

  it('does not match a keyword buried inside another word', () => {
    // "runway" is not a run; word boundaries keep the heuristic honest.
    expect(classifyEvent(event({ title: 'Runway deck', category: null }))).toBe('UNKNOWN');
  });

  it('reads "<errand> run" as an errand, not exercise', () => {
    // EXERCISE sits above ERRAND, so a bare `run` alternative used to swallow
    // every errand sense of the noun — a weekly "Grocery Run" rendered as an
    // exercise chip and said so in its own accessible name.
    expect(classifyEvent(event({ title: 'Grocery Run', category: null }))).toBe('ERRAND');
    expect(classifyEvent(event({ title: 'Coffee run', category: null }))).toBe('ERRAND');
    expect(classifyEvent(event({ title: 'School run', category: null }))).toBe('ERRAND');
  });

  it('still reads an actual run as exercise', () => {
    expect(classifyEvent(event({ title: 'Morning run', category: null }))).toBe('EXERCISE');
    expect(classifyEvent(event({ title: 'Run 5k', category: null }))).toBe('EXERCISE');
    expect(classifyEvent(event({ title: 'Long run with Dan', category: null }))).toBe('EXERCISE');
  });

  it('gives every class a distinct colour, and only UNKNOWN the neutral', () => {
    const colors = new Map(
      ACTIVITY_CLASSES.map((cls) => [cls, eventColor(event({ category: cls }), 'type')]),
    );

    expect(new Set(colors.values()).size).toBe(ACTIVITY_CLASSES.length);
    expect(colors.get('UNKNOWN')).toBe('var(--activity-none)');
  });
});

describe('normalizeClass — the rhythm layer’s own labels', () => {
  it('passes a known class through', () => {
    expect(normalizeClass('SOCIAL')).toBe('SOCIAL');
  });

  it('maps anything unrecognised, empty, or absent to UNKNOWN', () => {
    expect(normalizeClass('BRUNCHING')).toBe('UNKNOWN');
    expect(normalizeClass('')).toBe('UNKNOWN');
    expect(normalizeClass(null)).toBe('UNKNOWN');
  });
});

describe('source colouring', () => {
  it('treats an event with no connector as local rather than as a source', () => {
    expect(sourceOf(event({ sourceSystem: null }))).toBe(LOCAL_SOURCE);
    expect(sourceColor(LOCAL_SOURCE)).toBe('var(--activity-none)');
  });

  it('gives known connectors distinct fixed slots', () => {
    const google = sourceColor('google');
    const microsoft = sourceColor('microsoft');

    expect(google).not.toBe(microsoft);
    expect(google).not.toBe('var(--activity-none)');
  });

  it('keeps a connector’s colour stable regardless of what else is synced', () => {
    // Colour follows the source, not its rank in whatever set is on screen —
    // connecting a new calendar must not repaint the ones already there.
    expect(sourceColor('google')).toBe(sourceColor('google'));
    expect(sourceColor('some-self-hosted-caldav')).toBe(sourceColor('some-self-hosted-caldav'));
  });

  it('recognises a connector named with a suffix', () => {
    expect(sourceColor('google_calendar')).toBe(sourceColor('google'));
  });

  it('gives an unknown connector a real hue, never the neutral', () => {
    expect(sourceColor('fastmail')).not.toBe('var(--activity-none)');
  });

  it('colours by source, not by class, in source mode', () => {
    const workFromGoogle = event({ category: 'WORK', sourceSystem: 'google' });
    const gymFromGoogle = event({ category: 'EXERCISE', sourceSystem: 'google' });

    expect(eventColor(workFromGoogle, 'source')).toBe(eventColor(gymFromGoogle, 'source'));
    expect(eventColor(workFromGoogle, 'type')).not.toBe(eventColor(gymFromGoogle, 'type'));
  });
});
