import { FrameDecoder } from './FrameDecoder';
import { type Decoded } from './types';

interface Options {
  stream: ReadableStream<Uint8Array>;
  onChunk: (chunk: Decoded) => boolean | Promise<boolean>;
  onFinished?: () => void;
  onError?: (error: unknown) => void;
  /** Maximum number of retry attempts. Set to Infinity for unlimited retries. */
  retries?: number;
  /** Initial delay in milliseconds. */
  initialDelay?: number;
  /** The factor by which the delay increases after each retry (e.g., 2 for doubling). */
  factor?: number;
  /** The maximum delay in milliseconds. */
  maxDelay?: number;
}

export function createStreamProcessor({
  stream,
  onChunk,
  onFinished,
  onError,
  retries = 10,
  initialDelay = 10,
  factor = 2,
  maxDelay = 5000,
}: Options) {
  const decoder = new FrameDecoder();
  const abortController = new AbortController();

  const start = async () => {
    try {
      const frameTransformer = new TransformStream<Uint8Array, Decoded>({
        transform(chunk, controller) {
          const decodedFrames = decoder.push(chunk);

          for (const frame of decodedFrames) {
            controller.enqueue(frame);
          }
        },
        flush(controller) {
          if (decoder.hasBufferedData()) {
            controller.error(new Error('Stream ended with an incomplete frame'));
          }
        },
      });

      const frameStream = stream.pipeThrough(frameTransformer);
      const reader = frameStream.getReader();

      let chunkToReplay: Decoded | null = null;
      let retryCount = 0;
      let currentDelay = initialDelay;

      while (true) {
        if (abortController.signal.aborted) {
          await reader.cancel('Aborted by new stream or unmount');

          break;
        }

        let currentChunk: Decoded;

        if (chunkToReplay) {
          currentChunk = chunkToReplay;
        } else {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          currentChunk = value;
        }

        const success = await onChunk(currentChunk);

        if (success === false) {
          retryCount++;

          if (retryCount > retries) {
            throw new Error(`Processing failed for a chunk after ${retries} retries`);
          }

          console.warn(`Chunk processing failed. Retrying in ${currentDelay}ms (Attempt ${retryCount})`);

          await new Promise((resolve) => setTimeout(resolve, currentDelay));

          currentDelay = Math.min(maxDelay, currentDelay * factor);
          chunkToReplay = currentChunk;
        } else {
          chunkToReplay = null;
          retryCount = 0;
          currentDelay = initialDelay;
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        onError?.(err);
      }
    } finally {
      onFinished?.();
    }
  };

  return {
    start,
    cancel: () => abortController.abort(),
  };
}
