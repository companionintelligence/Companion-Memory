import { takeNativePhoto } from '@ci/common';

import {
  captureWithSystemCamera,
  pickDocuments,
  pickFromUserDevice,
  pickMediaFromLibrary,
} from './pickPhotosFromLibrary';

export type CameraMode = 'photo' | 'video';

/**
 * Still photo: native Capacitor Camera (system UI) when the plugin is present,
 * otherwise the browser/WKWebView capture file input.
 */
export async function capturePhoto(): Promise<File | null> {
  const native = await takeNativePhoto();

  if (native) {
    return native;
  }

  const files = await captureWithSystemCamera('photo');

  return files[0] ?? null;
}

/** System camera video (UIImagePicker / HTML capture). Capacitor Camera has no video API. */
export async function captureVideo(): Promise<File | null> {
  const files = await captureWithSystemCamera('video');

  return files[0] ?? null;
}

/**
 * One camera for stills and clips. Called without a mode — how Capture opens —
 * it accepts both media types, so the system camera keeps its own Photo/Video
 * toggle and we do not have to guess. A mode jumps straight to that side of it.
 *
 * On web there is no system camera: `capture` is ignored and this degrades to
 * the file picker filtered to photos and video.
 */
export async function captureFromCamera(mode?: CameraMode): Promise<File | null> {
  if (mode === 'photo') {
    return capturePhoto();
  }

  if (mode === 'video') {
    return captureVideo();
  }

  const files = await pickFromUserDevice({
    accept: 'image/*,video/*',
    multiple: false,
    capture: 'environment',
  });

  return files[0] ?? null;
}

export async function chooseFromLibrary(): Promise<File[]> {
  return pickMediaFromLibrary({ multiple: true });
}

export async function chooseFiles(): Promise<File[]> {
  return pickDocuments({ multiple: true });
}
