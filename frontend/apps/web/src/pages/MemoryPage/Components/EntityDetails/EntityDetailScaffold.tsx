import {
  Fragment,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { useApolloClient } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import { Button, Card, IconButton, Label, Sheet, Tooltip, cn, useToast } from '@ci/shadcn';
import { FileSymlink, ImageOff, Loader2, Pencil, Trash2 } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { Link, useInRouterContext } from 'react-router-dom';

import { useTagEntityService } from '@/api';
import { ChatWithAgentMenu } from '@/components/ChatWithAgent';
import {
  EntityFields,
  EntityMetaList,
  useEntityFieldsEditor,
  type EditField,
  type MetaItem,
} from '@/components/EntityFields';
import {
  EntityRelationshipCards,
  toGlobalResourceType,
  type RelatedEntityOpenTarget,
} from '@/components/EntityRelationshipCards/EntityRelationshipCards';
import { TagInput } from '@/components/TagInput';
import { entityToAgentChatContext } from '@/lib/entityToAgentChatContext';

import type { GenericEntity, MemoryEntity } from '../../../MemoryPage/useEntityService';

import { DeleteEntityDialog } from './DeleteEntityDialog';
import { DELETE_TARGETS } from './deleteTargets';
import { useEntityDrawerHost } from './drawerHost';
import { GET_DRAWER_NODE, genericEntityGlobalId, isDetailNode } from './drawerNode';
import { useReadOnly } from './readOnly';

// The field/meta contract now lives with the shared editor so the full-page
// entity views can render the very same field set (see components/EntityFields).
export type { EditField, MetaItem };

/**
 * The standalone page for each resource type the drawer can show, by raw id.
 * Types absent here (a file, a browser visit, a thread) have no page and get no
 * link. Kept in step with the routes in App.tsx and with `ITEM_PAGES` in the
 * API's DatabaseSearchTool, which hands the chat the same paths.
 */
const FULL_PAGE_PATHS: Readonly<Record<string, string>> = {
  communication: '/communications',
  concept: '/concepts',
  content: '/content',
  event: '/events',
  item: '/items',
  note: '/notes',
  person: '/people',
  place: '/places',
  receipt: '/receipts',
};

export function fullPagePath(resourceType: string | null, rawId: string | null): string | null {
  if (resourceType == null || rawId == null) {
    return null;
  }

  const base = FULL_PAGE_PATHS[resourceType];

  return base ? `${base}/${rawId}` : null;
}

/**
 * The header's "open full page" control. An in-app `Link`, never
 * `target="_blank"`: the old escape hatch opened a new tab, which on the
 * Capacitor build (WKWebView) left the app for the system browser (issue
 * #2311). Routing in place keeps the drawer's page in history, so Back returns
 * to the list with its filters intact. Outside a router (stories, unit tests)
 * it degrades to a plain anchor.
 */
function FullPageLink({ to, label }: { to: string; label: string }) {
  const inRouter = useInRouterContext();
  const className =
    '-mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground';
  const link = inRouter ? (
    <Link to={to} aria-label={label} className={className}>
      <FileSymlink className="size-4" />
    </Link>
  ) : (
    <a href={to} aria-label={label} className={className}>
      <FileSymlink className="size-4" />
    </a>
  );

  // The same bubble (and delay) IconButton gives its neighbours, so the four
  // header controls read as one row rather than three tooltips and a `title`.
  return (
    <Tooltip delayDuration={600}>
      <Tooltip.Content>{label}</Tooltip.Content>
      <Tooltip.Trigger asChild>{link}</Tooltip.Trigger>
    </Tooltip>
  );
}

interface EntityDetailScaffoldProps {
  entity: MemoryEntity;
  title: string;
  subtitle?: ReactNode;
  /**
   * How the subtitle reads. `label` (the default) is the small-caps eyebrow
   * for a kind word — "Event", "Person", "Receipt". `text` is for a sentence
   * of the entity's own words, such as a message preview under its subject or
   * a description: those keep their case, because capitals turn a sentence
   * into shouting and hide proper nouns.
   */
  subtitleKind?: 'label' | 'text';
  /** Media (image/video) rendered at the top, above everything else. */
  media?: ReactNode;
  /** Extra read-only content rendered under the media (e.g. a content snippet). */
  children?: ReactNode;
  /** Structured read-only sections rendered after the editable summary fields. */
  detailSections?: ReactNode;
  metaItems?: MetaItem[];
  editFields?: EditField[];
  /** When provided, an edit affordance appears and these values are persisted on save. */
  onSave?: (values: Record<string, string>) => Promise<void> | void;
  /** Raw record rendered in a collapsible JSON <details>. */
  rawData?: unknown;
  /** Whether the entity supports tag editing (renders a TagInput bound to its global id). */
  taggable?: boolean;
  /**
   * Allow tags to be edited even without field editing — opens an edit affordance
   * driven purely by tags. Used by graph-node drawers (GenericDetails) so they
   * reach tag parity with the same entity opened from list/gallery/map, while
   * read-only fallbacks keep their tags read-only.
   */
  tagsEditable?: boolean;
}

interface EntityRef {
  resourceType: string | null;
  rawId: string | null;
  globalId: string | null;
}

/**
 * Resolve the per-entity ids the drawer needs: the graph `rawId` (for related
 * entities + deep links) and the GraphQL `globalId` (for tag mutations). Search
 * results carry a GlobalUID-encoded id; graph nodes (GenericEntity) carry a raw
 * graph entity id and their own type string.
 */
function resolveEntityRef(entity: MemoryEntity): EntityRef {
  if (entity.__typename === 'GenericEntity') {
    // Reconstruct the GraphQL global id for known taggable node types so a
    // graph-node drawer can read/edit tags like the same entity opened from
    // list/gallery/map (mirrors EntityRelationshipCards' GlobalUID.encode).
    const globalType = entity.entityType ? toGlobalResourceType(entity.entityType) : null;

    return {
      resourceType: entity.entityType ? entity.entityType.toLowerCase().replace(/_/g, '-') : null,
      rawId: entity.id ?? null,
      globalId: globalType && entity.id ? GlobalUID.encode(globalType, entity.id) : null,
    };
  }

  try {
    const { type, id } = GlobalUID.decode(entity.id);

    return { resourceType: type, rawId: id, globalId: entity.id };
  } catch {
    return { resourceType: null, rawId: entity.id ?? null, globalId: entity.id ?? null };
  }
}

/** Best-effort read of tag labels carried in a graph node's free-form properties. */
function readTagsFromProperties(properties: Record<string, unknown> | null | undefined): string[] {
  if (!properties) {
    return [];
  }

  for (const key of ['tags', 'tagLabels', 'tag_labels', 'tagNames', 'tag_names']) {
    const value = properties[key];

    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((label): label is string => label.length > 0);
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      return value
        .split(',')
        .map((label) => label.trim())
        .filter((label) => label.length > 0);
    }
  }

  return [];
}

