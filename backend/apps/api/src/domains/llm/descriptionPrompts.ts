import { z } from 'zod/v3';

/**
 * The prompts and the parser behind every file description the appliance
 * writes: one photo, one frame of a video, and the merge that turns a video's
 * frame descriptions into a single label. Pure, so each prompt is unit-tested
 * as text and the listener that sends them stays about orchestration.
 */

/**
 * The base prompt. The description rule asks for two short sentences: the
 * one-paragraph form it replaced wrote roughly twice the tokens for detail the
 * search index rarely needs (see IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS).
 * `buildPrompt` appends the capture context, when there is
 * one, right before the schema — measured 2026-09-16 (see
 * CaptureContextService): without it a Palermo cathedral was titled after
 * five different cities across six runs; with one context line, "Palermo
 * Cathedral" four times out of four.
 *
 * The naming rule is unconditional. It is what stops the model guessing a
 * city, a landmark or a brand from a silhouette; the context line is what
 * lets it name one it could not otherwise know.
 */
const PROMPT_HEAD = `
  Analyze this image and provide a title and description.
  You are a JSON generator. Output ONLY valid JSON.
  Do not include any conversational text, markdown formatting, or explanations.

  The title should be a short, specific label suitable for indexing and search (e.g. "Red KitchenAid Stand Mixer", "Family at Beach Sunset").
  The description should be at most two short sentences (under 40 words) naming the main subject, notable details, and setting.
  Name a specific place, building, brand or product only when it is legible or unmistakable in the image, or when the context below makes it clear; otherwise describe it without naming it.
`;

const PROMPT_TAIL = `
  Return a JSON object with the following schema:
  {
    "title": "Brief, indexable title for the image",
    "description": "At most two short sentences describing what is depicted"
  }
`;

/** Which still of a video the model is looking at, for {@link buildFramePrompt}. */
export interface FramePosition {
  /** Zero-based. */
  index: number;
  count: number;
  atSeconds: number;
  durationSeconds: number | null;
}

/** A photo's prompt: the rules, the optional context line, the schema. */
export function buildPrompt(captureContext: string | null): string {
  return captureContext == null
    ? `${PROMPT_HEAD}${PROMPT_TAIL}`
    : `${PROMPT_HEAD}\n  ${captureContext}\n${PROMPT_TAIL}`;
}

/**
 * One frame's prompt: the photo prompt with a preface saying it is a still
 * from a video and where. The model is asked for this frame alone — the
 * merge is where the clip becomes one thing — so a model that has never seen
 * a video (most of them, through Ollama) is asked nothing it cannot do.
 */
export function buildFramePrompt(captureContext: string | null, frame: FramePosition): string {
  const length = frame.durationSeconds == null ? '' : ` about ${formatSeconds(frame.durationSeconds)} long`;
  const preface =
    `\n  This image is frame ${frame.index + 1} of ${frame.count}, taken in order from one video${length}, ` +
    `at ${formatSeconds(frame.atSeconds)}. Describe only what this frame shows; the frames are combined afterwards.\n`;

  return `${preface}${buildPrompt(captureContext)}`;
}

/** What one frame's description contributes to the merge. */
export interface FrameDescription {
  atSeconds: number;
  title: string;
  description: string;
}

/**
 * The merge: text only, so any model can run it, vision or not. It reads the
 * frame descriptions in time order and writes one label for the clip. The
 * rules mirror the photo prompt's, restated for a video: say what happens
 * over the clip, keep the two-sentence budget, and name a place or brand only
 * when a frame description already did or the context line makes it clear —
 * the frame pass saw the pixels; this pass must not invent past it.
 */
export function buildMergePrompt(
  frames: readonly FrameDescription[],
  durationSeconds: number | null,
  captureContext: string | null,
): string {
  const length = durationSeconds == null ? '' : `, about ${formatSeconds(durationSeconds)} long`;
  const lines = frames
    .map((frame) => `  - at ${formatSeconds(frame.atSeconds)}: ${frame.title} — ${frame.description}`)
    .join('\n');
  const context = captureContext == null ? '' : `\n  ${captureContext}\n`;

  return `
  Below are descriptions of ${frames.length} frames taken in order from one video${length}.
  Combine them into a title and description of the whole video.
  You are a JSON generator. Output ONLY valid JSON.
  Do not include any conversational text, markdown formatting, or explanations.

  Frames, in time order:
${lines}

  The title should be a short, specific label for the video, suitable for indexing and search.
  The description should be at most two short sentences (under 40 words) saying what the video shows and what happens or changes over it.
  Write about the video, not about frames: never mention frames, stills, samples or timestamps.
  Name a specific place, building, brand or product only when a frame description names it, or when the context below makes it clear; otherwise describe it without naming it.
${context}
  Return a JSON object with the following schema:
  {
    "title": "Brief, indexable title for the video",
    "description": "At most two short sentences describing what the video shows"
  }
`;
}

/**
 * Output ceiling for one description. With the two-sentence rule (2026-09-16)
 * measured outputs land at 50-70 tokens, down from 110-160 for the old "one
 * concise paragraph" — that halved decode time (2.8 s → 1.3 s per photo on
 * qwen3.8:27b) at the cost of secondary detail only; titles were unchanged.
 * The cap stays well above that so a model that ignores the rule cannot run a
 * queue job to the backend's default length limit.
 */
export const IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS = 256;

/**
 * Stills per video, at most. Each is a full vision call (about 8.5 s on a
 * 27B, measured 2026-09-16 for photos), so six frames plus the text merge is
 * under a minute a clip and a 500-clip library is an evening on the
 * background lane. Fewer frames lose the middle of a long clip; more mostly
 * repeat it. A short clip yields fewer regardless — see `frameTimestamps`.
 */
export const VIDEO_DESCRIPTION_MAX_FRAMES = 6;

const DescriptionSchema = z.object({
  title: z.string(),
  description: z.string(),
});

export type FileDescription = z.infer<typeof DescriptionSchema>;

/**
 * The model's answer as a label, or why it is not one. Tolerates a code fence
 * and prose around the object, since a small model asked for JSON alone still
 * sometimes wraps it.
 */
export function parseDescription(
  content: string,
): { ok: true; value: FileDescription } | { ok: false; reason: string } {
  let jsonStr = content.replace(/```json\n?|\n?```/g, '').trim();

  const firstOpen = jsonStr.indexOf('{');
  const lastClose = jsonStr.lastIndexOf('}');

  if (firstOpen !== -1 && lastClose !== -1) {
    jsonStr = jsonStr.substring(firstOpen, lastClose + 1);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonStr);
  } catch (error) {
    return { ok: false, reason: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  const result = DescriptionSchema.safeParse(parsed);

  return result.success ? { ok: true, value: result.data } : { ok: false, reason: result.error.message };
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);

  return `${minutes}m${String(rest).padStart(2, '0')}s`;
}
