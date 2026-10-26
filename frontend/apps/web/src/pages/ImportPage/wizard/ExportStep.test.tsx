import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogSource } from '../useImportApi';

import { ExportStep } from './ExportStep';
import type { ExportEntry } from './sources';

/**
 * The export card's contract with the backend: an upload becomes one
 * unpack+parse run PER DROP — parse now, push at Sync — labeled so History can
 * say what it was.
 */

const uploadFile = vi.fn(async (file: File, onProgress?: (loaded: number, total: number) => void) => {
  // A mid-flight progress event, so the live row has something to render.
  onProgress?.(Math.max(1, Math.floor(file.size / 2)), Math.max(file.size, 1));

  return { dropId: `drop-${file.name}`, originalFilename: file.name };
});
const startRun = vi.fn(async (dropId: string) => ({ id: `run-${dropId}`, stages: [] }));

const scanInbox = vi.fn(
  async (): Promise<{
    available: boolean;
    reason?: string;
    inboxDir: string;
    displayDir: string;
    units: never[];
    skippedSymlinks: number;
    truncated: boolean;
  }> => ({
    available: true,
    inboxDir: '/var/lib/ci-import/inbox',
    displayDir: '/var/lib/ci-import/inbox',
    units: [],
    skippedSymlinks: 0,
    truncated: false,
  }),
);

const API = {
  ready: true,
  uploadFile,
  startRun,
  scanInbox,
};

vi.mock('../useImportApi', () => ({
  useImportApi: () => API,
}));

vi.mock('../zipStore', () => ({
  zipFilesStore: vi.fn(async (files: File[], onProgress?: (done: number, total: number) => void) => {
    onProgress?.(files.length, files.length);

    return new File(['zip'], 'chatgpt-export.zip');
  }),
}));

vi.mock('./LiveRunList', () => ({
  LiveRunList: ({ runIds }: { runIds: readonly string[] }) => (
    <>
      {runIds.map((id) => (
        <div key={id}>pipeline for {id}</div>
      ))}
    </>
  ),
}));

vi.mock('../DropZone', () => ({
  DropZone: ({ onFiles, label }: { onFiles: (files: File[]) => void; label?: string }) => (
    <>
      <button
        type="button"
        onClick={() => onFiles([new File(['x'], 'spotify.zip'), new File(['y'], 'spotify-extended.zip')])}
      >
        {label ?? 'drop'}
      </button>
      <button
        type="button"
        onClick={() => onFiles(Array.from({ length: 60 }, (_, i) => new File(['x'], `part-${i}.mp4`)))}
      >
        drop many
      </button>
      <button
        type="button"
        onClick={() =>
          onFiles([
            new File(['a'], 'PXL_001.jpg'),
            new File(['b'], 'spotify.zip'),
            new File(['c'], 'PXL_002.jpg'),
            new File(['d'], 'VID_003.mp4'),
          ])
        }
      >
        drop photos
      </button>
      <button
        type="button"
        onClick={() => {
          const conversations = new File(['{}'], 'conversations.json');

          Object.defineProperty(conversations, 'webkitRelativePath', {
            value: 'chatgpt-export/conversations.json',
          });
          onFiles([conversations]);
        }}
      >
        drop folder
      </button>
    </>
  ),
}));

function catalogSource(overrides: Partial<CatalogSource> & { id: string }): CatalogSource {
  return {
    title: overrides.id,
    blurb: 'blurb',
    ecosystem: 'music',
    category: 'audio',
    acquisition: 'web-export',
    wait: 'days',
    steps: ['Ask for the export.', 'Upload it here.'],
    importer: overrides.id,
    importerReady: true,
    ...overrides,
  };
}

const SPOTIFY = {
  kind: 'service',
  key: 'spotify',
  source: catalogSource({ id: 'spotify', title: 'Spotify' }),
  importers: ['spotify'],
} satisfies ExportEntry;

