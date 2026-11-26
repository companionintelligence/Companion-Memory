import type { DataSource } from 'typeorm';

import {
  companionScanCaptureEvent,
  storedCaptureEvent,
  type CompanionScanCaptureName,
} from '../../../__tests__/support/companionScanCapture';
import {
  ObservationPromoteStage,
  PROMOTE_OBSERVATION_SOURCE,
  PROMOTE_OBSERVATION_STAGE_ID,
  PROMOTE_OBSERVATION_VERSION,
  extractScanLocation,
  extractScanObjects,
  promoteObservationStageVersion,
  type ScanRow,
} from '../promote/ObservationPromoteStage';

/**
 * `promote.observation` — Companion Scan room captures become SIGHTINGS.
 *
 * Companion Scan (then CI-Spatial) has been pushing one `capture.scan` event per
 * room scan to `POST /v1/events` since the scan pipeline shipped, carrying
 * `payload.objects`, `detected_labels`, a point count and a geo block. NOTHING
 * IN THIS REPO READ IT — `promote.object` handles `purchase` and `order` and
 * stops there, and the string `capture.scan` appeared nowhere in the backend.
 * Meanwhile `ci.object_observations` had a full column set, two arbiters and a
 * downstream edge projection already built against it, and no writer.
 *
 * What this suite is mostly about:
 *
 *  1. **It reads the wire that exists, not the one anyone wants.** Companion
 *     Scan's `memory_push.ts` now sends every detected object as an oriented
 *     box: its centre, an xyzw rotation, its extents and, when the scan has a
 *     metric fit, the same box in the Place's frame, beside an
 *     `object_extents` block that names the frame. Extents are no longer
 *     dropped at the push, so the stage keeps every box key the push sends
 *     (`attributes.scan_box`) and reads none it does not. The recorded pushes
 *     in `src/domains/__tests__/support/fixtures/companion-scan/` are that
 *     wire, built by the producer's own code. `scanRow()` below is the older
 *     `{label, position}` shape: every scan pushed before the boxes has it, and
 *     the push still sends it for a detector sidecar that has no boxes.
 *  2. **A scan-local position is never mistaken for a location.** `position` is
 *     a point in the splat's own frame and units. It goes to `attributes` under
 *     an explicit frame tag and never near `location_coordinates`, and the box
 *     goes beside it.
 *  3. **Selection never anti-joins the sightings table.** Same ratchet argument
 *     `promote.object` makes: a scan would leave the candidate set the moment
 *     it had observations, so a better extractor could never revisit it.
 *  4. **It mints nothing.** No `ci.objects` row, no resolution column. A scan
 *     says a chair-shaped thing was at a point in a room; it does not say whose.
 */

const USER = '00000000-0000-4000-8000-0000000000aa';
const EVENT = '00000000-0000-4000-8000-000000000001';
const PLACE = '00000000-0000-4000-8000-00000000p1ac'.replace(/[^0-9a-f-]/g, '0');

/* ===================================================================== *
 * Fixtures — an older push by hand, and the current one as recorded
 * ===================================================================== */

/**
 * A `capture.scan` row as `/v1/events` writes it: `kind` became `event_type`
 * and `payload` was folded into `metadata` (`BulkIngestController`), so the
 * payload keys sit directly on metadata alongside `kind`.
 *
 * Shaped like a push from before the boxes: every object is `{label, position}`
 * and there is no `object_extents` block. Scans already in a database look like
 * this, so this shape has to keep promoting exactly as it did.
 */
