import { type ReactNode, useId } from 'react';

import { useDeviceLayout } from '@ci/common';
import { Input, Label, Select, Textarea } from '@ci/shadcn';

import { CurrentLocationField } from './CurrentLocationField';
import { PLACE_KINDS, PLACE_KIND_LABELS, type PlaceDraft, type PlaceDraftProblem } from './placeDraft';

/** Sentinel for "no kind" — Select.Item rejects an empty string value. */
const NO_KIND = '__none__';

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
  step,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
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
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

const PROBLEM_MESSAGES: Record<PlaceDraftProblem, string> = {
  name: 'Give the place a name',
  coordinates: 'Enter both a latitude (-90 to 90) and a longitude (-180 to 180)',
};

interface Props {
  value: PlaceDraft;
  onChange: (next: PlaceDraft) => void;
  /** Set once the caller has tried to submit an invalid draft. */
  problem?: PlaceDraftProblem | null;
  disabled?: boolean;
}

/**
 * The place editor — name, kind, where it is — shared by the add flow and any
 * later edit flow so the two can't drift apart.
 *
 * Coordinates can come from this device's GPS or be typed. Either path writes
 * the typed `location_point` column so the place shows on the map.
 */
export function PlaceForm({ value, onChange, problem, disabled }: Props) {
  const uid = useId();
  const { isMobile } = useDeviceLayout();

  const set = <K extends keyof PlaceDraft>(key: K, next: PlaceDraft[K]) => {
    onChange({ ...value, [key]: next });
  };

  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-6">
      <Section title="Identity">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-name`}>Name</Label>
          <Input
            id={`${uid}-name`}
            value={value.name}
            autoFocus={!isMobile}
            placeholder="Blue Bottle on Mint Plaza"
            onChange={(event) => set('name', event.target.value)}
          />
          {problem === 'name' && <p className="text-sm text-destructive">{PROBLEM_MESSAGES.name}</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-kind`} className="text-xs text-muted-foreground">
            Kind
          </Label>
          <Select
            value={value.placeKind === '' ? NO_KIND : value.placeKind}
            onValueChange={(next) => set('placeKind', next === NO_KIND ? '' : next)}
          >
            <Select.Trigger id={`${uid}-kind`} className="w-full">
              <Select.Value placeholder="Unspecified" />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value={NO_KIND}>Unspecified</Select.Item>
              {PLACE_KINDS.map((kind) => (
                <Select.Item key={kind} value={kind}>
                  {PLACE_KIND_LABELS[kind]}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>
      </Section>

      <Section
        title="Where"
        description="Drop a pin from where you are, or type an address. Coordinates put the place on the map."
      >
        <CurrentLocationField value={value} onChange={onChange} disabled={disabled} />

        <Field
          id={`${uid}-address`}
          label="Address"
          value={value.address}
          placeholder="66 Mint St, San Francisco, CA"
          onChange={(next) => set('address', next)}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id={`${uid}-latitude`}
            label="Latitude"
            type="number"
            step="any"
            value={value.latitude}
            placeholder="37.7823"
            onChange={(next) => set('latitude', next)}
          />
          <Field
            id={`${uid}-longitude`}
            label="Longitude"
            type="number"
            step="any"
            value={value.longitude}
            placeholder="-122.4076"
            onChange={(next) => set('longitude', next)}
          />
        </div>

        {problem === 'coordinates' && (
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
            placeholder="What this place is to you"
            onChange={(event) => set('description', event.target.value)}
          />
        </div>
      </Section>
    </fieldset>
  );
}
