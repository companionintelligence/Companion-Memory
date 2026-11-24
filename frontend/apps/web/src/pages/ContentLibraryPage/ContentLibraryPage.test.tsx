import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { resolveContentTileUrl } from '@/components/entities/resolveMediaUrl';
import { renderWithProviders } from '@/test/renderWithProviders';

import { ContentLibraryPage, GET_CONTENTS, GET_CONTENT_FACETS, PAGE_SIZE } from './ContentLibraryPage';
import { contentKindFor } from './ContentTile';

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

vi.mock('@/components/MemoryHub', () => ({
  MemoryHubShell: ({ children }: { children: React.ReactNode }) => children,
}));

// The drawer has its own query; these tests exercise the grid.
vi.mock('./ContentSheet', () => ({
  ContentSheet: () => null,
}));

/**
 * `/memory/content/:contentId` carries the RAW uuid — the page re-encodes it
 * with `GlobalUID.encode('content', id)` before the drawer queries. GraphQL
 * `id` fields are global ids (base64 `content:<uuid>`), so routing with one
 * unchanged would double-encode it and the drawer would find nothing.
 */
const CONTENT_UUID = '019fd7c0-641c-76dd-8ed7-a5053faff6f1';
const CONTENT_GLOBAL_ID = btoa(`content:${CONTENT_UUID}`);
const SECOND_UUID = '019fd7c0-641c-76dd-8ed7-a5053faff6f2';
const SECOND_GLOBAL_ID = btoa(`content:${SECOND_UUID}`);

function pageInfo({ hasNextPage = false, endCursor = null as string | null } = {}) {
  return { __typename: 'PageInfo' as const, hasNextPage, endCursor };
}

function contentNode(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'ContentType' as const,
    id: CONTENT_GLOBAL_ID,
    title: 'Holiday photo',
    text: null,
    mimetype: 'image/jpeg',
    contentUrl: null,
    sourceUrl: null,
    previewUrl: null,
    mediaUrl: null,
    player: null,
    unfurl: null,
    ...overrides,
  };
}

/** See PeoplePage.test.tsx — the suite stubs IntersectionObserver with a no-op. */
function captureIntersectionObserver() {
  const callbacks: IntersectionObserverCallback[] = [];
  const original = globalThis.IntersectionObserver;

  class CapturingObserver {
    constructor(callback: IntersectionObserverCallback) {
      callbacks.push(callback);
    }

    observe() {}

    unobserve() {}

    disconnect() {}

    takeRecords() {
      return [];
    }
  }

  globalThis.IntersectionObserver = CapturingObserver as unknown as typeof IntersectionObserver;

  return {
    scrollSentinelIntoView: async () => {
      await act(async () => {
        for (const callback of callbacks) {
          callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
        }
      });
    },
    restore: () => {
      globalThis.IntersectionObserver = original;
    },
  };
}

function facets({
  types = ['image', 'post'],
  mimetypes = ['image/png', 'text/plain'],
  sourceSystems = ['reddit'],
} = {}) {
  return {
    request: { query: GET_CONTENT_FACETS, variables: {} },
    result: {
      data: { contentFacets: { __typename: 'ContentFacets' as const, types, mimetypes, sourceSystems } },
    },
  };
}

function firstPage({ hasNextPage = false, totalCount = 1, node = contentNode() } = {}) {
  return {
    request: { query: GET_CONTENTS, variables: { first: PAGE_SIZE } },
    result: {
      data: {
        contents: {
          __typename: 'ContentConnection' as const,
          totalCount,
          pageInfo: pageInfo({ hasNextPage, endCursor: hasNextPage ? CONTENT_GLOBAL_ID : null }),
          edges: [{ __typename: 'ContentEdge' as const, cursor: CONTENT_GLOBAL_ID, node }],
        },
      },
    },
  };
}

