/**
 * Sources is the merge of three routes — `/connect`, `/connections`, `/import` —
 * that answered one question badly. What is asserted here is the part a
 * refactor could quietly undo: that both paths are on screen at once, that the
 * empty state guides instead of reporting `Total Connections: 0`, and that the
 * import half stays hidden when the appliance has importing turned off.
 */
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { SourcesPage } from './SourcesPage';

const h = vi.hoisted(() => ({
  connections: 0,
  imports: 0,
  devices: 0,
  importEnabled: true,
}));

vi.mock('@/common/feature', async () => {
  const actual = await vi.importActual<typeof import('@/common/feature')>('@/common/feature');

  return {
    ...actual,
    useFeatures: () => ({
      isFeatureEnabled: (flag: string) => (flag === 'import.page' ? h.importEnabled : true),
    }),
  };
});

vi.mock('./useSourceCounts', () => ({
  useSourceCounts: () => ({
    connections: h.connections,
    imports: h.imports,
    devices: h.devices,
    isFirstRun: h.connections === 0 && h.imports === 0 && h.devices === 0,
    loading: false,
  }),
}));

// Both halves are real surfaces with their own network graphs. This page's job
// is which one is on screen, so they are stubbed down to a marker.
vi.mock('./ConnectPanel', () => ({ ConnectPanel: () => <div>connect panel</div> }));
vi.mock('./DevicesPanel', () => ({ DevicesPanel: () => <div>devices panel</div> }));
vi.mock('@/pages/ImportPage/ImportPage', () => ({
  ImportSurface: ({ variant }: { variant?: string }) => <div>import surface: {variant ?? 'page'}</div>,
}));

beforeEach(() => {
  h.connections = 0;
  h.imports = 0;
  h.devices = 0;
  h.importEnabled = true;
});

function renderAt(route: string) {
  return renderWithProviders(<SourcesPage />, { route, path: '/sources/:half?' });
}

