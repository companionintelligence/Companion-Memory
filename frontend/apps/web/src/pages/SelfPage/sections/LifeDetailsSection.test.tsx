import { DeviceLayoutProvider } from '@ci/common';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { curatedQuestionKeys, curatedQuestions, type CuratedQuestion } from './lifeDetails';
import { LifeDetailsSection } from './LifeDetailsSection';

const h = vi.hoisted(() => ({ authToken: 'jwt-abc' as string | null }));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: h.authToken }, {}],
}));

const fetchJson = vi.hoisted(() => vi.fn());
vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson,
}));

interface FetchCallInit {
  method?: string;
  body?: string;
}

type FetchCalls = Array<[string, FetchCallInit?]>;

function callsWithMethod(method: string): FetchCalls {
  return (fetchJson.mock.calls as FetchCalls).filter(([, init]) => init?.method === method);
}

// Curated KEYS, not ids: `question_id` is minted per appliance, so a test that
// hardcoded one would be asserting the very coupling this list exists to avoid.
// A yes_no question, a narrative open_ended one, a compact open_ended one and a
// multiple_choice one with options, so each control type is exercised against
// the real curated list.
const VOLUNTEER_KEY = 'volunteering';
const HOBBY_KEY = 'longest_hobby';
const BLOOD_TYPE_KEY = 'blood_type';
const MORNING_PERSON_KEY = 'morning_person_or_night_owl';

