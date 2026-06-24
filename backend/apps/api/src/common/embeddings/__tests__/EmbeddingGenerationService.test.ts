/* eslint-disable @typescript-eslint/no-explicit-any */
import { EmbeddingGenerationService } from '../services/EmbeddingGenerationService';

// Capture the embed mock so each test can assert how many HTTP calls were made
// and with what batched `input`.
const embedMock = jest.fn();

jest.mock('ollama', () => ({
  Ollama: jest.fn().mockImplementation(() => ({
    embed: embedMock,
  })),
}));

/**
 * Default embed implementation: returns one deterministic 2-d vector per input,
 * mirroring Ollama's array-input `/api/embed` contract (embeddings: number[][]).
 */
function defaultEmbedImpl({ input }: { input: string | string[] }) {
  const inputs = Array.isArray(input) ? input : [input];

  return Promise.resolve({
    model: 'nomic-embed-text',
    embeddings: inputs.map((text: string) => [text.length, 1]),
    total_duration: 0,
    load_duration: 0,
    prompt_eval_count: inputs.length,
  });
}

function makeService(): EmbeddingGenerationService {
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;

  return new EmbeddingGenerationService(logger);
}

describe('EmbeddingGenerationService', () => {
  beforeEach(() => {
    embedMock.mockReset();
    embedMock.mockImplementation(defaultEmbedImpl);
  });

  describe('generateEmbeddings (explicit batch API)', () => {
    it('returns one vector per input, in order', async () => {
      const service = makeService();

      const vectors = await service.generateEmbeddings(['aa', 'bbbb', 'c']);

      expect(vectors).toEqual([
        [2, 1],
        [4, 1],
        [1, 1],
      ]);
    });

    it('sends a single batched call for inputs under the batch size', async () => {
      const service = makeService();

      await service.generateEmbeddings(['one', 'two', 'three']);

      expect(embedMock).toHaveBeenCalledTimes(1);
      expect(embedMock).toHaveBeenCalledWith(expect.objectContaining({ input: ['one', 'two', 'three'] }));
    });

    it('chunks inputs that exceed the batch size into multiple calls', async () => {
      const service = makeService();
      // default CI_EMBED_BATCH_SIZE is 32; 70 inputs => 3 chunks (32 + 32 + 6)
      const inputs = Array.from({ length: 70 }, (_, i) => `text-${i}`);

      const vectors = await service.generateEmbeddings(inputs);

      expect(vectors).toHaveLength(70);
      expect(embedMock).toHaveBeenCalledTimes(3);
      const batchSizes = embedMock.mock.calls.map((c) => (c[0].input as string[]).length);
      expect(batchSizes).toEqual([32, 32, 6]);
    });

    it('returns [] without calling Ollama for an empty input list', async () => {
      const service = makeService();

      const vectors = await service.generateEmbeddings([]);

      expect(vectors).toEqual([]);
      expect(embedMock).not.toHaveBeenCalled();
    });

    it('throws if Ollama returns the wrong number of vectors', async () => {
      embedMock.mockResolvedValueOnce({ embeddings: [[1, 2]] }); // 1 vec for 2 inputs
      const service = makeService();

      await expect(service.generateEmbeddings(['a', 'b'])).rejects.toThrow(/1 vectors for 2 inputs/);
    });
  });

  describe('generateEmbedding (coalesced single-text path)', () => {
    it('coalesces concurrent single-text calls into ONE batched Ollama call', async () => {
      const service = makeService();

      const [v1, v2, v3] = await Promise.all([
        service.generateEmbedding('alpha'),
        service.generateEmbedding('bravo'),
        service.generateEmbedding('charlie'),
      ]);

      // Three logical calls, but only one HTTP request thanks to coalescing.
      expect(embedMock).toHaveBeenCalledTimes(1);
      expect(embedMock.mock.calls[0][0].input).toEqual(['alpha', 'bravo', 'charlie']);
      expect(v1).toEqual([5, 1]);
      expect(v2).toEqual([5, 1]);
      expect(v3).toEqual([7, 1]);
    });

    it('rejects empty text without hitting Ollama', async () => {
      const service = makeService();

      await expect(service.generateEmbedding('   ')).rejects.toThrow(/empty/i);
      expect(embedMock).not.toHaveBeenCalled();
    });

    it('rejects the matching caller when Ollama returns an empty vector', async () => {
      embedMock.mockResolvedValueOnce({ embeddings: [[]] });
      const service = makeService();

      await expect(service.generateEmbedding('lonely')).rejects.toThrow(/empty embedding vector/i);
    });

    it('propagates Ollama errors to all coalesced callers', async () => {
      embedMock.mockRejectedValueOnce(new Error('ollama down'));
      const service = makeService();

      const results = await Promise.allSettled([
        service.generateEmbedding('a-real-text'),
        service.generateEmbedding('another-real-text'),
      ]);

      expect(results.every((r) => r.status === 'rejected')).toBe(true);
    });
  });

  describe('generateEmbeddingString', () => {
    it('formats the vector as a pgvector string literal', async () => {
      const service = makeService();

      const str = await service.generateEmbeddingString('hello');

      expect(str).toBe('[5,1]');
    });
  });
});
