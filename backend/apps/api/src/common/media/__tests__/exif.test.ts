/* eslint-disable import/order -- each jest.mock() is deliberately paired with
   the import it replaces; both are hoisted, so source order does not affect
   behavior and splitting them apart only obscures what is mocked. */
jest.mock('exifr', () => ({ __esModule: true, default: { parse: jest.fn() } }));
import exifr from 'exifr';

// Stub child_process.execFile so the ffprobe call is deterministic without
// requiring the binary on the test host. jest.mock is hoisted above local
// `const`s, so the referenced mock must be named `mock*` for the hoist check
// to allow it. We preserve the rest of node:child_process — clobbering the
// whole module breaks unrelated internals that reach for it.
jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof import('node:child_process')>('node:child_process'),
  execFile: jest.fn(),
}));
import { execFile } from 'node:child_process';

// The mock must be created INSIDE the factory: `jest.mock` and the `import`s
// below are both hoisted, so the module under test loads (and promisifies
// execFile) before any `const` in this file initializes. Grab the handle after.
const mockExecFile = execFile as unknown as jest.Mock;

import {
  exifWallClockToUtc,
  parseExifOffsetMinutes,
  parseExifSafe,
  extractCameraFields,
  extractVideoFields,
  extractImageExif,
  extractVideoMetadata,
  extractMediaMetadata,
  _resetFfprobeAvailability,
} from '../exif';

const parseMock = exifr.parse as unknown as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

/**
 * promisify(execFile) on a jest.fn() loses the `util.promisify.custom` symbol
 * that real execFile carries (which is what resolves the promise with
 * `{stdout, stderr}`). Standard promisify resolves with the first non-error
 * callback arg, so the mock has to deliver one object containing both streams.
 */
function mockFfprobe(stdout: string) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
    if (typeof cb === 'function') {
      cb(null, { stdout, stderr: '' });
    }
  });
}

function mockFfprobeMissing() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
    const err: NodeJS.ErrnoException = new Error('spawn ffprobe ENOENT');
    err.code = 'ENOENT';
    if (typeof cb === 'function') {
      cb(err);
    }
  });
}