function readTags(entity: MemoryEntity): string[] {
  if (entity.__typename === 'GenericEntity') {
    return readTagsFromProperties(entity.properties);
  }

  const tags = (entity as { tags?: Array<{ label?: string | null } | null> | null }).tags;

  if (!Array.isArray(tags)) {
    return [];
  }

  return tags.map((tag) => tag?.label?.trim() ?? '').filter((label): label is string => label.length > 0);
}

/** Prefix relative storage paths with `/static`; pass absolute/data URLs through. */
export function resolveStaticUrl(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  return /^https?:\/\//.test(value) || value.startsWith('data:') ? value : `/static${value}`;
}

/**
 * Show the low-res preview only until the full-size bytes are here.
 *
 * The detail pane used to render the PREVIEW variant outright — a 300px grid
 * thumbnail upscaled to a ~576px sheet, visibly soft on a 4K screen — while
 * the original (which can be a 35MB, 200-megapixel camera file) was one click
 * away. Progressive instead: the preview paints instantly, the original loads
 * off-DOM, and the swap happens only on its onload — so the pane is never
 * blank and never permanently blurry. Falls back to whichever URL exists when
 * the other is missing.
 */
function useProgressiveSrc(src?: string | null, previewSrc?: string | null): string | null | undefined {
  const progressive = Boolean(src && previewSrc && src !== previewSrc);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!progressive || !src) {
      return undefined;
    }

    setLoadedSrc(null);
    const probe = new Image();

    probe.onload = () => setLoadedSrc(src);
    probe.src = src;

    // The entity changed under the open sheet: a stale probe must not swap the
    // NEW preview for the OLD original.
    return () => {
      probe.onload = null;
    };
  }, [progressive, src]);

  if (!progressive) {
    return src ?? previewSrc;
  }

  return loadedSrc === src ? src : previewSrc;
}

