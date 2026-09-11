import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { vipsCliAvailable } from '../../../__tests__/support/vipsCli';
import { VipsDecodeError, VipsService } from '../VipsService';

const FIXTURES = join(__dirname, '__fixtures__');
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

// Every fixture is a solid 64×40 image. The orientation-6 JPEG is the same
// pixels tagged "rotate 90° clockwise", so it DISPLAYS as 40×64; the HEIC was
// written by pillow-heif and is the format sharp's bundled libvips could not
// decode — the reason this service exists.
const describeIfVips = vipsCliAvailable() ? describe : describe.skip;

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeService() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new VipsService(makeLogger() as any);
}

const JPEG_SOI = Buffer.from([0xff, 0xd8]);

describeIfVips('VipsService.probe', () => {
  it.each([
    ['64x40.jpg', 'jpegload'],
    ['64x40.png', 'pngload'],
    ['64x40.heic', 'heifload'],
  ])('reads stored dimensions and the loader from %s', async (name, loader) => {
    await expect(makeService().probe(fixture(name))).resolves.toEqual({
      width: 64,
      height: 40,
      orientation: 1,
      loader,
    });
  });

  it('reports the EXIF orientation tag without applying it (stored dimensions stay 64×40)', async () => {
    await expect(makeService().probe(fixture('64x40-orientation-6.jpg'))).resolves.toMatchObject({
      width: 64,
      height: 40,
      orientation: 6,
    });
  });

  it('rejects bytes libvips does not recognise with VipsDecodeError', async () => {
    await expect(makeService().probe(Buffer.from('not an image'))).rejects.toBeInstanceOf(VipsDecodeError);
  });
});

describeIfVips('VipsService.renderJpeg', () => {
  it('applies EXIF orientation so a rotate-90 source comes out upright (40×64) and tag-free', async () => {
    const rendered = await makeService().renderJpeg(fixture('64x40-orientation-6.jpg'), {
      maxDimension: 300,
    });

    expect(rendered).toMatchObject({ width: 40, height: 64 });
    expect(rendered.buffer.subarray(0, 2)).toEqual(JPEG_SOI);
    // Rotation was baked into the pixels and the tag stripped, so a viewer
    // that honours EXIF does not rotate it a second time.
    await expect(makeService().probe(rendered.buffer)).resolves.toMatchObject({
      width: 40,
      height: 64,
      orientation: 1,
    });
  });

  it('decodes HEIC to JPEG', async () => {
    const rendered = await makeService().renderJpeg(fixture('64x40.heic'), { maxDimension: 300 });

    expect(rendered).toMatchObject({ width: 64, height: 40 });
    expect(rendered.buffer.subarray(0, 2)).toEqual(JPEG_SOI);
  });

  it('fits inside maxDimension and keeps the aspect ratio', async () => {
    await expect(makeService().renderJpeg(fixture('64x40.png'), { maxDimension: 32 })).resolves.toMatchObject(
      {
        width: 32,
        height: 20,
      },
    );
  });

  it('never upscales a source smaller than maxDimension', async () => {
    await expect(
      makeService().renderJpeg(fixture('64x40.jpg'), { maxDimension: 1500 }),
    ).resolves.toMatchObject({
      width: 64,
      height: 40,
    });
  });

  it('rejects undecodable bytes with VipsDecodeError, not a generic error', async () => {
    await expect(
      makeService().renderJpeg(Buffer.from('not an image'), { maxDimension: 300 }),
    ).rejects.toBeInstanceOf(VipsDecodeError);
  });
});
