import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { fetchJson } from '@ci/common';
import { Button, Input, Textarea, ToggleGroup, cn } from '@ci/shadcn';
import { Loader2, NotebookPen, Pencil } from '@ci/shadcn/icons';

import { AnswerProvenance, ProvenanceLegend } from '@/components/AnswerProvenance';
import { useAuth } from '@/hooks';
import type { CatalogueAnswer, CataloguePage } from '@/pages/PromptsPage/catalogue';

import {
  curatedCatalogueUrl,
  indexCuratedAnswers,
  LIFE_DETAIL_THEMES,
  type CuratedAnswers,
  type CuratedCatalogueRow,
  type CuratedQuestion,
} from './lifeDetails';

/** Debounce between the last keystroke and an unanswered row autosaving. */
const ANSWER_AUTOSAVE_DEBOUNCE_MS = 900;

/** Mirrors `createAnswerSchema`/`updateAnswerSchema` on the API, which reject longer text. */
const ANSWER_MAX_LENGTH = 5000;

/**
 * `value`, held to {@link ANSWER_MAX_LENGTH} (or to `previous`'s length, when an
 * answer already longer than the cap is being cut down — the cap must never eat
 * the tail of text the person did not choose to delete).
 *
 * The `maxLength` attribute on the fields is not relied on alone: a QA run saw a
 * 5,003-character run accepted whole on an iPhone (a short run of the same kind
 * stops at the attribute on iOS Safari, so what let that one through is not
 * established). The cap is also applied to the value the field reports, whatever
 * put the text there, so nothing over it is ever autosaved or sent.
 * A surrogate pair is never left half-cut: a lone half of an emoji is not text.
 */
function clampAnswer(value: string, previous = ''): string {
  const limit = Math.max(ANSWER_MAX_LENGTH, previous.length);

  if (value.length <= limit) {
    return value;
  }

  const cut = value.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);

  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Tailwind's `max-sm`: below it each theme's grid collapses to a single column. */
const STACKED_QUERY = '(width < 40rem)';

/**
 * Whether the rows are stacked (question above answer), i.e. a phone. Read at
 * first render and kept current, so the provenance badge is rendered once, in
 * the place that suits the layout, rather than twice with one hidden.
 */
function useStacked(): boolean {
  const [stacked, setStacked] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(STACKED_QUERY).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }

    const query = window.matchMedia(STACKED_QUERY);
    const update = () => setStacked(query.matches);

    update();
    query.addEventListener?.('change', update);

    return () => query.removeEventListener?.('change', update);
  }, []);

  return stacked;
}

/**
 * Both cells of one row, side by side in the theme's shared grid.
 *
 * The wrapper is `display: contents` on purpose: the row needs to exist in the
 * DOM (to key, to scope a test, to carry `data-question-key`) but must NOT be a
 * grid item, or every row would become its own two-column grid and the columns
 * would re-measure per row instead of lining up down the section. With
 * `contents` the two cells are promoted into the theme grid, so one column
 * width is resolved for all of a theme's questions at once — which is what
 * makes Q and A read as columns rather than as independent flex lines.
 *
 * Borders live on the cells, not the wrapper (a `contents` box paints nothing).
 * On a narrow viewport the grid collapses to one column and the cells stack, so
 * the question's own rule is dropped there — otherwise every question would be
 * separated from its own answer by a divider.
 */
function Row({
  question,
  status,
  children,
}: {
  question: CuratedQuestion;
  /** The answer's provenance badge, when the rows are stacked. */
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="contents" data-question-key={question.key}>
      <div className="flex items-start justify-between gap-2 pt-2.5 text-sm text-muted-foreground sm:block sm:border-b sm:border-border/60 sm:pb-2.5 sm:pr-6">
        <span>{question.text}</span>
        {/* Stacked (a phone), the answer sits under its question at full width,
            so the badge moves up onto the question's line instead of wrapping
            onto a line of its own under the answer. */}
        {status ? <span className="mt-1 flex shrink-0">{status}</span> : null}
      </div>
      <div className="border-b border-border/60 pb-2.5 pt-1 sm:pt-2.5">{children}</div>
    </div>
  );
}

/**
 * The answer as it reads when nothing is being edited: full text, wrapped —
 * never truncated, which was the whole complaint — and clickable to edit, with
 * the provenance badge trailing at the right edge of the answer column so the
 * badges line up down the section too.
 */