/**
 * Re-fetches the drawer's node from the server so its media links are fresh.
 *
 * Every media URL the drawer shows is a signed object-store link that expires
 * an hour after it was minted (`staticfiles.auth.signatureTTL`). The links
 * ride in whatever query put the entity in the cache — the search page, the
 * timeline — and stay there for as long as the tab does. A photo hides this:
 * its preview was fetched (and browser-cached) when the list rendered, and
 * the original's failure leaves the preview in place. A video is fetched
 * only when its drawer opens, so an hour after the search the object store
 * answers 403 and the element reports an error — "media couldn't be loaded"
 * for a file that is fine. Measured 2026-09-22: a tampered or expired
 * signature returns 403 through the gateway; nothing else about the file
 * changes.
 *
 * Resolves true when a fresh node was fetched and handed to the drawer (the
 * details re-render with the new links and the media retries by itself),
 * false when nothing could be fetched. Null outside a scaffold (stories,
 * unit tests).
 */
const MediaRefreshContext = createContext<(() => Promise<boolean>) | null>(null);

export function MediaRefreshProvider({
  refresh,
  children,
}: {
  refresh: (() => Promise<boolean>) | null;
  children: ReactNode;
}) {
  return <MediaRefreshContext.Provider value={refresh}>{children}</MediaRefreshContext.Provider>;
}

/**
 * Render image/video media for a media-bearing entity. `src` should already be
 * resolved to a loadable URL (callers add the `/static` prefix where needed).
 * Falls back to treating an unknown content type as an image.
 *
 * For images, pass `previewSrc` alongside the full-size `src` to paint the
 * preview while the original downloads (see {@link useProgressiveSrc}).
 * Videos stream `src` and use `previewSrc`, when given, as the poster — and
 * as the still that stays up when the browser cannot decode the stream.
 *
 * That last case is common, not exotic: phone recordings since ~2023 are
 * HEVC (H.265), which Chrome on Linux does not decode at all (measured
 * 2026-09-22: every 4K 2023–2026 clip in the library is HEVC Main/Main 10;
 * the older and messaging-app clips are H.264 and play). The bytes arrive
 * fine — a range request through the gateway answers 206 video/mp4 — the
 * element just fires `error` with MEDIA_ERR_SRC_NOT_SUPPORTED. So a video
 * that fails the way a codec does is not "couldn't be loaded": it is the
 * poster, a sentence saying the browser cannot play this format, and the
 * original to open or save. A network failure keeps "couldn't be loaded".
 */
