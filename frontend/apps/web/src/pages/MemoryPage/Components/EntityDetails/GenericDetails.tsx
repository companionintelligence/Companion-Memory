import type { GenericEntity } from '../../useEntityService';

import { EntityDetailScaffold, EntityMedia, type MetaItem } from './EntityDetailScaffold';

interface Props {
  entity: GenericEntity;
}

const HTTP_URL = /^https?:\/\/\S+$/i;

/**
 * Property keys whose value is a picture OF the entity — a Page's cover, a
 * profile photo, a channel avatar — rather than a link the reader follows.
 * The first such property renders as the drawer's media; the rest stay in
 * the property list as links.
 */
const IMAGE_PROPERTY_KEY = /(^|_)(cover|image|picture|photo|avatar|thumbnail|banner|logo)(_?url)?$/i;

/** Where the entity lives on its source service — the "open on <service>" link. */
const PAGE_URL_KEYS = ['url', 'link', 'page_url', 'permalink_url', 'website', 'homepage'];

export function asHttpUrl(value: unknown): string | null {
  return typeof value === 'string' && HTTP_URL.test(value.trim()) ? value.trim() : null;
}

/**
 * The first image-shaped property, as `[key, url]`, or null. Exported for the
 * test and for any other generic surface that wants the same pick.
 */
export function pickImageProperty(properties: Record<string, unknown>): [string, string] | null {
  for (const [key, value] of Object.entries(properties)) {
    const url = asHttpUrl(value);

    if (url && IMAGE_PROPERTY_KEY.test(key)) {
      return [key, url];
    }
  }

  return null;
}

/** The entity's own page on its source service, or null. */
export function pickPageUrl(properties: Record<string, unknown>): string | null {
  for (const key of PAGE_URL_KEYS) {
    const url = asHttpUrl(properties[key]);

    if (url) {
      return url;
    }
  }

  return null;
}

function ExternalLink({ href }: { href: string }) {
  // Same anchor the typed bodies use for an off-appliance URL (ContentDetails,
  // FallbackDetails, EntityMedia's "Open original"): a new tab, with the
  // opener severed. Issue #2311's "no target=_blank in the drawer" was about
  // the app's OWN full-page route, which must stay in the drawer; a link out
  // to another service is exactly what a new tab is for.
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all text-primary hover:underline"
    >
      {href}
    </a>
  );
}

function formatPropertyValue(value: unknown): MetaItem['value'] {
  const url = asHttpUrl(value);

  if (url) {
    return <ExternalLink href={url} />;
  }

  if (value != null && typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value ?? '');
}

/**
 * Read-only detail view for entities without a dedicated, fragment-backed
 * component (e.g. graph nodes from the REST graph API — an Organization the
 * Facebook connector minted for a liked Page, say). Renders the node's
 * generic fields through the shared scaffold so every memory view opens the
 * same drawer on click.
 *
 * Two of a node's properties get more than a `key: value` row:
 *
 *  - the first image-shaped one (`cover_url`, `avatar`, `logo`, …) renders as
 *    the drawer's media, the way a photo event or a file leads with its
 *    picture. Such URLs are often signed and short-lived (Facebook's CDN
 *    links expire in about a month); when one stops resolving, EntityMedia
 *    shows its "couldn't be loaded" state with the URL as an escape hatch
 *    rather than a broken image.
 *  - any http(s) value is a link that opens in a new tab, not text to copy
 *    out by hand.
 */
export function GenericDetails({ entity }: Props) {
  const properties = entity.properties ?? {};
  const image = pickImageProperty(properties);
  const propertyEntries = Object.entries(properties)
    .filter(([key]) => key !== image?.[0])
    .slice(0, 8);

  const metaItems: MetaItem[] = [
    { label: 'Type', value: entity.entityType },
    ...propertyEntries.map(([key, value]) => ({
      label: key,
      value: formatPropertyValue(value),
    })),
  ];

  return (
    <EntityDetailScaffold
      entity={entity}
      title={entity.name ?? 'Untitled Entity'}
      subtitle={entity.description ?? undefined}
      subtitleKind="text"
      media={
        image ? (
          <EntityMedia
            src={image[1]}
            contentType="image/*"
            alt={entity.name ?? ''}
            fallbackHref={pickPageUrl(properties) ?? image[1]}
          />
        ) : undefined
      }
      taggable
      tagsEditable
      metaItems={metaItems}
      rawData={entity.properties}
    />
  );
}
