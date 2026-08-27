/**
 * Structural compaction of replayed chat history.
 *
 * Every queued turn reloads the whole thread and re-sends it to the model. A
 * tool round persists three kinds of row (`ChatTurnService.persistTurn`): the
 * assistant row that carries `tool_calls`, one `role: 'tool'` row per call
 * holding `JSON.stringify(result)` — the entire unbounded tool result — and the
 * assistant's prose follow-up. Only the last of those three is worth replaying
 * once the turn is old: the call arguments and their results are the dominant
 * and fastest-growing part of the prompt, and nothing downstream reads them.
 *
 * The tool payload is already treated as droppable elsewhere in the codebase:
 * `infrastructure/powersync/sync-rules.yaml` excludes `tool_calls` /
 * `tool_call_results` from device replication, and the persisted `role: 'tool'`
 * rows carry no `tool_call_id` at all — so the replayed sequence is already
 * non-conformant with the strict OpenAI tool-message schema. Dropping a call
 * and its results *as a pair* makes the sequence more valid, not less.
 *
 * This is a read-time projection: nothing is deleted, no migration is involved,
 * and no model is called. The signal is purely structural, so it costs nothing
 * on the critical path.
 */

/** Newest N turns are replayed byte-for-byte. Generous on purpose: an elided
 * tool result the user then asks about ("what did that search return?") is
 * unanswerable, and this window is the only mitigation. */
export const DEFAULT_FOLD_KEEP_TURNS = 3;

/**
 * The synthetic assistant row {@link ChatTurnService.ensureActionPrompt} mints
 * has an `action:<id>` id and no database row behind it. It must survive the
 * fold verbatim — it is the whole reason the thread has an opening.
 */
const SYNTHETIC_ACTION_ID_PREFIX = 'action:';

/** The shape {@link foldHistory} actually reads. `Message` satisfies it. */
export interface FoldableMessage {
  id: string;
  role: string;
  content: string;
  toolCalls?: Record<string, unknown>[] | null;
}

export function isSyntheticActionMessage(message: FoldableMessage): boolean {
  return message.id.startsWith(SYNTHETIC_ACTION_ID_PREFIX);
}

function elisionNote(count: number): string {
  return `(${count} tool call${count === 1 ? '' : 's'} elided)`;
}

function withContent<T extends FoldableMessage>(message: T, content: string): T {
  return { ...message, content } as T;
}

function annotate(content: string, note: string): string {
  return content?.trim() ? `${content}\n\n${note}` : note;
}

/**
 * Compact one already-closed turn: keep the user message and the assistant's
 * prose, drop the `tool_calls` payload and the `role: 'tool'` rows it produced
 * *together*, and record how many calls went away.
 */
function foldTurn<T extends FoldableMessage>(turn: readonly T[]): T[] {
  const kept: T[] = [];
  let declaredCalls = 0;
  let toolRows = 0;
  let orphanedHost: T | null = null;

  for (const message of turn) {
    if (message.role === 'tool') {
      toolRows += 1;
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      declaredCalls += message.toolCalls.length;

      const stripped = { ...message, toolCalls: null } as T;

      // An assistant row that only announced tool calls has no prose to keep.
      // Hold on to it in case the turn ends without a follow-up, so the note
      // still has somewhere to live.
      if (message.content?.trim()) {
        kept.push(stripped);
      } else if (orphanedHost === null) {
        orphanedHost = stripped;
      }

      continue;
    }

    kept.push(message);
  }

  // Prefer the declared call count; fall back to counting result rows so an
  // assistant row lost to an aborted turn does not silently report zero.
  const elided = declaredCalls > 0 ? declaredCalls : toolRows;

  if (elided === 0) {
    return kept;
  }

  const note = elisionNote(elided);

  for (let index = kept.length - 1; index >= 0; index--) {
    const candidate = kept[index];

    if (candidate.role === 'assistant' && !isSyntheticActionMessage(candidate)) {
      kept[index] = withContent(candidate, annotate(candidate.content, note));

      return kept;
    }
  }

  if (orphanedHost !== null) {
    kept.push(withContent(orphanedHost, note));
  }

  return kept;
}

/**
 * Fold every turn older than the newest `keepTurns` turns. A turn starts at
 * each `role: 'user'` message; anything before the first user message (the
 * synthetic action prompt) is kept verbatim.
 *
 * Pure and allocation-only — safe to call between message load and prompt
 * assembly, which also skips the `fileService.getFileContent` round trip for
 * rows that were about to be elided.
 */
export function foldHistory<T extends FoldableMessage>(
  messages: readonly T[],
  keepTurns: number = DEFAULT_FOLD_KEEP_TURNS,
): T[] {
  const turnStarts: number[] = [];

  for (let index = 0; index < messages.length; index++) {
    if (messages[index].role === 'user') {
      turnStarts.push(index);
    }
  }

  const window = Math.max(0, Math.trunc(keepTurns));

  if (turnStarts.length <= window) {
    return [...messages];
  }

  const verbatimFrom = window === 0 ? messages.length : turnStarts[turnStarts.length - window];
  const folded: T[] = [];

  // Anything before the first user message (the synthetic action prompt) is
  // never folded.
  folded.push(...messages.slice(0, turnStarts[0]));

  for (let index = 0; index < turnStarts.length; index++) {
    const start = turnStarts[index];

    if (start >= verbatimFrom) {
      break;
    }

    const end = Math.min(turnStarts[index + 1] ?? verbatimFrom, verbatimFrom);

    folded.push(...foldTurn(messages.slice(start, end)));
  }

  return [...folded, ...messages.slice(verbatimFrom)];
}
