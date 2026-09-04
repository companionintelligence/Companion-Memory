import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogSource } from '../useImportApi';

import { PickStep } from './PickStep';

// The usage rollup reaches the import API through auth context, which the bare
// render here does not provide — the documented pattern is to stub the hook.
// `unambiguousImporters` is a pure derivation over the catalog and stays real.
const usage = vi.hoisted(() => ({ value: new Map<string, string>() }));

vi.mock('./useSourceUsage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useSourceUsage')>();

  return { ...actual, useSourceUsage: () => usage.value };
});

// Same reason, same pattern, for the object-count rollup. `countFor` is a
// pure derivation and stays real.
const objectCounts = vi.hoisted(() => ({ value: new Map<string, ReadonlyMap<string, number>>() }));

vi.mock('./useObjectCounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useObjectCounts')>();

  return { ...actual, useObjectCounts: () => objectCounts.value };
});

/**
 * Step 1's contract: recognizable brands in sections, each tile saying what
 * picking it imports, coming-soon visible-but-badged, and Continue earned by
 * picking something.
 */

function catalogSource(overrides: Partial<CatalogSource> & { id: string }): CatalogSource {
  return {
    title: overrides.id,
    blurb: '',
    ecosystem: 'music',
    category: 'audio',
    acquisition: 'web-export',
    wait: 'minutes',
    steps: [],
    importer: overrides.id,
    importerReady: true,
    ...overrides,
  };
}

const CATALOG = [
  catalogSource({
    id: 'spotify',
    title: 'Spotify',
    whatImported: ['Your full listening history', 'Playlists you made and followed'],
  }),
  catalogSource({ id: 'deezer', title: 'Deezer', importerReady: false }),
  catalogSource({ id: 'strava', title: 'Strava', ecosystem: 'wearable', category: 'health' }),
];

function renderStep(picked: ReadonlySet<string> = new Set()) {
  const onToggle = vi.fn();
  const onContinue = vi.fn();

  render(<PickStep catalog={CATALOG} picked={picked} onToggle={onToggle} onContinue={onContinue} />);

  return { onToggle, onContinue };
}

