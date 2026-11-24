import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogSource } from '../useImportApi';

import { ImportWizard } from './ImportWizard';

/**
 * The umbrella's own job, with every step stubbed to a thin probe: load the
 * catalog once the api is ready, report a load failure instead of hanging on
 * an empty Pick screen, and carry state (which export card, which runs belong
 * to which entry) across the pick → export → sync walk correctly.
 *
 * Each step's OWN behaviour (the picker grid, the upload flow, the push
 * button) is covered by its own test file — PickStep.test.tsx,
 * ExportStep.test.tsx, SyncStep.test.tsx. Stubbing them here is what keeps
 * this file about the orchestration, not a re-test of three other files.
 */

const h = vi.hoisted(() => ({
  api: { ready: true, listCatalog: vi.fn(), listBundles: vi.fn() } as {
    ready: boolean;
    listCatalog: () => Promise<unknown>;
    listBundles: () => Promise<unknown>;
  },
}));

vi.mock('../useImportApi', () => ({
  useImportApi: () => h.api,
}));

vi.mock('./PickStep', () => ({
  PickStep: ({
    catalog,
    picked,
    onToggle,
    onContinue,
  }: {
    catalog: readonly CatalogSource[];
    picked: ReadonlySet<string>;
    onToggle: (key: string) => void;
    onContinue: () => void;
  }) => (
    <div>
      <span data-testid="pick-catalog-count">{catalog.length}</span>
      <span data-testid="pick-picked">{[...picked].join(',')}</span>
      <button onClick={() => onToggle('spotify')}>toggle spotify</button>
      <button onClick={() => onToggle('deezer')}>toggle deezer</button>
      <button onClick={onContinue}>pick continue</button>
    </div>
  ),
}));

vi.mock('./ExportStep', () => ({
  ExportStep: ({
    entries,
    index,
    runsByEntry,
    onRunsStarted,
    onIndex,
    onBackToPick,
    onFinish,
  }: {
    entries: readonly { key: string }[];
    index: number;
    runsByEntry: ReadonlyMap<string, readonly string[]>;
    onRunsStarted: (key: string, runIds: readonly string[]) => void;
    onIndex: (index: number) => void;
    onBackToPick: () => void;
    onFinish: () => void;
  }) => (
    <div>
      <span data-testid="export-index">{index}</span>
      <span data-testid="export-entries">{entries.map((entry) => entry.key).join(',')}</span>
      <span data-testid="export-runs">{JSON.stringify([...runsByEntry.entries()])}</span>
      <button onClick={() => onIndex(index + 1)}>advance export index</button>
      <button onClick={onBackToPick}>export back to pick</button>
      <button onClick={onFinish}>export finish</button>
      <button onClick={() => onRunsStarted('spotify', ['run-a'])}>record spotify run a</button>
      <button onClick={() => onRunsStarted('spotify', ['run-b'])}>record spotify run b</button>
    </div>
  ),
}));

vi.mock('./SyncStep', () => ({
  SyncStep: ({ onBackToExport }: { onBackToExport: () => void }) => (
    <div>
      <span>sync step</span>
      <button onClick={onBackToExport}>sync back to export</button>
    </div>
  ),
}));

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

const CATALOG = [catalogSource({ id: 'spotify' }), catalogSource({ id: 'deezer' })];

beforeEach(() => {
  h.api = {
    ready: true,
    listCatalog: vi.fn().mockResolvedValue(CATALOG),
    listBundles: vi.fn().mockResolvedValue([]),
  };
});

describe('ImportWizard catalog loading', () => {
  it('does not fetch the catalog before the api is ready', () => {
    h.api = {
      ready: false,
      listCatalog: vi.fn().mockResolvedValue(CATALOG),
      listBundles: vi.fn().mockResolvedValue([]),
    };

    render(<ImportWizard />);

    expect(h.api.listCatalog).not.toHaveBeenCalled();
    expect(screen.getByTestId('pick-catalog-count')).toHaveTextContent('0');
  });

  it('fetches once ready and hands the catalog to Pick', async () => {
    render(<ImportWizard />);

    await waitFor(() => expect(screen.getByTestId('pick-catalog-count')).toHaveTextContent('2'));
    expect(h.api.listCatalog).toHaveBeenCalled();
  });

  it('shows a catalog error instead of a silently empty picker', async () => {
    h.api = {
      ready: true,
      listCatalog: vi.fn().mockRejectedValue(new Error('offline')),
      listBundles: vi.fn().mockResolvedValue([]),
    };

    render(<ImportWizard />);

    expect(await screen.findByText('offline')).toBeInTheDocument();
    // Pick still renders (empty), rather than the whole wizard going blank.
    expect(screen.getByTestId('pick-catalog-count')).toHaveTextContent('0');
  });

  it('falls back to the raw thrown value when it is not an Error', async () => {
    h.api = {
      ready: true,
      listCatalog: vi.fn().mockRejectedValue('server said no'),
      listBundles: vi.fn().mockResolvedValue([]),
    };

    render(<ImportWizard />);

    expect(await screen.findByText('server said no')).toBeInTheDocument();
  });
});

