import { Readable } from 'node:stream';

import { extractMediaMetadata } from '@ci/common/media/exif';

import {
  CaptureContentListener,
  captureContentInput,
  captureKind,
  resolveTakenAt,
} from '../CaptureContentListener';

jest.mock('@ci/common/media/exif', () => ({
  extractMediaMetadata: jest.fn(async () => ({ metadata: {} })),
}));

const mockedExtract = jest.mocked(extractMediaMetadata);

function makeListener(file: Record<string, unknown> | null) {
  const createContent = jest.fn(async (_context: unknown, input: unknown) => [
    { id: 'content-1', ...(input as object) },
  ]);
  const createEvent = jest.fn(async (_context: unknown, input: unknown) => [
    { id: 'event-1', ...(input as object) },
  ]);
  const findById = jest.fn(async () => file);
  const getFileStream = jest.fn(async () => Readable.from([Buffer.from('bytes')]));
  const logger = {
    setContext: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };
  const listener = new CaptureContentListener(
    { create: createContent } as never,
    { create: createEvent } as never,
    { findById, getFileStream } as never,
    logger as never,
  );

  return { listener, createContent, createEvent, findById, getFileStream, logger };
}

const photo = {
  id: 'file-1',
  userId: 'owner-1',
  filename: 'IMG_1792017993436.jpg',
  contentType: 'image/jpeg',
  hash: 'ABCDEF0123',
  key: 'obj-1',
};

const capture = { fileId: 'file-1', userId: 'owner-1', thingCapture: false, memoryCapture: true };

beforeEach(() => {
  mockedExtract.mockReset();
  mockedExtract.mockResolvedValue({ metadata: {} });
});

