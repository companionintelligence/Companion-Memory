import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiFetch, apiKeyHeaders, buildApiUrl, fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

/**
 * The import API, as the UI consumes it.
 *
 * Mirrors what `ImportRunsController` and `ImportUploadsController` return. The
 * shapes are restated here rather than imported from the backend because the two
 * are separate build graphs; the tests below are what keep them honest.
 */

export interface ImportSource {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly icon: string;
  /** Recognized but not implemented. Shown, so a search for it does not read as "unsupported". */
  readonly stub: boolean;
  readonly supportsFiles: boolean;
  readonly supportsApi: boolean;
  /** How to obtain this export. Null when nobody has authored a guide yet. */
  readonly guide: ImportSourceGuide | null;
}

/** Authored instructions for getting one export out of the service that holds it. */
export interface ImportSourceGuide {
  readonly title: string;
  readonly blurb: string;
  readonly ecosystem: string;
  readonly category: string;
  readonly wait: string;
  /** How the export is obtained: web-export, app-export, local-file, manual-upload, api. */
  readonly acquisition?: string;
  readonly url?: string;
  readonly stepsTitle?: string;
  readonly steps: readonly string[];
  readonly altPath?: { readonly title: string; readonly url?: string; readonly steps: readonly string[] };
  readonly expectedFormat?: string;
  readonly whatImported?: readonly string[];
  readonly caveats?: readonly string[];
  /** Loose addenda, rendered without a heading. */
  readonly notes?: readonly string[];
}

/**
 * One authored source from `GET /import/sources/catalog` — the wizard's unit.
 *
 * SOURCE-keyed where {@link ImportSource} is importer-keyed: services sharing
 * one parser each get an entry, and a service whose importer is not written
 * yet arrives with `importerReady: false` instead of being invisible. The
 * array order is curated server-side (tier then ecosystem) — never re-sort it.
 */
export interface CatalogSource {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly ecosystem: string;
  readonly category: string;
  readonly acquisition: string;
  readonly wait: string;
  readonly url?: string;
  readonly stepsTitle?: string;
  readonly steps: readonly string[];
  readonly altPath?: { readonly title: string; readonly url?: string; readonly steps: readonly string[] };
  readonly expectedFormat?: string;
  readonly whatImported?: readonly string[];
  readonly caveats?: readonly string[];
  readonly notes?: readonly string[];
  /** Effective importer name — what a run's detected `dataSources` records. */
  readonly importer: string;
  readonly importerReady: boolean;
}

/**
 * How many rows one importer has actually put in `ci.*`, for one object kind
 * — the picker tile's "24K Mail" line. From `GET
 * /import/sources/object-counts`, read from the live destination tables
 * rather than import run history (see `useObjectCounts.ts`'s docblock for
 * why, mirroring `useSourceUsage.ts`'s for the parallel "imported ✓" case).
 *
 * `importer` is the same string {@link CatalogSource.importer} carries, so a
 * shared/ambiguous importer (`calendar`, `vcard`, `email`, `generic`) can
 * appear here too — the server does not filter it out, because refusing to
 * attribute a shared bucket to one tile is `unambiguousImporters`' job, not
 * this endpoint's. `label` is one of `sources.tsx`'s `OBJECTS_BY_CATEGORY`
 * labels ('Mail', 'Posts', 'Watch history', …).
 */
export interface ObjectCount {
  readonly importer: string;
  readonly label: string;
  readonly count: number;
}

export interface ImportStage {
  readonly id: string;
  readonly seq: number;
  readonly kind: string;
  readonly status: string;
  readonly phase: string | null;
  readonly processed: number;
  /** Null means the work is not yet countable — draw an indeterminate bar, never 0%. */
  readonly total: number | null;
  readonly weight: number;
  /** Measured throughput. Separates "this parse is slow" from "this parse is big". */
  readonly itemsPerSec?: number | null;
  readonly etaSeconds: number | null;
  /** Wall clock for a FINISHED stage. Null while it is still going — use `startedAt`. */
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly detail: Record<string, unknown>;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
}

/**
 * Where a stage sits relative to the appliance's single execution slot.
 *
 * `waiting` and `blocked` are BOTH `status: 'queued'` in the database and they
 * mean completely different things — see {@link ActiveImportSnapshot}.
 */
