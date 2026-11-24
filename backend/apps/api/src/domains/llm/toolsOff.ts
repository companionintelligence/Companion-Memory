/**
 * A chat turn that runs WITHOUT tools: what it is told, and what it must not pretend.
 *
 * A turn has no tools when the person switched the wrench off, or when the model
 * they picked does not support them at all (`gemma3:1b`, the compiled-in default,
 * is one — see `OllamaService.resolveModel`). The base prompt used to describe
 * the same toolbox either way ("call knowledge.search", "use the available
 * tools"), so a tool-less model did what a language model does with a role it
 * cannot play: it wrote the call out as text (`tool_code` blocks, "Brief.list"),
 * invented the result ("You bought oat milk on 2026-09-28"), and — worst — told
 * the person a write had happened ("I've added Buy Oat Milk to the planned
 * tasks") when nothing had, because there was nothing to run it.
 *
 * Three layers, in descending order of how much they can be trusted:
 *
 *  1. {@link isWriteRequest} — a deterministic refusal, in code, for the plainly
 *     imperative requests ("add a task…", "remember that…", "forget…"). It does
 *     not ask the model, because a 1B model answers "Okay." to "Forget everything
 *     about my Amazon orders" no matter what its prompt says.
 *  2. {@link TOOLS_OFF_BASE_PROMPT} / {@link TOOLS_OFF_GUARD} /
 *     {@link TOOLS_OFF_TURN_REMINDER} — a prompt that describes the turn as it is:
 *     no tools, answer about the person only from what they were given, never claim
 *     an action. Prose; a model may still ignore it.
 *  3. The composer's own notice in the web app, which says the same thing to the
 *     person in words no model can overrule.
 *
 * No worked examples, and no internal names. The first version of layer 2 taught
 * the answer by example ("User: What tasks do I have?" / "Assistant: From your
 * Plan: the open to-dos listed in the Live snapshots.") and a 1B model copied the
 * example back, internal name and all, as the answer to the very question it
 * showed — while "What is my favorite cuisine?" went wrong more often than it had
 * without the guard. It also repeated whatever words it was given for the data
 * ("Live snapshots", "the content between the markers"). So the rules are stated
 * plainly, the data is named the way the person would name it (their Plan, their
 * Brief), and the one sentence that is quoted — the refusal, which has to come out
 * the same way every time — is only ever asked for in answer to a request to
 * change something.
 *
 * Plain template literals with no interpolation, on purpose: they are the whole
 * contract, and a prompt experiment can lift them out of this file verbatim.
 */

/**
 * The system prompt's head for a tool-less turn. The tools-on prompt in
 * `ChatTurnService.buildSystemPrompt` stays byte-for-byte what it was; this is
 * its twin with every tool name and every "use the tools" instruction removed,
 * so nothing in it describes a capability the turn does not have — and with the
 * pointer from each surface to the section of the same name in the message that
 * carries the data, in place of the name we use for that message ourselves.
 */
export const TOOLS_OFF_BASE_PROMPT = `You are Companion, a helpful AI assistant with information about the user.
You are designed to take in various data sources that the user connects you to (via Sources) and help the user with not just everyday tasks, but with their pursuit of happiness.

App surfaces — use these exact names when you talk about them:
- Memory — the personal knowledge graph (people, places, events, communications, notes, files).
- Plan — to-dos / tasks (open work, due dates, scheduled items). Answer from the Plan section; say "Plan", not "todo list".
- Forecast — predicted rest-of-day / tomorrow. Answer from the Forecast section.
- Brief — inbox of actions, insights, and summaries. Answer from the Brief section.
- Schedule — calendar and planned blocks.
- Sources — connected services and imports that feed Memory.
- Saved Searches — stored Memory queries.
- Chat — this conversation. The user can attach files or images; look at attachments when present.
- Stats / Jobs — analytics and background work.

Communication style:
- Be natural, warm, and conversational
- Keep responses concise unless detail is requested
- If you're not sure about something, say so
- Please be as concise as possible while still conveying substantially all information relevant to any question.
- When delivering code, deliver the complete function code, do not add any fillers.`;