/** The row's own DOM subtree — both grid cells — for scoping a query. */
function rowFor(questionKey: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-question-key="${questionKey}"]`);
  if (!row) {
    throw new Error(`no row rendered for question ${questionKey}`);
  }

  return row;
}

function questionFor(key: string): CuratedQuestion {
  const question = curatedQuestions().find((candidate) => candidate.key === key);
  if (!question) {
    throw new Error(`${key} is not a curated question`);
  }

  return question;
}

/**
 * The uuid the catalogue reports for a curated key on THIS database. Derived
 * from the key so the test never invents an id/key pairing by hand, and
 * deliberately unlike anything in lifeDetails.ts — an assertion on it passes
 * only because the component read the id off the response.
 */
function serverIdFor(key: string): string {
  const index = curatedQuestionKeys().indexOf(key);

  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

function catalogueEntry(
  key: string,
  answerText: string | null = null,
  // `evidence` is `QuestionCatalogueAnswer.evidence` on the API — the
  // { citations, linesShown, linesOwn, model } wrapper the drawer reads. Not
  // part of the frontend `CatalogueAnswer` type yet, hence `unknown`: the
  // drawer reads it defensively rather than through a generated type.
  answerOverrides: {
    source?: string;
    confidence?: number | null;
    rationale?: string | null;
    evidence?: unknown;
  } = {},
) {
  const question = questionFor(key);
  const id = serverIdFor(key);

  return {
    id,
    key,
    text: question.text,
    category: question.category,
    answerTier: question.tier,
    questionType: question.questionType,
    frequencyRecommendation: 'monthly',
    isActive: true,
    isSeedQuestion: true,
    createdByLlm: false,
    isPrivateTo: null,
    forkedFromQuestionId: null,
    timesAsked: 0,
    timesAnswered: answerText ? 1 : 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    answer: answerText
      ? {
          id: `${id}-answer`,
          text: answerText,
          source: 'user_input',
          confidence: null,
          rationale: null,
          answeredAt: '2026-01-01T00:00:00.000Z',
          ...answerOverrides,
        }
      : null,
  };
}

function cataloguePage(data: ReturnType<typeof catalogueEntry>[]) {
  return {
    data,
    totalCount: data.length,
    limit: 100,
    offset: 0,
    facets: { categories: [], answerTiers: [], answeredCount: 0, unansweredCount: 0 },
  };
}

/** What a correctly-seeded appliance returns: a row for every curated key. */
function fullCataloguePage(answers: Record<string, string> = {}) {
  return cataloguePage(
    curatedQuestions().map((question) => catalogueEntry(question.key, answers[question.key])),
  );
}

beforeEach(() => {
  h.authToken = 'jwt-abc';
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('LifeDetailsSection', () => {
  it('fetches every curated key in a single call and renders the answer in full', async () => {
    // A long answer, because the bug this replaced rendered the row as one
    // truncated line with the question and answer run together.
    const long =
      'O negative, which I only found out when I tried to donate blood in 2019 and they told me at the desk.';
    fetchJson.mockResolvedValue(fullCataloguePage({ [BLOOD_TYPE_KEY]: long }));

    render(<LifeDetailsSection />);

    expect(await screen.findByText(long)).toBeInTheDocument();

    // Question and answer are separate cells, not one run-together sentence.
    const row = rowFor(BLOOD_TYPE_KEY);
    expect(within(row).getByText('What is your blood type?')).not.toContainElement(screen.getByText(long));

    expect(fetchJson).toHaveBeenCalledTimes(1);
    const [url] = fetchJson.mock.calls[0] as [string];
    expect(url).toContain('/api/questions/catalogue?keys=');
    // No uuid rides in the request — that is the regression this section had.
    expect(url).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    // Every curated key rides in the one call — spot-check a few, not the whole list.
    expect(url).toContain(BLOOD_TYPE_KEY);
    expect(url).toContain(VOLUNTEER_KEY);
    const keysParam = new URL(url, 'http://localhost').searchParams.get('keys');
    expect(keysParam?.split(',')).toEqual(curatedQuestionKeys());
  });

  it('autosaves a compact open-ended answer typed into its Input, after a debounced pause', async () => {
    fetchJson.mockResolvedValue(fullCataloguePage());

    render(<LifeDetailsSection />);

    await screen.findByText('What is your blood type?');
    // Located by `rowFor`, not `.closest('div')`: the question and its answer
    // are sibling grid cells, so there is no single ancestor <div> wrapping
    // just this row.
    const input = within(rowFor(BLOOD_TYPE_KEY)).getByPlaceholderText('Answer…');
    fireEvent.change(input, { target: { value: 'O negative' } });

    // Kept from the row-layout tests: the input fills its cell rather than
    // sitting at a fixed 20rem.
    expect(input).toHaveClass('w-full');
    expect(input).not.toHaveClass('w-80');

    await waitFor(
      () => {
        const [postCall] = callsWithMethod('POST');
        expect(postCall).toBeDefined();
        expect(JSON.parse(postCall![1]!.body!)).toEqual({
          text: 'O negative',
          // The id the catalogue reported, not one this list carries.
          question: { id: serverIdFor(BLOOD_TYPE_KEY) },
        });
      },
      { timeout: 3000 },
    );
  });

  it('autosaves a second row even while an earlier row is still mid-submit, instead of silently dropping it', async () => {
    // Regression test for a single shared `submittingKey` lock across every
    // row: if row A's POST was still in flight when row B's own debounce
    // fired, `handleAnswer`'s guard saw the lock still held by A and
    // silently returned — B's text stayed visible in its input but was never
    // sent, with no error and no retry. Row A's POST is kept pending forever
    // here (never resolved) so the whole test runs with the lock still held.
    const pendingRowAPost = new Promise<unknown>(() => {});
    let postCount = 0;

    fetchJson.mockImplementation((_url: string, init?: FetchCallInit) => {
      if (init?.method === 'POST') {
        postCount += 1;

        return postCount === 1 ? pendingRowAPost : Promise.resolve({});
      }

      return Promise.resolve(fullCataloguePage());
    });

    render(<LifeDetailsSection />);

    await screen.findByText('What is your blood type?');
    await screen.findByText('Which hobby have you kept the longest, and for how many years?');

    // Row A: a compact Input. Its debounced autosave fires and its POST is
    // left pending (never resolves) for the rest of the test.
    fireEvent.change(within(rowFor(BLOOD_TYPE_KEY)).getByPlaceholderText('Answer…'), {
      target: { value: 'O negative' },
    });

    await waitFor(() => expect(callsWithMethod('POST')).toHaveLength(1), { timeout: 3000 });

    // Row B: a different row, typed into and debounced while row A's POST is
    // still unresolved — the exact overlap the shared lock used to block.
    fireEvent.change(within(rowFor(HOBBY_KEY)).getByPlaceholderText('Your answer…'), {
      target: { value: 'Photography, going on 8 years now.' },
    });

    // Before the fix this second call never arrives and the test times out.
    await waitFor(() => expect(callsWithMethod('POST')).toHaveLength(2), { timeout: 3000 });

    const [, rowBPostCall] = callsWithMethod('POST');
    expect(JSON.parse(rowBPostCall![1]!.body!)).toEqual({
      text: 'Photography, going on 8 years now.',
      question: { id: serverIdFor(HOBBY_KEY) },
    });
  });

  it('renders a yes_no question as two buttons, not a text field, and submits the clicked label', async () => {
    fetchJson.mockResolvedValue(fullCataloguePage());

    render(<LifeDetailsSection />);

    // Scoped to this question's own row — "Answer…" repeats across the many
    // other curated questions on the page.
    await screen.findByText('Do you volunteer for any organization?');
    const row = rowFor(VOLUNTEER_KEY);
    const yesButton = within(row).getByRole('radio', { name: 'Yes' });
    expect(within(row).getByRole('radio', { name: 'No' })).toBeInTheDocument();
    expect(within(row).queryByPlaceholderText('Answer…')).not.toBeInTheDocument();

    fireEvent.click(yesButton);

    await waitFor(() => {
      const [postCall] = callsWithMethod('POST');
      expect(postCall).toBeDefined();
      expect(postCall?.[0]).toBe('/api/answers');
      expect(JSON.parse(postCall![1]!.body!)).toEqual({
        text: 'Yes',
        question: { id: serverIdFor(VOLUNTEER_KEY) },
      });
    });

    // GET refires after the POST — once on mount, once on refetch.
    expect(fetchJson.mock.calls.filter(([, init]) => init?.method === undefined)).toHaveLength(2);
  });

  it('autosaves a narrative open-ended answer typed into its Textarea, after a debounced pause', async () => {
    fetchJson.mockResolvedValue(fullCataloguePage());

    render(<LifeDetailsSection />);

    // Scoped to this question's own row — the "Your answer…" Textarea
    // repeats across the other narrative-tier questions.
    await screen.findByText('Which hobby have you kept the longest, and for how many years?');
    fireEvent.change(within(rowFor(HOBBY_KEY)).getByPlaceholderText('Your answer…'), {
      target: { value: 'Photography, going on 8 years now.' },
    });

    await waitFor(
      () => {
        const [postCall] = callsWithMethod('POST');
        expect(postCall).toBeDefined();
        expect(JSON.parse(postCall![1]!.body!)).toEqual({
          text: 'Photography, going on 8 years now.',
          question: { id: serverIdFor(HOBBY_KEY) },
        });
      },
      { timeout: 3000 },
    );
  });

  // `truncate` was unconditional, so a ~340px-wide phone clipped the row at
  // the question and showed an ellipsis where the answer should be — every
  // answered row in the section read as blank. It stays a single line from
  // `sm` up, where the row is wide enough for it.
  it('wraps an answered row on a phone rather than clipping the answer away', async () => {
    fetchJson.mockResolvedValue(cataloguePage([catalogueEntry(BLOOD_TYPE_KEY, 'O negative')]));

    render(<LifeDetailsSection />);

    // The bug this guards: a `truncate` answer showed the question and an
    // ellipsis on a ~340px phone, so every answered row read as blank. The
    // question now lives in the row's own grid cell and the answer wraps in
    // its own element, so assert the wrapping where the answer actually is
    // rather than on a shared paragraph that no longer exists.
    const answer = await screen.findByText('O negative');
    expect(answer).toHaveClass('break-words');
    expect(answer).toHaveClass('whitespace-pre-wrap');
    expect(answer).not.toHaveClass('truncate');
  });

  it('shows one error for the whole section when the fetch fails, with no question text rendered', async () => {
    fetchJson.mockRejectedValue(new Error('network error'));

    render(<LifeDetailsSection />);

    expect(await screen.findByText("Couldn't load this section.")).toBeInTheDocument();
    expect(screen.queryByText('What is your blood type?')).not.toBeInTheDocument();
  });

  it('labels an inferred answer with its confidence band, and a hand-written one as Manual', async () => {
    fetchJson.mockResolvedValue(
      cataloguePage([
        catalogueEntry(BLOOD_TYPE_KEY, 'O negative', {
          source: 'inferred',
          confidence: 0.72,
          rationale: 'A 2019 donation reminder names it.',
        }),
        catalogueEntry(HOBBY_KEY, 'Photography'),
      ]),
    );

    render(<LifeDetailsSection />);

    // The inferred row shows the bare band word; the exact score stays in the
    // tooltip. The hand-written row carries the dot and its screen-reader text
    // only — no visible word.
    const badge = await screen.findByText('good');
    expect(rowFor(BLOOD_TYPE_KEY)).toContainElement(badge);
    expect(badge.closest('[title]')).toHaveAttribute('title', expect.stringContaining('0.72'));
    expect(within(rowFor(HOBBY_KEY)).getByText('Answered by you')).toBeInTheDocument();
  });

  it('marks a question with no answer yet with a neutral ring from `sm` up, and with nothing on a phone', async () => {
    fetchJson.mockResolvedValue(fullCataloguePage());

    render(<LifeDetailsSection />);

    await screen.findByText('What is your blood type?');
    const row = rowFor(BLOOD_TYPE_KEY);
    const status = within(row).getByText('No answer yet').closest('[title="No answer yet"]');
    const dot = row.querySelector('span.rounded-full');

    // Red under every empty field read as a validation error on a phone.
    expect(dot).toHaveClass('border');
    expect(dot).not.toHaveClass('bg-red-500');
    expect(status).toHaveClass('hidden', 'sm:inline-flex');
  });

  it('explains the dots once, above the questions, since a phone cannot hover for the tooltip', async () => {
    fetchJson.mockResolvedValue(fullCataloguePage());

    render(<LifeDetailsSection />);

    const legend = (await screen.findByText('Inferred by Memory')).closest('p');

    expect(legend).toHaveTextContent('Answered by you');
    expect(legend).toHaveTextContent('No answer yet');
  });

  it("puts an answer's badge on its question's line when the rows stack on a phone", async () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(width < 40rem)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    try {
      fetchJson.mockResolvedValue(
        cataloguePage([
          catalogueEntry(BLOOD_TYPE_KEY, 'O negative', { source: 'inferred', confidence: 0.72 }),
        ]),
      );

      render(<LifeDetailsSection />);

      const badge = await screen.findByText('good');
      const [questionLine, answerCell] = Array.from(rowFor(BLOOD_TYPE_KEY).children);

      expect(questionLine).toContainElement(badge);
      expect(answerCell).not.toContainElement(badge);
      expect(screen.getAllByText('good')).toHaveLength(1);
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  it('edits an existing answer with a PATCH carrying text alone, so the API re-stamps it as user-authored', async () => {
    fetchJson.mockResolvedValue(
      cataloguePage([
        catalogueEntry(BLOOD_TYPE_KEY, 'AB positive, I think?', { source: 'inferred', confidence: 0.41 }),
      ]),
    );

    render(<LifeDetailsSection />);

    fireEvent.click(await screen.findByRole('button', { name: /Edit your answer to/ }));

    const editor = within(rowFor(BLOOD_TYPE_KEY)).getByRole('textbox');
    expect(editor).toHaveValue('AB positive, I think?');

    fireEvent.change(editor, { target: { value: 'O negative' } });
    fireEvent.click(within(rowFor(BLOOD_TYPE_KEY)).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const [patchCall] = callsWithMethod('PATCH');
      expect(patchCall).toBeDefined();
      // The answer id off the response, same as the question id.
      expect(patchCall?.[0]).toBe(`/api/answers/${serverIdFor(BLOOD_TYPE_KEY)}-answer`);
      // Text ONLY: naming a source here would opt out of the API's
      // user-correction flip, leaving the row badged as a machine inference.
      expect(JSON.parse(patchCall![1]!.body!)).toEqual({ text: 'O negative' });
    });

    // Never a second POST — editing must not pile up a duplicate answer row.
    expect(callsWithMethod('POST')).toHaveLength(0);
  });

  it('cancels an edit back to the answer without writing anything', async () => {
    fetchJson.mockResolvedValue(cataloguePage([catalogueEntry(BLOOD_TYPE_KEY, 'O negative')]));

    render(<LifeDetailsSection />);

    fireEvent.click(await screen.findByRole('button', { name: /Edit your answer to/ }));

    const row = rowFor(BLOOD_TYPE_KEY);
    fireEvent.change(within(row).getByRole('textbox'), { target: { value: 'something else entirely' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }));

    expect(within(rowFor(BLOOD_TYPE_KEY)).getByText('O negative')).toBeInTheDocument();
    expect(callsWithMethod('PATCH')).toHaveLength(0);
    expect(callsWithMethod('POST')).toHaveLength(0);
  });

  it('re-picks an answered options question from its buttons rather than a text box', async () => {
    fetchJson.mockResolvedValue(
      cataloguePage([
        catalogueEntry(MORNING_PERSON_KEY, "I'm not sure, I haven't really thought about it.", {
          source: 'inferred',
          confidence: 0.44,
        }),
      ]),
    );

    render(<LifeDetailsSection />);

    fireEvent.click(await screen.findByRole('button', { name: /Edit your answer to/ }));

    const row = rowFor(MORNING_PERSON_KEY);
    expect(within(row).queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole('radio', { name: 'Night owl' }));

    await waitFor(() => {
      const [patchCall] = callsWithMethod('PATCH');
      expect(patchCall).toBeDefined();
      expect(patchCall?.[0]).toBe(`/api/answers/${serverIdFor(MORNING_PERSON_KEY)}-answer`);
      expect(JSON.parse(patchCall![1]!.body!)).toEqual({ text: 'Night owl' });
    });
  });

  it('keys rows off question_key, so the same answers survive a different set of server ids', async () => {
    // The same appliance-independent list, re-seeded: every uuid is new, every
    // key is the same. Nothing about what the user sees may change.
    const page = fullCataloguePage({ [BLOOD_TYPE_KEY]: 'O negative' });
    for (const entry of page.data) {
      entry.id = `ffffffff-0000-4000-8000-${entry.id.slice(-12)}`;
    }

    fetchJson.mockResolvedValue(page);

    render(<LifeDetailsSection />);

    expect(await screen.findByText('O negative')).toBeInTheDocument();
    expect(screen.getByText('Do you volunteer for any organization?')).toBeInTheDocument();
  });

  it('renders no input for a curated question the catalogue has no row for, and says so loudly', async () => {
    // The failure mode this section shipped with: a curated question the
    // database has never heard of. It must not render a control that quietly
    // discards whatever is typed into it.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchJson.mockResolvedValue(
      cataloguePage(
        curatedQuestions()
          .filter((question) => question.key !== BLOOD_TYPE_KEY)
          .map((question) => catalogueEntry(question.key)),
      ),
    );

    render(<LifeDetailsSection />);

    expect(await screen.findByText('What foods are you allergic to?')).toBeInTheDocument();
    expect(screen.queryByText('What is your blood type?')).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(BLOOD_TYPE_KEY));
  });

  it('renders nothing at all, rather than dead inputs, when the catalogue knows none of the keys', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchJson.mockResolvedValue(cataloguePage([]));

    render(<LifeDetailsSection />);

    // The heading stays; every question, and every theme heading, is gone.
    expect(await screen.findByText('Life details')).toBeInTheDocument();
    expect(screen.queryByText('What is your blood type?')).not.toBeInTheDocument();
    expect(screen.queryByText('Health')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Answer…')).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('29 curated question(s) are missing'));
  });
});

/** A promise settled from outside, for holding a fetch open while the test reads the screen. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

describe('LifeDetailsSection — saving does not reload the section', () => {
  /**
   * The saved answer as its row shows it once nothing is being typed: the button
   * that edits it. Not `findByText` — while a save is in flight the SAME words
   * sit in the field being typed into, and a query that finds those finds a node
   * that is gone a moment later.
   */
  function savedAnswer(questionKey: string) {
    return within(rowFor(questionKey)).findByRole('button', { name: /Edit your answer to/ });
  }

  /**
   * The first GET returns `firstPage`; every later GET is held open until the
   * test settles it, and every write succeeds at once. That makes the refetch
   * after a save a thing the test can stand inside and look at.
   */
  function holdRefetches(firstPage: unknown = fullCataloguePage()) {
    const refetches: Array<ReturnType<typeof deferred<unknown>>> = [];
    let gets = 0;

    fetchJson.mockImplementation((_url: string, init?: FetchCallInit) => {
      if (init?.method) {
        return Promise.resolve({});
      }

      gets += 1;

      if (gets === 1) {
        return Promise.resolve(firstPage);
      }

      const held = deferred<unknown>();
      refetches.push(held);

      return held.promise;
    });

    return refetches;
  }

  it('keeps every row mounted while a save refetches, instead of swapping the grid for "Loading…"', async () => {
    // REFL-04: the refetch after a save put the WHOLE grid behind "Loading…". The
    // section collapsed to one line, the page's scroll position was clamped to
    // the end of the (now short) page — on an iPhone, the Delete account area —
    // and the keyboard went with the field.
    const refetches = holdRefetches();

    render(<LifeDetailsSection />);

    await screen.findByText('Do you volunteer for any organization?');
    const bystander = rowFor(BLOOD_TYPE_KEY);

    fireEvent.click(within(rowFor(VOLUNTEER_KEY)).getByRole('radio', { name: 'Yes' }));

    // The POST has gone and the refetch is in flight.
    await waitFor(() => expect(refetches).toHaveLength(1));

    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(rowFor(BLOOD_TYPE_KEY)).toBe(bystander);
    expect(bystander).toBeInTheDocument();

    refetches[0]!.resolve(fullCataloguePage({ [VOLUNTEER_KEY]: 'Yes' }));

    expect(await savedAnswer(VOLUNTEER_KEY)).toHaveTextContent('Yes');
    // The very same node the whole way through: never unmounted and rebuilt.
    expect(rowFor(BLOOD_TYPE_KEY)).toBe(bystander);
  });

  it('leaves what was typed in the field until the saved answer replaces it', async () => {
    const refetches = holdRefetches();

    render(<LifeDetailsSection />);

    await screen.findByText('What is your blood type?');
    fireEvent.change(within(rowFor(BLOOD_TYPE_KEY)).getByPlaceholderText('Answer…'), {
      target: { value: 'O negative' },
    });

    await waitFor(() => expect(refetches).toHaveLength(1), { timeout: 3000 });

    // Clearing the draft as soon as the POST returned left an empty field on
    // screen for the length of the fetch.
    expect(within(rowFor(BLOOD_TYPE_KEY)).getByPlaceholderText('Answer…')).toHaveValue('O negative');

    refetches[0]!.resolve(fullCataloguePage({ [BLOOD_TYPE_KEY]: 'O negative' }));

    expect(await savedAnswer(BLOOD_TYPE_KEY)).toHaveTextContent('O negative');
    expect(within(rowFor(BLOOD_TYPE_KEY)).queryByPlaceholderText('Answer…')).not.toBeInTheDocument();
  });

  it('keeps the grid, and the editor, in place while an edit refetches', async () => {
    const refetches = holdRefetches(
      cataloguePage([
        catalogueEntry(BLOOD_TYPE_KEY, 'AB positive, I think?', { source: 'inferred', confidence: 0.41 }),
      ]),
    );

    render(<LifeDetailsSection />);

    fireEvent.click(await screen.findByRole('button', { name: /Edit your answer to/ }));

    const row = rowFor(BLOOD_TYPE_KEY);
    fireEvent.change(within(row).getByRole('textbox'), { target: { value: 'O negative' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(refetches).toHaveLength(1));

    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    // Still the editor, still saving: closing it first showed the OLD answer
    // again for as long as the fetch took.
    expect(within(rowFor(BLOOD_TYPE_KEY)).getByRole('textbox')).toBeInTheDocument();
    expect(screen.queryByText('AB positive, I think?')).not.toBeInTheDocument();

    refetches[0]!.resolve(cataloguePage([catalogueEntry(BLOOD_TYPE_KEY, 'O negative')]));

    expect(await savedAnswer(BLOOD_TYPE_KEY)).toHaveTextContent('O negative');
    expect(within(rowFor(BLOOD_TYPE_KEY)).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('does not let a slow earlier refetch put a later save back to "no answer yet"', async () => {
    // With the grid no longer hidden behind "Loading…", a second row can be
    // answered while the first one's refetch is still out. Whichever refetch was
    // STARTED last is the one that knows about both.
    const refetches = holdRefetches();

    render(<LifeDetailsSection />);

    await screen.findByText('Do you volunteer for any organization?');

    fireEvent.click(within(rowFor(VOLUNTEER_KEY)).getByRole('radio', { name: 'Yes' }));
    await waitFor(() => expect(refetches).toHaveLength(1));

    fireEvent.click(within(rowFor(MORNING_PERSON_KEY)).getByRole('radio', { name: 'Night owl' }));
    await waitFor(() => expect(refetches).toHaveLength(2));

    // The newer refetch lands first and knows about both answers...
    refetches[1]!.resolve(fullCataloguePage({ [VOLUNTEER_KEY]: 'Yes', [MORNING_PERSON_KEY]: 'Night owl' }));
    expect(await savedAnswer(MORNING_PERSON_KEY)).toHaveTextContent('Night owl');

    // ...then the older one arrives, from before the second save.
    await act(async () => {
      refetches[0]!.resolve(fullCataloguePage({ [VOLUNTEER_KEY]: 'Yes' }));
    });

    expect(await savedAnswer(MORNING_PERSON_KEY)).toHaveTextContent('Night owl');
    expect(await savedAnswer(VOLUNTEER_KEY)).toHaveTextContent('Yes');
  });
});

describe('LifeDetailsSection — the 5,000-character cap', () => {
  const OVER = 'a'.repeat(5200);
  const AT_CAP = 'a'.repeat(5000);

  it.each([
    ['a single-line answer', BLOOD_TYPE_KEY, 'Answer…'],
    ['a narrative answer', HOBBY_KEY, 'Your answer…'],
  ])('stops %s at 5,000 characters, however the text got there', async (_name, key, placeholder) => {
    // REFL-07: on an iPhone the field took a 5,003-character run whole. The
    // `maxLength` attribute is not what this asserts — jsdom ignores it, as did
    // the device — the value the component keeps is.
    fetchJson.mockResolvedValue(fullCataloguePage());

    render(<LifeDetailsSection />);

    await screen.findByText(questionFor(key).text);
    const field = within(rowFor(key)).getByPlaceholderText(placeholder);

    fireEvent.change(field, { target: { value: OVER } });

    expect(field).toHaveValue(AT_CAP);
  });

  it('stops the editor at 5,000 characters, and saves exactly that much', async () => {
    fetchJson.mockResolvedValue(cataloguePage([catalogueEntry(BLOOD_TYPE_KEY, 'AB positive')]));

    render(<LifeDetailsSection />);

    fireEvent.click(await screen.findByRole('button', { name: /Edit your answer to/ }));

    const row = rowFor(BLOOD_TYPE_KEY);
    const editor = within(row).getByRole('textbox');

    fireEvent.change(editor, { target: { value: OVER } });
    expect(editor).toHaveValue(AT_CAP);

    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const [patchCall] = callsWithMethod('PATCH');
      expect(patchCall).toBeDefined();
      expect(JSON.parse(patchCall![1]!.body!)).toEqual({ text: AT_CAP });
    });
  });

  it('never leaves half of an emoji at the cut', async () => {
    fetchJson.mockResolvedValue(cataloguePage([catalogueEntry(BLOOD_TYPE_KEY, 'AB positive')]));

    render(<LifeDetailsSection />);

    fireEvent.click(await screen.findByRole('button', { name: /Edit your answer to/ }));

    const editor = within(rowFor(BLOOD_TYPE_KEY)).getByRole('textbox');

    // The 5,000th UTF-16 unit is the emoji's high surrogate; keeping it would
    // store half a character.
    fireEvent.change(editor, { target: { value: `${'a'.repeat(4999)}😀${'b'.repeat(10)}` } });

    expect(editor).toHaveValue('a'.repeat(4999));
  });

  it('lets an answer already over the cap be cut down, without eating its tail', async () => {
    // Written before the cap existed (or through a door that did not enforce
    // it). Truncating it to 5,000 on the first keystroke would delete text the
    // person never chose to delete.
    const legacy = 'x'.repeat(6000);
    fetchJson.mockResolvedValue(cataloguePage([catalogueEntry(BLOOD_TYPE_KEY, legacy)]));

    render(<LifeDetailsSection />);

    fireEvent.click(await screen.findByRole('button', { name: /Edit your answer to/ }));

    const row = rowFor(BLOOD_TYPE_KEY);
    const editor = within(row).getByRole('textbox');
    expect(editor).toHaveValue(legacy);

    fireEvent.change(editor, { target: { value: legacy.slice(0, 5999) } });
    expect(editor).toHaveValue(legacy.slice(0, 5999));

    // It can shrink but not grow.
    fireEvent.change(editor, { target: { value: `${legacy.slice(0, 5999)}yyyy` } });
    expect(editor).toHaveValue(legacy.slice(0, 5999));

    // And it still cannot be saved over the cap: the person is told, nothing is sent.
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));

    expect(await within(row).findByRole('alert')).toHaveTextContent('Keep it under 5,000 characters.');
    expect(callsWithMethod('PATCH')).toHaveLength(0);
  });
});

describe('LifeDetailsSection — the provenance drawer', () => {
  /**
   * The section plus the ONE provider the drawer adds: it is a
   * `ResponsiveDialog`, which reads the device layout to decide dialog-vs-
   * bottom-sheet. Not `renderWithProviders` — this file mocks `@/hooks`
   * wholesale, and that harness pulls `CaptureModalProvider` out of it.
   */
  function renderSection() {
    return render(
      <DeviceLayoutProvider args={[]}>
        <LifeDetailsSection />
      </DeviceLayoutProvider>,
    );
  }

  /** The badge for one row, as the button it now is. */
  function provenanceButton(questionKey: string): HTMLElement {
    return within(rowFor(questionKey)).getByRole('button', {
      name: /Show where this answer came from/,
    });
  }

  it('opens the details drawer from the status badge, with the reasoning and the cited objects', async () => {
    fetchJson.mockResolvedValue(
      cataloguePage([
        catalogueEntry(BLOOD_TYPE_KEY, 'AB positive', {
          source: 'inferred',
          confidence: 0.72,
          rationale: 'A donor-card photo and one message to your GP both say AB positive.',
          // The wrapper exactly as `GET /api/questions/catalogue` sends it:
          // `evidence: { citations: [{ line, type, id, at, voice, snippet }] }`.
          evidence: {
            citations: [
              {
                line: 1,
                type: 'communication',
                id: 'c-1',
                at: '2026-02-02T05:41:00.000Z',
                voice: 'own',
                snippet: 'they told me AB positive at the donation desk',
              },
              {
                line: 4,
                type: 'communication',
                id: 'c-2',
                at: '2026-02-09T11:00:00.000Z',
                voice: 'other',
                snippet: 'your type is AB+, see you in six months',
              },
            ],
            linesShown: 9,
            linesOwn: 5,
            model: 'qwen3:8b',
          },
        }),
      ]),
    );

    renderSection();

    await screen.findByText('AB positive');
    fireEvent.click(provenanceButton(BLOOD_TYPE_KEY));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('What is your blood type?')).toBeInTheDocument();
    expect(within(dialog).getByText('AB positive')).toBeInTheDocument();
    expect(
      within(dialog).getByText('A donor-card photo and one message to your GP both say AB positive.'),
    ).toBeInTheDocument();
    // The confidence, spelled out rather than as the bare band word.
    expect(within(dialog).getByText(/good confidence \(0\.72\)/)).toBeInTheDocument();

    // Both cited objects, and — the point of the attribution work — which of
    // them is the owner speaking and which is somebody else.
    const cited = within(dialog).getAllByTestId('answer-citation');
    expect(cited).toHaveLength(2);
    expect(within(cited[0]!).getByText('they told me AB positive at the donation desk')).toBeInTheDocument();
    expect(within(cited[0]!).getByText('Your words')).toBeInTheDocument();
    expect(within(cited[1]!).getByText("Someone else's words")).toBeInTheDocument();

    // And what those two were picked out of — with the count of THIS list
    // leading, so the retrieval total cannot be read as records being withheld.
    expect(
      within(dialog).getByText('2 records support this answer. 9 were searched, 5 of them your own.'),
    ).toBeInTheDocument();
    // This catalogue row kept no unused lines (older write path), so the panel
    // admits the gap instead of offering an empty "also searched" group.
    expect(within(dialog).queryByTestId('answer-also-searched-toggle')).not.toBeInTheDocument();
    expect(
      within(dialog).getByText('7 more records were searched but not kept on this answer.'),
    ).toBeInTheDocument();
  });

  it('shows the records the model read and did not use, straight off the catalogue row', async () => {
    // End to end through the REST wrapper the Self page actually receives:
    // `GET /api/questions/catalogue` sends `evidence.uncited` alongside
    // `evidence.citations`, and the drawer reads both off the row it already has
    // — no second request to show the provenance of something already on screen.
    fetchJson.mockResolvedValue(
      cataloguePage([
        catalogueEntry(BLOOD_TYPE_KEY, 'AB positive', {
          source: 'inferred',
          confidence: 0.72,
          rationale: 'One message to your GP says AB positive.',
          evidence: {
            citations: [
              {
                line: 1,
                type: 'communication',
                id: 'c-1',
                at: '2026-02-02T05:41:00.000Z',
                voice: 'own',
                snippet: 'they told me AB positive at the donation desk',
              },
            ],
            uncited: [
              {
                line: 2,
                type: 'browser-activity',
                id: 'b-1',
                at: '2026-01-04T09:00:00.000Z',
                voice: 'own',
                snippet: '[Browser] Blood Type Diet — what to eat for AB',
              },
              {
                line: 3,
                type: 'communication',
                id: 'c-9',
                at: '2026-01-09T11:00:00.000Z',
                voice: 'other',
                snippet: 'I am O negative, universal donor apparently',
              },
            ],
            linesShown: 3,
            linesOwn: 2,
            model: 'qwen3:8b',
          },
        }),
      ]),
    );

    renderSection();

    await screen.findByText('AB positive');
    fireEvent.click(provenanceButton(BLOOD_TYPE_KEY));

    const dialog = screen.getByRole('dialog');

    expect(
      within(dialog).getByText('1 record supports this answer. 3 were searched, 2 of them your own.'),
    ).toBeInTheDocument();
    // Everything is accounted for, so nothing claims a shortfall.
    expect(within(dialog).queryByTestId('answer-evidence-shortfall')).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByTestId('answer-also-searched-toggle'));

    const unused = within(dialog).getAllByTestId('answer-uncited-record');
    expect(unused).toHaveLength(2);
    // The inbound line that was retrieved and correctly NOT used — the speaker
    // gate visibly working, which is the whole reason this group is worth
    // showing.
    expect(within(unused[1]!).getByText('I am O negative, universal donor apparently')).toBeInTheDocument();
    expect(within(unused[1]!).getByText("Someone else's words")).toBeInTheDocument();
  });

  it('opens with a graceful empty state when the answer carries no citations', async () => {
    // Every answer written before evidence was recorded looks like this.
    fetchJson.mockResolvedValue(
      cataloguePage([
        catalogueEntry(BLOOD_TYPE_KEY, 'AB positive', {
          source: 'inferred',
          confidence: 0.72,
          rationale: 'Mentioned once in a message to your GP.',
        }),
      ]),
    );

    renderSection();

    await screen.findByText('AB positive');
    fireEvent.click(provenanceButton(BLOOD_TYPE_KEY));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryAllByTestId('answer-citation')).toHaveLength(0);
    expect(within(dialog).getByText(/No source records were kept for this answer/)).toBeInTheDocument();
    // The rest of the panel still works — the drawer is not all-or-nothing.
    expect(within(dialog).getByText('Mentioned once in a message to your GP.')).toBeInTheDocument();
  });

  it('corrects the answer through the SAME edit path — a PATCH carrying text alone', async () => {
    fetchJson.mockResolvedValue(
      cataloguePage([
        catalogueEntry(BLOOD_TYPE_KEY, 'AB positive, I think?', { source: 'inferred', confidence: 0.41 }),
      ]),
    );

    renderSection();

    await screen.findByText('AB positive, I think?');
    fireEvent.click(provenanceButton(BLOOD_TYPE_KEY));
    fireEvent.click(screen.getByRole('button', { name: /Correct this answer/ }));

    // The drawer closes and hands over to the row's own inline editor — there
    // is no second write path in the drawer.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const editor = within(rowFor(BLOOD_TYPE_KEY)).getByRole('textbox');
    expect(editor).toHaveValue('AB positive, I think?');
    fireEvent.change(editor, { target: { value: 'O negative' } });
    fireEvent.click(within(rowFor(BLOOD_TYPE_KEY)).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const [patchCall] = callsWithMethod('PATCH');
      expect(patchCall).toBeDefined();
      expect(patchCall?.[0]).toBe(`/api/answers/${serverIdFor(BLOOD_TYPE_KEY)}-answer`);
      // Text ONLY — naming a source would opt out of the API's user-correction
      // flip and leave the row badged as a machine inference.
      expect(JSON.parse(patchCall![1]!.body!)).toEqual({ text: 'O negative' });
    });

    expect(callsWithMethod('POST')).toHaveLength(0);
  });

  it('leaves an unanswered row without a button to press', async () => {
    fetchJson.mockResolvedValue(cataloguePage([catalogueEntry(BLOOD_TYPE_KEY)]));

    renderSection();

    await screen.findByText('What is your blood type?');
    const row = rowFor(BLOOD_TYPE_KEY);
    expect(
      within(row).queryByRole('button', { name: /Show where this answer came from/ }),
    ).not.toBeInTheDocument();
    expect(within(row).getByText('No answer yet')).toBeInTheDocument();
  });
});