export type StageQueueState = 'running' | 'waiting' | 'blocked' | 'done';

export interface ActiveImportStage extends ImportStage {
  readonly queueState: StageQueueState;
  /** 1-based place in this user's ready queue. Null unless `waiting`. */
  readonly queuePosition: number | null;
  readonly waitingSince: string | null;
  /**
   * Live: how long the stage has been running, or waiting for the slot, or how
   * long it took. Null for `blocked`, which is not waiting on anything yet.
   */
  readonly elapsedMs: number | null;
  /** The claim's last sign of life — heartbeat or progress write. Absent from older servers. */
  readonly heartbeatAt?: string | null;
  /**
   * `running`, but silent past the server's threshold: its worker is gone or
   * wedged. Beside `queueState` rather than a fifth value of it, because the
   * stage still holds its slot. The appliance retries a stage whose worker is
   * gone within minutes; until then, this is the only honest word for it.
   */
  readonly stalled?: boolean;
}

export interface ActiveImportRun extends ImportRun {
  /**
   * The archive or folder this run is importing — `google-takeout`, `amazon`.
   * THE field that tells a thirteen-run batch apart; see the server's note.
   */
  readonly unit: string | null;
  readonly records: number;
  readonly elapsedMs: number | null;
  readonly stages: readonly ActiveImportStage[];
}

/**
 * Everything importing right now, in one object.
 *
 * `GET /import/runs/active`. One request per tick however many runs are in
 * flight, and it carries the things a per-run poll could not compute on its own:
 * which source each run is (`unit`), whether a queued stage is enqueued and
 * waiting for the appliance's single slot or simply has not been reached yet
 * (`queueState`), where it sits in line (`queuePosition`), and how long
 * everything has taken.
 */
export interface ActiveImportSnapshot {
  readonly generatedAt: string;
  /** Is anything still going? The one boolean that decides whether to render. */
  readonly active: boolean;
  readonly batch: {
    readonly total: number;
    readonly running: number;
    readonly queued: number;
    readonly completed: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly percent: number;
    readonly records: number;
    readonly startedAt: string | null;
    readonly elapsedMs: number | null;
  };
  readonly queue: {
    /**
     * Slots per stage KIND — the appliance runs one queue per kind, so a parse
     * waits behind other parses only. One each today except `media`, which
     * takes two; that asymmetry is why this is a map rather than a number.
     */
    readonly concurrency: Readonly<Record<string, number>>;
    /** Every kind's slots added up. What can be in flight across the batch. */
    readonly slots: number;
    readonly running: number;
    readonly waiting: number;
    readonly blocked: number;
    readonly longestWaitMs: number | null;
  };
  readonly runs: readonly ActiveImportRun[];
  readonly truncated: boolean;
}

export interface ImportRun {
  readonly id: string;
  readonly label: string | null;
  readonly source: string;
  /**
   * The services the archive turned out to contain, most rows first. Empty
   * until the run has parsed.
   */
  readonly dataSources: readonly string[];
  /**
   * The importer(s) the user's service card stood for when the run started —
   * null when nothing was declared (inbox, CLI, older runs). What makes the
   * picker's "imported ✓" a claim about intent, not stray recognition.
   */
  readonly declaredSources?: readonly string[] | null;
  readonly status: string;
  readonly percent: number;
  readonly requestedStages: readonly string[];
  readonly error: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /**
   * Records this run pushed into `ci.*`. Sent on the LIST only — the detail
   * endpoint carries the same number spread across its stages.
   */
  readonly records?: number;
}

export interface ImportRunDetail extends ImportRun {
  readonly stages: readonly ImportStage[];
}

export interface StagedDrop {
  readonly dropId: string;
  readonly originalFilename: string | null;
  readonly sizeBytes: number | null;
  readonly status: string;
  readonly expiresAt: string | null;
}

/** A run whose parsed rows are waiting for a push — what the Sync card lists. */
export interface UnpushedRun extends ImportRun {
  readonly pendingItems: number;
  readonly pendingEntities: number;
}

