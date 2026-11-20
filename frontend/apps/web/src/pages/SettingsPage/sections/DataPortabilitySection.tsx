import { useRef, useState } from 'react';

import { isNativePlatform } from '@ci/common';
import { Button, Dialog, Input, Label } from '@ci/shadcn';
import { Download, Upload } from '@ci/shadcn/icons';

import { WebSignInRequired } from '@/components/WebSignInRequired';
import { useAuth, useCurrentUser } from '@/hooks';
import {
  downloadAccountExport,
  uploadAccountImport,
  uploadLegacyAccountImport,
} from '@/lib/accountDataPortability';

import { SettingsGroup, SettingsRow, SettingsSection, SettingsStatus } from '../kit';

import { WorkingSetSection } from './WorkingSetSection';

function isLegacyJsonExport(file: File): boolean {
  const lower = file.name.toLowerCase();

  return lower.endsWith('.json') && !lower.endsWith('.ndjson');
}

export function DataPortabilitySection() {
  const [{ authToken }] = useAuth();
  const { user } = useCurrentUser();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [exporting, setExporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown inside the dialog, which stays open when an import fails. On the page it sat behind the
  // dialog's overlay and closing the dialog to read it cleared it.
  const [importError, setImportError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Every way out of the dialog clears what was chosen and typed, Cancel included (it used to only
  // hide the dialog, so reopening showed the same file and email with Replace my data already live).
  const closeImportDialog = () => {
    setImportOpen(false);
    setConfirmEmail('');
    setSelectedFile(null);
    setImportError(null);
  };

  const email = user?.email ?? '';
  const matches = email.length > 0 && confirmEmail.trim().toLowerCase() === email.trim().toLowerCase();
  // Export and import stream one very large file each way, and the native shell can do neither: it
  // carries no file-save or share plugin, and the helpers fetch a relative `/api/...` — the app's own
  // `capacitor://localhost` origin, not the Memory server — with no `x-api-key`. On the phone the export
  // still reported "Export downloaded." with no file to show for it. So say so, rather than offer it.
  const native = isNativePlatform();

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    setSuccess(null);

    try {
      await downloadAccountExport(authToken);
      setSuccess('Export downloaded.');
    } catch {
      setError('Could not export your data. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    if (!selectedFile) {
      return;
    }

    setImporting(true);
    setError(null);
    setImportError(null);
    setSuccess(null);

    try {
      const result = isLegacyJsonExport(selectedFile)
        ? await uploadLegacyAccountImport(authToken, selectedFile, confirmEmail)
        : await uploadAccountImport(authToken, selectedFile, confirmEmail);

      setSuccess(
        `Import complete — ${result.rowsImported.toLocaleString()} rows across ${result.tablesImported} tables, ${result.filesRestored.toLocaleString()} files restored.`,
      );
      closeImportDialog();
    } catch {
      setImportError('Could not import that archive. Check the file and confirmation email, then try again.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <SettingsSection
      title="Your data"
      description="Download a portable copy of everything in Memory, or restore from a previous export."
    >
      {native ? (
        <WebSignInRequired>
          Export and import move your whole Memory as one very large file, which this app cannot save or open
          yet. Open Companion Memory in a web browser, sign in, and use Your data there to export or restore
          it.
        </WebSignInRequired>
      ) : (
        <SettingsGroup title="Export and import">
          <SettingsRow
            label="Export all data"
            hint="An NDJSON archive of your memories, files, graph, schedule, and settings."
            help="Streams the archive as it is written, so large accounts are supported without a single-file size cap."
            control={
              <Button onClick={() => void handleExport()} disabled={exporting}>
                <Download aria-hidden="true" />
                {exporting ? 'Preparing export…' : 'Export all my data'}
              </Button>
            }
          />

          <SettingsRow
            label="Import data"
            hint="Replaces your current Memory data with a CI Memory export file (.ndjson, or legacy .json). This cannot be undone."
            control={
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Upload aria-hidden="true" />
                Import from file
              </Button>
            }
          />

          {error || success ? (
            <SettingsRow>
              {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}
              {success ? <SettingsStatus tone="success">{success}</SettingsStatus> : null}
            </SettingsRow>
          ) : null}
        </SettingsGroup>
      )}

      <WorkingSetSection />

      <input
        ref={fileInputRef}
        type="file"
        accept=".ndjson,application/x-ndjson,application/json,.json"
        className="hidden"
        onChange={(event) => {
          setSelectedFile(event.target.files?.[0] ?? null);
          // Emptied once read, or choosing the same file again would not fire onChange.
          event.target.value = '';
        }}
      />

      <Dialog
        open={importOpen}
        onOpenChange={(next) => {
          if (next) {
            setImportOpen(true);
          } else if (!importing) {
            // Escape, the close button and a click outside are refused mid-import, like Cancel.
            closeImportDialog();
          }
        }}
      >
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Import your data?</Dialog.Title>
            <Dialog.Description>
              This replaces your current memories on this server with the selected export file.
            </Dialog.Description>
          </Dialog.Header>

          <div className="space-y-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="exportFile">Export file</Label>
              <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
                {selectedFile ? selectedFile.name : 'Choose export file'}
              </Button>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="importConfirmEmail">
                Type <span className="font-medium text-foreground">{email}</span> to confirm
              </Label>
              <Input
                id="importConfirmEmail"
                autoComplete="off"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={email}
                value={confirmEmail}
                onChange={(event) => setConfirmEmail(event.target.value)}
              />
            </div>

            {importError ? <p className="text-sm text-destructive">{importError}</p> : null}
          </div>

          <Dialog.Footer>
            <Button variant="outline" onClick={closeImportDialog} disabled={importing}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleImport()}
              disabled={!selectedFile || !matches || importing}
            >
              {importing ? 'Importing…' : 'Replace my data'}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </SettingsSection>
  );
}