describe('exifWallClockToUtc', () => {
  it('re-interprets a local wall-clock as the same wall-clock in UTC (host-TZ-independent)', () => {
    const local = new Date(2021, 4, 1, 12, 30, 15);
    expect(exifWallClockToUtc(local).toISOString()).toBe('2021-05-01T12:30:15.000Z');
  });

  it('preserves midnight without rolling the date', () => {
    const local = new Date(2020, 0, 1, 0, 0, 0);
    expect(exifWallClockToUtc(local).toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('parseExifOffsetMinutes', () => {
  it('parses signed HH:MM offsets into minutes east of UTC', () => {
    expect(parseExifOffsetMinutes('+02:00')).toBe(120);
    expect(parseExifOffsetMinutes('-05:30')).toBe(-330);
    expect(parseExifOffsetMinutes('+00:00')).toBe(0);
  });

  it('accepts the colon-less variant some writers emit, and Z', () => {
    expect(parseExifOffsetMinutes('+0200')).toBe(120);
    expect(parseExifOffsetMinutes('Z')).toBe(0);
  });

  it('returns null for absent or junk values (callers keep the floating wall-clock)', () => {
    expect(parseExifOffsetMinutes(undefined)).toBeNull();
    expect(parseExifOffsetMinutes(null)).toBeNull();
    expect(parseExifOffsetMinutes('')).toBeNull();
    expect(parseExifOffsetMinutes('UTC+2')).toBeNull();
    expect(parseExifOffsetMinutes(120)).toBeNull();
    // Beyond ±14:00 is no real timezone.
    expect(parseExifOffsetMinutes('+15:00')).toBeNull();
  });
});

describe('parseExifSafe', () => {
  it('rejects after the timeout when exifr hangs — so one corrupt HEIC cannot wedge the walk', async () => {
    parseMock.mockReturnValue(new Promise(() => {}));
    await expect(parseExifSafe('bad.heic', { gps: true }, 50)).rejects.toThrow('exif-timeout');
  });

  it('returns the parse result when exifr settles in time', async () => {
    parseMock.mockResolvedValue({ latitude: 1, longitude: 2 });
    await expect(parseExifSafe('ok.jpg', { gps: true }, 500)).resolves.toEqual({ latitude: 1, longitude: 2 });
  });
});

describe('extractCameraFields', () => {
  it('returns {} for null/undefined (no-op when EXIF was unreadable)', () => {
    expect(extractCameraFields(null)).toEqual({});
    expect(extractCameraFields(undefined)).toEqual({});
  });

  it('maps camera/lens/exposure tags to the downstream metadata vocabulary', () => {
    const exif = {
      Make: 'Apple',
      Model: 'iPhone 15 Pro',
      LensModel: 'iPhone 15 Pro back triple camera 6.86mm f/1.78',
      FNumber: 1.78,
      ExposureTime: 0.025,
      ISO: 100,
      FocalLength: 6.86,
      Orientation: 6,
    };
    expect(extractCameraFields(exif)).toEqual({
      Make: 'Apple',
      Model: 'iPhone 15 Pro',
      Lens: 'iPhone 15 Pro back triple camera 6.86mm f/1.78',
      'F-Number': 1.78,
      'Exposure Time': 0.025,
      ISO: 100,
      'Focal Length': 6.86,
      Orientation: 6,
    });
  });

  it('omits absent/blank/NaN fields rather than emitting nulls', () => {
    // A real EXIF read often has partial coverage — e.g. a phone shot has
    // Make/Model but no LensModel; a film scan has none of these. The helper
    // must drop missing keys so callers can spread it into a metadata bag
    // without stomping pre-existing values with nulls.
    const exif = { Make: '', Model: 'X100V', FNumber: NaN, ISO: 200 };
    expect(extractCameraFields(exif)).toEqual({ Model: 'X100V', ISO: 200 });
  });

  it('trims whitespace from string tags', () => {
    expect(extractCameraFields({ Make: '  Sony  ', Model: 'ILCE-7M3\n' })).toEqual({
      Make: 'Sony',
      Model: 'ILCE-7M3',
    });
  });

  it('rejects wrong-typed numeric tags (a string ISO from a corrupted file does not poison the bag)', () => {
    const exif: Record<string, unknown> = { ISO: '100', FNumber: '1.8', FocalLength: 'auto' };
    expect(extractCameraFields(exif)).toEqual({});
  });
});

describe('extractVideoFields', () => {
  it('returns {} for null/undefined (no-op when exifr returned nothing)', () => {
    expect(extractVideoFields(null)).toEqual({});
    expect(extractVideoFields(undefined)).toEqual({});
  });

  it('maps QuickTime fields to the downstream metadata vocabulary', () => {
    const exif = {
      Duration: 12.34,
      VideoFrameRate: 29.97,
      ImageWidth: 1920,
      ImageHeight: 1080,
      CompressorID: 'hvc1',
    };
    expect(extractVideoFields(exif)).toEqual({
      Duration: 12.34,
      'Frame Rate': 29.97,
      Width: 1920,
      Height: 1080,
      Codec: 'hvc1',
    });
  });

  it('falls back from CompressorID to CompressorName when only the human label is present', () => {
    expect(extractVideoFields({ CompressorName: 'H.264 / AVC' })).toEqual({ Codec: 'H.264 / AVC' });
  });

  it('rejects zero/negative Duration as a non-signal sentinel', () => {
    // Some malformed .mov files report Duration=0 in the moov atom; treat as
    // missing rather than emitting a misleading "0 second video".
    expect(extractVideoFields({ Duration: 0 })).toEqual({});
    expect(extractVideoFields({ Duration: -1 })).toEqual({});
  });

  it('omits absent or wrong-typed fields rather than emitting nulls', () => {
    const exif: Record<string, unknown> = { Duration: '12.34', VideoFrameRate: NaN, ImageWidth: 1920 };
    expect(extractVideoFields(exif)).toEqual({ Width: 1920 });
  });
});

describe('extractImageExif', () => {
  beforeEach(() => {
    parseMock.mockReset();
    mockExecFile.mockReset();
    _resetFfprobeAvailability();
  });

  it('extracts camera/lens/exposure tags + GPS + UTC-re-interpreted capture time', async () => {
    parseMock.mockResolvedValue({
      DateTimeOriginal: new Date(2023, 5, 15, 14, 30, 0),
      latitude: 37.7749,
      longitude: -122.4194,
      Make: 'Apple',
      Model: 'iPhone 14 Pro',
      LensModel: 'iPhone 14 Pro back triple camera 6.86mm f/1.78',
      FNumber: 1.78,
      ExposureTime: 0.005,
      ISO: 100,
      FocalLength: 6.86,
    });
    const result = await extractImageExif('any.jpg');
    expect(result.timestamp?.toISOString()).toBe('2023-06-15T14:30:00.000Z');
    expect(result.location).toEqual({ latitude: 37.7749, longitude: -122.4194 });
    expect(result.metadata.Make).toBe('Apple');
    expect(result.metadata.Model).toBe('iPhone 14 Pro');
    expect(result.metadata.Lens).toMatch(/iPhone 14 Pro back/);
    expect(result.metadata['F-Number']).toBe(1.78);
    expect(result.metadata.ISO).toBe(100);
  });

  it('applies OffsetTimeOriginal to DateTimeOriginal to recover the true instant', async () => {
    // Wall-clock 12:00 recorded at +02:00 is 10:00Z — matching what a Takeout
    // sidecar's photoTakenTime says for the same photo.
    parseMock.mockResolvedValue({
      DateTimeOriginal: new Date(2023, 2, 30, 12, 0, 0),
      OffsetTimeOriginal: '+02:00',
    });
    const result = await extractImageExif('any.jpg');
    expect(result.timestamp?.toISOString()).toBe('2023-03-30T10:00:00.000Z');
  });

  it('pairs each datetime tag with ITS OWN offset tag (CreateDate ↔ OffsetTimeDigitized)', async () => {
    // No DateTimeOriginal: CreateDate wins, so OffsetTimeDigitized applies and
    // the unrelated OffsetTimeOriginal must be ignored.
    parseMock.mockResolvedValue({
      CreateDate: new Date(2023, 2, 30, 12, 0, 0),
      OffsetTimeOriginal: '-08:00',
      OffsetTimeDigitized: '+02:00',
    });
    const result = await extractImageExif('any.jpg');
    expect(result.timestamp?.toISOString()).toBe('2023-03-30T10:00:00.000Z');
  });

  it('keeps the wall-clock-as-UTC convention when the paired offset tag is absent or junk', async () => {
    parseMock.mockResolvedValue({
      DateTimeOriginal: new Date(2023, 2, 30, 12, 0, 0),
      // ModifyDate's OffsetTime is present but must NOT apply to DateTimeOriginal.
      OffsetTime: '+05:00',
    });
    const result = await extractImageExif('any.jpg');
    expect(result.timestamp?.toISOString()).toBe('2023-03-30T12:00:00.000Z');
  });

  it('surfaces GPSHPositioningError as accuracyMeters when the camera recorded one', async () => {
    parseMock.mockResolvedValue({
      latitude: 1,
      longitude: 2,
      GPSHPositioningError: 8.5,
    });
    const result = await extractImageExif('any.jpg');
    expect(result.accuracyMeters).toBe(8.5);
  });

  it('rejects null-island GPS (0,0 sentinel) and skips Lens when absent', async () => {
    parseMock.mockResolvedValue({ latitude: 0, longitude: 0, Make: 'Canon' });
    const result = await extractImageExif('any.jpg');
    expect(result.location).toBeUndefined();
    expect(result.metadata.Lens).toBeUndefined();
    expect(result.metadata.Make).toBe('Canon');
  });

  it('returns an empty result (never throws) when exifr fails', async () => {
    parseMock.mockRejectedValue(new Error('bad bytes'));
    const result = await extractImageExif('broken.jpg');
    expect(result).toEqual({ metadata: {} });
  });
});

describe('extractVideoMetadata', () => {
  beforeEach(() => {
    parseMock.mockReset();
    mockExecFile.mockReset();
    _resetFfprobeAvailability();
  });

  it('parses ffprobe output: duration, width/height, codec, framerate, bitrate, audio codec', async () => {
    mockFfprobe(
      JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'hevc',
            width: 3840,
            height: 2160,
            avg_frame_rate: '30000/1001',
            r_frame_rate: '30/1',
            bit_rate: '50000000',
          },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
        format: {
          duration: '12.345',
          bit_rate: '51000000',
          tags: {
            creation_time: '2023-08-01T18:30:00.000000Z',
            'com.apple.quicktime.location.ISO6709': '+34.0441-118.2598+020.000/',
            'com.apple.quicktime.make': 'Apple',
            'com.apple.quicktime.model': 'iPhone 14 Pro',
          },
        },
      }),
    );
    const result = await extractVideoMetadata('video.mov');
    expect(result.metadata.Duration).toBe(12.345);
    expect(result.metadata.Width).toBe(3840);
    expect(result.metadata.Height).toBe(2160);
    expect(result.metadata.Codec).toBe('hevc');
    expect(result.metadata['Frame Rate'] as number).toBeCloseTo(29.97, 2);
    expect(result.metadata.Bitrate).toBe(51000000);
    expect(result.metadata.AudioCodec).toBe('aac');
    expect(result.metadata.Make).toBe('Apple');
    expect(result.metadata.Model).toBe('iPhone 14 Pro');
    // QuickTime creation_time is real ISO 8601 (TZ-aware) — pass through, not re-interpreted.
    expect(result.timestamp?.toISOString()).toBe('2023-08-01T18:30:00.000Z');
    expect(result.location).toEqual({ latitude: 34.0441, longitude: -118.2598 });
  });

  it('rejects null-island Apple GPS (+0+0)', async () => {
    mockFfprobe(
      JSON.stringify({
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }],
        format: { duration: '1', tags: { 'com.apple.quicktime.location.ISO6709': '+0+0/' } },
      }),
    );
    const result = await extractVideoMetadata('video.mov');
    expect(result.location).toBeUndefined();
    expect(result.metadata.Width).toBe(1920);
  });

  it('falls back to exifr when ffprobe is not installed', async () => {
    mockFfprobeMissing();
    parseMock.mockResolvedValue({
      CreateDate: new Date(2022, 3, 1, 9, 0, 0),
      ImageWidth: 1280,
      ImageHeight: 720,
      Duration: 5.5,
    });
    const result = await extractVideoMetadata('video.mp4');
    expect(result.timestamp?.toISOString()).toBe('2022-04-01T09:00:00.000Z');
    expect(result.metadata.Width).toBe(1280);
    expect(result.metadata.Duration).toBe(5.5);
    // Codec is unknowable without ffprobe — must be absent, not made up.
    expect(result.metadata.Codec).toBeUndefined();
  });

  it('returns an empty result when neither ffprobe nor exifr produces anything', async () => {
    mockFfprobeMissing();
    parseMock.mockResolvedValue(undefined);
    const result = await extractVideoMetadata('mystery.mkv');
    expect(result).toEqual({ metadata: {} });
  });

  it('survives ffprobe stdout that is not valid JSON', async () => {
    mockFfprobe('not json');
    parseMock.mockResolvedValue(undefined);
    const result = await extractVideoMetadata('weird.mov');
    expect(result.metadata).toEqual({});
  });
});

describe('extractMediaMetadata dispatcher', () => {
  beforeEach(() => {
    parseMock.mockReset();
    mockExecFile.mockReset();
    _resetFfprobeAvailability();
  });

  it('routes image/* through the EXIF path (not ffprobe)', async () => {
    parseMock.mockResolvedValue({ Make: 'Canon' });
    const result = await extractMediaMetadata('photo.jpg', 'image/jpeg');
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(result.metadata.Make).toBe('Canon');
  });

  it('routes video/* through ffprobe', async () => {
    mockFfprobe(
      JSON.stringify({
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }],
        format: { duration: '10', tags: {} },
      }),
    );
    const result = await extractMediaMetadata('clip.mp4', 'video/mp4');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(result.metadata.Codec).toBe('h264');
  });

  it('returns an empty result for unknown MIME', async () => {
    const result = await extractMediaMetadata('blob.bin', undefined);
    expect(result).toEqual({ metadata: {} });
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(parseMock).not.toHaveBeenCalled();
  });
});