/**
 * What a discard took, itemised — see `DELETE /import/runs/:runId`.
 *
 * The last three fields are the halves that were NOT taken, and they are why
 * this is a shape rather than a boolean. `uploadsRestaged`: an archive the
 * appliance still holds goes back to the uploads list instead of being
 * destroyed with the parse. `mediaFilesKept` / `attachmentContentsKept`: the
 * photos and attachments the media stage had already stored stay in the user's
 * memory, because after the fact nothing can prove this run is the only import
 * that put them there. Only the server knows which of these happened, so only
 * the server can say — the UI must not guess.
 */
export interface DiscardedRun {
  readonly runId: string;
  readonly label: string | null;
  readonly stagedRowsDeleted: number;
  readonly sourceRowsDeleted: number;
  readonly uploadsRestaged: number;
  readonly mediaFilesKept: number;
  readonly attachmentContentsKept: number;
}

/** One importable thing the inbox scan found — a file, or a whole recognized directory. */
export interface InboxUnit {
  /** Path relative to the inbox folder — the handle importInbox takes. */
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly recognized: readonly { dataSource: string; title: string; confidence: number }[];
  /** Titles the unit's folder declares — the chips' fallback when recognition sees nothing (a zip). */
  readonly declared: readonly string[];
  /** An unfinished run of THIS user's already consuming the unit, if any. */
  readonly activeRunId: string | null;
  /**
   * Some run holds this unit, whoever started it. The inbox is one folder
   * shared by every account, so this — not `activeRunId` — is what says a unit
   * cannot be imported. Another user's run id is never exposed.
   */
  readonly claimed: boolean;
}

export interface InboxScan {
  readonly available: boolean;
  readonly reason?: string;
  /** The folder as the API sees it — inside the container on a managed appliance. */
  readonly inboxDir: string;
  /**
   * The folder as a PERSON reaches it: the host-side path of the bind mount
   * when the appliance knows it, otherwise `inboxDir`. Show this one.
   */
  readonly displayDir: string;
  readonly units: readonly InboxUnit[];
  readonly skippedSymlinks: number;
  readonly truncated: boolean;
  readonly recognitionPartial: boolean;
}

export interface InboxUnitResult {
  readonly unit: string;
  readonly runId?: string;
  readonly label?: string;
  readonly error?: string;
}

/** A run is done when the server says so — these are the terminal statuses. */
export const TERMINAL_RUN_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled']);

export function isRunFinished(run: Pick<ImportRun, 'status'> | null | undefined): boolean {
  return run != null && TERMINAL_RUN_STATUSES.has(run.status);
}

/**
 * Every call the import UI makes, in one place.
 *
 * The upload is deliberately NOT `fetchJson`: it posts multipart FormData, and a
 * JSON helper that sets Content-Type would break the boundary the browser has to
 * generate itself.
 */
