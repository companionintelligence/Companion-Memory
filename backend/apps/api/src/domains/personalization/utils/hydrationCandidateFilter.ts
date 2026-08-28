const TIME_ONLY = /^\d{1,2}:\d{2}$/;

const SCHEDULE_QUESTION =
  /\b(wake|waking|bed|sleep|workday|work day|start work|end work|go to bed|usual time)\b/i;

const AUTONOMY_QUESTION = /\b(companion do on its own|trust mode|autonom|auto-promote)\b/i;

const SETTING_ANSWER = /\b(auto-promote|high-confidence|hands.?off|cautious|balanced)\b/i;

// There is deliberately NO length or prose test here.
//
// An earlier version skipped anything over 64 characters or six words, on the
// reasoning that a paragraph cannot be a concept label. That was true while the
// answer text WAS the label. ConceptExtractionService now names the concept
// from the question and answer together, so a long answer is no longer a
// problem to avoid — it is the case the extractor exists for. Reinstating a
// length test here would silently drop exactly those answers before the model
// ever sees them.
//
// What remains below is the set of answers that should never become a
// preference edge no matter how they are worded: bare times, autonomy/trust
// settings, and answers to schedule questions. Those are cheap to reject
// without a model call, which is the only reason this filter still runs first.

/** Skip answer text that should not become a graph preference, before any LLM call. */
export function shouldSkipHydrationCandidate(text: string, questionText?: string | null): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }

  if (TIME_ONLY.test(trimmed)) {
    return true;
  }

  if (SETTING_ANSWER.test(trimmed)) {
    return true;
  }

  if (questionText) {
    if (SCHEDULE_QUESTION.test(questionText) || AUTONOMY_QUESTION.test(questionText)) {
      return true;
    }
  }

  return false;
}
