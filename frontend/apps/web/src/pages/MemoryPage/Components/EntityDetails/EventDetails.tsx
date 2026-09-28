import { useMutation } from '@apollo/client';
import { MapPin } from '@ci/shadcn/icons';

import { gql, useFragment } from '@/graphql';

import type { MemoryEntityOf } from '../../useEntityService';
import { EVENT_FRAGMENT } from '../EntityCard/EventCard';
import { eventDisplayTitle, formatBytes } from '../utils';

import { EntityDetailScaffold, EntityMedia, resolveStaticUrl } from './EntityDetailScaffold';
import { pickPageUrl } from './GenericDetails';
import { hasRichMedia, RichMediaCard } from './RichMediaCard';

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

  // Photo/video events: the ORIGINAL is what renders (a 300px PREVIEW upscaled
  // into the sheet reads as blur on any large screen), with the preview passed
  // alongside so EntityMedia can paint it during the original's download.
  // Videos play inline from the server's browser-playable rendition when
  // one exists (playbackUrl — the H.264 PLAYBACK variant made for HEVC and
  // other codecs browsers cannot be relied on to decode), else from the
  // original, with the preview as their poster and as the still that stays
  // up when the browser cannot decode the stream (see EntityMedia). The
  // original remains the "open or save" target either way. Resolved
  // server-side via the linked file; null for non-media events, which render
  // no media block.
  const isVideo = data.mediaContentType?.startsWith('video/') ?? false;
  const playbackSrc = isVideo ? resolveStaticUrl(data.playbackUrl) : null;
  const mediaSrc = playbackSrc ?? resolveStaticUrl(data.mediaUrl ?? data.previewUrl);
  const mediaContentType = playbackSrc
    ? (data.playbackContentType ?? data.mediaContentType)
    : data.mediaContentType;
  const mediaPreviewSrc = resolveStaticUrl(data.previewUrl);
  const originalHref = isVideo ? resolveStaticUrl(data.mediaUrl) : null;
  const dimensions = data.mediaWidth && data.mediaHeight ? `${data.mediaWidth} × ${data.mediaHeight}` : null;

  // A watch / listen / read event is ABOUT its content row: when that row has
  // a resolved preview or a player, the drawer leads with it (poster, facts,
  // click-to-play) rather than with a bare title and two timestamps.
  const richContent = (data.contents?.edges ?? [])
    .map((edge) => edge.node)
    .find((node) => hasRichMedia(node));

  const title = eventDisplayTitle({
    title: data.title,
    startTime: data.startTime,
    locationName: data.locationName ?? data.location?.name,
    mediaContentType: data.mediaContentType,
  });

  // The thing the event is ABOUT, when it lives on another service: a
  // connector stamps the source's own page URL into `metadata` (a liked
  // Facebook Page's `page_url`, a post's `permalink_url`). The related
  // entity's relationship card is the in-app way there; this is the way OUT,
  // and it opens a new tab like every other off-appliance link in the drawer.
  const pageUrl = pickPageUrl((data.metadata ?? {}) as Record<string, unknown>);

  return (
    <EntityDetailScaffold
      entity={entity}
      title={title || 'Event'}
      subtitle="Event"
      taggable
      media={
        mediaSrc ? (
          <EntityMedia
            src={mediaSrc}
            previewSrc={mediaPreviewSrc}
            contentType={mediaContentType}
            alt={title}
            fallbackHref={originalHref}
          />
        ) : richContent ? (
          <RichMediaCard content={richContent} title={richContent.title} url={richContent.contentUrl} />
        ) : undefined
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
        {
          label: 'Link',
          value: pageUrl ? (
            <a
              href={pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-primary hover:underline"
            >
              {pageUrl}
            </a>
          ) : null,
        },
        { label: 'Media type', value: data.mediaContentType },
        { label: 'Dimensions', value: dimensions },
        { label: 'Size', value: data.mediaSize != null ? formatBytes(data.mediaSize) : null },
      ]}
      detailSections={<DetailSection title="Location" items={locationItems} />}
      rawData={data}
    />
  );
}
