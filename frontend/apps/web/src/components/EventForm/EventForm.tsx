import { type ReactNode, useId } from 'react';

import { Checkbox, Input, Label, Textarea } from '@ci/shadcn';

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

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  type,
  listId,
  step,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  listId?: string;
  step?: string;
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
        list={listId}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

const PROBLEM_MESSAGES: Record<EventDraftProblem, string> = {
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
export function EventForm({ value, onChange, problem, disabled }: Props) {
  const uid = useId();
  const eventTypeListId = `${uid}-event-types`;

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

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <Field
                id={`${uid}-start-date`}
                label="Starts"
                type="date"
                value={value.startDate}
                onChange={(next) => set('startDate', next)}
              />
            </div>
            {!value.isAllDay && (
              <div className="w-32 shrink-0">
                <Field
                  id={`${uid}-start-clock`}
                  label="At"
                  type="time"
                  value={value.startClock}
                  onChange={(next) => set('startClock', next)}
                />
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <Field
                id={`${uid}-end-date`}
                label="Ends"
                type="date"
                value={value.endDate}
                onChange={(next) => set('endDate', next)}
              />
            </div>
            {!value.isAllDay && (
              <div className="w-32 shrink-0">
                <Field
                  id={`${uid}-end-clock`}
                  label="At"
                  type="time"
                  value={value.endClock}
                  onChange={(next) => set('endClock', next)}
                />
              </div>
            )}
          </div>
        </div>

        {messageFor('startDate') && <p className="text-sm text-destructive">{PROBLEM_MESSAGES.startDate}</p>}
        {messageFor('endBeforeStart') && (
          <p className="text-sm text-destructive">{PROBLEM_MESSAGES.endBeforeStart}</p>
        )}
      </Section>

      <Section title="Where" description="Coordinates are optional — they put the event on the map.">
        <Field
          id={`${uid}-location-name`}
          label="Place"
          value={value.locationName}
          placeholder="Where it happened"
          onChange={(next) => set('locationName', next)}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id={`${uid}-latitude`}
            label="Latitude"
            type="number"
            step="any"
            value={value.latitude}
            placeholder="37.7749"
            onChange={(next) => set('latitude', next)}
          />
          <Field
            id={`${uid}-longitude`}
            label="Longitude"
            type="number"
            step="any"
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
