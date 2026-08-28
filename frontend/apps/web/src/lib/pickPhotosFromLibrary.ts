/**
 * Picker-first media ingest. On iOS WKWebView, a hidden `<input type="file">`
 * with image/video accepts uses PHPickerViewController and does not need
 * `NSPhotoLibraryUsageDescription`. Do not add full-library PhotoKit /
 * READ_MEDIA_* for this path.
 *
 * `capture` opens the system camera (still or video) instead of the library.
 */

export interface PickFromUserDeviceOptions {
  accept?: string;
  multiple?: boolean;
  capture?: boolean | 'user' | 'environment';
}

export function pickFromUserDevice(options?: PickFromUserDeviceOptions): Promise<File[]> {
  const multiple = options?.capture ? false : (options?.multiple ?? true);

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    input.multiple = multiple;

    if (options?.accept) {
      input.accept = options.accept;
    }

    if (options?.capture === true) {
      input.setAttribute('capture', 'environment');
    } else if (options?.capture) {
      input.setAttribute('capture', options.capture);
    }

    const finish = (files: File[]) => {
      input.remove();
      resolve(files);
    };

    input.addEventListener('change', () => {
      finish(Array.from(input.files ?? []));
    });
    input.addEventListener('cancel', () => finish([]));

    document.body.appendChild(input);
    input.click();
  });
}

export function pickPhotosFromLibrary(options?: { multiple?: boolean }): Promise<File[]> {
  return pickFromUserDevice({ accept: 'image/*', multiple: options?.multiple ?? true });
}

export function pickMediaFromLibrary(options?: { multiple?: boolean }): Promise<File[]> {
  return pickFromUserDevice({
    accept: 'image/*,video/*',
    multiple: options?.multiple ?? true,
  });
}

/** Document picker (Files app on iOS) — photos, video, audio, and other files. */
export function pickDocuments(options?: { multiple?: boolean }): Promise<File[]> {
  return pickFromUserDevice({ multiple: options?.multiple ?? true });
}

export function captureWithSystemCamera(kind: 'photo' | 'video'): Promise<File[]> {
  return pickFromUserDevice({
    accept: kind === 'video' ? 'video/*' : 'image/*',
    multiple: false,
    capture: 'environment',
  });
}
