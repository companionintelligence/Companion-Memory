import { useCallback, useEffect, useRef, useState } from 'react';

import { Alert, Button, Card } from '@ci/shadcn';

import { useImportApi, type DiscardedRun, type ImportRun, type UnpushedRun } from '../useImportApi';

import { LiveRunList } from './LiveRunList';

export interface SyncStepProps {
  onBackToExport: () => void;
  /** When false, the host wizard footer carries the way back (onboarding). */
  showNav?: boolean;
  /**
   * Reports what the host footer's primary should be while this step is up.
   *
   * The sync IS the primary in host mode, and the handler lives here — but this
   * component must not register with `WizardNav` itself: the slot has one
   * owner (ImportWizard), and React runs child effects before parent effects,
   * so a registration made here would be overwritten on the very next parent
   * effect. It reports upward instead and lets the one owner publish it.
   */
  onNavState?: (state: { canSync: boolean; busy: boolean; sync: () => void }) => void;
}

/**
 * Step 3: everything staged, pushed into the memory.
 *
 * The card lists every run whose parse finished but whose rows never reached
 * `ci.*` — including runs from an earlier abandoned session, which is the
 * point: nothing staged is ever silently stranded, and coming back to the
 * wizard later finishes the job. One button appends a push stage to all of
 * them; progress from there is the ordinary run poll, rendered per run.
 *
 * Each row also carries the other answer. A run listed here is the ONE kind the
 * appliance keeps forever: retention will not delete a payload this card is
 * still offering to push, so a parse nobody wants (a 780k-item Takeout is
 * ~640 MB of staging) had no way out except pushing data the user had already
 * decided against. Discard is that way out, and because it is irreversible it
 * asks in the row rather than firing on the first click.
 */
export function SyncStep({ onBackToExport, showNav = true, onNavState }: SyncStepProps) {
  const api = useImportApi();
  const [unpushed, setUnpushed] = useState<UnpushedRun[] | null>(null);
  const [pushed, setPushed] = useState<ImportRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The run whose Discard has been clicked once and is awaiting confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [discarded, setDiscarded] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api.ready) {
      return;
    }

    try {
      setUnpushed(await api.listUnpushed());
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // A ref so the reported `sync` identity is stable: `handleSync` is redeclared
  // every render, and re-reporting on every render would re-register the host
  // footer on every render too.
  const syncRef = useRef<() => void>(() => undefined);

  async function handleSync() {
    setBusy(true);
    setError(null);

    try {
      const { runs } = await api.startPush();

      setPushed(runs);
      setUnpushed([]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDiscard(run: UnpushedRun) {
    setBusy(true);
    setError(null);

    try {
      const result = await api.discardRun(run.id);

      setConfirming(null);
      setUnpushed((current) => (current ?? []).filter((other) => other.id !== run.id));
      setDiscarded(describeDiscard(run.label ?? run.id, result));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  syncRef.current = () => void handleSync();

  const canSync = unpushed != null && unpushed.length > 0;
  const syncBusy = busy || !api.ready;

  useEffect(() => {
    onNavState?.({ canSync, busy: syncBusy, sync: () => syncRef.current() });
  }, [onNavState, canSync, syncBusy]);

  const pendingItems = (unpushed ?? []).reduce((sum, run) => sum + run.pendingItems, 0);
  const pendingEntities = (unpushed ?? []).reduce((sum, run) => sum + run.pendingEntities, 0);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Sync to your memory</h2>
        <p className="text-sm text-muted-foreground">
          Everything your uploads staged, saved into your Companion Memory in one go.
        </p>
      </div>

      {error != null && (
        <Alert variant="destructive">
          <span>{error}</span>
        </Alert>
      )}

      {discarded != null && <p className="text-sm text-muted-foreground">{discarded}</p>}

      {unpushed == null && error == null && (
        <p className="text-sm text-muted-foreground">Checking what is waiting…</p>
      )}

      {unpushed != null && unpushed.length > 0 && (
        <Card className="space-y-3 p-4">
          <p className="text-sm">
            <strong>{pendingItems.toLocaleString()}</strong> item
            {pendingItems === 1 ? '' : 's'}
            {pendingEntities > 0 && (
              <>
                {' '}
                and <strong>{pendingEntities.toLocaleString()}</strong> connected{' '}
                {pendingEntities === 1 ? 'person or thing' : 'people and things'}
              </>
            )}{' '}
            staged across <strong>{unpushed.length}</strong> import
            {unpushed.length === 1 ? '' : 's'}, ready to save.
          </p>

          <ul className="space-y-1 text-sm text-muted-foreground">
            {unpushed.map((run) => (
              <li key={run.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{run.label ?? run.id}</span>
                <span className="flex items-center gap-2 whitespace-nowrap">
                  {run.pendingItems.toLocaleString()} item{run.pendingItems === 1 ? '' : 's'}
                  {confirming === run.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => void handleDiscard(run)}
                      >
                        Delete permanently
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !api.ready}
                      onClick={() => setConfirming(run.id)}
                    >
                      Discard
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>

          {confirming != null && (
            <p className="text-sm text-destructive">
              Discarding deletes this import’s parsed rows for good: they are the only copy of that parse, so
              there is no undo and no way to sync them later. It does not delete your export — if this
              appliance still holds the archive you uploaded, it goes back to your uploads — and any photos
              this import already saved stay in your memory. You will be told exactly what was kept.
            </p>
          )}

          <Button onClick={() => void handleSync()} disabled={busy || !api.ready}>
            {busy ? 'Starting…' : 'Sync to my memory'}
          </Button>
        </Card>
      )}

      {unpushed != null && unpushed.length === 0 && pushed == null && (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nothing is waiting to sync — upload an export in the previous step first.
        </p>
      )}

      {pushed != null &&
        (pushed.length > 0 ? (
          <LiveRunList runIds={pushed.map((run) => run.id)} />
        ) : (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            Nothing was waiting to sync.
          </p>
        ))}

      {showNav && (
        <div>
          <Button variant="outline" onClick={onBackToExport}>
            ← Back to export
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * What actually happened, in the user's own terms.
 *
 * Built from the server's itemised reply and nothing else. The confirmation
 * prompt has to describe every discard, so it can only say what MAY survive;
 * this says what did. Both survivals are worth a sentence for the same reason:
 * "discarded" alone reads as "nothing left behind", and a user who believed
 * that would look for their export in the uploads list that still has it, or
 * assume the photos this import had already saved went with the parse.
 */
function describeDiscard(name: string, result: DiscardedRun): string {
  const kept: string[] = [];

  if (result.uploadsRestaged > 0) {
    kept.push('The uploaded archive is back in your uploads.');
  }

  if (result.mediaFilesKept > 0) {
    const files = `${result.mediaFilesKept.toLocaleString()} file${result.mediaFilesKept === 1 ? '' : 's'}`;

    kept.push(
      `${files} this import had already saved stay in your memory — discarding the parse does not remove them.`,
    );
  }

  return [
    `Discarded ${name} — ${result.stagedRowsDeleted.toLocaleString()} staged rows deleted.`,
    ...kept,
  ].join(' ');
}
