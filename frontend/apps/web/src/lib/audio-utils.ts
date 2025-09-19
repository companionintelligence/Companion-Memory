/**
 * Audio processing utilities for speech services
 */

/**
 * Converts a Blob to base64 string
 * @param blob - The audio blob to convert
 * @returns Promise that resolves to base64 string
 */
export const convertBlobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove the data URL prefix (e.g., "data:audio/webm;base64,")
      const base64 = result.split(',')[1];
      resolve(base64);
    };

    reader.onerror = () => reject(new Error('Failed to read audio file'));
    reader.readAsDataURL(blob);
  });
};

/**
 * Converts base64 string to Blob
 * @param base64Audio - The base64 encoded audio data
 * @param mimeType - The MIME type for the blob (defaults to 'audio/wav')
 * @returns Blob object
 */
export const convertBase64ToBlob = (base64Audio: string, mimeType: string = 'audio/wav'): Blob => {
  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
};

/**
 * Audio processing constants
 */
export const AUDIO_CONSTANTS = {
  MIME_TYPES: {
    WAV: 'audio/wav',
    WEBM: 'audio/webm',
    MP3: 'audio/mpeg',
  },
  TIMEOUT_MS: 120000, // 2 minutes
} as const;