const NOT_READY = {
  kind: 'service',
  key: 'deezer',
  source: catalogSource({ id: 'deezer', title: 'Deezer', importerReady: false }),
  importers: ['deezer'],
} satisfies ExportEntry;

function renderStep(overrides: Partial<Parameters<typeof ExportStep>[0]> = {}) {
  const onIndex = vi.fn();
  const onRunsStarted = vi.fn();
  const onFinish = vi.fn();

  render(
    <ExportStep
      entries={[SPOTIFY, NOT_READY]}
      index={0}
      runsByEntry={new Map()}
      onRunsStarted={onRunsStarted}
      onIndex={onIndex}
      onBackToPick={vi.fn()}
      onFinish={onFinish}
      {...overrides}
    />,
  );

  return { onIndex, onRunsStarted, onFinish };
}

describe('ExportStep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows where in the walk this card sits', () => {
    renderStep();

    expect(screen.getByText(/Service 1 of 2/)).toBeInTheDocument();
  });

  it('badges how the export is obtained beside how long it takes', () => {
    renderStep();

    // The fixture is a days-wait web-export: both chips, human words.
    expect(screen.getByText('Takes a day or more')).toBeInTheDocument();
    expect(screen.getByText('Web export')).toBeInTheDocument();
  });

  it('leads the card with the service’s logo when one exists', () => {
    renderStep();

    // spotify has a mapped logo; the img is decorative (empty alt), so it is
    // found by src rather than by role.
    expect(document.querySelector('img[src="/import-logos/spotify.svg"]')).not.toBeNull();
  });

  it('renders the expected format and the notes, which most guides carry', () => {
    renderStep({
      entries: [
        {
          ...SPOTIFY,
          source: {
            ...SPOTIFY.source,
            expectedFormat: 'A zip containing StreamingHistory*.json files.',
            notes: ['The extended history arrives separately, weeks later.'],
          },
        },
      ],
    });

    expect(screen.getByRole('heading', { name: /expected format/i })).toBeInTheDocument();
    expect(screen.getByText(/StreamingHistory\*\.json/)).toBeInTheDocument();
    expect(screen.getByText(/extended history arrives separately/i)).toBeInTheDocument();
  });

  it('names the service in the export-page button, below the instructions', () => {
    renderStep({
      entries: [
        {
          ...SPOTIFY,
          source: { ...SPOTIFY.source, url: 'https://www.spotify.com/account/privacy/' },
        },
      ],
    });

    const cta = screen.getByRole('link', { name: /open the spotify export page/i });

    expect(cta).toHaveAttribute('href', 'https://www.spotify.com/account/privacy/');

    // Below the steps, as upstream places it: the instructions are read first,
    // the doorway is the last thing on the way out.
    const lastStep = screen.getByText('Upload it here.');

    expect(lastStep.compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('starts one parse-and-store run per uploaded file, labeled by its filename', async () => {
    const { onRunsStarted } = renderStep();

    fireEvent.click(screen.getByRole('button', { name: /drop your spotify export here/i }));

    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(2));

    // Parse now, push at Sync — the whole reason the wizard has a step 3.
    // `media` goes with parse, NOT with the deferred push: it reads bytes out of
    // the run's scratch tree, which is reclaimed when the run's last stage
    // finishes. Deferring it is what made every wizard import parse its photos
    // and then delete them.
    expect(startRun).toHaveBeenCalledWith('drop-spotify.zip', {
      label: 'spotify.zip',
      stages: ['unpack', 'parse', 'media'],
      // The card's importer travels with the run — what lets the picker credit
      // "imported ✓" to intent instead of stray recognition.
      declaredSources: ['spotify'],
    });
    expect(startRun).toHaveBeenCalledWith('drop-spotify-extended.zip', {
      label: 'spotify-extended.zip',
      stages: ['unpack', 'parse', 'media'],
      declaredSources: ['spotify'],
    });
    // Reported after EVERY finished file — the first part's pipeline renders
    // while the second is still on the wire — and each report carries ONLY
    // that file's run: the host appends, so a cumulative list here re-added
    // every earlier run once per later file (the "duplicated dozens of
    // times" progress list).
    expect(onRunsStarted).toHaveBeenCalledWith('spotify', ['run-drop-spotify.zip']);
    expect(onRunsStarted).toHaveBeenLastCalledWith('spotify', ['run-drop-spotify-extended.zip']);
  });

  it('packs a dropped folder into ONE zip, uploads it with progress, and starts one run', async () => {
    const { onRunsStarted } = renderStep();

    fireEvent.click(screen.getByRole('button', { name: /drop folder/i }));

    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));

    // The unit that went up is the packed archive, not the tree's files.
    const sent = (uploadFile.mock.calls[0] as unknown as [File])[0];

    expect(sent.name).toBe('chatgpt-export.zip');
    expect(startRun).toHaveBeenCalledWith('drop-chatgpt-export.zip', {
      label: 'chatgpt-export.zip',
      stages: ['unpack', 'parse', 'media'],
      declaredSources: ['spotify'],
    });
    await waitFor(() =>
      expect(onRunsStarted).toHaveBeenCalledWith('spotify', ['run-drop-chatgpt-export.zip']),
    );
    // One row, named for the archive it became.
    expect(screen.getByText('chatgpt-export.zip')).toBeInTheDocument();
  });

  it('packs loose files that are not archives into ONE zip and starts one run, archives still one each', async () => {
    const { onRunsStarted } = renderStep();

    fireEvent.click(screen.getByRole('button', { name: /drop photos/i }));

    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(2));

    // Three photos and a video were picked together: one archive, named for
    // the card and the count rather than after whichever file came first.
    const sent = uploadFile.mock.calls.map((call) => (call as unknown as [File])[0].name);

    expect(sent).toEqual(['Spotify (3 files).zip', 'spotify.zip']);
    expect(startRun).toHaveBeenCalledWith('drop-Spotify (3 files).zip', {
      label: 'Spotify (3 files).zip',
      stages: ['unpack', 'parse', 'media'],
      declaredSources: ['spotify'],
    });
    await waitFor(() =>
      expect(onRunsStarted).toHaveBeenLastCalledWith('spotify', ['run-drop-spotify.zip']),
    );
    expect(screen.getByText('Spotify (3 files).zip')).toBeInTheDocument();
  });

  it('lists every dropped file with its upload state, ending fully uploaded', async () => {
    renderStep();

    fireEvent.click(screen.getByRole('button', { name: /drop your spotify export here/i }));

    // Both filenames appear as rows, and the batch settles as fully uploaded.
    await screen.findByText('All 2 files uploaded');

    expect(screen.getByText('spotify.zip')).toBeInTheDocument();
    expect(screen.getByText('spotify-extended.zip')).toBeInTheDocument();
    expect(screen.getAllByText('uploaded ✓')).toHaveLength(2);
  });

  it('warns against closing the tab while files are on the wire, and stops once they land', async () => {
    let release!: (drop: { dropId: string; originalFilename: string }) => void;

    uploadFile.mockImplementationOnce(
      () => new Promise<{ dropId: string; originalFilename: string }>((resolve) => (release = resolve)),
    );

    renderStep();

    fireEvent.click(screen.getByRole('button', { name: /drop your spotify export here/i }));

    await screen.findByText(/keep this tab open/i);

    release({ dropId: 'drop-spotify.zip', originalFilename: 'spotify.zip' });

    await screen.findByText('All 2 files uploaded');
    expect(screen.queryByText(/keep this tab open/i)).not.toBeInTheDocument();
  });

  it('parks a huge drop behind an inbox suggestion instead of uploading it', async () => {
    renderStep();

    fireEvent.click(screen.getByRole('button', { name: 'drop many' }));

    // Nothing uploads until the person decides — and the suggestion names the
    // appliance's ACTUAL inbox folder, fetched from the server, not hardcoded.
    expect(await screen.findByText(/import inbox handles big folders better/i)).toBeInTheDocument();
    expect(await screen.findByText('/var/lib/ci-import/inbox')).toBeInTheDocument();
    expect(uploadFile).not.toHaveBeenCalled();

    // Cancel clears the parked batch entirely.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/import inbox handles big folders better/i)).not.toBeInTheDocument();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('says so when the inbox is not reachable, instead of naming a folder that is not there', async () => {
    scanInbox.mockResolvedValueOnce({
      available: false,
      reason: 'The inbox directory is not readable: ENOENT',
      inboxDir: '/var/lib/ci-import/inbox',
      displayDir: '/var/lib/ci-import/inbox',
      units: [],
      skippedSymlinks: 0,
      truncated: false,
    });

    renderStep();

    fireEvent.click(screen.getByRole('button', { name: 'drop many' }));

    expect(await screen.findByText(/isn.t reachable on this appliance/i)).toBeInTheDocument();
  });

  it('uploads a parked drop after explicit confirmation', async () => {
    renderStep();

    fireEvent.click(screen.getByRole('button', { name: 'drop many' }));
    fireEvent.click(await screen.findByRole('button', { name: /upload 60 files anyway/i }));

    // Sixty small videos fit in one packed archive, so they make one run.
    await screen.findByText('File uploaded');
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it('a failed file is named and does not stop the files behind it', async () => {
    uploadFile.mockRejectedValueOnce(new Error('disk full'));

    const { onRunsStarted } = renderStep();

    fireEvent.click(screen.getByRole('button', { name: /drop your spotify export here/i }));

    // File 1 failed loudly; file 2 still uploaded and its run still started.
    await screen.findByText(/failed — disk full/);
    await waitFor(() =>
      expect(onRunsStarted).toHaveBeenLastCalledWith('spotify', ['run-drop-spotify-extended.zip']),
    );
    expect(screen.getByText(/Uploaded 1 of 2 files \(1 failed\)/)).toBeInTheDocument();
  });

  it('failed rows can be retried without re-dropping — the token-rotation recovery path', async () => {
    // The real incident: a session-token rotation mid-batch turned every
    // remaining upload into "failed — Unauthorized". After the fix the header
    // is read at send time, but stranded rows still need a second chance.
    uploadFile.mockRejectedValueOnce(new Error('Unauthorized'));

    renderStep();

    fireEvent.click(screen.getByRole('button', { name: /drop your spotify export here/i }));

    await screen.findByText(/failed — Unauthorized/);

    fireEvent.click(await screen.findByRole('button', { name: /retry 1 failed upload/i }));

    // Only the failed file re-uploads (1 initial failure + 1 success for file
    // 2 + 1 retry = 3 calls), and the retried batch settles clean.
    await screen.findByText('File uploaded');
    expect(uploadFile).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/failed — Unauthorized/)).not.toBeInTheDocument();
  });

  it('renders the live pipeline for runs already started from this card', () => {
    renderStep({ runsByEntry: new Map([['spotify', ['run-a']]]) });

    expect(screen.getByText('pipeline for run-a')).toBeInTheDocument();
  });

  it('walks forward, and the last card hands off to Sync', () => {
    const { onIndex } = renderStep();

    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(onIndex).toHaveBeenCalledWith(1);

    const { onFinish } = renderStep({ index: 1 });

    fireEvent.click(screen.getByRole('button', { name: /finish/i }));
    expect(onFinish).toHaveBeenCalled();
  });

  it('offers no upload for a coming-soon importer, but keeps the instructions', () => {
    renderStep({ index: 1 });

    expect(screen.queryByRole('button', { name: /drop your deezer export/i })).not.toBeInTheDocument();
    expect(screen.getByText(/not finished yet/i)).toBeInTheDocument();
    // The steps still render: exporting now and uploading later is legitimate.
    expect(screen.getByText('Ask for the export.')).toBeInTheDocument();
  });
});
