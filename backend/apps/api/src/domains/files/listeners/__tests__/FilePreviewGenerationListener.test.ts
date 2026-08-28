import { FilePreviewService } from '../../services/FilePreviewService';
import { FilePreviewGenerationListener } from '../FilePreviewGenerationListener';

/**
 * Preview generation must tolerate warning-level JPEG quirks. Real phone
 * JPEGs — Samsung above all — routinely carry defects like stray padding
 * before restart markers ("Corrupt JPEG data: N extraneous bytes before
 * marker 0xdN") that every mainstream viewer decodes fine, but sharp's
 * default failOn: 'warning' turned into failed preview jobs (~8% of a sampled
 * Google Takeout batch). The listener now decodes with failOn: 'error':
 * warning-level quirks produce a normal preview, and genuinely undecodable
 * bytes are skipped (the job completes) rather than dead-lettered.
 *
 * The fixture below is a real reproduction, not a mock: a tiny JPEG encoded
 * with restart markers and stray bytes stuffed before them, which makes the
 * default-strictness sharp throw exactly the production error
 * ("Corrupt JPEG data: 6 extraneous bytes before marker 0xd1").
 */
const QUIRKY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQ' +
    'ERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU' +
    'FBQUFBQUFBQUFBQUFBT/wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA' +
    'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6' +
    'Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
    'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA' +
    'AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5' +
    'OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE' +
    'xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/90ABAAB/9oADAMBAAIRAxEAPwD8z7LSOny1vWWkdPlrZstI6fLW' +
    '9ZaR0+WiEwy7MdtTACoR/9D4MstH6fLW9ZaR0+Wtmy0jp8tb1lo/T5a7oTP07Lsx21MAKhH/0fkmy0jp8tb1lpHT5a2LLSOn' +
    'y1v2WkdPlr3ITP6dy7MdtT8AKhH/0vBbLR+ny1v2WkdPlrYstI6fLW/ZaP0+WvqoTP7ry7MdtT8AKhH/0/j2y0fp8tb1lpHT' +
    '5a2bLSOny1vWWj9PlrhhM/McuzHbUwAqEf/U+erLSOny1vWWkdPlrZstI6fLW9ZaR0+WiEwy7MdtTwAqEf/V82stH6fLW/Za' +
    'R0+Wtiy0jp8tb9lo/T5a7oTP07Lsx21PACoR/9anZaR0+Wt+y0jp8tbFlpHT5a37LSOny17kJn9O5dmO2p8AKhH/1/K7LSOn' +
    'y1vWWkdPlrZstI6fLW9ZaR0+WvDhM/mLLsx21AAqEf/QyLLR+ny1vWWkdPlrZstI6fLW9ZaP0+WuGEz8xy7MdtQAKhH/0els' +
    'tI6fLW/ZaR0+Wtiy0jp8tb9lpHT5aITDLsx21AAqEf/S9istH6fLW9ZaR0+Wtmy0jp8tb1lo/T5a7oTP07Lsx21PACoR/9Pa' +
    'stH6fLW9ZaR0+Wtmy0jp8tb1lo/T5a+VhM/hTLsx21MAKhH/1PVrLSOny1v2WkdPlrYstI6fLW/ZaR0+WvDhM/mLLsx21AAq' +
    'Ef/V+k7LR+ny1v2WkdPlrYstI6fLW/ZaP0+WuGEz8xy7MdtTACoR/9b7QstI6fLW9ZaR0+Wtmy0jp8tb1lpHT5aITDLsx21P' +
    'ACoR/9k=',
  'base64',
);

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeListener(
  fileBytes: Buffer | (() => Promise<Buffer>),
  contentType = 'image/jpeg',
  // The length recorded at upload. Defaults to whatever the read returns, i.e.
  // "the bytes are all there"; a test passing a different number is simulating
  // a short read. `size` is a Postgres `bigint` column with no transformer, so
  // TypeORM hands it back as a STRING at runtime even though the entity types
  // it `number` — a test wanting to model production must be able to pass one.
  recordedSize?: number | string,
) {
  const created: unknown[] = [];
  const logger = makeLogger();
  const fileService = {
    findVariantByParentId: jest.fn(async () => null),
    findById: jest.fn(async () => ({
      id: 'file-1',
      bucket: 'files',
      key: 'user/file-1',
      contentType,
      size: recordedSize ?? (Buffer.isBuffer(fileBytes) ? fileBytes.length : null),
    })),
    getFileContent: jest.fn(async () => (typeof fileBytes === 'function' ? fileBytes() : fileBytes)),
    setDimensions: jest.fn(async () => {}),
    create: jest.fn(async (_ctx: unknown, input: unknown) => {
      created.push(input);

      return { id: 'preview-1' };
    }),
  };
  const mediaDimensionsService = {
    fromImageBuffer: jest.fn(async () => ({ width: 64, height: 64 })),
  };
  const eventService = { send: jest.fn(async () => {}) };

  // The generator moved into FilePreviewService (so the enrich.file_preview
  // stage can share it); the listener is the upload-path trigger over it.
  // Every assertion below is about the generator's behaviour, so the service
  // is built with the same mocks and driven through the listener as before.
  const service = new FilePreviewService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fileService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mediaDimensionsService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );
  const listener = new FilePreviewGenerationListener(service);

  return { listener, fileService, eventService, created, logger };
}

