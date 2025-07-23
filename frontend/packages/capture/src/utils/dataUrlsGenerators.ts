export function getImageDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      return reject(new Error('Provided file is not an image.'));
    }

    const reader = new FileReader();

    reader.addEventListener('error', () => {
      const error = reader.error;

      if (error) {
        reject(new Error(`File reading error: ${error.name} - ${error.message}`));
      } else {
        reject(new Error('An unknown FileReader error occurred.'));
      }
    });

    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('FileReader did not return a string result for Data URL.'));
      }
    });

    reader.addEventListener('abort', () => {
      reject(new Error('File reading was aborted.'));
    });

    try {
      reader.readAsDataURL(file);
    } catch (err) {
      reject(
        new Error(`Failed to initiate file reading: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  });
}

export function getVideoPreviewDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('video/')) {
      return reject(new Error('Provided file is not a video.'));
    }

    const video = document.createElement('video');
    const objectURL = URL.createObjectURL(file);

    video.addEventListener('error', () => {
      if (objectURL) {
        URL.revokeObjectURL(objectURL);
      }

      const mediaError = video.error;
      let errorMessage = 'An unknown video error occurred.';

      if (mediaError) {
        switch (mediaError.code) {
          case MediaError.MEDIA_ERR_ABORTED:
            errorMessage = 'Video loading aborted.';
            break;
          case MediaError.MEDIA_ERR_NETWORK:
            errorMessage = 'Network error during video loading.';
            break;
          case MediaError.MEDIA_ERR_DECODE:
            errorMessage = 'Video decoding error (unsupported format/corrupted).';
            break;
          case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            errorMessage = 'Video source not supported.';
            break;
          default:
            errorMessage = `Video error code: ${mediaError.code}`;
        }
      }

      reject(new Error(errorMessage));
    });

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.src = objectURL;

    video.addEventListener('loadedmetadata', () => {
      video.currentTime = 0;
    });

    video.addEventListener('seeked', () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const ctx = canvas.getContext('2d');

      if (!ctx) {
        if (objectURL) {
          URL.revokeObjectURL(objectURL);
        }

        return reject(new Error('Canvas context not available'));
      }

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      try {
        const dataURL = canvas.toDataURL('image/png');

        resolve(dataURL);
      } catch (e) {
        reject(
          new Error(`Failed to convert canvas to data URL: ${e instanceof Error ? e.message : String(e)}`),
        );
      } finally {
        if (objectURL) {
          URL.revokeObjectURL(objectURL);
        }

        video.remove();
      }
    });
  });
}
