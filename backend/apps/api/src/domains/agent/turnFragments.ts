import { createHash } from 'crypto';

/**
 * Pure half of the chat-turn memory producer: what a turn becomes, and what it
 * is called. Kept out of the service so the distillation rules can be pinned
 * without a repository, a queue or a clock.
 */

/** `source` stamped on every fragment this producer writes. */
export const TURN_FRAGMENT_SOURCE = 'chat-turn';

/**
 * Namespace mixed into the fragment id so a chat-turn fragment can never
 * collide with a deterministic id minted elsewhere from the same identifiers.
 */
const TURN_FRAGMENT_NAMESPACE = 'agent-memory:chat-turn';

export interface TurnFragmentIdInput {
  userId: string;
  threadId: string;
  /** `ci.messages.parent_message_id` — the user message that opened the turn. */
  promptMessageId: string;
}

/**
 * Deterministic, replay-safe id for one turn's fragment.
 *
 * Same construction as `MemoryController.createAgentTurnMessageId` (sha256 →
 * UUIDv8): a crash between "read the turn" and "write the fragment" replays
 * into the same row instead of minting a second one, so no watermark table is
 * needed. Deliberately NOT keyed on the turn's text — a tool-calling turn
 * writes several assistant rows against one prompt, and keying on content
 * would let a re-read that sees one more row write a second fragment for the
 * same turn.
 */
export function turnFragmentId(input: TurnFragmentIdInput): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        namespace: TURN_FRAGMENT_NAMESPACE,
        userId: input.userId,
        threadId: input.threadId,
        promptMessageId: input.promptMessageId,
      }),
    )
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));

  // UUID v8 uses custom deterministic bytes while preserving UUID shape.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');

  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join(
    '-',
  );
}

/**
 * Removes the reasoning block `persistedAssistantContent` wraps a turn in.
 *
 * Chain-of-thought is not memory: it is the model talking to itself, it is
 * frequently wrong on the way to a right answer, and embedding it puts that
 * wrongness into the recall channel as if it were something the user said. An
 * unterminated `<think>` (a cancelled stream) drops everything after the
 * opening tag, which is what the chat UI shows for the same row.
 */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, ' ')
    .replace(/<think>[\s\S]*$/, ' ')
    .trim();
}

function clamp(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trimEnd()}…`;
}

export interface TurnFragmentInput {
  /** `ci.threads.title`, when the summarizer has already named the thread. */
  threadTitle?: string | null;
  /** The user message that opened the turn. */
  prompt: string;
  /** Assistant messages produced for that prompt, in order. */
  replies: string[];
  maxSideChars: number;
  minFragmentChars: number;
}

export interface TurnFragment {
  title: string;
  content: string;
}

/**
 * Distils one turn into the fragment text.
 *
 * No LLM call: the fragment is the RAW turn, which is exactly the contract
 * `POST /memory/write` already writes for Hermes, and
 * `MemoryCompactionService` is the thing that runs the extraction model over
 * it. A second model call here would put a per-turn Ollama request on the same
 * 1–2 slot GPU as interactive chat, to produce the input for a model call that
 * is about to happen anyway.
 *
 * Returns null when the turn is not worth remembering: an empty reply (a
 * cancelled turn, or one whose only output was tool calls) or a pleasantry
 * under `minFragmentChars` — either would otherwise dominate a vector search
 * over a lightly used appliance.
 */
export function buildTurnFragment(input: TurnFragmentInput): TurnFragment | null {
  const prompt = stripThinking(input.prompt);
  const reply = input.replies
    .map((text) => stripThinking(text))
    .filter((text) => text.length > 0)
    .join('\n\n');

  if (prompt.length === 0 || reply.length === 0) {
    return null;
  }

  if (prompt.length + reply.length < input.minFragmentChars) {
    return null;
  }

  const threadTitle = input.threadTitle?.trim();

  return {
    title: threadTitle ? `[${TURN_FRAGMENT_SOURCE}] ${clamp(threadTitle, 120)}` : `[${TURN_FRAGMENT_SOURCE}]`,
    content: [
      `User: ${clamp(prompt, input.maxSideChars)}`,
      `Assistant: ${clamp(reply, input.maxSideChars)}`,
    ].join('\n'),
  };
}
