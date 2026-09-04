import { useCallback, useEffect, useMemo, useState, type ElementType } from 'react';

import { EmptyState, LoadingPage, useDeviceLayout, usePageTitle } from '@ci/common';
import { Button, IconButton, cn } from '@ci/shadcn';
import { CalendarRange, ChevronLeft, ChevronRight } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { useForecastService } from '@/api/useForecastService';
import { useRescheduleEvent } from '@/api/useRescheduleEvent';
import { type RhythmDay, type ScheduleEvent, useScheduleService } from '@/api/useScheduleService';
import { useFeatures } from '@/common/feature';
import { VerticalCalendar } from '@/components/HorizonGrid';
import {
  type CalendarSlot,
  RHYTHM_NOISE_FLOOR,
  daypartWeights,
  slotForecastLine,
} from '@/components/HorizonGrid/scheduleGeometry';
import { TodayNowNext, WeekDayChips } from '@/components/HorizonGrid/TodayNowNext';
import { PageContent } from '@/components/layout';
import { TaskSlateDrawer } from '@/components/TaskSlate';
import {
  type ActivityClass,
  type ColorMode,
  ACTIVITY_CLASSES,
  CLASS_LABEL,
  classColor,
  classifyEvent,
  normalizeClass,
  sourceColor,
  sourceLabel,
  sourceOf,
} from '@/lib/activityPalette';
import { usePlanTasks } from '@/pages/PlanPage/usePlanTasks';

import { PredictionBand } from './PredictionBand';

const DAYS_IN_VIEW = 7;

function startOfLocalDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);

  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);

  return d;
}

/** "Aug 3 – Aug 9" — the window, stated plainly. */
function formatRange(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

  return `${start.toLocaleDateString([], opts)} – ${addDays(end, -1).toLocaleDateString([], opts)}`;
}

/**
 * What the grid's footer is allowed to claim about the rhythm layer.
 *
 * `weekForecast` takes no date arguments, so the layer only ever describes the
 * seven days from today. Saying "updated <date>" over a lane that has nothing
 * to draw reads as "the model has learned nothing about you" — a different and
 * much worse statement than "this view cannot fetch that week".
 *
 * Three-way branch: `hbpeEnabled` is the sole "is it off" signal (the local
 * flags fetch, same source of truth as the backend FeatureService) — a falsy
 * `generatedAt` no longer implies "off" by itself. With the flag off, the
 * layer really is off. With the flag on but `generatedAt` still falsy, the
 * resolver's try/catch (ForecastResolver.ts) swallowed a real HBPE failure —
 * a genuinely untrained model returns real data with
 * systemStatus: 'COLD_START' instead, so a null `weekForecast` here can only
 * mean the call failed, never "not started yet". Only once the flag is on, the
 * data resolved, `coversWindow` holds AND the window actually contains a
 * pattern the grid will draw does the success copy apply.
 */
