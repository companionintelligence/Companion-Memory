import { useMutation } from '@apollo/client';
import { MapPin } from '@ci/shadcn/icons';

import { gql, useFragment } from '@/graphql';

import type { MemoryEntityOf } from '../../useEntityService';
import { EVENT_FRAGMENT } from '../EntityCard/EventCard';
import { eventDisplayTitle, formatBytes } from '../utils';

import { EntityDetailScaffold, EntityMedia, resolveStaticUrl } from './EntityDetailScaffold';

const UPDATE_EVENT = gql(`
  mutation UpdateEventDetail($input: UpdateEventInput!) {
    updateEvent(input: $input) {
      id
      title
      description
    }
  }
`);

type LocationProperties = {
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  [key: string]: unknown;
};

type EventLocationFields = {
  eventType?: string | null;
  locationName?: string | null;
  mapCoordinates?: unknown;
  locationCoordinates?: unknown;
};

type DetailItem = {
  label: string;
  value: string;
};

interface Props {
  entity: MemoryEntityOf<'EventType'>;
}

function formatTitleCase(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  return value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function formatDateTime(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  return isNaN(date.getTime())
    ? value
    : date.toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
}

function formatDuration(start?: string | null, end?: string | null): string | null {
  if (!start || !end) {
    return null;
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return null;
  }

  const minutes = Math.round((endDate.getTime() - startDate.getTime()) / 60000);

  if (minutes <= 0) {
    return null;
  }

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours} hr${hours === 1 ? '' : 's'}`);
  }

  if (mins > 0) {
    parts.push(`${mins} min`);
  }

  return parts.join(' ');
}

function readGeoJsonPoint(value: unknown): { lat: number; lng: number } | null {
  if (value == null || typeof value !== 'object') {
    return null;
  }

  const coords = (value as { coordinates?: unknown }).coordinates;

  if (!Array.isArray(coords) || coords.length < 2) {
    return null;
  }

  const [lng, lat] = coords;

  return typeof lat === 'number' && typeof lng === 'number' && !isNaN(lat) && !isNaN(lng)
    ? { lat, lng }
    : null;
}

function readPropertyCoordinates(properties: LocationProperties): { lat: number; lng: number } | null {
  return typeof properties.latitude === 'number' &&
    typeof properties.longitude === 'number' &&
    !isNaN(properties.latitude) &&
    !isNaN(properties.longitude)
    ? { lat: properties.latitude, lng: properties.longitude }
    : null;
}

function formatCoordinates(coords: { lat: number; lng: number } | null): string | null {
  return coords ? `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}` : null;
}

function formatPropertyValue(value: unknown): string | null {
  if (value == null || value === '') {
    return null;
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function extraLocationDetails(properties: LocationProperties): DetailItem[] {
  const hidden = new Set(['address', 'latitude', 'longitude']);

  return Object.entries(properties)
    .filter(([key]) => !hidden.has(key))
    .map(([key, value]) => ({
      label: formatTitleCase(key) ?? key,
      value: formatPropertyValue(value),
    }))
    .filter((item): item is DetailItem => Boolean(item.value));
}

function DetailSection({ title, items }: { title: string; items: DetailItem[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <section className="rounded-xl border border-border/60 bg-card/45 p-4 shadow-sm backdrop-blur">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-lg bg-sky-500/15 text-sky-300">
          <MapPin className="size-4" />
        </span>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>

      <div className="flex flex-col divide-y divide-border/50">
        {items.map((item) => (
          <div
            key={item.label}
            className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2 first:pt-0 last:pb-0"
          >
            <span className="text-xs uppercase tracking-wide text-muted-foreground">{item.label}</span>
            <span className="min-w-0 break-words text-sm text-foreground/90">{item.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function EventDetails({ entity }: Props) {
  const data = useFragment(EVENT_FRAGMENT, entity);
  const [updateEvent] = useMutation(UPDATE_EVENT);

  const props = (data.location?.properties ?? {}) as LocationProperties;
  const eventFields = entity as EventLocationFields;
  const mapCoordinates = readGeoJsonPoint(eventFields.mapCoordinates ?? eventFields.locationCoordinates);
  const coordinates = readPropertyCoordinates(props) ?? mapCoordinates;
  const locationItems: DetailItem[] = [
    { label: 'Place', value: data.location?.name ?? data.locationName ?? eventFields.locationName ?? '' },
    { label: 'Address', value: props.address ?? '' },
    { label: 'Coordinates', value: formatCoordinates(coordinates) ?? '' },
    ...extraLocationDetails(props),
  ].filter((item) => item.value);

  // Photo/video events: thumbnail (PREVIEW) for images, full source for video so
  // it plays inline. Resolved server-side via the linked file (data.previewUrl /
  // data.mediaUrl); null for non-media events, which render no media block.
  const isVideo = data.mediaContentType?.startsWith('video/') ?? false;
  const mediaSrc = resolveStaticUrl(isVideo ? data.mediaUrl : (data.previewUrl ?? data.mediaUrl));
  const dimensions = data.mediaWidth && data.mediaHeight ? `${data.mediaWidth} × ${data.mediaHeight}` : null;

  const title = eventDisplayTitle({
    title: data.title,
    startTime: data.startTime,
    locationName: data.locationName ?? data.location?.name,
    mediaContentType: data.mediaContentType,
  });

  return (
    <EntityDetailScaffold
      entity={entity}
      title={title || 'Event'}
      subtitle="Event"
      taggable
      media={
        mediaSrc ? <EntityMedia src={mediaSrc} contentType={data.mediaContentType} alt={title} /> : undefined
      }
      editFields={[
        { key: 'title', label: 'Title', value: data.title ?? '' },
        { key: 'description', label: 'Description', value: data.description ?? '', multiline: true },
      ]}
      onSave={async (values) => {
        await updateEvent({
          variables: {
            input: { id: entity.id, title: values.title, description: values.description },
          },
        });
      }}
      metaItems={[
        { label: 'Source', value: formatTitleCase(data.sourceSystem) },
        { label: 'Starts', value: formatDateTime(data.startTime) },
        { label: 'Ends', value: formatDateTime(data.endTime) },
        { label: 'Duration', value: formatDuration(data.startTime, data.endTime) },
        { label: 'Type', value: formatTitleCase(eventFields.eventType) ?? 'Event' },
        { label: 'Media type', value: data.mediaContentType },
        { label: 'Dimensions', value: dimensions },
        { label: 'Size', value: data.mediaSize != null ? formatBytes(data.mediaSize) : null },
      ]}
      detailSections={<DetailSection title="Location" items={locationItems} />}
      rawData={data}
    />
  );
}
