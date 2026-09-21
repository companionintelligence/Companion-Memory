import { Sheet } from '@ci/shadcn';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import type { EntityItem } from '../../useEntityService';

import { EntityDrawerHostProvider } from './drawerHost';
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

function routableEvent(): EntityItem {
  return {
    __typename: 'EventType',
    id: btoa(`event:${EVENT_UUID}`),
    name: "Mom's birthday",
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
});