function AnswerDisplay({
  question,
  answer,
  onEdit,
  showBadge,
}: {
  question: CuratedQuestion;
  answer: CatalogueAnswer;
  onEdit: () => void;
  /** False when stacked: the badge is on the question's line instead. */
  showBadge: boolean;
}) {
  return (
    // Side by side once there is width for it, so the badges line up as their
    // own column; stacked below `sm`, where sitting the badge beside the text
    // would squeeze a long answer into a sliver and leave the rest blank.
    <div className="flex flex-col items-start gap-1 sm:flex-row sm:gap-2">
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit your answer to “${question.text}”`}
        className="group -mx-1 w-full min-w-0 rounded-sm px-1 text-left text-sm text-foreground/90 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-auto sm:flex-1"
      >
        <span className="whitespace-pre-wrap break-words">{answer.text}</span>
        {/* Discoverability only — the button itself is the affordance, and its
            aria-label already says what activating it does. */}
        <Pencil
          className="ml-1.5 inline-block h-3 w-3 shrink-0 align-baseline text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          strokeWidth={1.5}
          aria-hidden="true"
        />
      </button>

      {/* The badge is the way in to the full account of this answer: the
          reasoning sentence and the database objects behind it. `details.record`
          is the catalogue's answer row verbatim — the drawer reads any evidence
          citations off it defensively, so this call site does not have to track
          the field the API hangs them on.

          `onEdit` hands straight back to `startEdit`, the SAME inline editor the
          answer text opens, which PATCHes `{text}` alone and re-stamps the row as
          the user's. There is deliberately no second write path in the drawer. */}
      {showBadge ? (
        <AnswerBadge question={question} answer={answer} onEdit={onEdit} className="shrink-0 sm:mt-px" />
      ) : null}
    </div>
  );
}

/** One answer's provenance badge: beside the answer, or on its question's line when stacked. */
function AnswerBadge({
  question,
  answer,
  onEdit,
  className,
}: {
  question: CuratedQuestion;
  answer: CatalogueAnswer;
  onEdit: () => void;
  className?: string;
}) {
  return (
    <AnswerProvenance
      source={answer.source}
      confidence={answer.confidence}
      rationale={answer.rationale}
      details={{
        question: question.text,
        answerText: answer.text,
        answeredAt: answer.answeredAt,
        record: answer,
        onEdit,
      }}
      className={className}
    />
  );
}

/**
 * Editing an existing answer. Explicitly Save/Cancel rather than the debounced
 * autosave the empty rows use: overwriting words already on the profile — some
 * of them the appliance's guesses, which is exactly what the user is here to
 * correct — should take a deliberate keystroke, and needs a way out that
 * restores what was there.
 */
function AnswerEditor({
  question,
  draft,
  busy,
  error,
  onDraftChange,
  onSave,
  onCancel,
}: {
  question: CuratedQuestion;
  draft: string;
  busy: boolean;
  error: string | null;
  onDraftChange: (value: string) => void;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  // An options question's answer domain IS its option list, so editing one is
  // picking again — not retyping. That is the path out of a rambling inferred
  // answer to "morning person or night owl?": one click replaces it.
  if (question.options) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={draft}
          onValueChange={(value) => value && onSave(value)}
        >
          {question.options.map((option) => (
            <ToggleGroup.Item key={option} value={option} className="px-3 text-xs" disabled={busy}>
              {option}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup>

        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>

        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" strokeWidth={1.5} />}
        {error && (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        // Focus follows the click that opened the editor — the user asked to
        // type here, so it would otherwise take a second click to do it.
        autoFocus
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }

          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave(draft);
          }
        }}
        rows={question.tier === 'narrative' ? 3 : 2}
        maxLength={ANSWER_MAX_LENGTH}
        disabled={busy}
        aria-label={`Your answer to “${question.text}”`}
        className="min-h-0 text-sm"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => onSave(draft)}
          disabled={busy || draft.trim().length === 0}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />}
          {busy ? 'Saving…' : 'Save'}
        </Button>

        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>

        {error && (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A row with no answer yet, rendered by type: button options as a ToggleGroup
 * (saves immediately on click), a narrative-tier open question as a compact
 * Textarea, everything else as a single-line Input — both text controls
 * autosave a fixed delay after the last keystroke, matching the identity form
 * above.
 */
function AnswerPrompt({
  question,
  draft,
  busy,
  onDraftChange,
  onAnswer,
}: {
  question: CuratedQuestion;
  draft: string;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onAnswer: (text: string) => void;
}) {
  // Fires only for the free-text branches below (yes_no/multiple_choice
  // buttons already save on click, before this could ever run).
  useEffect(() => {
    if (busy || draft.trim().length === 0) {
      return;
    }

    const timer = setTimeout(() => onAnswer(draft), ANSWER_AUTOSAVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // `onAnswer`/`busy` deliberately excluded: both are recreated by the parent
    // on every keystroke in ANY row (shared `drafts` state), so including them
    // would reset this row's debounce on unrelated sibling edits.
  }, [draft]);

  if (question.options) {
    // The question is NOT repeated here: it lives in this row's own grid cell
    // (see `Row`), so rendering it again would double it in every unanswered row.
    return (
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          className="w-full justify-start sm:w-auto sm:shrink-0"
          onValueChange={(value) => value && onAnswer(value)}
        >
          {question.options.map((option) => (
            <ToggleGroup.Item key={option} value={option} className="px-3 text-xs" disabled={busy}>
              {option}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup>

        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" strokeWidth={1.5} />}
      </div>
    );
  }

  if (question.tier === 'narrative') {
    return (
      <div className="flex items-start gap-2">
        <Textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          rows={2}
          maxLength={ANSWER_MAX_LENGTH}
          placeholder="Your answer…"
          aria-label={`Your answer to “${question.text}”`}
          className="min-h-0 flex-1 text-sm"
        />
        {busy && (
          <Loader2
            className="mt-2 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
            strokeWidth={1.5}
          />
        )}
      </div>
    );
  }

  return (
    // Question omitted for the same reason as the options branch above — it is
    // already this row's left grid cell.
    <div className="flex items-center gap-2">
      <Input
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        maxLength={ANSWER_MAX_LENGTH}
        placeholder="Answer…"
        aria-label={`Your answer to “${question.text}”`}
        // Full control height on a phone — `h-8` is 32px, under the 44px
        // Apple asks for, and these sit in a dense divided list where a
        // mistap lands on the neighbouring question.
        className="h-9 w-full min-w-0 text-sm sm:h-8 sm:max-w-80 sm:shrink-0"
      />
      {busy && (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" strokeWidth={1.5} />
      )}
    </div>
  );
}

interface LifeDetailsSectionProps {
  /**
   * Called after an answer has been written (saved or edited) and the section
   * has refreshed, so a page that lists the same answers elsewhere — About you's
   * "Recent answers" — can refresh too instead of showing the old words until a
   * reload.
   */
  onAnswersChanged?: () => void;
}

/** A fixed, hand-curated slice of your Reflections answers — see lifeDetails.ts for why these questions and not a generic category browse. */
export function LifeDetailsSection({ onAnswersChanged }: LifeDetailsSectionProps) {
  const [{ authToken }] = useAuth();
  const stacked = useStacked();
  const [rows, setRows] = useState<CuratedAnswers>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Per-row lock, not a single shared value: a shared lock meant row B's
  // autosave silently no-op'd whenever row A's POST was still in flight,
  // dropping B's answer with no error and no retry.
  const [submittingKeys, setSubmittingKeys] = useState<Set<string>>(new Set());
  // One row edits at a time, so the in-flight text and its error are single
  // values rather than another map keyed by question.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const sectionRef = useRef<HTMLElement>(null);
  const lastEditedKey = useRef<string | null>(null);

  // A long answer makes a tall editor, and a cancelled draft (or one saved much
  // shorter than it was) collapses it to the saved answer in one step. WebKit has
  // no scroll anchoring, so the scroller keeps its scrollTop and the page lands on
  // whatever used to be below the row — a screenful or the whole page away (QA:
  // 2,500 characters left the page ~1,400pt past the row, 5,000 at the very end).
  // Once the editor is gone, bring the row back into view; `nearest` leaves the
  // page alone when the row is still on screen, so a short edit moves nothing.
  useLayoutEffect(() => {
    if (editingKey !== null) {
      lastEditedKey.current = editingKey;

      return;
    }

    const closedKey = lastEditedKey.current;
    lastEditedKey.current = null;

    if (closedKey !== null) {
      sectionRef.current
        ?.querySelector<HTMLElement>(`[data-question-key="${closedKey}"]`)
        // The row wrapper is `display: contents` and has no box of its own; its
        // first child is the question cell, the top of the row.
        ?.firstElementChild?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [editingKey]);

  const authHeaders = useCallback(
    () => ({
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    }),
    [authToken],
  );

  // The newest load. Refreshes after a save now run while the person keeps using
  // the other rows, so a slow one that started before a later save finished must
  // not land on top of it and put that row back to "no answer yet".
  const latestLoad = useRef(0);

  const loadAnswers = useCallback(
    async ({ background = false }: { background?: boolean } = {}) => {
      const load = ++latestLoad.current;

      // `loading` swaps the whole grid for "Loading…": right for the first load,
      // wrong for the refetch after a save. That one unmounted every row, so the
      // section collapsed to a line, the page scroll was clamped to the end of
      // the (now short) page and the keyboard went with the field. A background
      // refresh swaps rows in place instead and never touches `loading`.
      if (!background) {
        setLoading(true);
      }

      try {
        const page = await fetchJson<CataloguePage>(curatedCatalogueUrl(), {
          headers: { ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        });

        if (load !== latestLoad.current) {
          return;
        }

        const { byKey, missingKeys } = indexCuratedAnswers(page?.data ?? []);

        // Loud, because the silent version of this is what shipped: a curated
        // key the catalogue has never heard of used to render a perfectly
        // normal-looking input that threw away whatever was typed into it.
        // Rows without a question to answer are not rendered at all (below).
        if (missingKeys.length > 0) {
          console.error(
            `Life details: ${missingKeys.length} curated question(s) are missing from the catalogue — ` +
              `their seed migration has not run, or they were added to lifeDetails.ts without one: ${missingKeys.join(', ')}`,
          );
        }

        setRows(byKey);
        setError(false);
      } catch {
        if (load === latestLoad.current) {
          setError(true);
        }
      } finally {
        if (load === latestLoad.current) {
          setLoading(false);
        }
      }
    },
    [authToken],
  );

  useEffect(() => {
    void loadAnswers();
  }, [loadAnswers]);

  // Keyed by `question_key` throughout; the question_id in the body is the one
  // the catalogue just reported, never one this list carries. Ids are minted
  // per appliance, which is the whole reason the curated list is keyed by slug.
  const handleAnswer = async (questionKey: string, questionId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed || submittingKeys.has(questionKey)) {
      return;
    }

    setSubmittingKeys((prev) => new Set(prev).add(questionKey));
    try {
      await fetchJson('/api/answers', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ text: trimmed, question: { id: questionId } }),
      });
      // Refresh behind the row, and clear what was typed only once the saved
      // answer is there to replace it — clearing first left an empty field on
      // screen for the length of the fetch.
      await loadAnswers({ background: true });
      setDrafts((prev) => ({ ...prev, [questionKey]: '' }));
      onAnswersChanged?.();
    } catch {
      // Draft (if any) survives on failure so the user doesn't retype it.
    } finally {
      setSubmittingKeys((prev) => {
        const next = new Set(prev);
        next.delete(questionKey);

        return next;
      });
    }
  };

  const startEdit = (questionKey: string) => {
    setEditingKey(questionKey);
    setEditDraft(rows[questionKey]?.answer?.text ?? '');
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setEditDraft('');
    setEditError(null);
  };

  /**
   * Rewrites an existing answer in place.
   *
   * PATCH, not another POST: `AnswerService.create` always INSERTs, so
   * re-answering would pile duplicate rows behind the newest one. More
   * importantly, a PATCH carrying only `text` is what the API treats as a user
   * correction — it flips `answer_source` to `user_input` and `answer_method`
   * to `user`, and clears the confidence and rationale the model left behind
   * (`AnswerService.update`). That is the whole point of letting someone edit a
   * guess: once these are their words, the row must stop wearing an "Inferred"
   * badge and a score for text the model no longer wrote. Passing any explicit
   * source here would opt out of that, so we deliberately send `text` alone.
   */
  const handleUpdate = async (questionKey: string, row: CuratedCatalogueRow, text: string) => {
    const trimmed = text.trim();
    if (!trimmed || submittingKeys.has(questionKey)) {
      return;
    }

    if (trimmed.length > ANSWER_MAX_LENGTH) {
      setEditError(`Keep it under ${ANSWER_MAX_LENGTH.toLocaleString()} characters.`);

      return;
    }

    const answerId = row.answer?.id;
    if (!answerId) {
      // No row to rewrite (the refetch that would have supplied the id failed,
      // or the answer was removed elsewhere) — write a fresh one instead.
      cancelEdit();
      await handleAnswer(questionKey, row.id, trimmed);

      return;
    }

    setSubmittingKeys((prev) => new Set(prev).add(questionKey));
    setEditError(null);
    try {
      await fetchJson(`/api/answers/${answerId}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ text: trimmed }),
      });
      // The editor stays (saving…) until the refreshed answer is in hand:
      // closing it first showed the OLD answer again for the length of the fetch.
      await loadAnswers({ background: true });
      setEditingKey(null);
      setEditDraft('');
      onAnswersChanged?.();
    } catch {
      // Stay in the editor with the typed text intact so it can be retried.
      setEditError("Couldn't save that. Try again.");
    } finally {
      setSubmittingKeys((prev) => {
        const next = new Set(prev);
        next.delete(questionKey);

        return next;
      });
    }
  };

  return (
    <section ref={sectionRef}>
      <div className="mb-3 flex items-center gap-2">
        <NotebookPen className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
        <h2 className="text-lg font-semibold">Life details</h2>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-muted-foreground">Couldn&apos;t load this section.</p>}

      {!loading && !error && (
        <div className="flex flex-col gap-4">
          <ProvenanceLegend className="-mt-1" />
          {LIFE_DETAIL_THEMES.map((theme) => {
            // Only questions the catalogue actually returned a row for. An
            // input with no question behind it cannot save, so rendering one
            // would just be a prettier way of losing the answer; a theme left
            // with nothing drops its heading too rather than sitting empty.
            const askable = theme.questions.flatMap((question) => {
              const row = rows[question.key];

              return row ? [{ question, row }] : [];
            });

            if (askable.length === 0) {
              return null;
            }

            return (
              <div key={theme.key}>
                <h3 className="mb-1 text-sm font-medium">{theme.label}</h3>

                {/* One grid per theme, two tracks: the question column is capped
                    so long questions wrap instead of squeezing the answers, and
                    collapses to a single stacked column below `sm`. */}
                <div
                  className={cn(
                    'grid grid-cols-1 items-start',
                    'sm:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] sm:items-stretch',
                  )}
                >
                  {askable.map(({ question, row }) => {
                    const answer = row.answer;
                    const busy = submittingKeys.has(question.key);

                    return (
                      <Row
                        key={question.key}
                        question={question}
                        status={
                          stacked && answer && editingKey !== question.key ? (
                            <AnswerBadge
                              question={question}
                              answer={answer}
                              onEdit={() => startEdit(question.key)}
                            />
                          ) : undefined
                        }
                      >
                        {answer && editingKey === question.key ? (
                          <AnswerEditor
                            question={question}
                            draft={editDraft}
                            busy={busy}
                            error={editError}
                            onDraftChange={(value) => setEditDraft((prev) => clampAnswer(value, prev))}
                            onSave={(text) => void handleUpdate(question.key, row, text)}
                            onCancel={cancelEdit}
                          />
                        ) : answer ? (
                          <AnswerDisplay
                            question={question}
                            answer={answer}
                            onEdit={() => startEdit(question.key)}
                            showBadge={!stacked}
                          />
                        ) : (
                          // Same two-part shape as AnswerDisplay so the status
                          // dots form one column down the section whether a row
                          // is answered or not.
                          <div className="flex flex-col items-start gap-1 sm:flex-row sm:gap-2">
                            <div className="w-full min-w-0 sm:flex-1">
                              <AnswerPrompt
                                question={question}
                                draft={drafts[question.key] ?? ''}
                                busy={busy}
                                onDraftChange={(value) =>
                                  setDrafts((prev) => ({
                                    ...prev,
                                    [question.key]: clampAnswer(value, prev[question.key]),
                                  }))
                                }
                                onAnswer={(text) => void handleAnswer(question.key, row.id, text)}
                              />
                            </div>

                            {/* Not on a phone: the empty field already says there is no
                                answer, and a marker under every one read as an error. */}
                            <AnswerProvenance
                              answered={false}
                              className="hidden shrink-0 sm:mt-px sm:inline-flex"
                            />
                          </div>
                        )}
                      </Row>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
