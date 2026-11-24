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

/**
 * The photo library, narrowed to the selected kind. The system picker filters
 * on the input's MIME types, so asking for `image/*` alone shows photos only
 * and `video/*` alone shows clips only; the old `image/*,video/*` showed both
 * under either tab. No kind keeps the combined picker.
 */
export async function chooseFromLibrary(kind?: CameraMode): Promise<File[]> {
  if (kind === 'photo') {
    return pickFromUserDevice({ accept: 'image/*', multiple: true });
  }

  if (kind === 'video') {
    return pickFromUserDevice({ accept: 'video/*', multiple: true });
  }

  return pickMediaFromLibrary({ multiple: true });
}

export async function chooseFiles(): Promise<File[]> {
  return pickDocuments({ multiple: true });
}

/**
 * Audio files from the device. There is no "audio library" the way there is a
 * photo library, so this is the system file picker narrowed to audio types —
 * the phone's document picker on Android and iOS, not the photos picker.
 */
export async function chooseAudioFiles(): Promise<File[]> {
  return pickFromUserDevice({ accept: 'audio/*', multiple: true });
}