export function useImportApi() {
  const [{ authToken, authenticated }] = useAuth();

  /**
   * The CURRENT token, readable from long-lived closures.
   *
   * `useAutoRefreshToken` rotates the session JWT on a schedule, and the
   * upload loop in ExportStep runs for hours inside one closure — with the
   * token captured directly, every file after a rotation was sent with the
   * dead token and failed "Unauthorized" for the rest of the batch. Routing
   * every request's header through this ref means even a stale closure signs
   * with whatever token is live at SEND time. It also makes `authHeaders` —
   * and therefore the whole returned api object — referentially stable across
   * rotations, so consumers keyed on it stop refetching for no reason.
   */
  const tokenRef = useRef(authToken);

  useEffect(() => {
    tokenRef.current = authToken;
  }, [authToken]);

  /**
   * The bearer, ONLY when there is one.
   *
   * This used to send `Bearer ` with an empty string on native, where
   * `authToken` is null — the phone's durable credential is a keystore API key
   * that `fetchJson` attaches as `x-api-key` by itself. An empty bearer is not
   * merely useless: it is a malformed Authorization header on a request that
   * would otherwise have authenticated fine. Built rather than ternaried for
   * the reason `useJobsAuth` documents — the conditional form infers
   * `{ Authorization?: undefined }`, which `exactOptionalPropertyTypes` refuses
   * to widen.
   *
   * The keystore key is added here too, because the multipart upload, `post`
   * and `del` below do NOT go through `fetchJson`: without it those requests
   * reach the server unauthenticated on a phone. Read per call, like the token,
   * so a long-lived closure signs with whatever is live at SEND time. Repeating
   * it on a `fetchJson` call is harmless — same header, same value.
   */
  const authHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = { ...apiKeyHeaders() };

    if (tokenRef.current) {
      headers.Authorization = `Bearer ${tokenRef.current}`;
    }

    return headers;
  }, []);

  const listSources = useCallback(
    async (): Promise<ImportSource[]> =>
      (await fetchJson<ImportSource[]>('/api/import/sources', { headers: authHeaders() })) ?? [],
    [authHeaders],
  );

  const listCatalog = useCallback(
    async (): Promise<CatalogSource[]> =>
      (await fetchJson<CatalogSource[]>('/api/import/sources/catalog', { headers: authHeaders() })) ?? [],
    [authHeaders],
  );

  const getObjectCounts = useCallback(
    async (): Promise<ObjectCount[]> =>
      (await fetchJson<ObjectCount[]>('/api/import/sources/object-counts', { headers: authHeaders() })) ?? [],
    [authHeaders],
  );

  const listRuns = useCallback(
    async (limit?: number, before?: { createdAt: string; id: string }): Promise<ImportRun[]> => {
      // Keyset cursor — the last run of the page already shown. See the
      // endpoint: pages chain by (createdAt, id), immune to runs created
      // while history is being read.
      const params = new URLSearchParams();

      if (limit != null) {
        params.set('limit', String(limit));
      }

      if (before != null) {
        params.set('beforeCreatedAt', before.createdAt);
        params.set('beforeId', before.id);
      }

      const query = params.toString();

      return (
        (await fetchJson<ImportRun[]>(`/api/import/runs${query.length > 0 ? `?${query}` : ''}`, {
          headers: authHeaders(),
        })) ?? []
      );
    },
    [authHeaders],
  );

  const listUnpushed = useCallback(
    async (): Promise<UnpushedRun[]> =>
      (await fetchJson<UnpushedRun[]>('/api/import/runs/unpushed', { headers: authHeaders() })) ?? [],
    [authHeaders],
  );

  const getRun = useCallback(
    async (runId: string): Promise<ImportRunDetail | null> =>
      (await fetchJson<ImportRunDetail>(`/api/import/runs/${runId}`, { headers: authHeaders() })) ?? null,
    [authHeaders],
  );

  /**
   * Everything importing right now, with stages, in ONE request.
   *
   * Declared before `getRun` in intent if not in source order: this is what a
   * surface watching a whole batch should call. `getRun` is for one run someone
   * deliberately opened.
   */
  const getActiveImports = useCallback(
    async (): Promise<ActiveImportSnapshot | null> =>
      (await fetchJson<ActiveImportSnapshot>('/api/import/runs/active', { headers: authHeaders() })) ?? null,
    [authHeaders],
  );

  /**
   * Upload ONE archive, reporting byte progress as it goes.
   *
   * `XMLHttpRequest` rather than `fetch`, because fetch has no upload-progress
   * events — and for a multi-hundred-GB Takeout part, the difference between a
   * static "Uploading…" and a moving byte count is whether the person believes
   * anything is happening. No explicit Content-Type either way: the browser
   * must generate the multipart boundary itself.
   *
   * One file per request on purpose (this replaced a single POST carrying every
   * file): a failure costs one archive instead of the whole batch, progress is
   * attributable to a file, and the caller can start the finished drop's
   * unpack+parse run while the next file is still uploading.
   */
  const uploadFile = useCallback(
    (file: File, onProgress?: (loadedBytes: number, totalBytes: number) => void): Promise<StagedDrop> =>
      new Promise<StagedDrop>((resolve, reject) => {
        const form = new FormData();

        form.append('files', file);

        const xhr = new XMLHttpRequest();

        // `buildApiUrl`, not the bare path: on the native shell the page origin is
        // `capacitor://localhost`, and Capacitor's XHR patch treats a relative URL
        // as the WebView's own — it never calls the native `open()`, so the very
        // next `setRequestHeader` throws "The object is in an invalid state", and
        // every wizard upload from a phone failed with exactly that text.
        xhr.open('POST', buildApiUrl('/api/import/uploads'));

        for (const [name, value] of Object.entries(authHeaders())) {
          xhr.setRequestHeader(name, value);
        }

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            onProgress?.(event.loaded, event.total);
          }
        };

        xhr.onerror = () => reject(new Error('Upload failed: network error'));
        xhr.ontimeout = () => reject(new Error('Upload failed: timed out'));

        xhr.onload = () => {
          if (xhr.status < 200 || xhr.status >= 300) {
            // The same message extraction as describeFailure, over the XHR shape.
            let message = `Upload failed (${xhr.status})`;

            try {
              const body = JSON.parse(xhr.responseText) as { message?: string | string[] };
              const detail = Array.isArray(body.message) ? body.message.join(', ') : body.message;

              if (detail) {
                message = detail;
              }
            } catch {
              // Not JSON — keep the status-code fallback.
            }

            reject(new Error(message));

            return;
          }

          try {
            // The endpoint answers one staged drop per file; this request
            // carried exactly one.
            const [drop] = JSON.parse(xhr.responseText) as StagedDrop[];

            if (drop == null) {
              reject(new Error('Nothing was uploaded'));

              return;
            }

            resolve(drop);
          } catch (err: unknown) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };

        xhr.send(form);
      }),
    [authHeaders],
  );

  /**
   * Upload one unzipped folder as a single drop.
   *
   * Each file is sent with its `webkitRelativePath` so the API can rebuild the
   * tree. One drop, one run — the same unit the inbox uses for a directory.
   * (The wizard prefers packing a folder into one zip client-side; this is the
   * no-zip fallback path and stays a single request.)
   */
  const uploadFolder = useCallback(
    async (files: readonly File[]): Promise<StagedDrop[]> => {
      const form = new FormData();

      for (const file of files) {
        form.append('files', file);
        form.append('paths', file.webkitRelativePath || file.name);
      }

      const response = await postUpload(form, authHeaders());

      return (await response.json()) as StagedDrop[];
    },
    [authHeaders],
  );

  const startRun = useCallback(
    async (
      dropId: string,
      options: { label?: string; stages?: readonly string[]; declaredSources?: readonly string[] } = {},
    ) =>
      post<ImportRunDetail>('/api/import/runs', authHeaders(), {
        dropId,
        label: options.label,
        stages: options.stages,
        declaredSources: options.declaredSources,
      }),
    [authHeaders],
  );

  /**
   * The Sync click: append a push to every unpushed run (or the named ones)
   * and set them going. Progress after this is the ordinary run poll.
   */
  const startPush = useCallback(
    async (runIds?: readonly string[]) =>
      post<{ runs: ImportRun[] }>('/api/import/push', authHeaders(), {
        runIds: runIds == null ? undefined : [...runIds],
      }),
    [authHeaders],
  );

  const cancelRun = useCallback(
    async (runId: string) =>
      post<{ cancelled: boolean }>(`/api/import/runs/${runId}/cancel`, authHeaders(), {}),
    [authHeaders],
  );

  /**
   * The opposite of Sync: throw the parse away instead of saving it.
   *
   * `confirm=discard` is the server's own gate and is spelled out here rather
   * than defaulted, so the one call in this file that destroys data reads as
   * destructive at the call site. There is no undo — the appliance keeps a
   * parsed-but-unpushed run forever precisely because those staged rows are the
   * only copy left of it.
   */
  const discardRun = useCallback(
    async (runId: string) => del<DiscardedRun>(`/api/import/runs/${runId}?confirm=discard`, authHeaders()),
    [authHeaders],
  );

  /** What is waiting in the appliance's inbox folder. */
  const scanInbox = useCallback(
    async (): Promise<InboxScan | null> =>
      (await fetchJson<InboxScan>('/api/import/inbox', { headers: authHeaders() })) ?? null,
    [authHeaders],
  );

  /**
   * Start one run per inbox unit. Omit `units` to import everything the scan
   * yields that is not already running. Per-unit failures ride in the results
   * rather than failing the batch.
   */
  const importInbox = useCallback(
    async (units?: readonly string[]) =>
      post<{ results: InboxUnitResult[] }>('/api/import/inbox/runs', authHeaders(), {
        units: units == null ? undefined : [...units],
      }),
    [authHeaders],
  );

  const retryStage = useCallback(
    async (runId: string, stageId: string) =>
      post<{ requeued: boolean }>(`/api/import/runs/${runId}/stages/${stageId}/retry`, authHeaders(), {}),
    [authHeaders],
  );

  /**
   * Push the rows a completed push could not write.
   *
   * Distinct from `retryStage`, which re-runs a stage that FAILED. A push that
   * mostly worked completes, and its casualties sit at `failed` where nothing
   * looks at them again — this is the only way back for them.
   */
  const retryFailedPush = useCallback(
    async (runId: string) =>
      post<{ items: number; entities: number; requeued: boolean }>(
        `/api/import/runs/${runId}/push/retry`,
        authHeaders(),
        {},
      ),
    [authHeaders],
  );

  // Memoized, and it has to be. Every call below is already a stable
  // `useCallback`, but a fresh object literal here is a new reference on every
  // render — and a caller with `[api]` in an effect then re-runs that effect on
  // every render, sets state, re-renders, and fetches again. The page did
  // exactly that: /import/sources and /import/runs on a loop, as fast as the
  // responses came back.
  return useMemo(
    () => ({
      // `authenticated`, NOT `authToken`. `authToken` is the web JWT and is
      // null inside the Capacitor app, so every import request returned before
      // it was made: /sources/import showed "Loading services…" forever, the
      // drop zone stayed disabled, Inbox never scanned, History was empty and
      // the live-import card never appeared — on a phone that was otherwise
      // signed in. `ImportController` guards with `JwtOrApiKeyAuthGuard`, so
      // the keystore key is a credential the server already accepts. This is
      // the same bug `useJobsAuth` documents as fixed for Jobs; the fix was
      // never ported here.
      ready: Boolean(authenticated),
      listSources,
      listCatalog,
      getObjectCounts,
      listRuns,
      listUnpushed,
      getRun,
      getActiveImports,
      uploadFile,
      uploadFolder,
      startRun,
      startPush,
      cancelRun,
      discardRun,
      retryStage,
      retryFailedPush,
      scanInbox,
      importInbox,
    }),
    [
      // `ready` is derived from `authenticated` now, so that is what this memo
      // has to track — keeping `authToken` here would leave `ready` stale on
      // native, where the token never changes because there never is one.
      authenticated,
      listSources,
      listCatalog,
      getObjectCounts,
      listRuns,
      listUnpushed,
      getRun,
      getActiveImports,
      uploadFile,
      uploadFolder,
      startRun,
      startPush,
      cancelRun,
      discardRun,
      retryStage,
      retryFailedPush,
      scanInbox,
      importInbox,
    ],
  );
}

