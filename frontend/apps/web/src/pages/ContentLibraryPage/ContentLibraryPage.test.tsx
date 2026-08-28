import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { resolveContentTileUrl } from '@/components/entities/resolveMediaUrl';
import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { ContentLibraryPage, PAGE_SIZE } from './ContentLibraryPage';
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

const GET_CONTENTS = gql(`
  query GetContents($first: Int, $after: String) {
    contents(first: $first, after: $after) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          ...ContentTileFragment
        }
      }
    }
  }
`);

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

    // `EmptyState` (from `@ci/common`) wraps its message in an
    // absolutely-positioned, pointer-events-none container — a DOM
    // fingerprint the old bespoke `<p className="text-sm text-muted-foreground">`
    // never had. Asserting on it proves this is genuinely the shared
    // component now, not just visually identical bespoke markup.
    expect(message.parentElement).toHaveClass('absolute', 'inset-0', 'pointer-events-none');
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