/**
 * The last thing in a tool-less system prompt, AFTER the user's context: what
 * cannot be done in this chat, and what must never be written. How to answer is
 * in {@link TOOLS_OFF_TURN_REMINDER}, which sits right before the question.
 *
 * Position matters for a model this small: the same rules placed up front were
 * followed measurably less often than when they were the final block before the
 * conversation. The wording is neutral about the cause — tools are "not
 * available here" whether the person turned them off or the model has none.
 */
export const TOOLS_OFF_GUARD = `You cannot take actions in this chat: you cannot add, change, complete, delete, schedule, send, save, remember or forget anything, and you cannot search Memory, open files or read the calendar. Never write tool names, function calls, code blocks or JSON.`;

/**
 * Heading of the in-flight message that carries the person's Plan, Forecast, Brief
 * and stats on a tool-less turn. The tools-on heading ({@link TURN_CONTEXT_HEADER},
 * "Live snapshots") is our own word for that message, and a model this small repeats
 * whatever words it is given; this one says only what the message is.
 *
 * Deliberately generic. A heading that listed the sections ("Your Plan, Forecast,
 * Brief and stats") read to the model as the whole of what it knew, and it answered
 * "capital of Italy" and "favorite cuisine" worse for it.
 */
export const TOOLS_OFF_TURN_CONTEXT_HEADER = '# Information about the user, current as of this question';

/**
 * Appended to the in-flight message of a tool-less turn, after the fence, so it is
 * the last text the model reads before the question. Our own words, not data —
 * which is why it sits outside the untrusted region.
 *
 * It carries the answering rules rather than the system prompt because that is
 * where a 1B model obeys them: what to do with a request to change something,
 * what to do when the answer is not in what it was given, and that a question
 * about the world is still just a question.
 */
export const TOOLS_OFF_TURN_REMINDER =
  'You cannot do things in this chat. If you are asked to add, save, note, set, remind, schedule, send, remember, forget, change or delete anything, reply: "I can\'t do that here: tools aren\'t available in this chat, so nothing was changed." Otherwise answer from the information above. If the answer about the user is not there, say you do not have it; questions about the world you can answer normally.';

/**
 * What the person is told when they ask a tool-less turn to change something.
 * Accurate for both causes (a model without tools, or the wrench switched off),
 * and it ends on the way out of a false positive: {@link isWriteRequest} is a
 * heuristic, and "just ask it as a question" costs nothing when it misfires.
 */
export const TOOLS_OFF_REFUSAL =
  "I can't do that here: tools aren't available in this chat (the selected model doesn't support them, or they're switched off), so I can't add, change, save, forget or delete anything, and nothing was changed. Choose a model with the wrench icon and switch tools on, then ask again. If you only wanted to talk it through, ask it as a question.";

/** The kinds of thing a person can create or change by asking: a to-do, a reminder, a note, an event. */
const OBJECT = String.raw`(?:tasks?|to-?dos?|reminders?|notes?|events?|appointments?|meetings?|alarms?)`;

/** What "delete my …" can name: the user's own records, not a sentence they pasted in. */
const RECORD = String.raw`(?:tasks?|to-?dos?|reminders?|notes?|events?|appointments?|meetings?|memor(?:y|ies)|messages?|emails?|photos?|files?|contacts?|orders?|purchases?|history|data|records?|entries|entry)`;

/**
 * Up to two words between an article and its noun — "a new dentist reminder",
 * "the oat milk task" — and never a preposition or the possessive that would turn
 * the noun into the object of a longer phrase ("a list of my tasks").
 */
const MODIFIERS = String.raw`(?:(?!(?:of|for|about|with|from|to|my|the|list)\b)[\w'-]+\s+){0,2}?`;

/** Where "add it to my …" puts something. */
const PLACE = String.raw`(?:(?:my|the)\s+)?(?:plan|to-?do(?:s|\s+list)?|tasks?|task\s+list|lists?|calendar|schedule|agenda|notes?|memory|reminders?|shopping\s+list)`;

/**
 * Politeness and framing that can come before the verb: "please", "hey,", "could
 * you …", "I'd like you to …", "go ahead and …". Stripped so the patterns below
 * can anchor on the verb itself.
 */