export function EntityMedia({
  src,
  previewSrc,
  contentType,
  alt,
  fallbackHref,
}: {
  src?: string | null;
  previewSrc?: string | null;
  contentType?: string | null;
  alt?: string;
  /**
   * Where to send the user when the media can't be shown inline — typically
   * the row's own `url`. Rendered as an external link in the unavailable state.
   */
  fallbackHref?: string | null;
}) {
  const isVideo = contentType?.startsWith('video/') ?? false;
  const isImage = contentType ? contentType.startsWith('image/') : true;
  const imageSrc = useProgressiveSrc(src, isVideo ? null : previewSrc);
  // A `url` that is really a web page (photos.google.com/photo/…) fails to
  // load as an image — the browser blocks the non-image response — and would
  // otherwise leave a broken-image glyph. Remember which source failed so the
  // block degrades to a link instead; keyed by src so a new entity retries.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const shownSrc = isVideo ? src : imageSrc;
  // At most ONE refresh per mount, and only for a failure a fresh link can
  // cure: a network error (MediaError 2 — the object store answered 403 for an
  // expired signature) or a source the element rejected outright (4). A DECODE
  // error (3) is the codec, not the link — measured 2026-09-22: every 4K HEVC
  // clip on the 7900 XTX dies with PIPELINE_ERROR_DECODE in Chrome's VA-API
  // path, with or without Chrome's acceleration flags, while ffmpeg decodes
  // the same bytes through the same driver — and refreshing on it produced a
  // refetch on every play click while the player did nothing. A successful
  // refresh re-renders with the re-minted `src` and remounts the element
  // (`attempt`) so the retry does not depend on the link's text changing (two
  // mints in one second are identical). Anything else, and any second
  // failure, is the unavailable state.
  const refreshMedia = useContext(MediaRefreshContext);
  const [refreshed, setRefreshed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // What the notice blames once a video gives up. DECODE (3) and
  // SRC_NOT_SUPPORTED (4) are how an unplayable codec surfaces; a network
  // error, or no reason at all, is the link or the connection, and "the file
  // itself is fine" would be a guess there.
  const [codecFailure, setCodecFailure] = useState(false);
  const handleError = useCallback(
    (failing: string, error: MediaError | null) => {
      const linkMayHaveExpired =
        error == null ||
        error.code === MediaError.MEDIA_ERR_NETWORK ||
        error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
      const fail = () => {
        setCodecFailure(
          error != null &&
            (error.code === MediaError.MEDIA_ERR_DECODE ||
              error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED),
        );
        setFailedSrc(failing);
      };

      if (refreshMedia && !refreshed && linkMayHaveExpired) {
        setRefreshed(true);
        void refreshMedia().then((ok) => {
          if (ok) {
            setAttempt((n) => n + 1);
          } else {
            fail();
          }
        });

        return;
      }

      fail();
    },
    [refreshMedia, refreshed],
  );
  if (!shownSrc) {
    return null;
  }

  if (!isVideo && !isImage) {
    return null;
  }

  if (failedSrc === shownSrc) {
    const originalHref = fallbackHref ?? (isVideo ? src : null);

    return (
      <div
        role="status"
        className="flex shrink-0 flex-col items-center justify-center gap-2 rounded-md border bg-muted/40 p-6 text-sm text-muted-foreground"
      >
        {isVideo && previewSrc ? (
          <img
            src={previewSrc}
            alt={alt ?? ''}
            className="max-h-[max(30vh,12rem)] w-full rounded object-contain"
          />
        ) : (
          <ImageOff className="size-8" aria-hidden />
        )}
        <span>
          {isVideo && codecFailure
            ? "This browser can't play this video (usually HEVC from a recent phone whose playable copy hasn't been made yet). The file itself is fine."
            : "Media couldn't be loaded"}
        </span>
        {originalHref && (
          <a
            href={originalHref}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-primary hover:underline"
          >
            {isVideo ? 'Open or save the original' : 'Open original'} <span aria-hidden>↗</span>
          </a>
        )}
      </div>
    );
  }

  // Two guards keep a short viewport from erasing the media:
  //
  // `shrink-0` — the scaffold renders this inside a `min-h-0 flex-1 flex-col
  // overflow-y-auto` body, and this wrapper's own `overflow-hidden` zeroes its
  // automatic minimum size, which made it the ONE flex item the column could
  // crush to nothing before scrolling. It must keep its size and let the
  // column scroll; without this it collapsed to a zero-height strip of border
  // whenever the sheet's content outgrew the window.
  //
  // The max() floor — the 45vh cap keeps a tall portrait from consuming the
  // whole sidebar, but a bare vh bound scales with the viewport and marches
  // toward zero on a short window (dev tools open, a small laptop). Floored
  // at 16rem, so the media stays readable at any window height while tall
  // screens keep the exact old behaviour.
  return (
    <div className="flex shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/40">
      {isVideo ? (
        <video
          key={attempt}
          src={shownSrc}
          poster={previewSrc ?? undefined}
          controls
          className="max-h-[max(45vh,16rem)] w-full object-contain"
          onError={(event) => handleError(shownSrc, event.currentTarget.error)}
        />
      ) : (
        <img
          key={attempt}
          src={shownSrc}
          alt={alt ?? ''}
          className="max-h-[max(45vh,16rem)] w-full object-contain"
          onError={() => handleError(shownSrc, null)}
        />
      )}
    </div>
  );
}

function RawDataDetails({ data }: { data: unknown }) {
  const pretty = useMemo(() => {
    try {
      const json = JSON.stringify(data, null, 2);

      return json && json !== '{}' && json !== 'null' && json !== '[]' ? json : null;
    } catch {
      return null;
    }
  }, [data]);

  if (!pretty) {
    return null;
  }

  return (
    <details className="rounded-xl border border-border/60 bg-card/45 shadow-sm backdrop-blur">
      <summary className="cursor-pointer px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Raw data
      </summary>
      <pre className="max-h-72 overflow-auto px-4 pb-4 text-xs leading-relaxed text-foreground/85">
        {pretty}
      </pre>
    </details>
  );
}

/** How long a related-card click waits for the typed node before showing the stub. */
const RELATED_RESOLVE_BUDGET_MS = 1_500;

export function EntityDetailScaffold({
  entity,
  title,
  subtitle,
  subtitleKind = 'label',
  media,
  children,
  detailSections,
  metaItems,
  editFields,
  onSave,
  rawData,
  taggable = false,
  tagsEditable = false,
}: EntityDetailScaffoldProps) {
  const { t } = useTranslation();
  const ref = useMemo(() => resolveEntityRef(entity), [entity]);
  const currentTags = useMemo(() => readTags(entity), [entity]);
  const { tagEntities, untagEntities } = useTagEntityService();
  const { refetch, setActiveEntity, refreshActiveEntity } = useEntityDrawerHost();
  const apolloClient = useApolloClient();
  const { toast } = useToast();
  // Shared-search viewer: the drawer is display-only. Suppress every mutation /
  // navigation affordance (the writes are owner-scoped and would silently fail).
  const readOnly = useReadOnly();

  // Resolve the typed node BEFORE switching the drawer to it. Switching to the
  // stub first and upgrading in place (ResolvedGenericDetails) mounted two
  // different detail bodies in a row, and each body owns its Sheet.Content, so
  // the sheet replayed its slide-in twice — a visible double flash on every
  // card click. With the node in hand the drawer transitions exactly once.
  // The stub is still the fallback: a slow or failed lookup must not make the
  // click feel dead, and the in-drawer upgrade still happens from there.
  const handleOpenRelatedEntity = useCallback(
    (target: RelatedEntityOpenTarget) => {
      const stub: GenericEntity = {
        __typename: 'GenericEntity',
        id: target.id,
        name: target.name,
        entityType: target.entityType,
        description: target.description,
        properties: target.properties,
      };
      const globalId = genericEntityGlobalId(stub);
      if (!globalId) {
        setActiveEntity(stub);

        return;
      }

      let settled = false;
      const fallback = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          setActiveEntity(stub);
        }
      }, RELATED_RESOLVE_BUDGET_MS);

      apolloClient
        .query({ query: GET_DRAWER_NODE, variables: { id: globalId }, fetchPolicy: 'cache-first' })
        .then(({ data }) => {
          const node = data?.node ?? null;
          if (settled) {
            return;
          }

          settled = true;
          window.clearTimeout(fallback);
          setActiveEntity(node && isDetailNode(node) ? node : stub);
        })
        .catch(() => {
          if (!settled) {
            settled = true;
            window.clearTimeout(fallback);
            setActiveEntity(stub);
          }
        });
    },
    [apolloClient, setActiveEntity],
  );

  // Deleting is offered for every type the server can actually remove, keyed off
  // the entity's own resource type — so it reaches search results and graph
  // nodes alike, without each *Details body having to opt in.
  const deleteTarget = ref.resourceType ? (DELETE_TARGETS[ref.resourceType] ?? null) : null;
  // Fresh media links for the block above — see MediaRefreshContext. The same
  // node query the related-card click uses, forced to the network so the
  // signed URLs are re-minted. The cache write reaches a drawer whose entity
  // is a live query result (an explorer row, the content library's routed
  // row). It does not reach one holding a snapshot — a graph node, a map pin,
  // a related card, a row paged out of the results — because `useFragment`
  // here is a plain cast, not a cache subscription. So the fresh node also
  // goes to the host, which swaps it in only if this entity is still shown.
  const refreshMedia = useCallback(async (): Promise<boolean> => {
    if (!ref.globalId) {
      return false;
    }

    try {
      const { data } = await apolloClient.query({
        query: GET_DRAWER_NODE,
        variables: { id: ref.globalId },
        fetchPolicy: 'network-only',
      });
      const node = data?.node ?? null;

      if (node && isDetailNode(node)) {
        refreshActiveEntity?.(node);
      }

      return node != null;
    } catch {
      return false;
    }
  }, [apolloClient, ref.globalId, refreshActiveEntity]);

  const fullPage = fullPagePath(ref.resourceType, ref.rawId);
  const canDelete = !readOnly && Boolean(deleteTarget && ref.globalId);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const canEdit = !readOnly && Boolean(onSave && editFields && editFields.length > 0);
  // Tags-only edit mode: no persisted fields, just an editable TagInput. Lets
  // graph-node drawers manage tags without the field-editing wiring.
  const canManageTags = !readOnly && Boolean(tagsEditable && taggable && ref.globalId);
  const canEnterEditMode = canEdit || canManageTags;

  // Abandon any in-progress edit when the open entity changes (by id), so one
  // entity's edits can never be persisted onto another.
  const entityKey = ref.globalId ?? ref.rawId ?? '';
  const [editing, setEditing] = useState(false);
  const [activeKey, setActiveKey] = useState(entityKey);

  if (activeKey !== entityKey) {
    setActiveKey(entityKey);
    setEditing(false);
    setConfirmingDelete(false);
  }

  // Shared with the full-page entity views, which offer the same field set.
  const { values, setValue, saving, saveError, save, reset } = useEntityFieldsEditor({
    fields: editFields,
    onSave,
    editing,
    resetKey: entityKey,
  });

  const startEditing = () => {
    setEditing(true);
  };

  const handleSave = async () => {
    // Leave edit mode open on failure so the user can retry without retyping.
    if (await save()) {
      setEditing(false);
    }
  };

  const handleCancel = () => {
    reset();
    setEditing(false);
  };

  const chatContext = useMemo(() => entityToAgentChatContext(entity), [entity]);

  const visibleMeta = (metaItems ?? []).filter(
    (item) => item.value !== null && item.value !== undefined && item.value !== '',
  );

  return (
    <Sheet.Content
      data-testid="entity-detail-sheet"
      className="z-[1000] w-full gap-0 overflow-hidden border-l border-white/10 bg-background/75 p-0 shadow-2xl backdrop-blur-2xl supports-[backdrop-filter]:bg-background/65 sm:max-w-xl pt-[var(--safe-area-top)] pb-[var(--safe-area-bottom)] [&>button]:top-[calc(var(--safe-area-top)+1rem)]"
      // Radix's default open-autofocus lands on the first tabbable descendant —
      // here that is always the header's ChatWithAgentMenu IconButton, whose
      // `Tooltip` opens on keyboard focus. That mounts a second DismissableLayer
      // (the tooltip's) *after* this sheet's own layer in Radix's shared,
      // app-wide layer stack, so it becomes the topmost layer and swallows the
      // very first Escape press to itself (closing only the tooltip); a second
      // Escape is then needed to actually close the sheet. Move initial focus to
      // the sheet container instead — nothing inside opens on focus, so Escape
      // reaches this sheet's own dismiss handler on the first press.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        (event.currentTarget as HTMLElement | null)?.focus();
      }}
    >
      <Sheet.Header className="gap-2 border-b border-border/60 bg-background/45 p-5 pr-12 backdrop-blur-xl">
        <div className="flex items-start justify-between gap-2">
          <Sheet.Title className="text-xl leading-tight tracking-tight">{title}</Sheet.Title>
          <div className="flex shrink-0 items-center gap-1">
            {fullPage != null && <FullPageLink to={fullPage} label={t('ENTITY_DETAILS_OPEN_PAGE')} />}
            {!readOnly && <ChatWithAgentMenu context={chatContext} className="-mt-1 size-8 shrink-0" />}
            {canEnterEditMode && !editing && (
              <IconButton
                variant="ghost"
                className="-mt-1 size-8 shrink-0"
                label={t('ENTITY_DETAILS_EDIT')}
                onClick={startEditing}
              >
                <Pencil className="size-4" />
              </IconButton>
            )}
            {canDelete && !editing && (
              <IconButton
                variant="ghost"
                className="-mt-1 size-8 shrink-0 text-muted-foreground hover:text-destructive"
                label={`Delete ${deleteTarget?.noun ?? 'entity'}`}
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2 className="size-4" />
              </IconButton>
            )}
          </div>
        </div>
        {/* Always render a description so Radix has an accessible description to
            point `aria-describedby` at (otherwise it logs a console warning). */}
        {subtitle != null && subtitle !== '' ? (
          <Sheet.Description
            className={cn(
              'text-xs text-muted-foreground',
              subtitleKind === 'label' ? 'font-medium uppercase tracking-wide' : 'break-words',
            )}
          >
            {subtitle}
          </Sheet.Description>
        ) : (
          <Sheet.Description className="sr-only">{`Details for ${title}`}</Sheet.Description>
        )}
      </Sheet.Header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
        {/* Keyed per entity: a related card swaps the entity under the same
            *Details body, and EntityMedia's once-per-mount refresh must not
            carry over to the next entity's media. */}
        <MediaRefreshProvider refresh={refreshMedia}>
          <Fragment key={entityKey}>{media}</Fragment>
        </MediaRefreshProvider>

        {children}

        {editFields && editFields.length > 0 && (
          <section className="flex flex-col gap-4 rounded-xl border border-border/60 bg-card/45 p-4 shadow-sm backdrop-blur">
            <EntityFields fields={editFields} editing={editing} values={values} onChange={setValue} />
          </section>
        )}

        {detailSections}

        {visibleMeta.length > 0 && (
          <Card className="gap-0 border-border/60 bg-card/45 p-0 shadow-sm backdrop-blur">
            <Card.Header className="p-4 pb-2">
              <Card.Title className="text-sm">Details</Card.Title>
            </Card.Header>
            <Card.Content className="flex flex-col p-4 pt-0">
              <EntityMetaList items={visibleMeta} />
            </Card.Content>
          </Card>
        )}

        {taggable && ref.globalId && (currentTags.length > 0 || editing) && (
          <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card/45 p-4 shadow-sm backdrop-blur">
            <Label>Tags</Label>
            <TagInput
              key={ref.globalId}
              tags={currentTags}
              readOnly={!editing}
              onTagAdded={async (label) => {
                try {
                  await tagEntities([ref.globalId!], [label]);

                  return true;
                } catch {
                  toast.error(`Couldn't add tag “${label}”.`);

                  return false;
                }
              }}
              onTagRemoved={async (label) => {
                try {
                  await untagEntities([ref.globalId!], [label]);

                  return true;
                } catch {
                  // Returning false tells the TagInput to roll back its optimistic removal.
                  toast.error(`Couldn't remove tag “${label}”.`);

                  return false;
                }
              }}
            />
          </div>
        )}

        {/* Relationship cards navigate to the owner's per-entity routes (which
            resolve under the VIEWER's scope and fall outside the shared
            search), so they stay hidden in read-only mode. */}
        {!readOnly && ref.rawId && (
          <EntityRelationshipCards
            key={ref.rawId}
            entityId={ref.rawId}
            onOpenRelatedEntity={handleOpenRelatedEntity}
          />
        )}

        {rawData != null && <RawDataDetails data={rawData} />}

        {/* The "open full page" control lives in the header (FullPageLink), as
            an in-app route. It used to be omitted on purpose: the earlier
            control was a `target="_blank"` Link, which on the Capacitor build
            (WKWebView) left the app for the system browser (issue #2311). The
            drawer still carries everything — media, editable fields, metadata,
            tags, relationships — the link only gives the object its address. */}
      </div>

      {editing && (
        <Sheet.Footer className="gap-2 border-t border-border/60 bg-background/55 backdrop-blur-xl">
          {saveError && (
            <p role="alert" className="text-sm text-destructive">
              {saveError}
            </p>
          )}
          <div className="flex flex-row justify-end gap-2">
            {/* Tags-only mode persists each tag immediately, so its footer just
                exits edit mode ("Done") with no separate Save step. */}
            <Button variant="outline" onClick={handleCancel} disabled={saving}>
              {canEdit ? 'Cancel' : 'Done'}
            </Button>
            {canEdit && (
              <Button onClick={handleSave} disabled={saving} className={cn(saving && 'opacity-80')}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {saving ? 'Saving…' : 'Save'}
              </Button>
            )}
          </div>
        </Sheet.Footer>
      )}

      {confirmingDelete && deleteTarget && ref.globalId && (
        <DeleteEntityDialog
          target={deleteTarget}
          entityId={ref.globalId}
          typename={entity.__typename === 'GenericEntity' ? undefined : entity.__typename}
          title={title}
          onClose={() => setConfirmingDelete(false)}
          onDeleted={() => {
            setConfirmingDelete(false);
            // The entity no longer exists — close the drawer rather than leave
            // it showing a record the user just removed.
            setActiveEntity(null);
          }}
          onRestored={refetch}
        />
      )}
    </Sheet.Content>
  );
}