describe('SourcesPage', () => {
  it('offers every way in from any of them', async () => {
    renderAt('/sources/connect');

    // The switch is the point: someone who lands on the wrong path can see the
    // others without going back.
    expect(await screen.findByRole('link', { name: /Services/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Import/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Devices/ })).toBeInTheDocument();
  });

  // The extension and Capture spent this page's first version as sections
  // below the whole service catalogue, which put the two sources nothing else
  // can substitute behind the longest scroll.
  it('gives devices a path of its own', async () => {
    renderAt('/sources/devices');

    expect(await screen.findByText('devices panel')).toBeInTheDocument();
  });

  it('normalises /sources to the connect half', async () => {
    renderAt('/sources');

    await waitFor(() => expect(screen.getByText('connect panel')).toBeInTheDocument());
  });

  it('hosts the same import surface /import did', async () => {
    renderAt('/sources/import');

    expect(await screen.findByText(/import surface: page/)).toBeInTheDocument();
  });

  it('scrolls the import surface under the path tiles, like connect and devices', async () => {
    renderAt('/sources/import');

    const surface = await screen.findByText(/import surface: page/);
    const scroller = surface.parentElement;

    expect(scroller).toHaveClass('overflow-y-auto');
    expect(scroller?.contains(screen.getByRole('link', { name: /Services/ }))).toBe(false);
  });

  // The breadcrumb, the rail entry and the tiles all already name this page;
  // a heading and a standfirst on top of them pushed the only actionable thing
  // on the screen below the fold.
  it('does not restate its own name above the tiles', async () => {
    renderAt('/sources/connect');

    await waitFor(() => expect(screen.getByText('connect panel')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Sources' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Everything Companion knows came from somewhere/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing is feeding your memory yet/i)).not.toBeInTheDocument();
  });

  // The pitch moved off the switch and into each path's own content. On the
  // tiles it made three tiles three different heights and pushed the content
  // below the fold.
  it('keeps the switch to a switch', async () => {
    renderAt('/sources/connect');

    // ConnectPanel is stubbed here, so nothing but a tile could supply these.
    await waitFor(() => expect(screen.getByText('connect panel')).toBeInTheDocument());
    expect(screen.queryByText('Effort')).not.toBeInTheDocument();
    expect(screen.queryByText('You get')).not.toBeInTheDocument();
    expect(screen.queryByText(/About a minute, once\./)).not.toBeInTheDocument();
  });

  describe('once something is flowing', () => {
    it('drops the first-run guidance and reports counts instead', async () => {
      h.connections = 3;
      h.imports = 2;
      h.devices = 1;

      renderAt('/sources/connect');

      await waitFor(() => expect(screen.getByText('3 connected')).toBeInTheDocument());
      expect(screen.getByText('2 imports')).toBeInTheDocument();
      expect(screen.getByText('1 device')).toBeInTheDocument();
    });

    it('counts a single import in the singular', async () => {
      h.connections = 1;
      h.imports = 1;

      renderAt('/sources/connect');

      await waitFor(() => expect(screen.getByText('1 import')).toBeInTheDocument());
    });

    // A path with nothing yet says so by omission — no count — rather than by
    // becoming a different shape from the other two.
    it('reports a count only for the paths that have one', async () => {
      h.connections = 3;
      h.imports = 0;
      h.devices = 0;

      renderAt('/sources/connect');

      await waitFor(() => expect(screen.getByText('3 connected')).toBeInTheDocument());
      expect(screen.queryByText(/0 imports/)).not.toBeInTheDocument();
      expect(screen.queryByText(/0 devices/)).not.toBeInTheDocument();
    });
  });

  describe('with importing turned off', () => {
    beforeEach(() => {
      h.importEnabled = false;
    });

    it('does not offer a path that leads nowhere', async () => {
      renderAt('/sources/connect');

      await waitFor(() => expect(screen.getByText('connect panel')).toBeInTheDocument());
      expect(screen.queryByRole('link', { name: /Import/ })).not.toBeInTheDocument();

      // Only import is gated — the other two must survive the flag.
      expect(screen.getByRole('link', { name: /Services/ })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Devices/ })).toBeInTheDocument();
    });

    it('lands /sources/import on the connect half rather than an empty page', async () => {
      // The import surface is not registered when the flag is off, so a stale
      // link or bookmark has to resolve to something real.
      renderAt('/sources/import');

      await waitFor(() => expect(screen.getByText('connect panel')).toBeInTheDocument());
      expect(screen.queryByText(/import surface/)).not.toBeInTheDocument();
    });
  });
});

/** Phone or not, as `useDeviceLayout` reads it (the `max-width` query). */
function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? mobile : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

/**
 * On a phone the three tiles stacked one per row and, pinned above the scrolling
 * content, took nearly half the screen. There the switch is one row of segments.
 */
describe('SourcesPage on a phone', () => {
  afterEach(() => setViewport(false));

  it('keeps every path in one row of segments, the current one marked', async () => {
    setViewport(true);
    renderAt('/sources/connect');

    const services = await screen.findByRole('link', { name: /Services/ });
    const row = services.parentElement;

    expect(row).toHaveClass('grid-cols-3');
    expect(row).toContainElement(screen.getByRole('link', { name: /Import/ }));
    expect(row).toContainElement(screen.getByRole('link', { name: /Devices/ }));
    expect(services).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Import/ })).not.toHaveAttribute('aria-current');
  });

  it('shows counts as numbers, keeping the noun for screen readers', async () => {
    setViewport(true);
    h.imports = 2;
    renderAt('/sources/connect');

    const importLink = await screen.findByRole('link', { name: /Import/ });

    expect(importLink).toHaveTextContent(/2/);
    expect(importLink).toHaveAccessibleName(/Import\s*2 imports/);
    expect(screen.queryByText('2 imports')).not.toBeInTheDocument();
  });

  it('drops the import segment when importing is off, and the row to two', async () => {
    setViewport(true);
    h.importEnabled = false;
    renderAt('/sources/connect');

    const services = await screen.findByRole('link', { name: /Services/ });

    expect(services.parentElement).toHaveClass('grid-cols-2');
    expect(screen.queryByRole('link', { name: /Import/ })).not.toBeInTheDocument();
  });
});