function scanRow(overrides: Partial<ScanRow> = {}): ScanRow {
  return {
    id: EVENT,
    start_time: new Date('2026-04-02T14:30:00.000Z'),
    source_system: 'companion-scan',
    location_entity_id: null,
    lat: null,
    lng: null,
    metadata: {
      kind: 'capture.scan',
      scan_id: 'scan-7',
      session_id: 'session-2',
      glb_filename: 'room.glb',
      glb_file_id: '00000000-0000-4000-8000-0000000000gb'.replace(/[^0-9a-f-]/g, '0'),
      point_count: 481_233,
      detection_count: 2,
      detected_labels: ['chair', 'desk lamp'],
      objects: [
        { label: 'chair', position: { x: 1.25, y: 0, z: -2.5 } },
        { label: 'desk lamp', position: { x: 0.5, y: 1.1, z: -1.75 } },
      ],
      location: {
        lat: 51.5072,
        lon: -0.1276,
        address: '10 Example Street',
        display_address: 'Example Street, London',
        bearing: 45,
        accuracy_m: 12,
      },
    },
    ...overrides,
  };
}

/**
 * A `capture.scan` row from one of Companion Scan's recorded pushes, stored the
 * way `/v1/events` stores it (`storedCaptureEvent`, which the ingest routes
 * suite checks against the real controller). `/v1/events` writes no geo
 * columns and resolves no place, so those arrive NULL and the fix travels in
 * `metadata.location`.
 */
function recordedScanRow(name: CompanionScanCaptureName, overrides: Partial<ScanRow> = {}): ScanRow {
  const stored = storedCaptureEvent(companionScanCaptureEvent(name));

  return {
    id: EVENT,
    start_time: stored.start_time,
    metadata: stored.metadata,
    source_system: stored.source_system,
    location_entity_id: null,
    lat: null,
    lng: null,
    ...overrides,
  };
}

/** The objects exactly as a recorded push sent them. */
function recordedObjects(name: CompanionScanCaptureName): Array<Record<string, unknown>> {
  return companionScanCaptureEvent(name).payload.objects as Array<Record<string, unknown>>;
}

interface Harness {
  stage: ObservationPromoteStage;
  createMany: jest.Mock;
  placesNear: jest.Mock;
  query: jest.Mock;
}

