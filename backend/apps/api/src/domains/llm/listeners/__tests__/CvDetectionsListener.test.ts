import type { CreateObjectObservationDto } from '@ci/domains/memory';

import type { CvDetection, CvDetectionsCapturedPayload } from '../../events';
import { CvDetectionsListener, CV_DETECTION_LINKED_TABLE } from '../CvDetectionsListener';

/** Only the fields CvDetectionsListener reads off a file. */
interface StubFile {
  id: string;
  createdAt: Date;
  externalCreatedAt: Date | null;
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeListener(opts: { fileExists?: boolean } = {}) {
  const { fileExists = true } = opts;

  const fileService = {
    findById: jest.fn(async (_ctx: unknown, id: string): Promise<StubFile | null> =>
      fileExists ? { id, createdAt: new Date('2026-01-02T03:04:05.000Z'), externalCreatedAt: null } : null,
    ),
  };

  const personService = {
    create: jest.fn(async (_ctx: unknown, dto: { linkedId: string; name: string }) => ({
      id: `person-${dto.linkedId}`,
      name: dto.name,
    })),
  };

  const observationService = {
    createMany: jest.fn(async (_ctx: unknown, dtos: CreateObjectObservationDto[]) => ({
      written: dtos.map((_dto, index) => ({ id: `observation-${index}` })),
      protectedByConfirmation: 0,
      duplicatesInBatch: 0,
      rejectedUnarbitered: 0,
    })),
  };

  const logger = makeLogger();

  const listener = new CvDetectionsListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fileService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    personService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    observationService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { listener, fileService, personService, observationService, logger };
}

function person(detectionId: string, overrides: Partial<CvDetection> = {}): CvDetection {
  return {
    detectionId,
    kind: 'Person',
    label: 'person',
    score: 0.9,
    ...overrides,
  };
}

function payload(fileId: string, detections: CvDetection[]): CvDetectionsCapturedPayload {
  return { userId: 'user-1', fileId, detections };
}

describe('CvDetectionsListener', () => {
  it('materializes a Person entity per detected face, linked to the source file', async () => {
    const { listener, personService } = makeListener();

    await listener.handleDetections(
      payload('file-1', [person('det-a', { semanticLabel: 'Alice' }), person('det-b')]),
    );

    expect(personService.create).toHaveBeenCalledTimes(2);

    // First detection uses semanticLabel as the name; link key is file:detection.
    expect(personService.create).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        name: 'Alice',
        linkedTable: CV_DETECTION_LINKED_TABLE,
        linkedId: 'file-1:det-a',
      }),
    );

    // Second detection falls back to the label; distinct link key => distinct entity.
    expect(personService.create).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        name: 'person',
        linkedId: 'file-1:det-b',
      }),
    );
  });

  it('records detection provenance in entity properties', async () => {
    const { listener, personService } = makeListener();

    await listener.handleDetections(
      payload('file-2', [
        person('det-x', {
          source: 'omi',
          score: 0.7,
          bboxNormalized: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        }),
      ]),
    );

    expect(personService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        properties: expect.objectContaining({
          source: 'omi',
          source_file_id: 'file-2',
          detection_id: 'det-x',
          detection_score: 0.7,
          detection_bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        }),
      }),
    );
  });

  it('skips entirely when the source file does not exist', async () => {
    const { listener, personService, logger } = makeListener({ fileExists: false });

    await listener.handleDetections(payload('missing', [person('det-a')]));

    expect(personService.create).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is a no-op for an empty detection list and never touches the file', async () => {
    const { listener, fileService, personService } = makeListener();

    await listener.handleDetections(payload('file-3', []));

    expect(fileService.findById).not.toHaveBeenCalled();
    expect(personService.create).not.toHaveBeenCalled();
  });

  it('records Thing detections as sightings and still defers Concept', async () => {
    const { listener, personService, observationService } = makeListener();

    await listener.handleDetections(
      payload('file-4', [
        { detectionId: 'obj-1', kind: 'Thing', label: 'coffee mug' },
        { detectionId: 'scene-1', kind: 'Concept', label: 'kitchen' },
      ]),
    );

    expect(personService.create).not.toHaveBeenCalled();
    // One batched call, carrying the Thing and NOT the Concept.
    expect(observationService.createMany).toHaveBeenCalledTimes(1);

    const [, dtos] = observationService.createMany.mock.calls[0];

    expect(dtos).toHaveLength(1);
    expect(dtos[0]).toEqual(expect.objectContaining({ label: 'coffee mug', fileId: 'file-4' }));
  });

  it('keys a sighting on the provenance triple, not a derived detection key', async () => {
    const { listener, observationService } = makeListener();

    await listener.handleDetections(
      payload('file-6', [
        {
          detectionId: 'obj-9',
          kind: 'Thing',
          label: 'chair',
          score: 0.8,
          source: 'cv-server',
          bboxNormalized: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        },
      ]),
    );

    const [, dtos] = observationService.createMany.mock.calls[0];

    expect(dtos[0]).toEqual(
      expect.objectContaining({
        sourceType: 'cv_detection',
        sourceSystem: 'cv-server',
        sourceId: 'file-6:obj-9',
        detector: 'cv-server',
        detectionConfidence: 0.8,
        // CvBBoxNormalized is {width, height}; the observation column is {w, h}.
        // A spread would have written undefined here.
        bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      }),
    );
  });

  it('never writes a resolution or a confirmation from a detection', async () => {
    const { listener, observationService } = makeListener();

    await listener.handleDetections(
      payload('file-7', [{ detectionId: 'obj-3', kind: 'Thing', label: 'lamp' }]),
    );

    // The DTO type forbids these at compile time; this is the runtime witness
    // that the listener does not smuggle them through anyway. A detection is
    // "seen", never "owned".
    const [, dtos] = observationService.createMany.mock.calls[0];

    expect(dtos[0]).not.toHaveProperty('resolvedObjectId');
    expect(dtos[0]).not.toHaveProperty('resolutionMethod');
    expect(dtos[0]).not.toHaveProperty('confirmedByUser');
  });

  it('dates a sighting from the capture time, not the time the job ran', async () => {
    const { listener, fileService, observationService } = makeListener();

    // An imported photo: uploaded today, taken in 2019.
    fileService.findById.mockResolvedValueOnce({
      id: 'file-8',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      externalCreatedAt: new Date('2019-07-04T12:00:00.000Z'),
    });

    await listener.handleDetections(
      payload('file-8', [{ detectionId: 'obj-4', kind: 'Thing', label: 'bicycle' }]),
    );

    const [, dtos] = observationService.createMany.mock.calls[0];

    expect(dtos[0].observedAt).toEqual(new Date('2019-07-04T12:00:00.000Z'));
  });

  it('processes mixed kinds, materializing the Person and the sighting', async () => {
    const { listener, personService, observationService } = makeListener();

    await listener.handleDetections(
      payload('file-5', [person('det-p'), { detectionId: 'obj-2', kind: 'Thing', label: 'lamp' }]),
    );

    expect(personService.create).toHaveBeenCalledTimes(1);
    expect(personService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ linkedId: 'file-5:det-p' }),
    );

    const [, dtos] = observationService.createMany.mock.calls[0];

    expect(dtos).toHaveLength(1);
    expect(dtos[0]).toEqual(expect.objectContaining({ label: 'lamp' }));
  });

  it('does not call the observation writer when there is nothing to record', async () => {
    const { listener, observationService } = makeListener();

    await listener.handleDetections(payload('file-9', [person('det-only')]));

    expect(observationService.createMany).not.toHaveBeenCalled();
  });
});