function rhythmFooter(
  generatedAt: string | null,
  coversWindow: boolean,
  hbpeEnabled: boolean,
  pipelineRunning = false,
  hasRhythmSignal = false,
): string {
  if (!hbpeEnabled) {
    return 'HBPE rhythm forecast is off — showing committed time only.';
  }

  if (pipelineRunning && !hasRhythmSignal) {
    return 'Predict is still running — the boxes on the left will fill in. This can take a while.';
  }

  if (!generatedAt) {
    return "Couldn't reach the rhythm forecast just now — showing committed time only.";
  }

  if (!coversWindow) {
    return 'HBPE rhythm only covers the next seven days — this week shows committed time only.';
  }

  // A forecast that resolved for the right window can still carry nothing the
  // grid will draw: `week_forecast` returns a row per day whether or not any
  // recurrence profile qualified, so a cold or thin model answers with seven
  // empty days. Claiming "from your history, updated <date>" over strips that
  // are all decoration is the same lie the `coversWindow` branch above exists
  // to prevent — the footer has to follow the ink, not the envelope.
  if (!hasRhythmSignal) {
    return 'No rhythm pattern learned for this week yet — showing committed time only.';
  }

  const updated = new Date(generatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' });

  return `Pattern rhythm (HBPE) from your history, updated ${updated}.`;
}

const COLOR_MODE_LABEL: Record<ColorMode, string> = {
  type: 'Activity',
  source: 'Source',
};

/**
 * The activity classes and sources the visible window actually contains.
 *
 * Both lanes contribute a class: one the rhythm predicts but you have not
 * committed to is exactly the kind of thing this page exists to show.
 */
function windowVocabulary(events: ScheduleEvent[], rhythm: RhythmDay[]) {
  const classes = new Set<ActivityClass>(events.map(classifyEvent));

  for (const day of rhythm) {
    for (const cluster of day.clusters) {
      classes.add(normalizeClass(cluster.l0Class));
    }
  }

  return { classes, sources: new Set(events.map(sourceOf)) };
}

/**
 * Whether hue is carrying information this week.
 *
 * Activity / Source is a choice between two readings of the same marks, and
 * both collapse to one colour when the window holds a single class and a single
 * source — at which point the control and its legend are chrome that answers a
 * question nothing on screen is asking. An empty week is the extreme case of
 * that, not a special case, so this is derived from what loaded rather than
 * from the viewport.
 */
function colorSaysSomething(events: ScheduleEvent[], rhythm: RhythmDay[]): boolean {
  const { classes, sources } = windowVocabulary(events, rhythm);

  return classes.size > 1 || sources.size > 1;
}

/** One swatch + word. The word is why hue never carries identity alone. */
function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

/**
 * The key for what is actually on screen this week — not the whole vocabulary.
 *
 * Listing all eight classes when the week holds two is noise, and it would make
 * the legend the widest thing in the header.
 */
function ScheduleLegend({
  mode,
  events,
  rhythm,
}: {
  mode: ColorMode;
  events: ScheduleEvent[];
  rhythm: RhythmDay[];
}) {
  const keys = useMemo(() => {
    const { classes, sources } = windowVocabulary(events, rhythm);

    if (mode === 'source') {
      return [...sources].sort().map((source) => ({
        key: source,
        color: sourceColor(source),
        label: sourceLabel(source),
      }));
    }

    return ACTIVITY_CLASSES.filter((cls) => classes.has(cls)).map((cls) => ({
      key: cls,
      color: classColor(cls),
      label: CLASS_LABEL[cls],
    }));
  }, [mode, events, rhythm]);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {keys.map(({ key, color, label }) => (
        <LegendKey key={key} color={color} label={label} />
      ))}
    </div>
  );
}

export interface SchedulePageProps {
  /**
   * Rendered inside a host page (Today) that already owns the document title
   * and the page frame. Embedded, this contributes the schedule and nothing
   * else — PageContent is the page's scroll container, so a second one nests
   * its padding and its scrollbar inside the host's.
   */
  embedded?: boolean;
}

