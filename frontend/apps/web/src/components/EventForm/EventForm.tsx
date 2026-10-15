import { type ReactNode, useId, useState } from 'react';

import { Button, Checkbox, Input, Label, Textarea } from '@ci/shadcn';

import type { PlaceLookup } from '@/api/usePlaceLookup';

import type { EventDraft, EventDraftProblem } from './eventDraft';

/**
 * Suggestions, not a closed set. `event_type` is free text server-side (imports
 * carry kinds no dropdown would predict), so the common ones are offered
 * through a `datalist` and the user can always type their own.
 *
 * Blank is the meaningful default and is NOT in this list: CalendarEventService only
 * puts calendar kinds and rows with no `event_type` on the Schedule, so an
 * untyped event is the one that shows up there.
 */
const EVENT_TYPE_SUGGESTIONS = ['calendar_event', 'meeting', 'appointment', 'visited', 'traveled'];

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** Native date and time controls get a plain box on touch devices; see `Field`. */
const PLAIN_PICKER = 'pointer-coarse:appearance-none';

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  type,
  listId,
  step,
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  listId?: string;
  step?: string;
  inputMode?: 'decimal' | 'numeric' | 'text';
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type={type}
        step={step}
        inputMode={inputMode}
        list={listId}
        value={value}
        placeholder={placeholder}
        // WebKit sizes a native date or time control's `width: 100%` as the
        // CONTENT box and adds its padding and border on top — 28pt too wide
        // for the cell it sits in on iOS, so Starts/Ends ran under the clock
        // beside them and the clock ran off the row's edge. Neither `min-w-0`
        // nor the flex cell can help; an ordinary box can. The native picker
        // still opens on tap.
        className={type === 'date' || type === 'time' ? PLAIN_PICKER : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/**
 * One line of "when": a single word above a date and, unless all-day, a clock
 * beside it. One label for the pair — "Starts" over a date and "At" over its
 * clock read as two unrelated fields, and the clock's own name moves to
 * `aria-label` so it stays nameable without a second caption.
 *
 * Always its own row. Two of these side by side looked fine on a wide form,
 * but the calendar's slot drawer is a narrow panel on a wide viewport: the
 * `sm:` columns matched, each half got ~180px, the fixed clock took 128 of it,
 * and the date was a sliver showing the month.
 */
function WhenRow({
  id,
  label,
  timeLabel,
  date,
  clock,
  allDay,
  onDate,
  onClock,
}: {
  id: string;
  label: string;
  timeLabel: string;
  date: string;
  clock: string;
  allDay: boolean;
  onDate: (value: string) => void;
  onClock: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={`${id}-date`} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {/* Each control is as wide as what it shows. Stretched to the row they
          left a blank run after the picker icon, which the browser draws right
          after the value rather than at the far edge. */}
      <div className="flex flex-wrap gap-3">
        <Input
          id={`${id}-date`}
          type="date"
          value={date}
          className={`w-auto flex-none ${PLAIN_PICKER}`}
          onChange={(event) => onDate(event.target.value)}
        />
        {!allDay && (
          <Input
            id={`${id}-clock`}
            type="time"
            aria-label={timeLabel}
            value={clock}
            className={`w-auto flex-none ${PLAIN_PICKER}`}
            onChange={(event) => onClock(event.target.value)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * What each refusal says. Exported so a caller can say it again beside its own
 * submit button: the line this form draws at the offending field is the one
 * that names WHICH field, but in a long scrolling form it is not where the
 * finger just tapped.
 */
export const PROBLEM_MESSAGES: Record<EventDraftProblem, string> = {
  title: 'Give the event a title',
  startDate: 'Pick a start date',
  endBeforeStart: 'The event ends before it starts',
  coordinates: 'Enter both a latitude (-90 to 90) and a longitude (-180 to 180)',
};

interface Props {
  value: EventDraft;
  onChange: (next: EventDraft) => void;
  /** Set once the caller has tried to submit an invalid draft. */
  problem?: EventDraftProblem | null;
  disabled?: boolean;
  /**
   * Turns the Place name into coordinates (see `usePlaceLookup`). Without it
   * there is no "Look up" button: the coordinates are typed or left blank.
   */
  lookupPlace?: PlaceLookup;
}

/**
 * The event editor — what happened, when, and where — kept as its own
 * component (rather than inlined in the modal) so the add flow and any later
 * edit flow share one definition of the fields and their rules.
 *
 * Coordinates are typed directly rather than picked on a map: this is the
 * fallback path for an event no importer produced, and the map surfaces read
 * `locationCoordinates`, so a manually created event stays invisible on the
 * map without them.
 */
export function EventForm({ value, onChange, problem, disabled, lookupPlace }: Props) {
  const uid = useId();
  const eventTypeListId = `${uid}-event-types`;

  type LookupState =
    | { kind: 'idle' }
    | { kind: 'busy' }
    | { kind: 'found'; address: string | null }
    | { kind: 'none' }
    | { kind: 'unconfigured' }
    | { kind: 'error' };
  const [lookup, setLookup] = useState<LookupState>({ kind: 'idle' });
  const canLookUp = Boolean(lookupPlace) && value.locationName.trim().length > 0 && lookup.kind !== 'busy';

  const lookUpPlace = async () => {
    if (!lookupPlace || !canLookUp) {
      return;
    }

    setLookup({ kind: 'busy' });
    const result = await lookupPlace(value.locationName.trim());

    if (result.status === 'ok') {
      // Both at once: two `set` calls would each spread the same stale value.
      onChange({ ...value, latitude: String(result.latitude), longitude: String(result.longitude) });
      setLookup({ kind: 'found', address: result.address });
    } else {
      setLookup({ kind: result.status });
    }
  };

  const set = <K extends keyof EventDraft>(key: K, next: EventDraft[K]) => {
    onChange({ ...value, [key]: next });
  };

  const messageFor = (field: EventDraftProblem) => (problem === field ? PROBLEM_MESSAGES[field] : null);

  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-6">
      <datalist id={eventTypeListId}>
        {EVENT_TYPE_SUGGESTIONS.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>

      <Section title="What happened">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-title`}>Title</Label>
          <Input
            id={`${uid}-title`}
            value={value.title}
            autoFocus
            placeholder="Dinner with Sam"
            onChange={(event) => set('title', event.target.value)}
          />
          {messageFor('title') && <p className="text-sm text-destructive">{PROBLEM_MESSAGES.title}</p>}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id={`${uid}-event-type`}
            label="Kind"
            value={value.eventType}
            listId={eventTypeListId}
            placeholder="Leave blank to show it on your schedule"
            onChange={(next) => set('eventType', next)}
          />
          <Field
            id={`${uid}-category`}
            label="Category"
            value={value.category}
            placeholder="Personal, work, …"
            onChange={(next) => set('category', next)}
          />
        </div>
      </Section>

      <Section title="When">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${uid}-all-day`}
            checked={value.isAllDay}
            onCheckedChange={(checked) => set('isAllDay', checked === true)}
          />
          <Label htmlFor={`${uid}-all-day`} className="cursor-pointer text-sm font-normal">
            All day
          </Label>
        </div>

        <div className="grid gap-3">
          <WhenRow
            id={`${uid}-start`}
            label="Starts at"
            timeLabel="Start time"
            date={value.startDate}
            clock={value.startClock}
            allDay={value.isAllDay}
            onDate={(next) => set('startDate', next)}
            onClock={(next) => set('startClock', next)}
          />
          <WhenRow
            id={`${uid}-end`}
            label="Ends at"
            timeLabel="End time"
            date={value.endDate}
            clock={value.endClock}
            allDay={value.isAllDay}
            onDate={(next) => set('endDate', next)}
            onClock={(next) => set('endClock', next)}
          />
        </div>

        {messageFor('startDate') && <p className="text-sm text-destructive">{PROBLEM_MESSAGES.startDate}</p>}
        {messageFor('endBeforeStart') && (
          <p className="text-sm text-destructive">{PROBLEM_MESSAGES.endBeforeStart}</p>
        )}
      </Section>

      <Section title="Where" description="Coordinates are optional — they put the event on the map.">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field
              id={`${uid}-location-name`}
              label="Place"
              value={value.locationName}
              placeholder="Where it happened"
              onChange={(next) => {
                set('locationName', next);
                // A new name makes the last answer stale.
                setLookup({ kind: 'idle' });
              }}
            />
          </div>
          {lookupPlace && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 shrink-0"
              disabled={!canLookUp || disabled}
              onClick={() => void lookUpPlace()}
            >
              {lookup.kind === 'busy' ? 'Looking up…' : 'Look up'}
            </Button>
          )}
        </div>

        {lookup.kind === 'found' && (
          <p role="status" className="text-xs text-muted-foreground">
            {lookup.address ? `Matched ${lookup.address} — coordinates filled in.` : 'Coordinates filled in.'}
          </p>
        )}
        {lookup.kind === 'none' && (
          <p role="status" className="text-xs text-muted-foreground">
            No match for that name. Try adding a city, or type the coordinates.
          </p>
        )}
        {lookup.kind === 'unconfigured' && (
          <p role="status" className="text-xs text-muted-foreground">
            Looking places up isn&apos;t set up on this appliance yet. Type the coordinates instead.
          </p>
        )}
        {lookup.kind === 'error' && (
          <p role="status" className="text-xs text-destructive">
            Could not look that up right now. Try again shortly.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id={`${uid}-latitude`}
            label="Latitude"
            // Text, not number: a number input grows spin buttons that nudge a
            // coordinate by one, which means nothing on a map. `decimal` still
            // brings up the numeric keyboard on a phone; validation is the
            // draft's (`coordinates`), not the browser's.
            inputMode="decimal"
            value={value.latitude}
            placeholder="37.7749"
            onChange={(next) => set('latitude', next)}
          />
          <Field
            id={`${uid}-longitude`}
            label="Longitude"
            inputMode="decimal"
            value={value.longitude}
            placeholder="-122.4194"
            onChange={(next) => set('longitude', next)}
          />
        </div>

        {messageFor('coordinates') && (
          <p className="text-sm text-destructive">{PROBLEM_MESSAGES.coordinates}</p>
        )}
      </Section>

      <Section title="Notes">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-description`} className="text-xs text-muted-foreground">
            Description
          </Label>
          <Textarea
            id={`${uid}-description`}
            value={value.description}
            placeholder="Anything worth remembering about it"
            onChange={(event) => set('description', event.target.value)}
          />
        </div>
      </Section>
    </fieldset>
  );
}
