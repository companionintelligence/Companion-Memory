/**
 * What an OpenAI-compatible backend says about the models it serves, read from its `/v1/models`
 * rows. The OpenAI shape itself carries only `id`; everything else here is an extension some
 * backends add and others don't, so every field is optional and a missing one means "unknown",
 * never "no".
 *
 * - `labels`: Lemonade tags each row with what the model does (`chat`, `vision`, `embeddings`,
 *   `reranking`, `transcription`, `tts`, `image`, …). CI-Hub's pool passes rows through whole, so
 *   the tags survive the proxy.
 * - Context size: Lemonade reports the window it loads the model with as `context_length` (its
 *   saved `ctx_size`, else its default); vLLM reports `max_model_len`. llama.cpp's own server lists
 *   only the training window (`meta.n_ctx_train`), which is not what it loaded, so it is not read.
 */
export interface ServedModel {
  id: string;
  labels: string[];
  /** The window the backend runs this model with, when it says; `null` when it doesn't. */
  contextTokens: number | null;
}

export function servedModelFromRow(row: { id: string } & Record<string, unknown>): ServedModel {
  const labels = row.labels;

  return {
    id: row.id,
    labels: Array.isArray(labels) ? labels.filter((label): label is string => typeof label === 'string') : [],
    contextTokens: positiveInteger(row.context_length) ?? positiveInteger(row.max_model_len),
  };
}

/**
 * Tags that name a job other than chat. A model carrying one of these and no `chat` tag cannot
 * answer a chat completion. Every chat model in Lemonade's registry carries `chat` (including the
 * speech-in Omni models, which are `chat,vision,chat-transcription`), and a user-registered chat
 * model carries only `custom`, so it is kept.
 */
const NON_CHAT_LABELS = new Set([
  '3d',
  'audio-generation',
  'classification',
  'edit',
  'embedding',
  'embeddings',
  'image',
  'realtime-transcription',
  'rerank',
  'reranking',
  'transcription',
  'tts',
  'upscaling',
  'voice-design',
]);

/**
 * Name fragments of the model families that serve a non-chat endpoint, for backends that publish
 * no tags (vLLM, Ollama and its `/v1`). Deliberately short: a false match hides a real chat model,
 * so only names that never belong to one are here.
 */
const NON_CHAT_NAME = /embed|rerank|whisper|kokoro|minilm|(^|[^a-z0-9])(tts|bge)([^a-z0-9]|$)/i;

/**
 * Whether a served model can answer a chat request. Tags decide when the backend publishes them;
 * otherwise the name does. `embeddingModel` (the configured embedder) is always excluded, whatever
 * it is called.
 */
export function isChatCapableModel(
  model: { id: string; labels?: string[] },
  embeddingModel?: string,
): boolean {
  if (embeddingModel && sameBaseModel(model.id, embeddingModel)) {
    return false;
  }

  const labels = model.labels ?? [];

  if (labels.includes('chat')) {
    return true;
  }

  if (labels.some((label) => NON_CHAT_LABELS.has(label))) {
    return false;
  }

  return !NON_CHAT_NAME.test(model.id);
}

/** `nomic-embed-text` and `nomic-embed-text:latest` name the same Ollama model. */
function sameBaseModel(a: string, b: string): boolean {
  const base = (id: string) => (id.endsWith(':latest') ? id.slice(0, -':latest'.length) : id);

  return base(a) === base(b);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
