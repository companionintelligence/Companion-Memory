import { useCallback, useEffect, useState } from 'react';

import { Alert, Button, Card } from '@ci/shadcn';
import { FileArchive, Folder, Inbox, Loader2, RefreshCcw } from '@ci/shadcn/icons';

import { ServiceBadges } from './ServiceBadges';
import { useImportApi, type InboxScan, type InboxUnitResult } from './useImportApi';

/**
 * The inbox folder: batch import without the per-archive drag-and-drop.
 *
 * A user moves export archives — or whole unzipped export folders — into the
 * appliance's inbox mount, and this panel lists what the scan recognizes and
 * starts one run per unit. The folder is consume-and-delete territory: every
 * unit is a copy the importer owns, removed as its run consumes it. That
 * contract is stated ON the Import All confirm, because "importing deleted my
 * files" must never be a surprise, even when it is the designed behavior.
 *
 * Started runs live on the History tab like every other run; this panel only
 * reports per-unit start results inline (a unit that was already claimed is a
 * row-level note, not a batch failure).
 */
export function InboxPanel() {
  const api = useImportApi();
  const [scan, setScan] = useState<InboxScan | null>(null);
  const [results, setResults] = useState<ReadonlyMap<string, InboxUnitResult>>(new Map());
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api.ready) {
      return;
    }

    setScanning(true);

    try {
      setScan(await api.scanInbox());
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startUnits = useCallback(
    async (units?: readonly string[]) => {
      setBusy(true);

      try {
        const { results: batch } = await api.importInbox(units);

        setResults((current) => {
          const next = new Map(current);

          for (const result of batch) {
            next.set(result.unit, result);
          }

          return next;
        });
        // Consumed units leave the folder as their runs pick them up; a
        // refresh keeps the list honest without waiting for the user to ask.
        await refresh();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [api, refresh],
  );

  const handleImportAll = useCallback(async () => {
    // `claimed`, not `activeRunId`: the inbox is one folder shared by every
    // account, so a unit another user's run already holds is unavailable here
    // too — and their run id is deliberately not exposed to this client.
    const pending = scan?.units.filter((unit) => !unit.claimed) ?? [];

    if (pending.length === 0) {
      return;
    }

    const confirmed = window.confirm(
      `Import ${pending.length} item${pending.length === 1 ? '' : 's'} from the inbox?\n\n` +
        'Inbox contents are copies the importer owns: each item is removed from the folder ' +
        'as its import consumes it. Keep your original exports elsewhere.',
    );

    if (confirmed) {
      await startUnits();
    }
  }, [scan, startUnits]);

  if (scan == null) {
    if (error != null) {
      return (
        <Alert variant="destructive">
          <Alert.Description>{error}</Alert.Description>
        </Alert>
      );
    }

    // A first scan over a full inbox takes real seconds; silence here reads
    // as a frozen page.
    return (
      <div className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        Scanning the inbox folder…
      </div>
    );
  }

  if (!scan.available) {
    return (
      <Alert>
        <Alert.Description>
          The inbox folder is not available on this appliance
          {scan.reason ? ` — ${scan.reason}` : '.'}
        </Alert.Description>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-medium">Inbox folder</h2>
          <p className="text-muted-foreground text-sm">
            Move export archives — or whole unzipped export folders — into{' '}
            <code className="text-xs">{scan.displayDir}</code> and import them all at once. Everything here is
            treated as a copy; each item is removed from the folder as its import consumes it.
          </p>
        </div>

        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy || scanning}>
            <RefreshCcw aria-hidden className={scanning ? 'mr-1 size-4 animate-spin' : 'mr-1 size-4'} />
            {scanning ? 'Scanning…' : 'Rescan'}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleImportAll()}
            disabled={busy || scan.units.every((unit) => unit.claimed)}
          >
            Import all
          </Button>
        </div>
      </div>

      {error == null ? null : (
        <Alert variant="destructive">
          <Alert.Description>{error}</Alert.Description>
        </Alert>
      )}

      {scan.truncated ? (
        <Alert>
          {/* Bare text lands in the grid's zero-width icon column and wraps
              per word; alert content always goes through Description. */}
          <Alert.Description>
            The inbox holds more than this scan lists. Import what is shown, then rescan for the rest.
          </Alert.Description>
        </Alert>
      ) : null}

      {scan.recognitionPartial ? (
        <Alert>
          <Alert.Description>
            Every item is listed, but some have not been identified yet — rescan to finish identifying them.
            Importing now still works.
          </Alert.Description>
        </Alert>
      ) : null}

      {scan.units.length === 0 ? (
        <Card className="text-muted-foreground flex flex-col items-center gap-2 p-8 text-sm">
          <Inbox aria-hidden className="size-8" />
          <p>The inbox is empty. Anything you move into the folder shows up here.</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {scan.units.map((unit) => {
            const result = results.get(unit.path);

            return (
              <li key={unit.path}>
                <Card className="flex flex-row items-center gap-3 p-3">
                  {unit.kind === 'directory' ? (
                    <Folder aria-hidden className="text-muted-foreground size-5 shrink-0" />
                  ) : (
                    <FileArchive aria-hidden className="text-muted-foreground size-5 shrink-0" />
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{unit.path}</p>
                    <p className="text-muted-foreground text-xs">
                      {formatBytes(unit.sizeBytes)}
                      {unit.kind === 'directory' ? ` · ${unit.fileCount} files` : ''}
                    </p>
                    {result?.error == null ? null : (
                      <p className="text-destructive text-xs">{result.error}</p>
                    )}
                  </div>

                  {/* Titles, not raw importer names — and when recognition saw
                      nothing (it cannot look inside an archive), the folder's
                      declared services still say what this will import as. */}
                  <ServiceBadges
                    services={
                      unit.recognized.length > 0
                        ? unit.recognized.map((recognition) => recognition.title)
                        : unit.declared
                    }
                  />

                  {unit.claimed || result?.runId != null ? (
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {unit.activeRunId != null || result?.runId != null
                        ? 'Importing — see History'
                        : 'Importing on this appliance'}
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={busy}
                      onClick={() => void startUnits([unit.path])}
                    >
                      Import
                    </Button>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** "1.4 GB" — coarse, like every other number on this page. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) {
    return `${(bytes / 1e9).toFixed(1)} GB`;
  }

  if (bytes >= 1e6) {
    return `${(bytes / 1e6).toFixed(1)} MB`;
  }

  if (bytes >= 1e3) {
    return `${(bytes / 1e3).toFixed(1)} kB`;
  }

  return `${bytes} B`;
}
