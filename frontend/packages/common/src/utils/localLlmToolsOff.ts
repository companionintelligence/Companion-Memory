/**
 * The deterministic refusal for a tool-less on-device turn.
 *
 * A phone model with no tools bound (the appliance unreachable, intent tools switched off, a model with
 * no tool slot) is told so in its system instruction, but a small model does not reliably obey a prompt:
 * asked "Add a task to buy milk" it answered "I've added that to your tasks", which was false. The
 * appliance's chat has the same backstop in code (`isWriteRequest` in
 * `backend/apps/api/src/domains/llm/toolsOff.ts`); this is that detector, pattern for pattern, so the
 * two surfaces refuse the same requests. Change one with the other, and keep the test cases in step
 * (`frontend/apps/web/src/lib/localLlmToolsOff.test.ts` mirrors the appliance's).
 */

/** The kinds of thing a person can create or change by asking: a to-do, a reminder, a note, an event. */
const OBJECT = String.raw`(?:tasks?|to-?dos?|reminders?|notes?|events?|appointments?|meetings?|alarms?)`;

/** What "delete my …" can name: the user's own records, not a sentence they pasted in. */
const RECORD = String.raw`(?:tasks?|to-?dos?|reminders?|notes?|events?|appointments?|meetings?|memor(?:y|ies)|messages?|emails?|photos?|files?|contacts?|orders?|purchases?|history|data|records?|entries|entry)`;

/**
 * Up to two words between an article and its noun — "a new dentist reminder", "the oat milk task" — and
 * never a preposition or the possessive that would turn the noun into the object of a longer phrase.
 */
const MODIFIERS = String.raw`(?:(?!(?:of|for|about|with|from|to|my|the|list)\b)[\w'-]+\s+){0,2}?`;

/** Where "add it to my …" puts something. */
const PLACE = String.raw`(?:(?:my|the)\s+)?(?:plan|to-?do(?:s|\s+list)?|tasks?|task\s+list|lists?|calendar|schedule|agenda|notes?|memory|reminders?|shopping\s+list)`;

/** Politeness and framing before the verb, stripped so the patterns anchor on the verb itself. */
const LEAD_IN = new RegExp(
  String.raw`^(?:(?:hey|hi|hello|ok|okay|so|and|also|now|then|please|pls|kindly)\b[,.!]?\s+)*` +
    String.raw`(?:(?:(?:can|could|would|will)\s+you|i(?:'d|\s+would)\s+like\s+you\s+to|i\s+(?:want|need)\s+you\s+to|you\s+(?:should|can|could|need\s+to)|go\s+ahead\s+and|let's|let\s+us)\s+(?:please\s+)?)?`,
);

/** Requests to CHANGE the user's data, anchored at the start of the message. Deliberately narrow. */
const WRITE_REQUESTS: readonly RegExp[] = [
  new RegExp(
    String.raw`^(?:add|create|make|new|set\s+up|schedule|book)\s+(?:me\s+)?(?:an?|another|the|my|new)\s+${MODIFIERS}${OBJECT}\b(?!\s+(?:list|summary|overview|template)\b)`,
  ),
  new RegExp(String.raw`^(?:add|put|save|log|store|stick)\s+.{1,80}?\s(?:to|on|in|into)\s+${PLACE}\b`),
  /^(?:remember|memori[sz]e|note)\s+(?:that|to|this)\b/,
  /^remember:/,
  /^remind\s+me\s+(?:to|that|at|in|on|tomorrow|tonight|every|next)\b/,
  /^forget\s+(?:everything|all|anything|my|the|that|this|those|these|about\s+(?:my|the|all|everything))\b/,
  /^(?:delete|remove|erase|wipe|trash|discard)\s+(?:everything|all\b)/,
  new RegExp(
    String.raw`^(?:delete|remove|erase|wipe|trash|discard)\s+(?:my|the|this|that|these|those|every|any)\s+${MODIFIERS}${RECORD}\b`,
  ),
  /^(?:mark|check\s+off|tick\s+off)\s+.{1,80}?\s(?:as\s+)?(?:done|complete|completed|finished|resolved)\b/,
  new RegExp(
    String.raw`^(?:complete|finish)\s+(?:my|the|this|that)\s+${MODIFIERS}(?:task|to-?do|reminder)\b`,
  ),
  new RegExp(
    String.raw`^(?:reschedule|postpone|snooze|cancel|rename|update|edit|move|change)\s+(?:my|the|this|that)\s+${MODIFIERS}${OBJECT}\b`,
  ),
  /^(?:change|update|set)\s+(?:my|the)\s+(?:due\s+date|deadline|title)\b/,
];

/**
 * Whether the message is plainly an instruction to change something — add, save, remember, forget,
 * delete, reschedule — which a tool-less on-device turn cannot do. Only the START of the message counts.
 */
export function isLocalWriteRequest(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }

  const normalized = text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const request = normalized.replace(LEAD_IN, '');

  return WRITE_REQUESTS.some((pattern) => pattern.test(request));
}

/** What the chat shows, in place of a model reply, for a write request on a tool-less on-device turn. */
export const LOCAL_TOOLS_OFF_REFUSAL =
  "I can't do that here: this reply is coming from the model on your phone, which has no tools right now (your Companion can't be reached, or intent tools are switched off), so I can't add, change, save, forget or delete anything, and nothing was changed. Ask again once your Companion is reachable, or if you only wanted to talk it through, ask it as a question.";
