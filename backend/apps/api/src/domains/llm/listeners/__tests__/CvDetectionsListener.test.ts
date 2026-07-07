import type { CvDetection, CvDetectionsCapturedPayload } from '../../events';
import { CvDetectionsListener, CV_DETECTION_LINKED_TABLE } from '../CvDetectionsListener';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeListener(opts: { fileExists?: boolean } = {}) {
  const { fileExists = true } = opts;

  const fileService = {
    findById: jest.fn(async (_ctx: unknown, id: string) => (fileExists ? { id } : null)),
  };

  const personService = {
    create: jest.fn(async (_ctx: unknown, dto: { linkedId: string; name: string }) => ({
      id: `person-${dto.linkedId}`,
      name: dto.name,
    })),
  };

  const logger = makeLogger();

  const listener = new CvDetectionsListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fileService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    personService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { listener, fileService, personService, logger };
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

  it('defers Thing and Concept detections without creating Person entities', async () => {
    const { listener, personService } = makeListener();

    await listener.handleDetections(
      payload('file-4', [
        { detectionId: 'obj-1', kind: 'Thing', label: 'coffee mug' },
        { detectionId: 'scene-1', kind: 'Concept', label: 'kitchen' },
      ]),
    );

    expect(personService.create).not.toHaveBeenCalled();
  });

  it('processes mixed kinds, materializing only the Person', async () => {
    const { listener, personService } = makeListener();

    await listener.handleDetections(
      payload('file-5', [person('det-p'), { detectionId: 'obj-2', kind: 'Thing', label: 'lamp' }]),
    );

    expect(personService.create).toHaveBeenCalledTimes(1);
    expect(personService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ linkedId: 'file-5:det-p' }),
    );
  });
});
