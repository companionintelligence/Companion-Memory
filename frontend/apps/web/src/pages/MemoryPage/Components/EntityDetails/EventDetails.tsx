import { useMutation } from '@apollo/client';
import { MapPin } from '@ci/shadcn/icons';

import { gql, useFragment } from '@/graphql';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import type { DateTimeFormatter } from '@/lib/dateTimeFormat';

import { readCoordinates, readGeoJsonPoint } from '../../MapView/mapCoordinates';
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
  [key: string]: unknown;
};

type EventLocationFields = {
  eventType?: string | null;
  locationName?: string | null;
  /** Every query that opens this drawer aliases `locationCoordinates` to this key. */
  mapCoordinates?: unknown;
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

function formatDateTime(value: string | null | undefined, fmt: DateTimeFormatter): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  return isNaN(date.getTime())
    ? value
    : fmt.dateTime(
        date,
        {
          dateStyle: 'medium',
          timeStyle: 'short',
        },
        'en-US',
      );
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

function formatCoordinates(coords: { lat: number; lng: number } | null): string | null {
  return coords ? `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}` : null;
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
  const fmt = useDateTimeFormat();

  const props = (data.location?.properties ?? {}) as LocationProperties;
  const eventFields = entity as EventLocationFields;
  // The event's own point first (a photo's GPS fix), then the linked place's,
  // which is the order the map pin uses. An event can be linked to a place
  // without a point of its own. The place's typed latitude/longitude come from
  // its location_point at full precision. The `lat`/`lng` in its properties
  // are snapped to 3 decimals for geocoded places and missing for hand-made
  // ones, so they are only the last resort (as in PlaceDetails).
  const coordinates =
    readGeoJsonPoint(eventFields.mapCoordinates) ??
    readCoordinates({ latitude: data.location?.latitude, longitude: data.location?.longitude }) ??
    readCoordinates(props);
  const locationItems: DetailItem[] = [
    { label: 'Place', value: data.location?.name ?? data.locationName ?? eventFields.locationName ?? '' },
    // The bag is free-form JSON. An object here would crash the render.
    { label: 'Address', value: typeof props.address === 'string' ? props.address : '' },
    { label: 'Coordinates', value: formatCoordinates(coordinates) ?? '' },
    // Nothing else from the place's properties. The rest of that bag is the
    // pipeline's bookkeeping (`promote`, `source`, `place_id`, `type`) and
    // listing it printed raw JSON in the drawer.
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
        { label: 'Starts', value: formatDateTime(data.startTime, fmt) },
        { label: 'Ends', value: formatDateTime(data.endTime, fmt) },
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