/**
 * Poll one run until it reaches a terminal status.
 *
 * The interval stops on its own when the run finishes, rather than polling a
 * completed import forever — this page is left open while a 40GB Takeout runs,
 * and it should go quiet when there is nothing left to say.
 */
export function useRunProgress(runId: string | null, intervalMs = 2_000) {
  const { getRun, ready } = useImportApi();
  const [run, setRun] = useState<ImportRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isInitialLoad = useRef(true);

  const load = useCallback(async () => {
    if (!ready || runId == null) {
      return;
    }

    try {
      setRun(await getRun(runId));
      setError(null);
      isInitialLoad.current = false;
    } catch (err: unknown) {
      // Only the first failure is worth showing: a blip mid-import should not
      // replace a progress bar someone is watching with an error banner.
      if (isInitialLoad.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [getRun, ready, runId]);

  useEffect(() => {
    // Clearing on a null id is the whole point of a null id. Without this the
    // last run stayed in state after it was deselected, so closing an opened
    // import called its handler, set the id to null, and changed nothing on
    // screen — the page still had a run to render.
    if (runId == null) {
      setRun(null);
      setError(null);

      return;
    }

    if (!ready) {
      return;
    }

    isInitialLoad.current = true;
    void load();
  }, [load, ready, runId]);

  useEffect(() => {
    if (!ready || runId == null || isRunFinished(run)) {
      return;
    }

    const handle = window.setInterval(() => void load(), intervalMs);

    return () => window.clearInterval(handle);
  }, [intervalMs, load, ready, run, runId]);

  return { run, error, refresh: load } as const;
}

/**
 * Shared progress for MANY runs: one runs-list poll feeds every card.
 *
 * The wizard used to mount one {@link useRunProgress} per run — reasonable at
 * three uploads, a self-inflicted flood at a Takeout's 140: each card polled
 * the detail endpoint every two seconds and re-rendered on its own clock,
 * which pegged the tab's renderer (and, Chrome sharing renderer processes
 * same-site, every other tab of the app with it). This hook makes it ONE
 * request per tick regardless of run count, and it stops itself once every
 * watched run is finished.
 *
 * Returns summaries (no stages) — enough to say finished/failed/percent per
 * run. The handful of runs still ACTIVE keep their detailed per-run poll via
 * `LiveRun`; with parsing single-file that is one or two, not a hundred.
 *
 * `GET /import/runs` caps at 200, newest first; a watched id beyond that page
 * simply stays unknown and its card falls back to the detailed poll.
 */
export function useRunsProgress(
  runIds: readonly string[],
  intervalMs = 2_000,
): ReadonlyMap<string, ImportRun> {
  const { listRuns, ready } = useImportApi();
  const [runs, setRuns] = useState<ReadonlyMap<string, ImportRun>>(new Map());
  // The ids as a value, so a parent re-render with a fresh (but equal) array
  // does not restart the poll.
  const idsKey = runIds.join(',');

  useEffect(() => {
    const ids = idsKey.length === 0 ? [] : idsKey.split(',');

    if (!ready || ids.length === 0) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const page = await listRuns(200);

        if (cancelled) {
          return;
        }

        const wanted = new Set(ids);
        const next = new Map(page.filter((run) => wanted.has(run.id)).map((run) => [run.id, run]));

        setRuns(next);

        const allFinished = ids.every((id) => isRunFinished(next.get(id)));

        if (!allFinished) {
          timer = window.setTimeout(() => void tick(), intervalMs);
        }
      } catch {
        // A blip mid-import must not kill the poll; try again next tick.
        if (!cancelled) {
          timer = window.setTimeout(() => void tick(), intervalMs);
        }
      }
    };

    void tick();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [idsKey, intervalMs, listRuns, ready]);

  return runs;
}

/**
 * The whole appliance's import activity, on one poll, for a whole page.
 *
 * ## Why this is not another per-run poll
 *
 * {@link useRunProgress} is one request per run per tick. {@link useRunsProgress}
 * already had to exist because mounting one of those per card flooded
 * `/import/runs` — the comment on it documents the tab pegging its renderer at a
 * Takeout's 140 runs. This hook is the same lesson applied to the DETAILED view:
 * one request, `GET /import/runs/active`, however many runs are in flight, with
 * the stage rows and queue reasoning already assembled server-side. A page
 * mounts exactly one, and it is the only thing the pinned progress region needs.
 *
 * ## Why it does not simply stop
 *
 * `useRunsProgress` watches a FIXED set of ids and can go quiet forever once
 * they are all terminal. This one has no id set: it is the answer to "is
 * anything importing", which becomes true again when someone starts an import
 * from the CLI, the inbox, another tab, or the wizard three steps away. So
 * instead of stopping it slows down, hard:
 *
 *  - **2s while something is active** — the cadence people expect of a progress
 *    bar, and the same one every other import poll uses.
 *  - **30s while nothing is** — one request every thirty seconds is not a
 *    "flood" by any measure (it is 2/min against the 30/min a single active run
 *    already costs), and it is what makes the region appear on its own when an
 *    import starts elsewhere instead of requiring a reload.
 *  - **no REPEAT polling while the tab is hidden** — the case that actually
 *    mattered: this page is left open for hours while a 40GB Takeout runs, and
 *    a background tab polling for a progress bar nobody is looking at is pure
 *    waste. A `visibilitychange` listener resumes immediately on return, so
 *    coming back shows current state rather than a stale bar catching up.
 *
 * The FIRST read happens regardless of visibility, which is not an oversight —
 * it was a bug, found by rendering the page in an offscreen browser pane that
 * reports `visibilityState: 'hidden'` for its whole life. Skipping the initial
 * fetch there meant the region never appeared at all, and nothing would ever
 * fire `visibilitychange` to rescue it. Prerendered pages and tabs restored in
 * the background have the same shape. One request costs nothing; it is the
 * repetition this is trying to avoid.
 */
export function useActiveImports(
  activeIntervalMs = 2_000,
  idleIntervalMs = 30_000,
  // Lets a caller that only sometimes wants the poll (the getting-started banner
  // on an appliance with importing switched off) call the hook unconditionally.
  enabled = true,
): { snapshot: ActiveImportSnapshot | null; error: string | null; refresh: () => void } {
  const { getActiveImports, ready } = useImportApi();
  const [snapshot, setSnapshot] = useState<ActiveImportSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The pending timer, so `refresh` and the visibility listener can pre-empt a
  // scheduled tick instead of racing it into a double fetch.
  const timer = useRef<number | undefined>(undefined);
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    if (!ready || !enabled) {
      return;
    }

    let cancelled = false;
    // Whether this mount has ever got an answer. Gates the hidden-tab pause, so
    // a page that is hidden for its entire life still renders something.
    let loaded = false;

    const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const schedule = (delayMs: number) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void tick(), delayMs);
    };

    const tick = async () => {
      // Pause REPEATS on a hidden tab, never the first read — see the note
      // above on the offscreen-pane bug.
      if (isHidden() && loaded) {
        return;
      }

      try {
        const next = await getActiveImports();

        if (cancelled) {
          return;
        }

        loaded = true;
        setSnapshot(next);
        setError(null);

        // A hidden tab schedules nothing; `visibilitychange` below restarts it.
        if (!isHidden()) {
          schedule(next?.active ? activeIntervalMs : idleIntervalMs);
        }
      } catch (err: unknown) {
        if (cancelled) {
          return;
        }

        loaded = true;

        // A blip mid-import must not replace a progress bar someone is watching
        // with an error banner, and must not kill the poll — the same bargain
        // useRunProgress makes. The error is reported only when there is no
        // snapshot to show instead.
        setError(err instanceof Error ? err.message : String(err));

        if (!isHidden()) {
          schedule(idleIntervalMs);
        }
      }
    };

    kick.current = () => void tick();

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void tick();
      }
    };

    document.addEventListener('visibilitychange', onVisible);
    void tick();

    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [activeIntervalMs, enabled, getActiveImports, idleIntervalMs, ready]);

  const refresh = useCallback(() => kick.current(), []);

  return { snapshot, error, refresh };
}

