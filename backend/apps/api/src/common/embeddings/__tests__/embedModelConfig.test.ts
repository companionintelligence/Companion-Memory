/*
 * The embedding model this process asks for: an operator's CI_EMBED_MODEL, else the embedder CI-Hub
 * handed out as LLM_DEFAULT_EMBEDDING_MODEL when it is one this index can take, else the default.
 * Before 2026-09-29 the handout was ignored, so a Lemonade-only node asked its engine for
 * `nomic-embed-text` — a name Lemonade does not serve — and every embed failed.
 */
function loadEmbeddingModel(env: Record<string, string | undefined>): { model: string; errors: string[] } {
  const saved = {
    CI_EMBED_MODEL: process.env.CI_EMBED_MODEL,
    LLM_DEFAULT_EMBEDDING_MODEL: process.env.LLM_DEFAULT_EMBEDDING_MODEL,
  };
  const errors: string[] = [];
  const spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    let model = '';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      model = require('../../../configuration').default.embedding.model;
    });

    return { model, errors };
  } finally {
    spy.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('embedding model resolution', () => {
  it("uses the embedder CI-Hub installed on Lemonade (nomic v1.5 under Lemonade's name)", () => {
    expect(
      loadEmbeddingModel({
        CI_EMBED_MODEL: undefined,
        LLM_DEFAULT_EMBEDDING_MODEL: 'nomic-embed-text-v1.5-GGUF',
      }).model,
    ).toBe('nomic-embed-text-v1.5-GGUF');
  });

  it("refuses an older Hub's Lemonade v1 handout, with an error line, instead of failing boot", () => {
    const { model, errors } = loadEmbeddingModel({
      CI_EMBED_MODEL: undefined,
      LLM_DEFAULT_EMBEDDING_MODEL: 'nomic-embed-text-v1-GGUF',
    });
    expect(model).toBe('nomic-embed-text');
    expect(errors.join('\n')).toMatch(/nomic-embed-text-v1-GGUF has no declared embedding generation/);
  });

  it("lets an operator's CI_EMBED_MODEL win over the handout", () => {
    expect(
      loadEmbeddingModel({
        CI_EMBED_MODEL: 'nomic-embed-text:v1.5',
        LLM_DEFAULT_EMBEDDING_MODEL: 'nomic-embed-text-v1.5-GGUF',
      }).model,
    ).toBe('nomic-embed-text:v1.5');
  });
});