export function SchedulePage({ embedded = false }: SchedulePageProps = {}) {
  const { t } = useTranslation();
  const { isMobile } = useDeviceLayout();
  const { isFeatureEnabled } = useFeatures();
  const hbpeEnabled = isFeatureEnabled('hbpe');
  const forecastPageEnabled = isFeatureEnabled('forecast.page');
  const [weekOffset, setWeekOffset] = useState(0);
  const [colorMode, setColorMode] = useState<ColorMode>('type');
  const [slot, setSlot] = useState<CalendarSlot | null>(null);

  usePageTitle(embedded ? null : 'Schedule - Companion Intelligence');

  const { start, end } = useMemo(() => {
    const from = addDays(startOfLocalDay(new Date()), weekOffset * DAYS_IN_VIEW);

    return { start: from, end: addDays(from, DAYS_IN_VIEW) };
  }, [weekOffset]);

  const [selectedDay, setSelectedDay] = useState(start);

  // ═══ WHAT THIS USED TO DO ═══
  // Move the selected day and leave `slot` alone, so paging a week with the
  // drawer open kept composing against the day that had just scrolled off
  // screen: "New event" → Add, or a Possibilities card, landed on last week.
  useEffect(() => {
    setSelectedDay(start);
    setSlot(null);
  }, [start]);

  const { events, rhythm, generatedAt, rhythmCoversWindow, loading, fetching, error, refetch } =
    useScheduleService(start, end);
  // The band's retry has to come from here: a swallowed HBPE error resolves as
  // `null`, `useForecastService` reads that as "nothing to poll for" and stops
  // polling, so unless `refetch` is threaded down there is no way back from the
  // unavailable state short of leaving the page and returning.
  const [
    { data: occupancy, loading: occupancyLoading, stalled: occupancyStalled },
    { refetch: refetchForecast },
  ] = useForecastService();
  const pipelineRunning = Boolean(
    hbpeEnabled && Boolean(occupancy?.systemStatus?.includes(':')) && !occupancyStalled,
  );
  // "Has signal" has to mean what the grid draws, not what the payload holds:
  // the strip lights a cell only at or above RHYTHM_NOISE_FLOOR, so a day of
  // clusters that all fall under it renders exactly like a day of no clusters
  // at all. Measuring the same weights the strip does keeps the footer from
  // announcing a layer the user cannot see.
  const hasRhythmSignal = rhythm.some((day) =>
    daypartWeights(day).some((weight) => weight >= RHYTHM_NOISE_FLOOR),
  );

  // Placing a backlog task mints a planned block, so the committed lane has to re-read.
  const {
    backlog,
    backlogCount,
    loading: planLoading,
    error: planError,
    placeOnDay,
    dismissProposed,
  } = usePlanTasks(refetch);

  /**
   * Whatever a drag or a card button asked the server to do, and it refused.
   *
   * Every one of these mutations is fire-and-forget from the user's point of
   * view — the card stays on the rail, or the chip snaps back — so without this
   * a rejection is only ever visible in the console.
   */
  const [actionError, setActionError] = useState<string | null>(null);

  const run = useCallback((work: Promise<unknown>, message: string) => {
    setActionError(null);
    work.catch(() => setActionError(message));
  }, []);

  const handleSelectSlot = useCallback((next: CalendarSlot) => {
    setSlot(next);
    setSelectedDay(startOfLocalDay(next.instant));
  }, []);

  /**
   * The slot and the visible window are one selection.
   *
   * Paging the week clears it (the effect above), but on the phone the window
   * is a SINGLE day and the day chips are what move it — so changing the chip
   * has to clear the slot too. Without this the grid showed Wednesday while the
   * open drawer still wrote to Monday. On a week-wide window the slot stays on
   * screen, so picking a day column there is not a reason to drop it.
   */
  const handleSelectDay = useCallback(
    (day: Date) => {
      setSelectedDay(day);

      if (isMobile) {
        setSlot(null);
      }
    },
    [isMobile],
  );

  const handlePlace = useCallback(
    (taskId: string) => {
      if (!slot) {
        return;
      }

      const at = slot.allDay ? startOfLocalDay(slot.instant) : slot.instant;
      run(placeOnDay(taskId, at), 'Could not put that on the calendar. Try again shortly.');
    },
    [placeOnDay, run, slot],
  );

  const slotInsight = useMemo(() => {
    if (!slot || !hbpeEnabled || !rhythmCoversWindow) {
      return null;
    }

    const lookup = (key: string) => rhythm.find((day) => day.date === key);

    return slotForecastLine(slot, lookup);
  }, [hbpeEnabled, rhythm, rhythmCoversWindow, slot]);

  const rescheduleEvent = useRescheduleEvent(refetch);

  const handleMove = useCallback(
    (eventId: string, startTime: Date) => {
      run(rescheduleEvent(eventId, startTime), 'Could not move that. Try again shortly.');
    },
    [rescheduleEvent, run],
  );

  const handleDismissProposed = useCallback(
    (id: string) => {
      run(dismissProposed(id), 'Could not dismiss that task. Try again shortly.');
    },
    [dismissProposed, run],
  );

  const goBack = useCallback(() => setWeekOffset((offset) => offset - 1), []);
  const goForward = useCallback(() => setWeekOffset((offset) => offset + 1), []);
  const goToday = useCallback(() => setWeekOffset(0), []);

  // `errorPolicy: 'all'` means an error and usable data can arrive together, so
  // the surface is gated on whether anything resolved rather than on `error`.
  const hasAnything = events.length > 0 || rhythm.length > 0 || backlogCount > 0;
  const isTrulyEmpty = !loading && !fetching && !hasAnything && !error && !planError && weekOffset === 0;
  const showScheduleSurface = weekOffset !== 0 || hasAnything || planError || fetching;

  // Embedded, the host (Calendar) supplies the frame and is otherwise empty —
  // this is the whole page now, not one block in a taller scrolling column —
  // so it takes the host's full height (`flex-1 min-h-0`) rather than sizing
  // to its own content, and the calendar grid inside gets a real, bounded
  // height to fill and scroll within instead of a viewport-fraction cap.
  //
  // `relative` is not decoration: LoadingPage is `absolute inset-0 z-10`, so
  // without a positioned boundary here it anchors to the HOST's PageContent
  // and blankets the page.
  //
  // `PageContent` is a stable module-level reference and `'div'` is a string,
  // so `Frame` keeps the same element type across renders — no remounting, and
  // `weekOffset` / `selectedDay` survive the host re-rendering.
  const Frame: ElementType = embedded ? 'div' : PageContent;

  // Shown only once hue has more than one thing to say — see `colorSaysSomething`.
  const colorKey = useMemo(() => colorSaysSomething(events, rhythm), [events, rhythm]);

  const colorModeToggle = (
    <div
      role="radiogroup"
      aria-label={
        colorMode === 'type'
          ? 'Colour by activity type — what kind of activity'
          : 'Colour by source — which calendar or connector'
      }
      title={colorMode === 'type' ? 'What kind of activity' : 'Which calendar or connector'}
      className="flex shrink-0 items-center rounded-md border border-border p-0.5"
    >
      {(['type', 'source'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={colorMode === mode}
          onClick={() => setColorMode(mode)}
          className={cn(
            'rounded-[4px] px-2 py-0.5 text-[11px] leading-none transition-colors',
            colorMode === mode
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {COLOR_MODE_LABEL[mode]}
        </button>
      ))}
    </div>
  );

  // Hue answers one question at a time; this picks which one. Committed time
  // and rhythm stay told apart by their lanes and by fill weight, so colour is
  // free to carry category instead of certainty — but only while the week holds
  // more than one category to tell apart.
  const colorChrome = colorKey ? (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
      <ScheduleLegend mode={colorMode} events={events} rhythm={rhythm} />
      {colorModeToggle}
    </div>
  ) : null;

  // Week chrome: range, legend, activity/source. Lives under the TimelineJS
  // today strip and immediately above the week so it sits next to schedule /
  // rhythm instead of floating above the zoomable story.
  const weekChrome = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <div className="flex items-center gap-0.5">
        <IconButton variant="ghost" label={t('SCHEDULE_PREVIOUS_WEEK')} onClick={goBack}>
          <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
        </IconButton>
        <h2 className="min-w-[9rem] text-center text-base font-semibold text-foreground tabular-nums">
          {formatRange(start, end)}
        </h2>
        <IconButton variant="ghost" label={t('SCHEDULE_NEXT_WEEK')} onClick={goForward}>
          <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
        </IconButton>
      </div>

      {weekOffset !== 0 && (
        <Button variant="ghost" size="sm" onClick={goToday} className="h-7 text-xs">
          Back to today
        </Button>
      )}

      {colorChrome && <div className="ml-auto">{colorChrome}</div>}
    </div>
  );

  return (
    <>
      <Frame className={embedded ? 'relative flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3' : 'gap-3'}>
        {fetching && !hasAnything && <LoadingPage />}

        {actionError && (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        )}

        {error && !loading && (
          <p role="alert" className="text-sm text-muted-foreground">
            {hasAnything
              ? 'Part of this week could not be loaded — what is shown may be incomplete.'
              : 'Could not load the schedule. Try again shortly.'}
          </p>
        )}

        {hbpeEnabled && (
          <PredictionBand
            forecast={occupancy}
            loading={occupancyLoading}
            stalled={occupancyStalled}
            showFullForecastLink={forecastPageEnabled}
            onRetry={refetchForecast}
          />
        )}

        {isTrulyEmpty && (
          <>
            {weekChrome}
            <EmptyState
              icon={<CalendarRange size={48} strokeWidth={1} />}
              message="Nothing here yet. Connect a calendar and your week will start to fill in."
            />
          </>
        )}

        {showScheduleSurface && (
          <>
            {/* One schedule, one geometry. Week chrome, then the week — where
                what a day usually holds rides in beside the hours rather than
                as a second tab of the same seven days. */}
            <div className={cn('flex min-h-0 flex-1 flex-col', isMobile ? 'gap-3' : 'gap-4')}>
              {isMobile ? (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <div className="flex items-center gap-0.5">
                      <IconButton variant="ghost" label={t('SCHEDULE_PREVIOUS_WEEK')} onClick={goBack}>
                        <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
                      </IconButton>
                      <h2 className="min-w-[8rem] text-center text-sm font-semibold text-foreground tabular-nums">
                        {formatRange(start, end)}
                      </h2>
                      <IconButton variant="ghost" label={t('SCHEDULE_NEXT_WEEK')} onClick={goForward}>
                        <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
                      </IconButton>
                    </div>

                    {weekOffset !== 0 && (
                      <Button variant="ghost" size="sm" onClick={goToday} className="h-8 text-xs">
                        Back to today
                      </Button>
                    )}
                  </div>

                  <WeekDayChips
                    start={start}
                    days={DAYS_IN_VIEW}
                    selectedDay={selectedDay}
                    onSelectDay={handleSelectDay}
                  />

                  {colorChrome}
                </div>
              ) : (
                weekChrome
              )}

              {isMobile && <TodayNowNext events={events} day={selectedDay} />}

              <VerticalCalendar
                className="min-h-0 flex-1"
                start={isMobile ? selectedDay : start}
                days={isMobile ? 1 : DAYS_IN_VIEW}
                events={events}
                rhythm={rhythm}
                colorMode={colorMode}
                pipelineRunning={pipelineRunning}
                selectedDay={selectedDay}
                onSelectDay={handleSelectDay}
                selectedSlot={slot}
                onSelectSlot={handleSelectSlot}
                onMoveEvent={handleMove}
                footer={rhythmFooter(
                  generatedAt,
                  rhythmCoversWindow,
                  hbpeEnabled,
                  pipelineRunning,
                  hasRhythmSignal,
                )}
              />

              <TaskSlateDrawer
                open={slot !== null}
                onOpenChange={(open) => {
                  if (!open) {
                    setSlot(null);
                  }
                }}
                slot={slot}
                insight={slotInsight}
                sections={backlog}
                loading={planLoading}
                error={planError}
                onDismissProposed={handleDismissProposed}
                onPlace={handlePlace}
                onCreated={refetch}
              />
            </div>
          </>
        )}
      </Frame>
    </>
  );
}