function makeStage(rows: ScanRow[] = [scanRow()]): Harness {
  const query = jest.fn(async () => rows);

  const createMany = jest.fn(async (_ctx: unknown, dtos: unknown[]) => ({
    written: dtos.map((_dto, index) => ({ id: `obs-${index}` })),
    protectedByConfirmation: 0,
    duplicatesInBatch: 0,
    rejectedUnarbitered: 0,
  }));

  const placesNear = jest.fn(async () => []);

  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const stage = new ObservationPromoteStage(
    { query } as unknown as DataSource,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { createMany } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { placesNear } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { stage, createMany, placesNear, query };
}

function ctx() {
  return { userId: USER };
}

/* ===================================================================== *
 * Declaration
 * ===================================================================== */

describe('promote.observation — declaration', () => {
  it('selects undeleted capture.scan events', () => {
    expect(PROMOTE_OBSERVATION_SOURCE).toEqual({
      schema: 'ci',
      table: 'events',
      idColumn: 'event_id',
      userColumn: 'user_id',
      predicate: "s.event_type = 'capture.scan' AND COALESCE(s.is_deleted, false) = false",
    });
  });

  it('NEVER anti-joins the table it writes', () => {
    // "Scans that have not produced observations yet" is the one-way ratchet
    // the ledger exists to remove: a scan would leave the candidate set the
    // moment it succeeded, and a version bump could never bring it back.
    expect(PROMOTE_OBSERVATION_SOURCE.predicate).not.toContain('object_observations');
    expect(PROMOTE_OBSERVATION_SOURCE.predicate).not.toContain('NOT EXISTS');
  });

  it('agrees with the central version declaration', () => {
    expect(promoteObservationStageVersion()).toBe(PROMOTE_OBSERVATION_VERSION);
    // 2 = each sighting keeps its object's oriented box.
    expect(PROMOTE_OBSERVATION_VERSION).toBe(2);
  });

  it('reports its id, version and queue', () => {
    const { stage } = makeStage();

    expect(stage.id).toBe(PROMOTE_OBSERVATION_STAGE_ID);
    expect(stage.version).toBe(PROMOTE_OBSERVATION_VERSION);
    expect(stage.queue).toBe('pipeline-index');
    expect(stage.entityTypes).toEqual(['event']);
  });
});

/* ===================================================================== *
 * extractScanObjects — built for what arrives
 * ===================================================================== */

describe('extractScanObjects — an older push, {label, position} per object', () => {
  it('reads both detections out of a scan pushed before the boxes', () => {
    const objects = extractScanObjects(scanRow());

    expect(objects.map((object) => object.label)).toEqual(['chair', 'desk lamp']);
    expect(objects[0].position).toEqual({ x: 1.25, y: 0, z: -2.5 });
    expect(objects.map((object) => object.box)).toEqual([null, null]);
  });

  it('gives each object an ORDER-INDEPENDENT id', () => {
    const forward = extractScanObjects(scanRow());
    const reversed = extractScanObjects(
      scanRow({
        metadata: {
          ...(scanRow().metadata as Record<string, unknown>),
          objects: [
            { label: 'desk lamp', position: { x: 0.5, y: 1.1, z: -1.75 } },
            { label: 'chair', position: { x: 1.25, y: 0, z: -2.5 } },
          ],
        },
      }),
    );

    // A positional key would have relabelled row 0 from "chair" to "desk lamp"
    // on a re-run that emitted the same objects in a different order — a silent
    // rewrite of an existing sighting, which is worse than a duplicate because
    // nothing looks wrong afterwards.
    expect(forward[0].objectKey).toBe(reversed[1].objectKey);
    expect(forward[1].objectKey).toBe(reversed[0].objectKey);
  });

  it('keeps two objects of the same label at different points apart', () => {
    const objects = extractScanObjects(
      scanRow({
        metadata: {
          objects: [
            { label: 'chair', position: { x: 1, y: 0, z: 0 } },
            { label: 'chair', position: { x: 4, y: 0, z: 0 } },
          ],
        },
      }),
    );

    expect(objects[0].objectKey).not.toBe(objects[1].objectKey);
  });

  it('survives float jitter at centimetre rounding', () => {
    const key = (z: number) =>
      extractScanObjects(
        scanRow({ metadata: { objects: [{ label: 'chair', position: { x: 1, y: 0, z } }] } }),
      )[0].objectKey;

    expect(key(-2.5)).toBe(key(-2.5001));
  });

  it('drops a label-less detection instead of writing an empty sighting', () => {
    const objects = extractScanObjects(
      scanRow({
        metadata: {
          objects: [{ label: '   ', position: { x: 0, y: 0, z: 0 } }, { label: 'chair' }],
        },
      }),
    );

    expect(objects).toHaveLength(1);
    expect(objects[0].label).toBe('chair');
  });

  it('falls back to an ordinal when a malformed payload omits the position', () => {
    // `memory_push` filters these out before sending, so this covers a
    // hand-written or corrupted payload, not the wire.
    const objects = extractScanObjects(scanRow({ metadata: { objects: [{ label: 'chair' }] } }));

    expect(objects[0].position).toBeNull();
    expect(objects[0].objectKey).toBe('ordinal:0');
  });

  it('IGNORES 3-D keys that no push sends', () => {
    // The push's box keys are `rotation` (an xyzw quaternion), `extent_m`,
    // `extent_mm` and the three project-frame ones. `extent`, `dimensions` and
    // `bbox3d` are none of them, and a rotation with no `w` is not a
    // quaternion. Reading them would be reading a wire that does not exist —
    // the road to a fabricated `dimensions` believed downstream.
    const objects = extractScanObjects(
      scanRow({
        metadata: {
          objects: [
            {
              label: 'chair',
              position: { x: 1, y: 0, z: 0 },
              extent: { x: 0.6, y: 0.9, z: 0.6 },
              rotation: { x: 0, y: 1.57, z: 0 },
              dimensions: '60 x 90 x 60 cm',
              bbox3d: [0, 0, 0, 0.6, 0.9, 0.6],
            },
          ],
        },
      }),
    );

    expect(objects[0]).toEqual({
      label: 'chair',
      position: { x: 1, y: 0, z: 0 },
      objectKey: expect.any(String),
      box: null,
    });
  });

  it('returns nothing for a scan with no detections sidecar', () => {
    expect(extractScanObjects(scanRow({ metadata: { kind: 'capture.scan' } }))).toEqual([]);
    expect(extractScanObjects(scanRow({ metadata: null }))).toEqual([]);
  });

  it('ignores a non-array objects value rather than throwing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractScanObjects(scanRow({ metadata: { objects: 'chair' } as any }))).toEqual([]);
  });
});