// `apiFetch` resolves the path against the Memory origin (a no-op on web) and, on
// the native shells, goes out through CapacitorHttp — a bare `fetch('/api/...')`
// there is a request to the app's own `capacitor://localhost` bundle.
async function del<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await apiFetch(url, { method: 'DELETE', headers });

  if (!response.ok) {
    throw new Error(await describeFailure(response, 'Request failed'));
  }

  return (await response.json()) as T;
}

async function post<T>(url: string, headers: Record<string, string>, body: unknown): Promise<T> {
  const response = await apiFetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await describeFailure(response, 'Request failed'));
  }

  return (await response.json()) as T;
}

/**
 * The server's own explanation when it gave one.
 *
 * The import API says useful things — "not enough disk space to unpack", "this
 * upload has already been claimed" — and replacing them with a status code
 * throws away the only actionable part.
 */
async function postUpload(form: FormData, headers: Record<string, string>): Promise<Response> {
  let response: Response;

  try {
    response = await apiFetch('/api/import/uploads', {
      method: 'POST',
      headers,
      body: form,
    });
  } catch {
    throw new Error(
      'Could not reach the appliance. If you dropped a folder, use Choose folder — or upload the .zip.',
    );
  }

  if (!response.ok) {
    throw new Error(await describeFailure(response, 'Upload failed'));
  }

  return response;
}

async function describeFailure(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string | string[] };
    const message = Array.isArray(body.message) ? body.message.join(', ') : body.message;

    return message || `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}
