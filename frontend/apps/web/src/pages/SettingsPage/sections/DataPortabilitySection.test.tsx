import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DataPortabilitySection } from './DataPortabilitySection';

const h = vi.hoisted(() => ({
  authToken: 'jwt-abc' as string | null,
  email: 'jsmith@example.com',
  native: false,
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: h.authToken }],
  useCurrentUser: () => ({ user: { id: 'u1', email: h.email }, loading: false, error: undefined }),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  isNativePlatform: () => h.native,
}));

const downloadAccountExport = vi.hoisted(() => vi.fn());
const uploadAccountImport = vi.hoisted(() => vi.fn());
const uploadLegacyAccountImport = vi.hoisted(() => vi.fn());

vi.mock('@/lib/accountDataPortability', () => ({
  downloadAccountExport,
  uploadAccountImport,
  uploadLegacyAccountImport,
}));

vi.mock('./WorkingSetSection', () => ({
  WorkingSetSection: () => <div data-testid="working-set" />,
}));

/** The hidden `<input type="file">` — its `<Label>` targets a nonexistent id, so it
 *  cannot be reached via getByLabelText and is queried directly instead. */
function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');

  if (!input) {
    throw new Error('file input not found');
  }

  return input as HTMLInputElement;
}

function chooseFile(name: string, contents = '{}') {
  const file = new File([contents], name);
  fireEvent.change(fileInput(), { target: { files: [file] } });
}

function openImportDialog() {
  fireEvent.click(screen.getByRole('button', { name: /import from file/i }));
}

function replaceButton() {
  return screen.getByRole('button', { name: /replace my data/i });
}

describe('DataPortabilitySection', () => {
  beforeEach(() => {
    h.authToken = 'jwt-abc';
    h.native = false;
    h.email = 'jsmith@example.com';
    downloadAccountExport.mockResolvedValue(undefined);
    uploadAccountImport.mockResolvedValue({
      tablesImported: 1,
      rowsImported: 2,
      filesRestored: 0,
      format: 'ndjson',
    });
    uploadLegacyAccountImport.mockResolvedValue({
      tablesImported: 1,
      rowsImported: 2,
      filesRestored: 0,
      format: 'json',
    });
  });

  it('starts a streaming export when export is clicked', async () => {
    render(<DataPortabilitySection />);
    fireEvent.click(screen.getByRole('button', { name: 'Export all my data' }));

    await waitFor(() => {
      expect(downloadAccountExport).toHaveBeenCalledWith('jwt-abc');
    });
  });

  it('keeps the destructive replace button disabled until a file is chosen and the email confirmation matches', async () => {
    render(<DataPortabilitySection />);
    openImportDialog();

    expect(replaceButton()).toBeDisabled();

    chooseFile('export.ndjson');
    expect(replaceButton()).toBeDisabled();

    // Wrong email still blocks it — a matching filename alone must not be enough
    // to arm an irreversible, whole-account overwrite.
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'someone-else@example.com' } });
    expect(replaceButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: h.email } });
    expect(replaceButton()).toBeEnabled();
  });

  it('accepts the confirmation email case- and whitespace-insensitively', async () => {
    render(<DataPortabilitySection />);
    openImportDialog();
    chooseFile('export.ndjson');

    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: '  JSmith@Example.com  ' } });

    expect(replaceButton()).toBeEnabled();
  });

  it('routes a .ndjson export through the streaming importer', async () => {
    render(<DataPortabilitySection />);
    openImportDialog();
    chooseFile('ci-memory-export.ndjson');
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: h.email } });

    fireEvent.click(replaceButton());

    await waitFor(() => expect(uploadAccountImport).toHaveBeenCalledTimes(1));
    const [token, file, confirmEmail] = uploadAccountImport.mock.calls[0] as [string, File, string];
    expect(token).toBe('jwt-abc');
    expect(file.name).toBe('ci-memory-export.ndjson');
    expect(confirmEmail).toBe(h.email);
    expect(uploadLegacyAccountImport).not.toHaveBeenCalled();
  });

  it('routes a legacy .json export through the legacy importer, not the streaming one', async () => {
    render(<DataPortabilitySection />);
    openImportDialog();
    chooseFile('old-export.json');
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: h.email } });

    fireEvent.click(replaceButton());

    await waitFor(() => expect(uploadLegacyAccountImport).toHaveBeenCalledTimes(1));
    const [, file] = uploadLegacyAccountImport.mock.calls[0] as [string, File, string];
    expect(file.name).toBe('old-export.json');
    expect(uploadAccountImport).not.toHaveBeenCalled();
  });

  it('does not mistake a legacy-looking name that actually ends in .ndjson for legacy JSON', async () => {
    // isLegacyJsonExport only trips on a bare `.json` suffix; `.ndjson` must win
    // even though it also contains the substring "json".
    render(<DataPortabilitySection />);
    openImportDialog();
    chooseFile('export-2026.ndjson');
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: h.email } });

    fireEvent.click(replaceButton());

    await waitFor(() => expect(uploadAccountImport).toHaveBeenCalledTimes(1));
    expect(uploadLegacyAccountImport).not.toHaveBeenCalled();
  });

  it('reports the rows/tables/files restored and closes the dialog on success', async () => {
    uploadAccountImport.mockResolvedValue({
      tablesImported: 7,
      rowsImported: 12345,
      filesRestored: 42,
      format: 'ndjson',
    });

    render(<DataPortabilitySection />);
    openImportDialog();
    chooseFile('export.ndjson');
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: h.email } });

    fireEvent.click(replaceButton());

    expect(await screen.findByText(/12,345 rows across 7 tables, 42 files restored/)).toBeInTheDocument();
    // The confirmation dialog is gone, not just satisfied — a re-open must not
    // carry the previous file/email selection forward.
    expect(screen.queryByText('Import your data?')).not.toBeInTheDocument();
  });

  it('shows an error and leaves the dialog open, re-enabled, when the import fails', async () => {
    uploadAccountImport.mockRejectedValue(new Error('Import failed (500)'));

    render(<DataPortabilitySection />);
    openImportDialog();
    chooseFile('export.ndjson');
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: h.email } });

    fireEvent.click(replaceButton());

    expect(
      await screen.findByText(/Could not import that archive\. Check the file and confirmation email/i),
    ).toBeInTheDocument();

    // The dialog stays open on failure — a silent close would look like success.
    expect(screen.getByText('Import your data?')).toBeInTheDocument();
    expect(replaceButton()).toBeEnabled();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeEnabled();
  });

  it('clears the file, confirmation, and any error when the dialog is dismissed', async () => {
    uploadAccountImport.mockRejectedValue(new Error('Import failed (500)'));

    render(<DataPortabilitySection />);
    openImportDialog();
    chooseFile('export.ndjson');
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: h.email } });
    fireEvent.click(replaceButton());
    await screen.findByText(/Could not import that archive/i);

    // The reset lives in `onOpenChange`, which only Radix's own dismiss paths invoke
    // (Escape, overlay click, its Close control) — not a plain state-setting onClick.
    // The dialog's built-in close (X) button goes through that real path.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    openImportDialog();
    expect(screen.getByRole('button', { name: /choose export file/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/to confirm/i)).toHaveValue('');
    expect(screen.queryByText(/Could not import that archive/i)).not.toBeInTheDocument();
  });

  it('clears the file and confirmation when Cancel is clicked, so reopening starts over', async () => {
    render(<DataPortabilitySection />);
    openImportDialog();
    chooseFile('export.ndjson');
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: h.email } });
    expect(replaceButton()).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    openImportDialog();

    expect(screen.getByRole('button', { name: /choose export file/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/to confirm/i)).toHaveValue('');
    expect(replaceButton()).toBeDisabled();
    // Emptied too, or picking the same file again would not register as a change.
    expect(fileInput().value).toBe('');
  });
});

