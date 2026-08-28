import { takeNativePhoto } from '@ci/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureFromCamera, capturePhoto, captureVideo, chooseFiles, chooseFromLibrary } from './captureMedia';
import {
  captureWithSystemCamera,
  pickDocuments,
  pickFromUserDevice,
  pickMediaFromLibrary,
} from './pickPhotosFromLibrary';

vi.mock('@ci/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ci/common')>();

  return {
    ...actual,
    takeNativePhoto: vi.fn(),
  };
});

vi.mock('./pickPhotosFromLibrary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pickPhotosFromLibrary')>();

  return {
    ...actual,
    captureWithSystemCamera: vi.fn(),
    pickDocuments: vi.fn(),
    pickFromUserDevice: vi.fn(),
    pickMediaFromLibrary: vi.fn(),
  };
});

const mockedTakeNativePhoto = vi.mocked(takeNativePhoto);
const mockedCaptureWithSystemCamera = vi.mocked(captureWithSystemCamera);
const mockedPickDocuments = vi.mocked(pickDocuments);
const mockedPickFromUserDevice = vi.mocked(pickFromUserDevice);
const mockedPickMediaFromLibrary = vi.mocked(pickMediaFromLibrary);

describe('captureMedia', () => {
  beforeEach(() => {
    mockedTakeNativePhoto.mockReset();
    mockedCaptureWithSystemCamera.mockReset();
    mockedPickDocuments.mockReset();
    mockedPickFromUserDevice.mockReset();
    mockedPickMediaFromLibrary.mockReset();
  });

  it('prefers the native system camera for stills', async () => {
    const photo = new File(['p'], 'IMG.jpg', { type: 'image/jpeg' });
    mockedTakeNativePhoto.mockResolvedValue(photo);

    await expect(capturePhoto()).resolves.toBe(photo);
    expect(mockedCaptureWithSystemCamera).not.toHaveBeenCalled();
  });

  it('falls back to a capture file input when the Camera plugin is absent', async () => {
    const photo = new File(['p'], 'shot.jpg', { type: 'image/jpeg' });
    mockedTakeNativePhoto.mockResolvedValue(null);
    mockedCaptureWithSystemCamera.mockResolvedValue([photo]);

    await expect(capturePhoto()).resolves.toBe(photo);
    expect(mockedCaptureWithSystemCamera).toHaveBeenCalledWith('photo');
  });

  it('records video through the system camera capture input', async () => {
    const video = new File(['v'], 'clip.mov', { type: 'video/quicktime' });
    mockedCaptureWithSystemCamera.mockResolvedValue([video]);

    await expect(captureVideo()).resolves.toBe(video);
    expect(mockedCaptureWithSystemCamera).toHaveBeenCalledWith('video');
  });

  it('opens one camera that accepts stills and clips when no mode is asked for', async () => {
    const clip = new File(['v'], 'IMG.mov', { type: 'video/quicktime' });
    mockedPickFromUserDevice.mockResolvedValue([clip]);

    await expect(captureFromCamera()).resolves.toBe(clip);
    expect(mockedPickFromUserDevice).toHaveBeenCalledWith({
      accept: 'image/*,video/*',
      multiple: false,
      capture: 'environment',
    });
    expect(mockedTakeNativePhoto).not.toHaveBeenCalled();
    expect(mockedCaptureWithSystemCamera).not.toHaveBeenCalled();
  });

  it('returns null when the camera is dismissed without a capture', async () => {
    mockedPickFromUserDevice.mockResolvedValue([]);

    await expect(captureFromCamera()).resolves.toBeNull();
  });

  it('jumps straight into stills or video when the mode bar asks for one', async () => {
    const photo = new File(['p'], 'IMG.jpg', { type: 'image/jpeg' });
    const clip = new File(['v'], 'clip.mov', { type: 'video/quicktime' });
    mockedTakeNativePhoto.mockResolvedValue(photo);
    mockedCaptureWithSystemCamera.mockResolvedValue([clip]);

    await expect(captureFromCamera('photo')).resolves.toBe(photo);
    await expect(captureFromCamera('video')).resolves.toBe(clip);

    expect(mockedCaptureWithSystemCamera).toHaveBeenCalledWith('video');
    expect(mockedPickFromUserDevice).not.toHaveBeenCalled();
  });

  it('library and files pickers stay on the PHPicker / document path', async () => {
    mockedPickMediaFromLibrary.mockResolvedValue([]);
    mockedPickDocuments.mockResolvedValue([]);

    await chooseFromLibrary();
    await chooseFiles();

    expect(mockedPickMediaFromLibrary).toHaveBeenCalledWith({ multiple: true });
    expect(mockedPickDocuments).toHaveBeenCalledWith({ multiple: true });
  });
});
