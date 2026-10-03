import { useMemo, useState } from 'react';

import { ApolloClient } from '@apollo/client';
import { Sheet } from '@ci/shadcn';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { withFresherEntity, type EntityItem, type MemoryEntity } from '../../useEntityService';

import { EntityDrawerHostProvider } from './drawerHost';
import { GET_DRAWER_NODE } from './drawerNode';
import { EntityDetailScaffold, EntityMedia } from './EntityDetailScaffold';
import { FallbackDetails } from './FallbackDetails';

vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => null,
}));

vi.mock('@/components/EntityRelationshipCards/EntityRelationshipCards', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/EntityRelationshipCards/EntityRelationshipCards')>();

  return { ...actual, EntityRelationshipCards: () => null };
});

const host = { setActiveEntity: vi.fn(), refetch: vi.fn() };

/** A routable entity: `event` used to resolve to an `/events/:id` "full page". */
const EVENT_UUID = '019fd7c0-641c-76dd-8ed7-a5053faff6f1';

function routableEvent(name = "Mom's birthday"): EntityItem {
  return {
    __typename: 'EventType',
    id: btoa(`event:${EVENT_UUID}`),
    name,
    description: 'Cake at seven.',
    tags: [],
  } as unknown as EntityItem;
}

describe('EntityDetailScaffold', () => {
  it('pads the sheet into the iPhone safe area so the header and close control stay on-screen', async () => {
    renderWithProviders(
      <EntityDrawerHostProvider value={host}>
        <Sheet open>
          <FallbackDetails
            entity={
              {
                __typename: 'ThreadType',
                id: 'thread-0',
                name: 'Project Planning Assistant',
                description: 'Helping outline the phases.',
                tags: [],
              } as EntityItem
            }
          />
        </Sheet>
      </EntityDrawerHostProvider>,
    );

    const sheet = await screen.findByTestId('entity-detail-sheet');

    expect(sheet).toHaveClass('pt-[var(--safe-area-top)]');
    expect(sheet).toHaveClass('pb-[var(--safe-area-bottom)]');
    expect(sheet).toHaveClass('[&>button]:top-[calc(var(--safe-area-top)+1rem)]');
    expect(await screen.findByRole('heading', { name: 'Project Planning Assistant' })).toBeInTheDocument();
  });

  /**
   * Issue #2311. The drawer used to end in an "Open full page" `Link` with
   * `target="_blank"`; on the Capacitor build that handed the URL to the system
   * browser, so tapping it left the app entirely. The drawer is the object now.
   */
  it('offers an in-app "Open full page" link for an entity that has a routable detail page', async () => {
    renderWithProviders(
      <EntityDrawerHostProvider value={host}>
        <Sheet open>
          <FallbackDetails entity={routableEvent()} />
        </Sheet>
      </EntityDrawerHostProvider>,
    );

    await screen.findByTestId('entity-detail-sheet');

    const link = screen.getByRole('link', { name: /open full page/i });
    expect(link).toHaveAttribute('href', `/events/${EVENT_UUID}`);
    // In-app route, never a new tab: a `target="_blank"` here left the
    // Capacitor build for Safari (issue #2311).
    expect(link).not.toHaveAttribute('target');
  });

  it('keeps the object itself in the drawer, and opens no new browser tab from it', async () => {
    renderWithProviders(
      <EntityDrawerHostProvider value={host}>
        <Sheet open>
          <FallbackDetails entity={routableEvent()} />
        </Sheet>
      </EntityDrawerHostProvider>,
    );

    const sheet = await screen.findByTestId('entity-detail-sheet');

    // The content that made the "full page" worth visiting is right here.
    expect(screen.getByRole('heading', { name: "Mom's birthday" })).toBeInTheDocument();
    expect(screen.getByText('Cake at seven.')).toBeInTheDocument();
    // Subtitle + the "Type" metadata row both label it.
    expect(screen.getAllByText('Event').length).toBeGreaterThan(0);
    expect(screen.getByText('Type')).toBeInTheDocument();

    // Nothing in the drawer body sends iOS out to Safari.
    expect(sheet.querySelectorAll('a[target="_blank"]')).toHaveLength(0);
  });

  /**
   * QA re-test of #2930: an Instagram message whose title ends in a URL
   * (`… https://www.threads.com/@hannahstocking/post/DZoTALDGmu6`) drew a heading
   * 496pt wide on a 402pt screen. It ran under the close button and pushed the four
   * header actions (Open full page, Chat, Edit, Delete) off the right edge.
   *
   * A flex item will not shrink below its longest unbreakable word unless it is
   * allowed to (`min-w-0`), and a word is only broken where the box is narrower
   * than it (`break-words`). jsdom does no layout, so what can be pinned here is
   * the structure that decides it: the title may shrink and wrap, and the actions
   * beside it may not give way.
   */
  it('lets a long unbroken URL in the title wrap, so the header actions are not pushed off screen', async () => {
    const url = 'https://www.threads.com/@hannahstocking/post/DZoTALDGmu6';

    renderWithProviders(
      <EntityDrawerHostProvider value={host}>
        <Sheet open>
          <FallbackDetails entity={routableEvent(`rest in peace to my buddy ${url}`)} />
        </Sheet>
      </EntityDrawerHostProvider>,
    );

    const title = await screen.findByRole('heading', { name: new RegExp(url.replace(/[.?]/g, '\\$&')) });
    const openFullPage = screen.getByRole('link', { name: /open full page/i });
    const actions = openFullPage.parentElement;

    // The title can shrink below the URL and breaks it where it must…
    expect(title).toHaveClass('min-w-0', 'break-words');
    // …in the same flex row as the actions, which hold their size instead.
    expect(title.parentElement).toHaveClass('flex');
    expect(title.parentElement).toContainElement(actions);
    expect(actions).toHaveClass('shrink-0');
  });
});

