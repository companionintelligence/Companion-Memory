import { embedStageVersion } from '../../../domains/pipeline/stages/index/embedVersion';
import { EMBED_MODEL_GENERATIONS, canonicalEmbedModel, isDeclaredEmbedModel } from '../embedModelIdentity';

/*
 * The embed stage version is keyed on the MODEL, not on an engine's name for it. Ollama serves
 * nomic-embed-text v1.5 as `nomic-embed-text`; CI-Hub installs the same F16 weights into Lemonade as
 * `nomic-embed-text-v1.5-GGUF` (measured 2026-09-29: cosine 0.99996–0.99998 between the two engines'
 * vectors for the same text). Lemonade's own `nomic-embed-text-v1-GGUF` is v1 — cosine 0.69–0.73,
 * a different vector space — and must never share v1.5's generation.
 */
describe('embedModelIdentity', () => {
  it("folds every engine's name for nomic v1.5 onto the declared model", () => {
    for (const name of [
      'nomic-embed-text',
      'nomic-embed-text:latest',
      'nomic-embed-text:v1.5',
      'nomic-embed-text-v1.5-GGUF',
      'user.nomic-embed-text-v1.5-GGUF',
    ]) {
      expect(canonicalEmbedModel(name)).toBe('nomic-embed-text');
      expect(isDeclaredEmbedModel(name)).toBe(true);
      expect(embedStageVersion(name, 768)).toBe(embedStageVersion('nomic-embed-text', 768));
    }
  });

  it("does not treat Lemonade's nomic v1 as the same model", () => {
    expect(canonicalEmbedModel('nomic-embed-text-v1-GGUF')).toBe('nomic-embed-text-v1-GGUF');
    expect(isDeclaredEmbedModel('nomic-embed-text-v1-GGUF')).toBe(false);
    expect(() => embedStageVersion('nomic-embed-text-v1-GGUF', 768)).toThrow(
      /no embedding generation declared/i,
    );
  });

  it('keeps an unknown name as it is, and checks declarations at the given dimension', () => {
    expect(canonicalEmbedModel('  mxbai-embed-large ')).toBe('mxbai-embed-large');
    expect(isDeclaredEmbedModel('nomic-embed-text', 1024)).toBe(false);
    expect(
      isDeclaredEmbedModel('mxbai-embed-large', 1024, {
        ...EMBED_MODEL_GENERATIONS,
        'mxbai-embed-large@1024': 2,
      }),
    ).toBe(true);
  });
});
