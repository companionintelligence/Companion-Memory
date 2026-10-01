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

/**
 * What a bare llama-server says about itself on `GET /props`: the window it loaded the model with
 * (`default_generation_settings.n_ctx`) and whether it took a vision projector (`modalities.vision`).
 * One model per server, so the answer applies to whatever the server lists. Lemonade does not
 * proxy the route (its `/props` is the web UI), vLLM has none; both yield `null`.
 */
export interface ServerProps {
  contextTokens: number | null;
  vision: boolean | null;
}

/** `null` unless the payload is llama-server's `/props` shape — an HTML page or another JSON is not. */
export function serverPropsFromPayload(payload: unknown): ServerProps | null {
  if (payload == null || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const settings = record.default_generation_settings;
  const modalities = record.modalities;

  if (
    (settings == null || typeof settings !== 'object') &&
    (modalities == null || typeof modalities !== 'object')
  ) {
    return null;
  }

  const vision = (modalities as Record<string, unknown> | undefined)?.vision;

  return {
    contextTokens: positiveInteger((settings as Record<string, unknown> | undefined)?.n_ctx),
    vision: typeof vision === 'boolean' ? vision : null,
  };
}

/**
 * Names that belong only to models that read images, for a backend that publishes no capability
 * (vLLM, Ollama's `/v1`, a llama-server whose `/props` could not be read). Short and specific: a
 * false positive sends every image-description job to a model that answers with prose about a
 * missing image, so a family that ships both sighted and blind sizes (Gemma 3's 1B) is left out
 * unless the name says which.
 */
const VISION_NAME =
  /(^|[^a-z])(vl|llava|pixtral|molmo|idefics|internvl|minicpm-v|smolvlm)([^a-z]|$)|vision|gemma-?3-(4b|12b|27b)|gemma-?4/i;

/**
 * Whether a served model reads images, from the best signal the backend gives: a `vision` label
 * where labels are published at all (Lemonade — a labelled row without it cannot see), else the
 * server's own `/props` (llama-server), else the name. Before 2026-09-30 only the label counted, so
 * vLLM and llama.cpp reported no vision for any model.
 */
export function servedModelSeesImages(
  model: { id: string; labels?: string[] },
  props?: ServerProps | null,
): boolean {
  const labels = model.labels ?? [];

  if (labels.length > 0) {
    return labels.includes('vision');
  }

  if (props?.vision != null) {
    return props.vision;
  }

  return VISION_NAME.test(model.id);
}

/** `nomic-embed-text` and `nomic-embed-text:latest` name the same Ollama model. */
function sameBaseModel(a: string, b: string): boolean {
  const base = (id: string) => (id.endsWith(':latest') ? id.slice(0, -':latest'.length) : id);

  return base(a) === base(b);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