describe('PickStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usage.value = new Map();
    objectCounts.value = new Map();
  });

  it('groups services into their sections', () => {
    renderStep();

    expect(screen.getByRole('heading', { name: /music/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /fitness/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Spotify/ })).toBeInTheDocument();
  });

  it('badges a coming-soon importer instead of hiding it', () => {
    renderStep();

    const deezer = screen.getByRole('button', { name: /deezer/i });

    expect(deezer).toBeInTheDocument();
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });

  it('filters tiles as you type, dropping emptied sections whole', () => {
    renderStep();

    fireEvent.change(screen.getByRole('textbox', { name: /search services/i }), {
      target: { value: 'spot' },
    });

    expect(screen.getByRole('button', { name: /Spotify/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Strava/ })).not.toBeInTheDocument();
    // Fitness lost its only tile; an empty heading would read as "everything
    // here was taken away".
    expect(screen.queryByRole('heading', { name: /fitness/i })).not.toBeInTheDocument();
  });

  it('finds a bundle by its member names', () => {
    render(
      <PickStep
        catalog={[
          catalogSource({
            id: 'gmail',
            title: 'Gmail (Google Takeout)',
            ecosystem: 'google',
            category: 'email',
          }),
        ]}
        picked={new Set()}
        onToggle={vi.fn()}
        onContinue={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: /search services/i }), {
      target: { value: 'gmail' },
    });

    // The tile is labeled "Google"; typing a member's name must surface it,
    // not an empty grid.
    expect(screen.getByRole('button', { name: /Google/ })).toBeInTheDocument();
  });

  it('says when nothing matches instead of showing an empty void', () => {
    renderStep();

    fireEvent.change(screen.getByRole('textbox', { name: /search services/i }), {
      target: { value: 'zzzz' },
    });

    expect(screen.getByText(/no services match/i)).toBeInTheDocument();
  });

  it('says what each source imports, not just its name', () => {
    renderStep();

    // Answering "what would picking this give me" on the tile is the whole
    // reason it is a card rather than a one-line label.
    expect(screen.getByRole('button', { name: /Spotify/ })).toHaveTextContent('Listening');
  });

  // The feature this file exists to cover: a real, compact count next to the
  // kind it describes — "118.3k Listening", not a bare label.
  it('shows a compact count next to an object kind this appliance can actually count', () => {
    objectCounts.value = new Map([['spotify', new Map([['Listening', 118_286]])]]);

    renderStep();

    expect(screen.getByRole('button', { name: /Spotify/ })).toHaveTextContent('118.3k Listening');
  });

  // Never imported and "imported, and it was zero" must look identical: no
  // number at all, the same way the "imported ✓" line renders nothing rather
  // than a date for a source that has never run.
  it('shows no number for a kind nobody has imported, or that this feature cannot count', () => {
    renderStep();

    const spotify = screen.getByRole('button', { name: /Spotify/ });

    expect(spotify).toHaveTextContent('Listening');
    expect(spotify).not.toHaveTextContent(/\d/);
  });

  it("sums a bundle's own members instead of showing nothing just because it is a bundle", () => {
    objectCounts.value = new Map([
      ['gmail', new Map([['Mail', 24_000]])],
      ['google_photos', new Map([['Photos', 1_234_000]])],
    ]);

    render(
      <PickStep
        catalog={[
          catalogSource({ id: 'gmail', title: 'Gmail', ecosystem: 'google', category: 'mail' }),
          catalogSource({
            id: 'google_photos',
            title: 'Google Photos',
            ecosystem: 'google',
            category: 'photos',
          }),
        ]}
        picked={new Set()}
        onToggle={vi.fn()}
        onContinue={vi.fn()}
      />,
    );

    const google = screen.getByRole('button', { name: /Google/ });

    expect(google).toHaveTextContent('24.0k Mail');
    expect(google).toHaveTextContent('1.2M Photos');
  });

  it('renders every kind on a tile that has more than four, none dropped', () => {
    const onToggle = vi.fn();
    const onContinue = vi.fn();

    // The Amazon bundle's five members span four categories — five kinds in
    // all, which the tile lays out in two columns rather than truncating.
    render(
      <PickStep
        catalog={[
          catalogSource({ id: 'amazon', title: 'Amazon orders', ecosystem: 'amazon', category: 'finance' }),
          catalogSource({ id: 'prime_video', title: 'Prime Video', ecosystem: 'amazon', category: 'video' }),
          catalogSource({ id: 'audible', title: 'Audible', ecosystem: 'amazon', category: 'audio' }),
          catalogSource({
            id: 'kindle_reading',
            title: 'Kindle reading',
            ecosystem: 'amazon',
            category: 'reading',
          }),
          catalogSource({
            id: 'amazon_music',
            title: 'Amazon Music',
            ecosystem: 'amazon',
            category: 'audio',
          }),
        ]}
        picked={new Set()}
        onToggle={onToggle}
        onContinue={onContinue}
      />,
    );

    const amazon = screen.getByRole('button', { name: /Amazon/ });

    for (const kind of [
      'Orders & payments',
      'Watch history',
      'Listening',
      'Playlists',
      'Books & highlights',
    ]) {
      expect(amazon).toHaveTextContent(kind);
    }
  });

  // "I could import this" and "I already did, in March" are different
  // answers, and the second is what stops someone re-importing an archive
  // they already have. How MUCH it brought is a fact about the run, not about
  // the source, so it is not claimed here.
  it('says when a source was last imported', () => {
    usage.value = new Map([['spotify', '2026-03-14T00:00:00.000Z']]);

    renderStep();

    expect(screen.getByRole('button', { name: /Spotify/ })).toHaveTextContent(/imported/);
    expect(screen.getByRole('button', { name: /Strava/ })).not.toHaveTextContent(/imported/);
  });

  // A run records which IMPORTER it fed, and thirteen catalog sources share
  // four parsers. Crediting Apple Calendar because a Google Calendar was
  // imported is a claim about the wrong service.
  it('claims nothing for a source whose parser is shared with another', () => {
    usage.value = new Map([['calendar', '2026-03-14T00:00:00.000Z']]);

    render(
      <PickStep
        catalog={[
          catalogSource({ id: 'google_calendar', title: 'Google Calendar', importer: 'calendar' }),
          catalogSource({ id: 'apple_calendar', title: 'Apple Calendar', importer: 'calendar' }),
        ]}
        picked={new Set()}
        onToggle={vi.fn()}
        onContinue={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /Google Calendar/ })).not.toHaveTextContent(/imported/);
    expect(screen.getByRole('button', { name: /Apple Calendar/ })).not.toHaveTextContent(/imported/);
  });

  it('toggling reports the source key upward', () => {
    const { onToggle } = renderStep();

    fireEvent.click(screen.getByRole('button', { name: /Spotify/ }));
    expect(onToggle).toHaveBeenCalledWith('spotify');
  });

  it('Continue is disabled until something is picked, and counts the picks', () => {
    renderStep();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('Continue reports the pick count and fires', () => {
    const { onContinue } = renderStep(new Set(['spotify', 'strava']));
    const button = screen.getByRole('button', { name: /continue.*2 selected/i });

    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalled();
  });

  it('pins Continue and scrolls the catalog by default', () => {
    renderStep();

    expect(screen.getByTestId('pick-catalog').className).toMatch(/overflow-y-auto/);
  });

  it('lets Continue sit after the catalog when the page is the scroller', () => {
    render(
      <PickStep
        catalog={CATALOG}
        picked={new Set(['spotify'])}
        onToggle={vi.fn()}
        onContinue={vi.fn()}
        pinContinue={false}
      />,
    );

    const catalog = screen.getByTestId('pick-catalog');
    const continueButton = screen.getByRole('button', { name: /continue/i });

    expect(catalog.className).not.toMatch(/overflow-y-auto/);
    expect(catalog.compareDocumentPosition(continueButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Page hosts scroll the whole surface, so the row must stick to the bottom
    // of that scrollport — a 2,300px catalog cannot bury the control that acts
    // on the pick.
    expect(continueButton.parentElement?.className).toMatch(/sticky/);
    expect(continueButton.parentElement?.className).toMatch(/bottom-0/);
  });

  it('does not make the pinned-variant row sticky (the flex split already pins it)', () => {
    render(<PickStep catalog={CATALOG} picked={new Set()} onToggle={vi.fn()} onContinue={vi.fn()} />);

    const continueButton = screen.getByRole('button', { name: /continue/i });
    expect(continueButton.parentElement?.className).not.toMatch(/sticky/);
  });
});