describe('FilePreviewGenerationListener', () => {
  it('generates a preview for a JPEG with warning-level defects (stray bytes before restart markers)', async () => {
    const { listener, fileService, eventService, created } = makeListener(QUIRKY_JPEG);

    await listener.generatePreview({ userId: 'u1', fileId: 'file-1', thingCapture: false });

    expect(fileService.create).toHaveBeenCalledTimes(1);
    const preview = created[0] as { contentType: string; width: number; height: number; buffer: Buffer };
    expect(preview.contentType).toBe('image/jpeg');
    expect(preview.width).toBeGreaterThan(0);
    expect(preview.width).toBeLessThanOrEqual(300);
    expect(preview.height).toBeGreaterThan(0);
    expect(preview.height).toBeLessThanOrEqual(300);
    expect(preview.buffer.length).toBeGreaterThan(0);
    expect(eventService.send).toHaveBeenCalledTimes(1);
  });

  /**
   * Routing on the MIME prefix alone (`contentType.startsWith('image/')`) hands
   * sharp anything labelled image/*, and libvips throws "Input buffer contains
   * unsupported image format" for any bytes it has no loader for. That throw
   * used to reach the pg-boss worker: 3 retries and then a permanent dead
   * letter per file (32 on the QA appliance), re-earned on every re-import.
   * An undecodable file is a skip — the job must complete.
   */
  it('skips instead of failing the job when the image bytes are undecodable', async () => {
    const { listener, fileService, eventService } = makeListener(Buffer.from('this is not an image at all'));

    await expect(
      listener.generatePreview({ userId: 'u1', fileId: 'file-1', thingCapture: false }),
    ).resolves.toBeUndefined();

    expect(fileService.create).not.toHaveBeenCalled();
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('logs fileId and contentType on a decode skip so the undecodable corpus is countable', async () => {
    const { listener, logger } = makeListener(Buffer.from('not an image'), 'image/heic');

    await listener.generatePreview({ userId: 'u1', fileId: 'file-1', thingCapture: false });

    const decodeWarn = logger.warn.mock.calls.find(
      ([message]) => message === 'Image decode failed, skipping preview generation',
    );

    expect(decodeWarn).toBeDefined();
    expect(decodeWarn?.[1]).toMatchObject({ fileId: 'file-1', contentType: 'image/heic' });
  });

  /**
   * libvips returns the SAME verdict — "Input buffer contains unsupported image
   * format" — for "this format has no loader" and "this read came back short",
   * and those need opposite handling. The 32 dead letters that motivated the
   * skip turned out to be complete, valid JPEGs that decode cleanly, i.e. the
   * failures were transient and the retries were their only recovery. Skipping
   * on the first attempt would have removed it, so the skip is gated on the
   * bytes being all there.
   */
  it('retries rather than skipping when the bytes came back short', async () => {
    const truncated = Buffer.from('this is not an image at all');
    const { listener, fileService } = makeListener(truncated, 'image/jpeg', truncated.length + 4096);

    await expect(
      listener.generatePreview({ userId: 'u1', fileId: 'file-1', thingCapture: false }),
    ).rejects.toThrow();

    expect(fileService.create).not.toHaveBeenCalled();
  });

  /**
   * `size` is a Postgres `bigint` with no transformer, so TypeORM returns it
   * as a STRING at runtime (`"430679"`, not `430679`) even though the entity
   * types it `number`. `!==` never coerces, so a naive
   * `original.length !== file.size` compares a number to a string and is
   * ALWAYS true — every intact-but-undecodable file was misrouted into the
   * "short read" branch and retried to exhaustion instead of skipped. This is
   * exactly what put a real, complete Google Ultra HDR JPEG (a legitimate
   * format this build's libvips has no loader for) into the dead-letter queue
   * in production: `bytes: 430679` next to `expectedBytes: "430679"` in the
   * logs, string and number, identical value.
   */
  it('skips (does not retry) when the bytes match a `size` recorded as a string, not a number', async () => {
    const bytes = Buffer.from('this is not an image at all');
    const { listener, fileService, eventService } = makeListener(bytes, 'image/jpeg', String(bytes.length));

    await expect(
      listener.generatePreview({ userId: 'u1', fileId: 'file-1', thingCapture: false }),
    ).resolves.toBeUndefined();

    expect(fileService.create).not.toHaveBeenCalled();
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('still retries a genuine short read when `size` is recorded as a string', async () => {
    const truncated = Buffer.from('this is not an image at all');
    const { listener, fileService } = makeListener(truncated, 'image/jpeg', String(truncated.length + 4096));

    await expect(
      listener.generatePreview({ userId: 'u1', fileId: 'file-1', thingCapture: false }),
    ).rejects.toThrow();

    expect(fileService.create).not.toHaveBeenCalled();
  });

  it('keeps the probed dimensions on a decode skip', async () => {
    // The probe uses its own tolerant path and usually succeeds on bytes sharp
    // will not resize. Those dimensions are the one thing a preview-less file
    // can still show in the drawer, and they are already in hand.
    const { listener, fileService } = makeListener(Buffer.from('not an image'), 'image/heic');

    await listener.generatePreview({ userId: 'u1', fileId: 'file-1', thingCapture: false });

    expect(fileService.setDimensions).toHaveBeenCalledWith(expect.anything(), 'file-1', {
      width: 64,
      height: 64,
    });
  });

  /**
   * The object-storage read stays outside the decode try/catch: unlike a
   * decode failure, a failed fetch is transient and the queue's retries are
   * the right answer. Losing that distinction would turn every blip into a
   * silently missing thumbnail.
   */
  it('still fails the job when the original cannot be read from object storage', async () => {
    const { listener, fileService } = makeListener(async () => {
      throw new Error('S3 object body was empty for key: user/file-1');
    });

    await expect(
      listener.generatePreview({ userId: 'u1', fileId: 'file-1', thingCapture: false }),
    ).rejects.toThrow('S3 object body was empty');
    expect(fileService.create).not.toHaveBeenCalled();
  });
});