const LEAD_IN = new RegExp(
  String.raw`^(?:(?:hey|hi|hello|ok|okay|so|and|also|now|then|please|pls|kindly)\b[,.!]?\s+)*` +
    String.raw`(?:(?:(?:can|could|would|will)\s+you|i(?:'d|\s+would)\s+like\s+you\s+to|i\s+(?:want|need)\s+you\s+to|you\s+(?:should|can|could|need\s+to)|go\s+ahead\s+and|let's|let\s+us)\s+(?:please\s+)?)?`,
);

/**
 * Requests to CHANGE the user's data, anchored at the start of the message.
 *
 * Deliberately narrow, and deliberately a backstop: each pattern needs the verb
 * AND an object a person can actually create or change, so "What tasks do I
 * have?", "Remember when we went to Lisbon?", "Add up my spending" and "Make a
 * list of my tasks" all pass through to the model. A request this misses is not
 * lost — it falls through to a model that has been told it has no tools, and the
 * composer says so as well. A request this wrongly catches gets
 * {@link TOOLS_OFF_REFUSAL}, which tells the person how to rephrase.
 */
const WRITE_REQUESTS: readonly RegExp[] = [
  // "Add a task to buy milk", "Create a reminder for Friday", "Schedule a meeting with Sam".
  new RegExp(
    String.raw`^(?:add|create|make|new|set\s+up|schedule|book)\s+(?:me\s+)?(?:an?|another|the|my|new)\s+${MODIFIERS}${OBJECT}\b(?!\s+(?:list|summary|overview|template)\b)`,
  ),
  // "Add milk to my shopping list", "Put the dentist on my calendar", "Save this to my notes".
  new RegExp(String.raw`^(?:add|put|save|log|store|stick)\s+.{1,80}?\s(?:to|on|in|into)\s+${PLACE}\b`),
  // "Remember that my locker code is 42", "Remember to call mom", "Note that I prefer tea".
  /^(?:remember|memori[sz]e|note)\s+(?:that|to|this)\b/,
  /^remember:/,
  // "Remind me to call mom", "Remind me in ten minutes".
  /^remind\s+me\s+(?:to|that|at|in|on|tomorrow|tonight|every|next)\b/,
  // "Forget everything about my Amazon orders", "Forget my address".
  /^forget\s+(?:everything|all|anything|my|the|that|this|those|these|about\s+(?:my|the|all|everything))\b/,
  // "Delete my notes about Paris", "Remove the task", "Erase everything". The object has to be one of
  // the user's records: "remove the adjectives from this sentence" is writing help, not a deletion.
  /^(?:delete|remove|erase|wipe|trash|discard)\s+(?:everything|all\b)/,
  new RegExp(
    String.raw`^(?:delete|remove|erase|wipe|trash|discard)\s+(?:my|the|this|that|these|those|every|any)\s+${MODIFIERS}${RECORD}\b`,
  ),
  // "Mark the oat milk task as done".
  /^(?:mark|check\s+off|tick\s+off)\s+.{1,80}?\s(?:as\s+)?(?:done|complete|completed|finished|resolved)\b/,
  // "Complete the dentist task".
  new RegExp(
    String.raw`^(?:complete|finish)\s+(?:my|the|this|that)\s+${MODIFIERS}(?:task|to-?do|reminder)\b`,
  ),
  // "Cancel my 3pm meeting", "Move the dentist appointment to Friday", "Rename the passport task".
  new RegExp(
    String.raw`^(?:reschedule|postpone|snooze|cancel|rename|update|edit|move|change)\s+(?:my|the|this|that)\s+${MODIFIERS}${OBJECT}\b`,
  ),
  // "Change the due date for…", "Update the title of…".
  /^(?:change|update|set)\s+(?:my|the)\s+(?:due\s+date|deadline|title)\b/,
];

/**
 * Whether the message is plainly an instruction to change something — add, save,
 * remember, forget, delete, reschedule — which a tool-less turn cannot do.
 *
 * Only the START of the message counts. Matching anywhere would turn every
 * question that mentions a task into a refusal.
 */
export function isWriteRequest(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }

  const normalized = text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const request = normalized.replace(LEAD_IN, '');

  return WRITE_REQUESTS.some((pattern) => pattern.test(request));
}