describe('ContentLibraryPage', () => {
  it('reports how much of the library is on screen', async () => {
    renderWithProviders(<ContentLibraryPage />, {
      mocks: [firstPage({ hasNextPage: true, totalCount: 14194 })],
    });

    expect(await screen.findByLabelText('Holiday photo')).toBeInTheDocument();
    expect(screen.getByText(/loaded/).textContent).toContain('1 of 14194 loaded');
  });

  it('appends the next page when the sentinel scrolls into view', async () => {
    const observer = captureIntersectionObserver();

    try {
      renderWithProviders(<ContentLibraryPage />, {
        mocks: [
          firstPage({ hasNextPage: true, totalCount: 2 }),
          {
            request: { query: GET_CONTENTS, variables: { first: PAGE_SIZE, after: CONTENT_GLOBAL_ID } },
            result: {
              data: {
                contents: {
                  __typename: 'ContentConnection' as const,
                  totalCount: 2,
                  pageInfo: pageInfo(),
                  edges: [
                    {
                      __typename: 'ContentEdge' as const,
                      cursor: SECOND_GLOBAL_ID,
                      node: contentNode({
                        id: SECOND_GLOBAL_ID,
                        title: 'Tax notes',
                        mimetype: 'text/plain',
                        text: 'Remember the receipts',
                      }),
                    },
                  ],
                },
              },
            },
          },
        ],
      });

      expect(await screen.findByLabelText('Holiday photo')).toBeInTheDocument();
      expect(screen.queryByLabelText('Tax notes')).not.toBeInTheDocument();

      await observer.scrollSentinelIntoView();

      // Appended, not swapped in — and the footer now says the list is complete.
      expect(await screen.findByLabelText('Tax notes')).toBeInTheDocument();
      expect(screen.getByLabelText('Holiday photo')).toBeInTheDocument();
      expect(screen.getByText('Remember the receipts')).toBeInTheDocument();
      expect(screen.getByText(/loaded/).textContent).toContain('2 of 2 loaded · end');
    } finally {
      observer.restore();
    }
  });

  it('shows the hydrated file preview when the row is backed by a file', async () => {
    renderWithProviders(<ContentLibraryPage />, {
      mocks: [firstPage({ node: contentNode({ previewUrl: '/files/abc/preview.webp?sig=1' }) })],
    });

    const img = await screen.findByRole('img', { name: 'Holiday photo' });

    expect(img).toHaveAttribute('src', '/static/files/abc/preview.webp?sig=1');
  });

  it('falls back to a typed card when there is nothing to show as a picture', async () => {
    renderWithProviders(<ContentLibraryPage />, {
      mocks: [
        firstPage({
          node: contentNode({
            title: null,
            mimetype: 'text/html',
            text: 'An article',
            sourceUrl: 'https://x.test',
          }),
        }),
      ],
    });

    const tile = await screen.findByLabelText('Untitled');

    expect(tile.querySelector('img')).toBeNull();
    expect(tile.textContent).toContain('An article');
    expect(tile.textContent).toContain('Web page');
  });

  it('routes to the decoded uuid so an individual row has a shareable URL', async () => {
    navigate.mockClear();
    renderWithProviders(<ContentLibraryPage />, { mocks: [firstPage()] });

    fireEvent.click(await screen.findByLabelText('Holiday photo'));

    expect(navigate).toHaveBeenCalledWith(`/memory/content/${CONTENT_UUID}`);
    expect(navigate).not.toHaveBeenCalledWith(`/memory/content/${CONTENT_GLOBAL_ID}`);
  });

  it('carries the search and facets along when a row opens, so the library behind the drawer keeps them', async () => {
    navigate.mockClear();
    const page = firstPage();
    renderWithProviders(<ContentLibraryPage />, {
      route: '/memory/content?search=squirrel&types=media',
      mocks: [
        {
          ...page,
          request: { ...page.request, variables: { first: PAGE_SIZE, query: 'squirrel', types: ['media'] } },
        },
      ],
    });

    fireEvent.click(await screen.findByLabelText('Holiday photo'));

    expect(navigate).toHaveBeenCalledWith(`/memory/content/${CONTENT_UUID}?search=squirrel&types=media`);
  });

  it('sends the URL filters with the query and offers to clear them', async () => {
    const filteredPage = {
      ...firstPage(),
      request: {
        query: GET_CONTENTS,
        variables: { first: PAGE_SIZE, types: ['image'], connectors: ['reddit'] },
      },
    };

    renderWithProviders(<ContentLibraryPage />, {
      route: '/memory/content?types=image&connectors=reddit',
      mocks: [filteredPage, facets()],
    });

    // The tile only appears if the request carried exactly those variables.
    expect(await screen.findByText('Holiday photo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Content type: image/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^File type: all/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^How: Reddit/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    await screen.findByRole('button', { name: /^Content type: all/ });
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('collapses mobile filters while keeping active choices visible', async () => {
    const originalMatchMedia = window.matchMedia;

    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    try {
      const filteredPage = {
        ...firstPage(),
        request: {
          query: GET_CONTENTS,
          variables: { first: PAGE_SIZE, types: ['image'], connectors: ['reddit'] },
        },
      };

      renderWithProviders(<ContentLibraryPage />, {
        route: '/memory/content?types=image&connectors=reddit',
        mocks: [filteredPage, facets()],
      });

      expect(await screen.findByLabelText('Holiday photo')).toBeInTheDocument();
      expect(screen.queryByTestId('content-filters')).not.toBeInTheDocument();
      expect(screen.getByText('Type: image')).toBeInTheDocument();
      expect(screen.getByText('How: reddit')).toBeInTheDocument();

      const toggle = screen.getByRole('button', { name: /Filters/ });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(toggle);

      expect(screen.getByTestId('content-filters')).toBeInTheDocument();
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('button', { name: /^Content type: image/ })).toBeInTheDocument();
      expect(document.querySelector('.grid.grid-cols-2')).toHaveClass('gap-2', 'device:gap-4');
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('lists every value the account carries when a facet picker opens', async () => {
    renderWithProviders(<ContentLibraryPage />, {
      mocks: [firstPage(), facets({ types: ['image', 'post', 'video'] })],
    });

    expect(await screen.findByText('Holiday photo')).toBeInTheDocument();

    // Radix's DropdownMenuTrigger opens on pointerdown, not click.
    fireEvent.pointerDown(await screen.findByRole('button', { name: /^Content type: all/ }), { button: 0 });

    const items = await screen.findAllByRole('menuitemcheckbox');
    expect(items.map((item) => item.textContent)).toEqual(['image', 'post', 'video']);
  });

  it('says the facets could not load, not that there are none, when their query fails', async () => {
    // Live 2026-09-22: Postgres out of /dev/shm failed contentFacets on every
    // load, and both pickers read "No content types yet" over a 132k-row
    // library. The picker must not turn a failed query into a claim about
    // the account.
    renderWithProviders(<ContentLibraryPage />, {
      mocks: [
        firstPage(),
        { request: { query: GET_CONTENT_FACETS, variables: {} }, error: new Error('db down') },
      ],
    });

    expect(await screen.findByText('Holiday photo')).toBeInTheDocument();

    fireEvent.pointerDown(await screen.findByRole('button', { name: /^Content type: all/ }), { button: 0 });

    expect(await screen.findByText("Couldn't load content types")).toBeInTheDocument();
    expect(screen.queryByText('No content types yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemcheckbox')).not.toBeInTheDocument();
  });

  it('shows the shared EmptyState when the library is genuinely empty', async () => {
    renderWithProviders(<ContentLibraryPage />, {
      mocks: [
        {
          request: { query: GET_CONTENTS, variables: { first: PAGE_SIZE } },
          result: {
            data: {
              contents: {
                __typename: 'ContentConnection' as const,
                totalCount: 0,
                pageInfo: pageInfo(),
                edges: [],
              },
            },
          },
        },
      ],
    });

    const message = await screen.findByText(
      'Nothing here yet. Content appears as your sources sync and files finish parsing.',
    );

    // `EmptyState` (from `@ci/common`) wraps its message in a
    // pointer-events-auto content box nested inside an absolutely-positioned,
    // pointer-events-none overlay — a DOM fingerprint the old bespoke
    // `<p className="text-sm text-muted-foreground">` never had. Asserting on
    // it proves this is genuinely the shared component now, not just visually
    // identical bespoke markup. The pointer-events pair is inline style rather
    // than a Tailwind class because `packages/common` is outside the web app's
    // Tailwind source set, so a class authored only there is never compiled.
    const content = message.parentElement;
    expect(content).toHaveStyle({ pointerEvents: 'auto' });
    expect(content?.parentElement).toHaveClass('absolute', 'inset-0');
    expect(content?.parentElement).toHaveStyle({ pointerEvents: 'none' });
  });
});

describe('resolveContentTileUrl', () => {
  it('prefers the derived preview, then the original for images only', () => {
    expect(resolveContentTileUrl({ mimetype: 'application/pdf', previewUrl: '/p', mediaUrl: '/m' })).toBe(
      '/static/p',
    );
    expect(resolveContentTileUrl({ mimetype: 'image/png', mediaUrl: '/m', contentUrl: 'https://c' })).toBe(
      '/static/m',
    );
    expect(resolveContentTileUrl({ mimetype: 'image/png', contentUrl: 'https://c/x.png' })).toBe(
      'https://c/x.png',
    );
    expect(resolveContentTileUrl({ mimetype: 'application/pdf', mediaUrl: '/m' })).toBeUndefined();
  });
});

describe('contentKindFor', () => {
  it('labels by top-level mimetype', () => {
    expect(contentKindFor('video/mp4').label).toBe('Video');
    expect(contentKindFor('audio/mpeg').label).toBe('Audio');
    expect(contentKindFor('application/pdf').label).toBe('PDF');
    expect(contentKindFor(null).label).toBe('Content');
  });
});
