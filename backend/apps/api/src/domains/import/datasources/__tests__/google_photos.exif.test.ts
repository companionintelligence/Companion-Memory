import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Mock exifr so the camera-side EXIF read on the (fake) JPEG bytes is
// deterministic, mirroring apple_photos.exif.test.ts.
jest.mock('exifr', () => ({ __esModule: true, default: { parse: jest.fn() } }));
import exifr from 'exifr';

import { allDataSources } from '../registry';
import type { DirEntry } from '../registry';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

import '../google_photos';

const parseMock = exifr.parse as unknown as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

function getImporter() {
  const ds = allDataSources().find((d) => d.name === 'google_photos');
  if (!ds?.newFileImporter) {
    throw new Error('missing importer');
  }

  return ds.newFileImporter();
}

/**
 * A directory with one JPEG + a matching Takeout-style sidecar. Exercises the
 * `processFile` path (not the album-root path), which is the one that reads
 * binary EXIF to recover camera context the sidecar omits.
 */
async function dirWithOneSidecaredJpeg() {
  const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'gp-exif-'));
  const img = path.join(dir, 'IMG_0001.jpg');
  await fs.promises.writeFile(img, Buffer.from([0xff, 0xd8, 0xff]));
  await fs.promises.writeFile(
    `${img}.json`,
    JSON.stringify({
      photoTakenTime: { timestamp: '1620000000' },
      geoData: { latitude: 37.7, longitude: -122.4 },
      title: 'IMG_0001.jpg',
    }),
  );

  return dir;
}

async function runImport(dir: string) {
  const pipeline: EmittedGraph[] = [];
  await getImporter().fileImport(
    {},
    { filename: dir, fullPath: dir } as DirEntry,
    {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams,
  );

  return pipeline.map((g) => g.item);
}

describe('google_photos camera-side EXIF', () => {
  beforeEach(() => parseMock.mockReset());

  it('merges Make/Model/Lens/F-Number/Exposure Time/ISO/Focal Length/Orientation onto item.metadata alongside the sidecar fields', async () => {
    // Vocabulary mirrors generic.ts (see common/media/exif.ts extractCameraFields):
    //   LensModel -> 'Lens', FNumber -> 'F-Number', ExposureTime -> 'Exposure Time',
    //   FocalLength -> 'Focal Length'. Make/Model/ISO/Orientation pass through.
    parseMock.mockResolvedValue({
      Make: 'FUJIFILM',
      Model: 'X100V',
      LensModel: '23mm f/2',
      FNumber: 2,
      ExposureTime: 0.001,
      ISO: 400,
      FocalLength: 23,
      Orientation: 1,
    });
    const [item] = await runImport(await dirWithOneSidecaredJpeg());
    expect(item.metadata.Source).toBe('Google Photos');
    expect(item.metadata.Make).toBe('FUJIFILM');
    expect(item.metadata.Model).toBe('X100V');
    expect(item.metadata.Lens).toBe('23mm f/2');
    expect(item.metadata['F-Number']).toBe(2);
    expect(item.metadata['Exposure Time']).toBe(0.001);
    expect(item.metadata.ISO).toBe(400);
    expect(item.metadata['Focal Length']).toBe(23);
    expect(item.metadata.Orientation).toBe(1);
    // Sidecar-provided fields must survive the EXIF merge.
    expect(item.location).toEqual({ latitude: 37.7, longitude: -122.4 });
    expect(item.metadata.Title).toBe('IMG_0001.jpg');
  });

  it('leaves no camera keys on metadata when exifr returns undefined (stripped JPEG, video, etc.)', async () => {
    parseMock.mockResolvedValue(undefined);
    const [item] = await runImport(await dirWithOneSidecaredJpeg());
    expect(item.metadata.Make).toBeUndefined();
    expect(item.metadata.Model).toBeUndefined();
    expect(item.metadata.Lens).toBeUndefined();
    // Sidecar fields still land.
    expect(item.metadata.Title).toBe('IMG_0001.jpg');
    expect(item.location).toEqual({ latitude: 37.7, longitude: -122.4 });
  });
});