describe('CaptureContentListener', () => {
  it('ignores an upload that was not a memory capture', async () => {
    const { listener, createContent, createEvent, findById } = makeListener(photo);

    await listener.handleFileUploaded({ fileId: 'file-1', userId: 'owner-1', thingCapture: false });

    expect(findById).not.toHaveBeenCalled();
    expect(createContent).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('dates a photo from its EXIF, with its GPS, and links the content row to the event', async () => {
    const taken = new Date('2026-10-14T20:15:00Z');
    mockedExtract.mockResolvedValue({
      timestamp: taken,
      location: { latitude: 33.6, longitude: -117.9 },
      accuracyMeters: 12,
      metadata: { Make: 'Samsung' },
    });
    const { listener, createContent, createEvent, getFileStream } = makeListener(photo);

    await listener.handleFileUploaded({ ...capture, capturedAt: '2026-10-14T22:46:00Z' });

    expect(getFileStream).toHaveBeenCalledWith({ userId: 'owner-1' }, 'obj-1');
    expect(mockedExtract).toHaveBeenCalledWith(expect.stringContaining('ci-capture-'), 'image/jpeg');
    expect(createEvent).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      expect.objectContaining({
        title: 'IMG_1792017993436.jpg',
        start_time: taken,
        event_type: 'media',
        category: 'capture',
        source_type: 'capture',
        source_system: 'file',
        source_id: 'sha256:abcdef0123',
        location_coordinates: { type: 'Point', coordinates: [-117.9, 33.6] },
        metadata: expect.objectContaining({
          kind: 'capture.photo',
          Make: 'Samsung',
          'Timestamp Source': 'EXIF',
          locationSource: 'exif',
          accuracyMeters: 12,
          contentHash: 'ABCDEF0123',
        }),
      }),
    );
    expect(createContent).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      expect.objectContaining({
        type: 'media',
        external_id: 'file-1',
        external_id_kind: 'file',
        source_id: 'sha256:abcdef0123',
        event: { id: 'event-1' },
      }),
    );
  });

  it('falls back to the device capture moment when the bytes carry no date', async () => {
    const { listener, createEvent } = makeListener(photo);

    await listener.handleFileUploaded({ ...capture, capturedAt: '2026-10-14T22:46:00Z' });

    expect(createEvent).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      expect.objectContaining({
        start_time: new Date('2026-10-14T22:46:00Z'),
        metadata: expect.objectContaining({ 'Timestamp Source': 'Device' }),
      }),
    );
  });

  it('makes content only, no event, for a library pick with no date anywhere', async () => {
    const { listener, createContent, createEvent } = makeListener(photo);

    await listener.handleFileUploaded(capture);

    expect(createEvent).not.toHaveBeenCalled();
    expect(createContent).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      expect.not.objectContaining({ event: expect.anything() }),
    );
  });

  it('dates a recording from the device without reading the bytes', async () => {
    const { listener, createEvent, getFileStream } = makeListener({
      ...photo,
      filename: 'AUD_1.m4a',
      contentType: 'audio/mp4',
    });

    await listener.handleFileUploaded({ ...capture, capturedAt: '2026-10-14T22:30:00Z' });

    expect(getFileStream).not.toHaveBeenCalled();
    expect(mockedExtract).not.toHaveBeenCalled();
    expect(createEvent).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      expect.objectContaining({
        title: 'AUD_1.m4a',
        start_time: new Date('2026-10-14T22:30:00Z'),
        metadata: expect.objectContaining({ kind: 'capture.audio', 'Timestamp Source': 'Device' }),
      }),
    );
  });

  it('still catalogues the capture when the metadata read fails', async () => {
    mockedExtract.mockRejectedValue(new Error('exif exploded'));
    const { listener, createContent, createEvent, logger } = makeListener(photo);

    await listener.handleFileUploaded({ ...capture, capturedAt: '2026-10-14T22:46:00Z' });

    expect(logger.warn).toHaveBeenCalled();
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createContent).toHaveBeenCalledTimes(1);
  });

  it('skips, with a warning, when the file row is gone', async () => {
    const { listener, createContent, createEvent, logger } = makeListener(null);

    await listener.handleFileUploaded(capture);

    expect(createContent).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('resolveTakenAt', () => {
  it('prefers the embedded date over the device moment', () => {
    const embedded = new Date('2020-01-01T00:00:00Z');

    expect(resolveTakenAt({ timestamp: embedded, metadata: {} }, '2026-10-14T22:46:00Z')).toEqual({
      at: embedded,
      source: 'EXIF',
    });
  });

  it('labels a container date as such', () => {
    const embedded = new Date('2020-01-01T00:00:00Z');

    expect(resolveTakenAt({ timestamp: embedded, metadata: { Duration: 12 } }, undefined)?.source).toBe(
      'Container',
    );
  });

  it('ignores an unparseable device moment', () => {
    expect(resolveTakenAt(null, 'yesterday-ish')).toBeNull();
    expect(resolveTakenAt({ metadata: {} }, undefined)).toBeNull();
  });
});

describe('captureKind', () => {
  it('maps mimetypes onto the importer kinds', () => {
    expect(captureKind('image/heic')).toBe('capture.photo');
    expect(captureKind('video/quicktime')).toBe('capture.video');
    expect(captureKind('audio/mp4')).toBe('capture.audio');
    expect(captureKind('application/pdf')).toBe('capture.file');
    expect(captureKind(null)).toBe('capture.file');
  });
});

describe('captureContentInput', () => {
  it('types a recording and a clip as media', () => {
    expect(captureContentInput({ ...photo, contentType: 'audio/mp4' } as never).type).toBe('media');
    expect(captureContentInput({ ...photo, contentType: 'video/quicktime' } as never).type).toBe('media');
  });

  it('types a document as file', () => {
    expect(
      captureContentInput({ ...photo, filename: 'notes.pdf', contentType: 'application/pdf' } as never).type,
    ).toBe('file');
  });

  it('falls back to the file id when the store recorded no hash', () => {
    const input = captureContentInput({ ...photo, hash: null } as never);

    expect(input.source_system).toBe('file');
    expect(input.source_id).toBe('id:file-1');
  });

  it('leaves title, mimetype and event out when the row has none', () => {
    const input = captureContentInput({ ...photo, filename: null, contentType: '' } as never);

    expect(input.type).toBe('file');
    expect(input).not.toHaveProperty('title');
    expect(input).not.toHaveProperty('mimetype');
    expect(input).not.toHaveProperty('event');
  });
});