/**
 * ═══ "EXPORT DOWNLOADED." AND NOTHING WAS SAVED ═══
 *
 * On the native shell the export fetched a relative `/api/account/export` — the app's own
 * `capacitor://localhost` origin, not the Memory server — with no API key, then clicked a
 * download anchor in the web view. The page said "Export downloaded." and the QA run could find
 * no file. The shells carry no file-save or share plugin, and a streamed whole-account archive is
 * not something a phone can hold in memory, so the honest thing is to say it needs the web app.
 * Import has the same two problems (it can only fail), so both cards give way to one explanation.
 */
describe('DataPortabilitySection on the native shell', () => {
  beforeEach(() => {
    h.native = true;
    h.authToken = null;
    downloadAccountExport.mockReset();
    uploadAccountImport.mockReset();
    uploadLegacyAccountImport.mockReset();
  });

  it('says plainly that a web sign-in is needed, instead of offering buttons that cannot work', () => {
    render(<DataPortabilitySection />);

    expect(screen.getByText('Needs a web sign-in')).toBeInTheDocument();
    expect(screen.getByText(/cannot save or open yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export all my data' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /import from file/i })).not.toBeInTheDocument();
  });

  it('never claims an export was downloaded', () => {
    render(<DataPortabilitySection />);

    expect(downloadAccountExport).not.toHaveBeenCalled();
    expect(screen.queryByText('Export downloaded.')).not.toBeInTheDocument();
  });

  it('keeps the on-device cache controls, which are about this phone', () => {
    render(<DataPortabilitySection />);

    expect(screen.getByTestId('working-set')).toBeInTheDocument();
  });

  it('keeps export and import on the web', () => {
    h.native = false;
    h.authToken = 'jwt-abc';

    render(<DataPortabilitySection />);

    expect(screen.getByRole('button', { name: 'Export all my data' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import from file/i })).toBeInTheDocument();
    expect(screen.queryByText('Needs a web sign-in')).not.toBeInTheDocument();
  });
});
