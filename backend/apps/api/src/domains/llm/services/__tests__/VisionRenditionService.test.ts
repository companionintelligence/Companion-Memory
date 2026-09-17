import { VipsDecodeError, VipsUnavailableError } from '@ci/domains/files';

import { VISION_RENDITION_MAX_DIMENSION } from '../../constants';
import { VisionRenditionService } from '../VisionRenditionService';

const ORIGINAL = Buffer.from('original-bytes');
const PREVIEW = Buffer.from('preview-bytes');
const RENDERED = Buffer.from('rendered-jpeg');
const context = { userId: 'user-1' } as never;

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeService(renderJpeg: jest.Mock) {
  const fileService = {
    getFileContent: jest.fn(async (_ctx: unknown, key: string) => (key === 'orig-key' ? ORIGINAL : PREVIEW)),
  };
  const vips = { renderJpeg };
  const logger = makeLogger();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new VisionRenditionService(fileService as any, vips as any, logger as any);

  return { service, fileService, logger };
}

const original = { id: 'file-1', key: 'orig-key', contentType: 'image/heic' };

describe('VisionRenditionService.render', () => {
  it('renders the ORIGINAL down to the vision cap, not the thumbnail', async () => {
    const renderJpeg = jest.fn(async () => ({ buffer: RENDERED, width: 1125, height: 1500 }));
    const { service, fileService } = makeService(renderJpeg);

    await expect(service.render(context, original, 'preview-key')).resolves.toEqual({
      jpeg: RENDERED,
      source: 'original',
      // The same download, handed back so the EXIF read (capture context) needs no second fetch.
      original: ORIGINAL,
    });

    expect(fileService.getFileContent).toHaveBeenCalledTimes(1);
    expect(fileService.getFileContent).toHaveBeenCalledWith(context, 'orig-key');
    expect(renderJpeg).toHaveBeenCalledWith(ORIGINAL, {
      maxDimension: VISION_RENDITION_MAX_DIMENSION,
      quality: expect.any(Number),
    });
  });

  it('falls back to the preview bytes when the original cannot be decoded', async () => {
    const renderJpeg = jest.fn(async () => {
      throw new VipsDecodeError('is not a known file format');
    });
    const { service, logger } = makeService(renderJpeg);

    await expect(service.render(context, original, 'preview-key')).resolves.toEqual({
      jpeg: PREVIEW,
      source: 'preview',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Original could not be rendered for vision; falling back to preview',
      expect.objectContaining({ fileId: 'file-1', hasFallback: true }),
    );
  });

  it('returns null when the original cannot be decoded and there is no preview to fall back to', async () => {
    const renderJpeg = jest.fn(async () => {
      throw new VipsDecodeError('is not a known file format');
    });
    const { service } = makeService(renderJpeg);

    await expect(service.render(context, original)).resolves.toBeNull();
  });

  it('uses the preview directly when the original has no stored bytes', async () => {
    const renderJpeg = jest.fn();
    const { service } = makeService(renderJpeg);

    await expect(service.render(context, { ...original, key: null }, 'preview-key')).resolves.toEqual({
      jpeg: PREVIEW,
      source: 'preview',
    });
    expect(renderJpeg).not.toHaveBeenCalled();
  });

  // A missing decoder is an environment fault. Swallowing it here would have
  // every description quietly made from a 300px thumbnail, which is exactly
  // the behaviour this service replaced.
  it('propagates a missing-vips error instead of falling back', async () => {
    const renderJpeg = jest.fn(async () => {
      throw new VipsUnavailableError('vips not found on PATH');
    });
    const { service } = makeService(renderJpeg);

    await expect(service.render(context, original, 'preview-key')).rejects.toBeInstanceOf(
      VipsUnavailableError,
    );
  });
});
