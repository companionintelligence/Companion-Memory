import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { adoptIngestIdentity } from '@ci/domains/memory';

/**
 * Companion Scan's `capture.scan` push, recorded from the producer itself.
 *
 * Companion Scan (`companionintelligence/Companion-Scan`, formerly CI-Spatial)
 * sends each finished room scan to Memory as a GLB upload and one
 * `POST /v1/events` call. Nothing at compile time ties that body to what Memory
 * reads, because the producer lives in another repository. That is how
 * `promote.observation` came to document a narrower wire than the one being
 * sent: the push added an oriented box to every object, and the stage dropped
 * them all without any test failing.
 *
 * Each file under `fixtures/companion-scan/` is one push. It was recorded by
 * running the producer's own `pushScanToMemory` (`server/memory_push.ts`, at
 * the commit in `recorded_from`) with an injected `fetch`, and holds:
 *
 * - `request`: the `/v1/events` call it made, with `body` verbatim;
 * - `inputs`: what it read to build that body. These are the scan manifest,
 *   the Place it was called with, its sidecars by file name, the sizes of its
 *   binary files, and the file ids the stubbed `/files/upload` answered with,
 *   in order.
 *
 * `oriented-boxes` is a scan whose detector sidecar has oriented 3-D boxes and
 * whose splat has a metric fit, so every object ships its box in both frames.
 * `label-position` is the same room from a sidecar with labels and positions
 * only. To re-record after the push changes, call `pushScanToMemory` from a
 * Companion Scan checkout with `inputs.scan` and `{ place: inputs.place }`,
 * file readers that serve `inputs.sidecars` and `inputs.files`, and a `fetch`
 * that answers each upload with the next of `inputs.upload_ids`. Then write
 * what it POSTs to `/v1/events` back into `request`.
 *
 * TODO: move these files to a shared contracts repository once one exists.
 * Both sides would test against the same copy there, and Companion Scan would
 * check that its push still builds `request` from `inputs`. Nothing checks that
 * producer half of the contract today.
 */
const FIXTURE_DIR = resolve(__dirname, 'fixtures/companion-scan');

export type CompanionScanCaptureName = 'oriented-boxes' | 'label-position';

/** One record of the `/v1/events` envelope, as Companion Scan sends it. */
export interface CompanionScanCaptureEvent {
  source_system: string;
  source_id: string;
  kind: string;
  occurred_at: string;
  title?: string;
  description?: string;
  payload: Record<string, unknown>;
}

export interface CompanionScanCapture {
  recorded_from: { repository: string; commit: string; producer: string; recorded_on: string };
  request: { method: string; path: string; body: { events: CompanionScanCaptureEvent[] } };
  inputs: Record<string, unknown>;
}

export function readCompanionScanCapture(name: CompanionScanCaptureName): CompanionScanCapture {
  return JSON.parse(
    readFileSync(resolve(FIXTURE_DIR, `capture-scan.${name}.json`), 'utf8'),
  ) as CompanionScanCapture;
}

/** The one event a recorded push sends. */
export function companionScanCaptureEvent(name: CompanionScanCaptureName): CompanionScanCaptureEvent {
  const [event] = readCompanionScanCapture(name).request.body.events;

  return event;
}

/**
 * The `ci.events` columns `POST /v1/events` writes for one capture record. This
 * restates the materialize mapping in `BulkIngestController.ingest` for suites
 * that read a stored scan rather than post one, so it is the part of the row a
 * pipeline stage sees.
 *
 * The ingest routes suite posts each recorded push through the real controller
 * and checks the result against this, so a change to the controller fails a
 * test rather than leaving this copy behind.
 */
export function storedCaptureEvent(event: CompanionScanCaptureEvent) {
  const identity = adoptIngestIdentity(event.source_system, event.source_id);

  return {
    event_type: event.kind,
    start_time: new Date(event.occurred_at),
    source_system: identity.system ?? null,
    source_id: identity.id ?? null,
    metadata: { kind: event.kind, ...event.payload },
  };
}