/* ===================================================================== *
 * extractScanObjects — the oriented box, as the push sends it now
 * ===================================================================== */

/** The keys `memory_push.ts` writes for a box: four in the splat's frame, three in the Place's. */
const BOX_KEYS = [
  'position',
  'rotation',
  'extent_m',
  'extent_mm',
  'extent_metric_m',
  'position_project',
  'rotation_project',
];

describe('extractScanObjects — the oriented box in the recorded push', () => {
  it('reads every object of the recorded push with its box', () => {
    const objects = extractScanObjects(recordedScanRow('oriented-boxes'));

    expect(objects.map((object) => object.label)).toEqual(['chair', 'desk lamp']);
    // The chair as memory_push.ts built it: the box in the splat's frame, under
    // the frame facts of the scan's `object_extents` block, and the same box in
    // the Place's metric frame, because the scan's fit passed.
    expect(objects[0].box).toEqual({
      frame: 'splat_local',
      calibrated: false,
      world_frame_aligned: false,
      position: { x: 2.5, y: 0, z: -5 },
      rotation: { x: 0, y: 0.3827, z: 0, w: 0.9239 },
      extent_m: { x: 1.1, y: 1.9, z: 1.2 },
      extent_mm: { x: 1100, y: 1900, z: 1200 },
      extent_metric_m: { x: 0.55, y: 0.95, z: 0.6 },
      position_project: { x: -0.5, y: 0, z: -2.75 },
      rotation_project: { x: 0, y: 0.9238823925624398, z: 0, w: 0.3826765275178269 },
    });
  });

  it('copies every box key the push sent, verbatim, and no other key of the object', () => {
    const objects = extractScanObjects(recordedScanRow('oriented-boxes'));

    recordedObjects('oriented-boxes').forEach((sent, index) => {
      const geometry = Object.fromEntries(Object.entries(sent).filter(([key]) => BOX_KEYS.includes(key)));

      expect(objects[index].box).toEqual({
        frame: 'splat_local',
        calibrated: false,
        world_frame_aligned: false,
        ...geometry,
      });
    });
  });

  it('has a decision for every key the recorded push puts on an object', () => {
    // Each key is the label, is read into the box, or is knowingly not read
    // yet. A key outside all three means the push has widened again: decide
    // what it means here, and bump the version with that change.
    const notReadYet = ['confidence', 'frame_votes'];

    for (const sent of recordedObjects('oriented-boxes')) {
      for (const key of Object.keys(sent)) {
        expect(['label', ...BOX_KEYS, ...notReadYet]).toContain(key);
      }
    }
  });

  it('keys every object exactly as it was keyed before the box arrived', () => {
    // Version 2 re-promotes every scan. The box's centre is `position`, so the
    // per-object id is unchanged and the re-run updates the sightings version 1
    // wrote instead of adding a second set.
    const withBoxes = extractScanObjects(recordedScanRow('oriented-boxes'));
    const withoutBoxes = extractScanObjects(recordedScanRow('label-position'));

    expect(withBoxes.map((object) => object.objectKey)).toEqual(
      withoutBoxes.map((object) => object.objectKey),
    );
  });

  it('has no box for an object the push sent without one', () => {
    const objects = extractScanObjects(recordedScanRow('label-position'));

    expect(objects.map((object) => object.position)).toEqual([
      { x: 2.5, y: 0, z: -5 },
      { x: 1, y: 2.2, z: -3.5 },
    ]);
    expect(objects.map((object) => object.box)).toEqual([null, null]);
  });

  it('keeps the well-formed keys of a box and drops a malformed one on its own', () => {
    const objects = extractScanObjects(
      scanRow({
        metadata: {
          object_extents: { frame: 'splat_local', calibrated: false, world_frame_aligned: false },
          objects: [
            {
              label: 'chair',
              position: { x: 1, y: 0, z: 0 },
              // No `w`: not a quaternion.
              rotation: { x: 0, y: 0.7071, z: 0 },
              extent_m: { x: 0.6, y: 0.9, z: 0.6 },
              // A string axis: not a size.
              extent_mm: { x: 600, y: 900, z: '600' },
              // Half a point.
              position_project: { x: 2, y: 0, z: null },
            },
          ],
        },
      }),
    );

    expect(objects[0].box).toEqual({
      frame: 'splat_local',
      calibrated: false,
      world_frame_aligned: false,
      position: { x: 1, y: 0, z: 0 },
      extent_m: { x: 0.6, y: 0.9, z: 0.6 },
    });
  });

  it('refuses a size with a zero axis, as the push does', () => {
    const objects = extractScanObjects(
      scanRow({
        metadata: {
          objects: [{ label: 'chair', position: { x: 1, y: 0, z: 0 }, extent_m: { x: 0.6, y: 0, z: 0.6 } }],
        },
      }),
    );

    expect(objects[0].box).toBeNull();
  });

  it('keeps an orientation that arrives without a size, and invents no frame', () => {
    // The push refuses an extent with a zero axis and still sends the rotation,
    // which is real. It sends `object_extents` only when some object has an
    // extent, so this scan has no block, and the frame facts stay unknown.
    const objects = extractScanObjects(
      scanRow({
        metadata: {
          objects: [{ label: 'rug', position: { x: 0, y: 0, z: 1 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }],
        },
      }),
    );

    expect(objects[0].box).toEqual({
      frame: null,
      calibrated: null,
      world_frame_aligned: null,
      position: { x: 0, y: 0, z: 1 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
  });

  it('has no box without a centre', () => {
    const objects = extractScanObjects(
      scanRow({ metadata: { objects: [{ label: 'chair', rotation: { x: 0, y: 0, z: 0, w: 1 } }] } }),
    );

    expect(objects[0].box).toBeNull();
  });
});

/* ===================================================================== *
 * extractScanLocation
 * ===================================================================== */

describe('extractScanLocation — the fix travels in the payload', () => {
  it('reads lon from the payload, which is the spelling Companion Scan sends', () => {
    expect(extractScanLocation(scanRow())).toEqual({ lat: 51.5072, lng: -0.1276 });
  });

  it('accepts lng too, because this is a cross-repo wire', () => {
    expect(extractScanLocation(scanRow({ metadata: { location: { lat: 1, lng: 2 } } }))).toEqual({
      lat: 1,
      lng: 2,
    });
  });

  it('prefers the event columns when something has filled them', () => {
    expect(extractScanLocation(scanRow({ lat: 10, lng: 20 }))).toEqual({ lat: 10, lng: 20 });
  });

  it('returns null for a scan with no geo at all', () => {
    expect(extractScanLocation(scanRow({ metadata: { objects: [] } }))).toBeNull();
    expect(extractScanLocation(scanRow({ metadata: { location: null } }))).toBeNull();
  });

  it('refuses a half-coordinate', () => {
    expect(extractScanLocation(scanRow({ metadata: { location: { lat: 51.5 } } }))).toBeNull();
  });
});

/* ===================================================================== *
 * run — what gets written
 * ===================================================================== */

describe('ObservationPromoteStage.run — one sighting per detected object', () => {
  it('writes a sighting per object and reports done', async () => {
    const { stage, createMany } = makeStage();

    const results = await stage.run(ctx(), [EVENT]);

    expect(results.get(EVENT)).toEqual(
      expect.objectContaining({
        outcome: 'done',
        detail: expect.objectContaining({ detected: 2, recorded: 2 }),
      }),
    );

    const [, dtos] = createMany.mock.calls[0];

    expect(dtos).toHaveLength(2);
  });

  it('keys each sighting on the event plus a stable per-object id', async () => {
    const { stage, createMany } = makeStage();

    await stage.run(ctx(), [EVENT]);

    const [, dtos] = createMany.mock.calls[0];

    expect(dtos[0]).toEqual(
      expect.objectContaining({
        sourceType: 'promote.observation',
        sourceSystem: 'companion-scan',
        sourceId: expect.stringMatching(new RegExp(`^${EVENT}:[0-9a-f]{32}$`)),
        eventId: EVENT,
      }),
    );
  });

  it('PUTS THE SCAN POSITION IN ATTRIBUTES, TAGGED WITH ITS FRAME', async () => {
    const { stage, createMany } = makeStage();

    await stage.run(ctx(), [EVENT]);

    const [, dtos] = createMany.mock.calls[0];

    // A point in the capture's own coordinate system — not lat/lon, and not
    // comparable between two scans of the same room. The tag is what stops
    // someone downstream reading it as geography.
    expect(dtos[0].attributes).toEqual({
      scan_position: { x: 1.25, y: 0, z: -2.5 },
      scan_frame: 'scan_local',
    });
  });

  it('PUTS THE BOX IN ATTRIBUTES BESIDE THE POSITION, for every object of the recorded push', async () => {
    const { stage, createMany } = makeStage([recordedScanRow('oriented-boxes')]);

    const results = await stage.run(ctx(), [EVENT]);

    expect(results.get(EVENT)).toEqual(
      expect.objectContaining({
        outcome: 'done',
        detail: expect.objectContaining({ detected: 2, recorded: 2 }),
      }),
    );

    const dtos = createMany.mock.calls[0][1] as Array<Record<string, unknown>>;
    const objects = extractScanObjects(recordedScanRow('oriented-boxes'));

    expect(dtos.map((dto) => dto.attributes)).toEqual(
      objects.map((object) => ({
        scan_position: object.position,
        scan_frame: 'scan_local',
        scan_box: object.box,
      })),
    );
    expect(objects.every((object) => object.box != null)).toBe(true);
    // `bbox` is a 2-D rectangle in 0..1 of an image; a 3-D box there would be
    // read as one.
    expect(dtos[0]).not.toHaveProperty('bbox');
  });

  it('reads the rest of the recorded push as it always has', async () => {
    const { stage, createMany } = makeStage([recordedScanRow('oriented-boxes')]);

    await stage.run(ctx(), [EVENT]);

    const [, dtos] = createMany.mock.calls[0];

    expect(dtos[0]).toEqual(
      expect.objectContaining({
        observedAt: new Date('2026-04-02T14:30:00.000Z'),
        coordinates: { lat: 51.5072, lon: -0.1276 },
        fileId: '00000000-0000-4000-8000-0000000000f1',
        detector: 'companion-scan',
        sourceSystem: 'companion-scan',
        metadata: {
          scan_id: 'scan-fixture-oriented-boxes',
          session_id: 'session-fixture-1',
          point_count: 481_233,
          promoted_by: 'promote.observation',
        },
      }),
    );
  });

  it('writes a recorded push without boxes exactly as version 1 wrote one', async () => {
    const { stage, createMany } = makeStage([recordedScanRow('label-position')]);

    await stage.run(ctx(), [EVENT]);

    const dtos = createMany.mock.calls[0][1] as Array<Record<string, unknown>>;

    // No `scan_box` key at all rather than a null one, so a box-less
    // sighting's attributes are what they always were.
    expect(dtos.map((dto) => dto.attributes)).toEqual([
      { scan_position: { x: 2.5, y: 0, z: -5 }, scan_frame: 'scan_local' },
      { scan_position: { x: 1, y: 2.2, z: -3.5 }, scan_frame: 'scan_local' },
    ]);
  });

  it('keeps the geographic fix in coordinates, separate from the scan position', async () => {
    const { stage, createMany } = makeStage();

    await stage.run(ctx(), [EVENT]);

    const [, dtos] = createMany.mock.calls[0];

    expect(dtos[0].coordinates).toEqual({ lat: 51.5072, lon: -0.1276 });
  });

  it('dates the sighting from the scan, and records source_kind honestly', async () => {
    const { stage, createMany } = makeStage();

    await stage.run(ctx(), [EVENT]);

    const [, dtos] = createMany.mock.calls[0];

    expect(dtos[0].observedAt).toEqual(new Date('2026-04-02T14:30:00.000Z'));
    // The CHECK has no `scan` value; live_camera is the closest true statement.
    expect(dtos[0].sourceKind).toBe('live_camera');
    // The CHECK on label_source admits none of cv-server's models, so the
    // truthful record of who spoke is `detector`.
    expect(dtos[0].labelSource).toBeNull();
    expect(dtos[0].detector).toBe('companion-scan');
  });

  it('NEVER sets a resolution or a confirmation', async () => {
    const { stage, createMany } = makeStage();

    await stage.run(ctx(), [EVENT]);

    const [, dtos] = createMany.mock.calls[0];

    for (const dto of dtos) {
      expect(dto).not.toHaveProperty('resolvedObjectId');
      expect(dto).not.toHaveProperty('resolutionMethod');
      expect(dto).not.toHaveProperty('confirmedByUser');
    }
  });
});

/* ===================================================================== *
 * Place resolution
 * ===================================================================== */

describe('ObservationPromoteStage — place resolution, by the strongest evidence', () => {
  it('trusts an existing location_entity_id over re-deriving one', async () => {
    const { stage, createMany, placesNear } = makeStage([scanRow({ location_entity_id: PLACE })]);

    await stage.run(ctx(), [EVENT]);

    expect(placesNear).not.toHaveBeenCalled();
    expect(createMany.mock.calls[0][1][0].placeEntityId).toBe(PLACE);
  });

  it('falls back to the nearest known place within the radius', async () => {
    const { stage, createMany, placesNear } = makeStage();

    placesNear.mockResolvedValue([{ id: PLACE, distanceMeters: 30 }]);

    await stage.run(ctx(), [EVENT]);

    expect(placesNear).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lat: 51.5072, lng: -0.1276, radiusMeters: 150, limit: 1 }),
    );
    expect(createMany.mock.calls[0][1][0].placeEntityId).toBe(PLACE);
  });

  it('NEVER CREATES A PLACE for a scan with nothing nearby', async () => {
    const { stage, createMany, placesNear } = makeStage();

    placesNear.mockResolvedValue([]);

    await stage.run(ctx(), [EVENT]);

    // Minting a Location per room scan would fill the graph with unnamed points
    // the place-dedupe rules then have to argue with. A sighting with
    // coordinates and no place is a true statement, and resolvable later.
    expect(createMany.mock.calls[0][1][0].placeEntityId).toBeNull();
    expect(createMany.mock.calls[0][1][0].coordinates).not.toBeNull();
  });

  it('never keys a sighting on a NULL source_system', async () => {
    const { stage, createMany } = makeStage([scanRow({ source_system: null })]);

    await stage.run(ctx(), [EVENT]);

    // Two NULLs in a multi-column unique index do not conflict in Postgres, so
    // a NULL here would make every re-promotion INSERT a fresh set of sightings
    // rather than update them — unbounded duplication on every version bump.
    expect(createMany.mock.calls[0][1][0].sourceSystem).toBe('unknown');
  });

  it('does not look for a place when the scan has no fix', async () => {
    const { stage, createMany, placesNear } = makeStage([
      scanRow({ metadata: { objects: [{ label: 'chair', position: { x: 0, y: 0, z: 0 } }] } }),
    ]);

    await stage.run(ctx(), [EVENT]);

    expect(placesNear).not.toHaveBeenCalled();
    expect(createMany.mock.calls[0][1][0].placeEntityId).toBeNull();
    expect(createMany.mock.calls[0][1][0].coordinates).toBeNull();
  });
});

/* ===================================================================== *
 * Every id gets a verdict, and every non-done one gets a reason
 * ===================================================================== */

describe('ObservationPromoteStage.run — verdicts', () => {
  it('records a scan with no detections as a countable skip, not a silence', async () => {
    const { stage, createMany } = makeStage([scanRow({ metadata: { kind: 'capture.scan' } })]);

    const results = await stage.run(ctx(), [EVENT]);

    // The sidecar is optional and memory_push sends the event without it, so
    // this is a normal outcome that still has to be a number in the state route.
    expect(results.get(EVENT)).toEqual({ outcome: 'skipped', reason: 'no_detected_objects' });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('refuses to invent a time for a sighting', async () => {
    const { stage, createMany } = makeStage([scanRow({ start_time: null })]);

    const results = await stage.run(ctx(), [EVENT]);

    expect(results.get(EVENT)).toEqual({ outcome: 'skipped', reason: 'no_start_time' });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('answers for an id whose row came back missing', async () => {
    const { stage } = makeStage([]);

    const results = await stage.run(ctx(), [EVENT]);

    expect(results.get(EVENT)).toEqual({ outcome: 'skipped', reason: 'source_row_missing' });
  });

  it('reports a write error as FAILED, so the retry gate applies', async () => {
    const { stage, createMany } = makeStage();

    createMany.mockRejectedValue(new Error('deadlock detected'));

    const results = await stage.run(ctx(), [EVENT]);

    // A transient deadlock against a concurrent writer must come back rather
    // than be written off as a decision.
    expect(results.get(EVENT)).toEqual(
      expect.objectContaining({ outcome: 'failed', reason: 'observation_write_failed' }),
    );
  });

  it('does not let one bad scan take the slice down with it', async () => {
    const other = '00000000-0000-4000-8000-000000000002';
    const { stage, createMany } = makeStage([scanRow(), scanRow({ id: other, start_time: null })]);

    const results = await stage.run(ctx(), [EVENT, other]);

    expect(results.get(EVENT)?.outcome).toBe('done');
    expect(results.get(other)).toEqual({ outcome: 'skipped', reason: 'no_start_time' });
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it('gives every id in the slice a verdict', async () => {
    const { stage } = makeStage();

    const results = await stage.run(ctx(), [EVENT, 'missing-1', 'missing-2']);

    expect([...results.keys()].sort()).toEqual([EVENT, 'missing-1', 'missing-2'].sort());
  });

  it('every non-done result carries a reason, which PipelineStateService enforces', async () => {
    const { stage } = makeStage([scanRow({ start_time: null })]);

    const results = await stage.run(ctx(), [EVENT, 'missing-1']);

    for (const result of results.values()) {
      if (result.outcome !== 'done') {
        expect(result.reason).toBeTruthy();
      }
    }
  });

  it('never reports a confidence, because it measured nothing', async () => {
    const { stage } = makeStage();

    const results = await stage.run(ctx(), [EVENT]);

    expect(results.get(EVENT)).not.toHaveProperty('confidence');
  });

  it('does nothing at all for an empty slice', async () => {
    const { stage, query } = makeStage();

    expect(await stage.run(ctx(), [])).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it('scopes the load to the context user, for a dead letter replayed weeks later', async () => {
    const { stage, query } = makeStage();

    await stage.run(ctx(), [EVENT]);

    expect(query.mock.calls[0][0]).toContain('AND e.user_id = $2::uuid');
    expect(query.mock.calls[0][1]).toEqual([[EVENT], USER]);
  });
});