describe('ImportWizard step walk', () => {
  it('starts on Pick and walks forward to Export, then to Sync', async () => {
    render(<ImportWizard />);

    await waitFor(() => expect(screen.getByTestId('pick-catalog-count')).toHaveTextContent('2'));
    expect(screen.queryByTestId('export-index')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'toggle spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick continue' }));

    expect(screen.getByTestId('export-index')).toHaveTextContent('0');
    expect(screen.getByTestId('export-entries')).toHaveTextContent('spotify');
    expect(screen.queryByTestId('pick-catalog-count')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'export finish' }));

    expect(screen.getByText('sync step')).toBeInTheDocument();
    expect(screen.queryByTestId('export-index')).not.toBeInTheDocument();
  });

  it('walks Sync back to Export and Export back to Pick', async () => {
    render(<ImportWizard />);

    await waitFor(() => expect(screen.getByTestId('pick-catalog-count')).toHaveTextContent('2'));

    fireEvent.click(screen.getByRole('button', { name: 'toggle spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'export finish' }));

    expect(screen.getByText('sync step')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'sync back to export' }));
    expect(screen.getByTestId('export-index')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'export back to pick' }));
    expect(screen.getByTestId('pick-catalog-count')).toBeInTheDocument();
  });

  it('resets the export index to 0 every time Continue is pressed from Pick', async () => {
    render(<ImportWizard />);

    await waitFor(() => expect(screen.getByTestId('pick-catalog-count')).toHaveTextContent('2'));

    fireEvent.click(screen.getByRole('button', { name: 'toggle spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick continue' }));
    expect(screen.getByTestId('export-index')).toHaveTextContent('0');

    // Move to the second export card.
    fireEvent.click(screen.getByRole('button', { name: 'advance export index' }));
    expect(screen.getByTestId('export-index')).toHaveTextContent('1');

    // Back to Pick and forward again — the second visit must not resume
    // where the first left off.
    fireEvent.click(screen.getByRole('button', { name: 'export back to pick' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick continue' }));

    expect(screen.getByTestId('export-index')).toHaveTextContent('0');
  });

  it('tells a controlling host about every step change', async () => {
    const onStepChange = vi.fn();

    render(<ImportWizard onStepChange={onStepChange} />);

    await waitFor(() => expect(screen.getByTestId('pick-catalog-count')).toHaveTextContent('2'));
    expect(onStepChange).toHaveBeenLastCalledWith('pick');

    fireEvent.click(screen.getByRole('button', { name: 'toggle spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick continue' }));

    expect(onStepChange).toHaveBeenLastCalledWith('export');

    fireEvent.click(screen.getByRole('button', { name: 'export finish' }));

    expect(onStepChange).toHaveBeenLastCalledWith('sync');
  });
});

describe('ImportWizard picked state', () => {
  it('reports canExport only once something is picked', async () => {
    const onCanExportChange = vi.fn();

    render(<ImportWizard onCanExportChange={onCanExportChange} />);

    await waitFor(() => expect(screen.getByTestId('pick-catalog-count')).toHaveTextContent('2'));
    expect(onCanExportChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'toggle spotify' }));
    expect(onCanExportChange).toHaveBeenLastCalledWith(true);

    // Toggling the same key back off drops it to unreachable again.
    fireEvent.click(screen.getByRole('button', { name: 'toggle spotify' }));
    expect(onCanExportChange).toHaveBeenLastCalledWith(false);
  });

  it('accumulates more than one picked key rather than replacing the set', async () => {
    render(<ImportWizard />);

    await waitFor(() => expect(screen.getByTestId('pick-catalog-count')).toHaveTextContent('2'));

    fireEvent.click(screen.getByRole('button', { name: 'toggle spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'toggle deezer' }));

    expect(screen.getByTestId('pick-picked')).toHaveTextContent('spotify,deezer');

    fireEvent.click(screen.getByRole('button', { name: 'pick continue' }));
    expect(screen.getByTestId('export-entries')).toHaveTextContent('spotify,deezer');
  });
});

describe('ImportWizard runsByEntry', () => {
  it('accumulates run ids reported for the same entry across multiple uploads', async () => {
    render(<ImportWizard />);

    await waitFor(() => expect(screen.getByTestId('pick-catalog-count')).toHaveTextContent('2'));

    fireEvent.click(screen.getByRole('button', { name: 'toggle spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick continue' }));

    fireEvent.click(screen.getByRole('button', { name: 'record spotify run a' }));
    expect(screen.getByTestId('export-runs')).toHaveTextContent('run-a');

    fireEvent.click(screen.getByRole('button', { name: 'record spotify run b' }));

    // Both runs survive under the same entry key — the second report must
    // not have replaced the first.
    const runs = JSON.parse(screen.getByTestId('export-runs').textContent ?? '[]') as [string, string[]][];

    expect(runs).toEqual([['spotify', ['run-a', 'run-b']]]);
  });

  it('a re-reported run id is not appended twice (each run renders once, ever)', async () => {
    render(<ImportWizard />);

    await waitFor(() => expect(screen.getByTestId('pick-catalog-count')).toHaveTextContent('2'));

    fireEvent.click(screen.getByRole('button', { name: 'toggle spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick continue' }));

    // ExportStep once reported the CUMULATIVE list per finished unit; combined
    // with append-on-report here, file 1's run rendered once per remaining
    // file ("duplicated dozens of times" on a real Takeout). The store must
    // absorb a repeated id no matter what the reporter sends.
    fireEvent.click(screen.getByRole('button', { name: 'record spotify run a' }));
    fireEvent.click(screen.getByRole('button', { name: 'record spotify run a' }));
    fireEvent.click(screen.getByRole('button', { name: 'record spotify run b' }));

    const runs = JSON.parse(screen.getByTestId('export-runs').textContent ?? '[]') as [string, string[]][];

    expect(runs).toEqual([['spotify', ['run-a', 'run-b']]]);
  });
});