/** jsdom never sets `MediaError`; stamp one on the element before firing `error`. */
function failWith(el: HTMLMediaElement, code: number) {
  if (typeof (globalThis as { MediaError?: unknown }).MediaError === 'undefined') {
    Object.assign(globalThis, {
      MediaError: {
        MEDIA_ERR_ABORTED: 1,
        MEDIA_ERR_NETWORK: 2,
        MEDIA_ERR_DECODE: 3,
        MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
      },
    });
  }

  Object.defineProperty(el, 'error', { configurable: true, value: { code, message: `code ${code}` } });
  fireEvent.error(el);
}

type VideoEvent = EntityItem & { mediaUrl: string };

function videoEvent(uuid: string, mediaUrl: string): VideoEvent {
  return {
    __typename: 'EventType',
    id: btoa(`event:${uuid}`),
    name: 'Clip',
    tags: [],
    mediaUrl,
  } as unknown as VideoEvent;
}

/** A video drawer the way a *Details body builds one: media from the entity prop. */
function VideoScaffold({ entity }: { entity: VideoEvent }) {
  return (
    <EntityDetailScaffold
      entity={entity}
      title="Clip"
      media={<EntityMedia src={entity.mediaUrl} contentType="video/mp4" alt="clip" />}
    />
  );
}

describe('EntityDetailScaffold media refresh', () => {
  const STALE = '/static/companion/clip.mp4?X-Amz-Signature=old';
  const FRESH = '/static/companion/clip.mp4?X-Amz-Signature=new';
  const A = '019fd7c0-641c-76dd-8ed7-a5053faff6f1';
  const B = '019fd7c0-641c-76dd-8ed7-a5053faff6f2';

  let query: MockInstance;

  beforeEach(() => {
    query = vi.spyOn(ApolloClient.prototype, 'query');
  });

  afterEach(() => {
    query.mockRestore();
  });

  /**
   * The drawer's host holds a snapshot — what a graph node, a map pin or a
   * related card hands it — so nothing re-reads the cache write the refetch
   * makes. Only the node handed to the host can bring the new link.
   */
  function SnapshotDrawer({ initial }: { initial: VideoEvent }) {
    const [entity, setEntity] = useState<MemoryEntity | null>(initial);
    const drawerHost = useMemo(
      () => ({
        setActiveEntity: setEntity,
        refetch: vi.fn(),
        refreshActiveEntity: (fresh: MemoryEntity) =>
          setEntity((current) => withFresherEntity(current, fresh)),
      }),
      [],
    );

    return (
      <EntityDrawerHostProvider value={drawerHost}>
        <Sheet open>{entity && <VideoScaffold entity={entity as VideoEvent} />}</Sheet>
      </EntityDrawerHostProvider>
    );
  }

  it('plays the re-minted link in a drawer that holds a snapshot', async () => {
    const stale = videoEvent(A, STALE);
    query.mockResolvedValue({ data: { node: { ...stale, mediaUrl: FRESH } } });

    const { container } = renderWithProviders(<SnapshotDrawer initial={stale} />);
    await screen.findByTestId('entity-detail-sheet');

    failWith(container.ownerDocument.querySelector('video')!, 2);
    await act(async () => {});

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: GET_DRAWER_NODE,
        variables: { id: stale.id },
        fetchPolicy: 'network-only',
      }),
    );
    expect(container.ownerDocument.querySelector('video')).toHaveAttribute('src', FRESH);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('gives the next entity in the same drawer its own refresh', async () => {
    // A related card swaps the entity under the same *Details body. The
    // once-per-mount guard used to carry over, so B went straight to the
    // unavailable state without asking for a fresh link.
    query.mockResolvedValue({ data: { node: null } });
    const drawerHost = { setActiveEntity: vi.fn(), refetch: vi.fn(), refreshActiveEntity: vi.fn() };
    const inDrawer = (entity: VideoEvent) => (
      <EntityDrawerHostProvider value={drawerHost}>
        <Sheet open>
          <VideoScaffold entity={entity} />
        </Sheet>
      </EntityDrawerHostProvider>
    );

    const { container, rerender } = renderWithProviders(inDrawer(videoEvent(A, STALE)));
    await screen.findByTestId('entity-detail-sheet');

    failWith(container.ownerDocument.querySelector('video')!, 2);
    await act(async () => {});

    expect(query).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toBeInTheDocument();

    const b = videoEvent(B, '/static/companion/other.mp4?X-Amz-Signature=old');
    rerender(inDrawer(b));

    failWith(container.ownerDocument.querySelector('video')!, 2);
    await act(async () => {});

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ variables: { id: b.id } }));
    expect(drawerHost.refreshActiveEntity).not.toHaveBeenCalled();
  });
});
