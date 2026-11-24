import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CatalogueEntry, CataloguePage } from './catalogue';
import { ReflectionCatalogue } from './ReflectionCatalogue';

// The real `useSessionAuth` runs on top of this (the catalogue hook gates on it).
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => [{ authToken: 'tok', authenticated: true, expired: false, loading: false, error: null }, {}],
}));

function entry(overrides: Partial<CatalogueEntry> = {}): CatalogueEntry {
  return {
    id: 'q1',
    key: null,
    text: 'What foods are you allergic to?',
    category: 'Health & Body',
    answerTier: 'factual',
    questionType: 'open_ended',
    frequencyRecommendation: null,
    isActive: true,
    isSeedQuestion: true,
    createdByLlm: false,
    isPrivateTo: null,
    forkedFromQuestionId: null,
    timesAsked: 0,
    timesAnswered: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    answer: null,
    ...overrides,
  };
}

function pageOf(data: CatalogueEntry[], overrides: Partial<CataloguePage> = {}): CataloguePage {
  return {
    data,
    totalCount: data.length,
    limit: 25,
    offset: 0,
    ...overrides,
    facets: {
      categories: [{ value: 'Health & Body', count: 157 }],
      answerTiers: [{ value: 'factual', count: 101 }],
      answeredCount: 23,
      unansweredCount: 1261,
      ...overrides.facets,
    },
  };
}

const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

function setFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  vi.stubGlobal('fetch', mock);

  return mock;
}

const methodOf = (init: unknown) => (init as RequestInit | undefined)?.method;
const bodyOf = (init: unknown) => JSON.parse(String((init as RequestInit).body));

afterEach(() => vi.unstubAllGlobals());

describe('ReflectionCatalogue', () => {
  it('lists catalogue reflections with their category and answer type', async () => {
    setFetch(() => ok(pageOf([entry()])));

    render(<ReflectionCatalogue />);

    expect(await screen.findByText('What foods are you allergic to?')).toBeInTheDocument();
    expect(screen.getByText('Health & Body')).toBeInTheDocument();
    expect(screen.getByText('Fact')).toBeInTheDocument();
  });

  it('marks an unanswered reflection as unanswered', async () => {
    setFetch(() => ok(pageOf([entry()])));

    render(<ReflectionCatalogue />);

    expect(await screen.findByText('Unanswered')).toBeInTheDocument();
  });

  it('shows the answer and its provenance when one exists', async () => {
    setFetch(() =>
      ok(
        pageOf([
          entry({
            answer: {
              id: 'a1',
              text: 'Shellfish.',
              source: 'inferred',
              confidence: 0.93,
              rationale: 'Two prior answers mention an allergy.',
              evidence: null,
              answeredAt: '2026-02-01T00:00:00.000Z',
            },
          }),
        ]),
      ),
    );

    render(<ReflectionCatalogue />);

    expect(await screen.findByText('Shellfish.')).toBeInTheDocument();
    // AnswerProvenance: an inferred answer must never read like one the user wrote.
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('Inferred, high confidence')).toHaveClass('sr-only');
  });

  it('reports how much of the catalogue is answered', async () => {
    setFetch(() => ok(pageOf([entry()], { totalCount: 1284 })));

    render(<ReflectionCatalogue />);

    expect(await screen.findByText(/23 answered/)).toBeInTheDocument();
    expect(screen.getByText(/1,261 unanswered/)).toBeInTheDocument();
  });

  it('deactivates a reflection with PATCH isActive rather than DELETE', async () => {
    const fetchMock = setFetch((_url, init) => (init?.method === 'PATCH' ? ok({}) : ok(pageOf([entry()]))));

    render(<ReflectionCatalogue />);
    await screen.findByText('What foods are you allergic to?');

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => methodOf(init) === 'PATCH');
      expect(patch).toBeDefined();
      expect(bodyOf(patch?.[1])).toEqual({ isActive: false });
    });

    expect(fetchMock.mock.calls.some(([, init]) => methodOf(init) === 'DELETE')).toBe(false);
  });

  it('offers reactivation for a deactivated reflection', async () => {
    setFetch(() => ok(pageOf([entry({ isActive: false })])));

    render(<ReflectionCatalogue />);

    expect(await screen.findByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    expect(screen.getByText('Deactivated')).toBeInTheDocument();
  });

  // Shared reflections are read-only — every user on the appliance is asked from
  // them — so editing one copies it first. The badge is how a reader tells their
  // own wording apart from what the appliance shipped.
  it("marks a reflection that is the reader's own copy of a shared one", async () => {
    setFetch(() => ok(pageOf([entry({ forkedFromQuestionId: 'shared-1' })])));

    render(<ReflectionCatalogue />);

    expect(await screen.findByText('Your copy')).toBeInTheDocument();
  });

  it('does not mark a shared reflection as a copy', async () => {
    setFetch(() => ok(pageOf([entry()])));

    render(<ReflectionCatalogue />);

    await screen.findByText('What foods are you allergic to?');
    expect(screen.queryByText('Your copy')).not.toBeInTheDocument();
  });

  it('searches the whole catalogue on the server, not just the current page', async () => {
    const fetchMock = setFetch(() => ok(pageOf([entry()])));

    render(<ReflectionCatalogue />);
    await screen.findByText('What foods are you allergic to?');

    fireEvent.change(screen.getByLabelText('Search reflections'), { target: { value: 'allerg' } });

    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('search=allerg'));
  });

  it('creates a reflection from the New reflection dialog', async () => {
    const fetchMock = setFetch((_url, init) => (init?.method === 'POST' ? ok({}) : ok(pageOf([entry()]))));

    render(<ReflectionCatalogue />);
    await screen.findByText('What foods are you allergic to?');

    fireEvent.click(screen.getByRole('button', { name: /New reflection/ }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Question'), {
      target: { value: 'What is your shoe size?' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create reflection' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => methodOf(init) === 'POST');
      expect(post).toBeDefined();
      expect(bodyOf(post?.[1])).toMatchObject({ text: 'What is your shoe size?' });
    });
  });

  it('opens the edit dialog seeded with the existing wording, and offers no delete', async () => {
    setFetch(() => ok(pageOf([entry()])));

    render(<ReflectionCatalogue />);
    await screen.findByText('What foods are you allergic to?');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Question')).toHaveValue('What foods are you allergic to?');
    // Deleting cascades to ci.answers, so the dialog must not offer it.
    expect(within(dialog).queryByRole('button', { name: /delete/i })).toBeNull();
  });

  // The four filter triggers carried hard pixel widths (190/150/170/180) with
  // no responsive variant, so on a phone they wrapped into ragged rows and the
  // widest overflowed the content column. They fill their cell below `sm` and
  // keep the fixed widths above it.
  it('lets the filter controls fill the width on a phone instead of holding a fixed one', async () => {
    setFetch(() => ok(pageOf([entry()])));

    render(<ReflectionCatalogue />);
    await screen.findByText('What foods are you allergic to?');

    for (const label of [
      'Filter by category',
      'Filter by answer type',
      'Filter by answered state',
      'Filter by status',
    ]) {
      const trigger = screen.getByLabelText(label);
      expect(trigger).toHaveClass('w-full');
      expect(trigger.className).toMatch(/sm:w-\[\d+px]/);
    }
  });

  // Radix caps the open list at the room on the side it opens toward, and with 21 categories on a
  // phone that is upward, all the way to the top edge: under the status bar / Dynamic Island, where a
  // tap on the first entry ("All categories") reaches the status bar instead. The cap has to stop at
  // the safe area on whichever side it opens.
  it('keeps the open category list clear of the status bar and the home indicator', async () => {
    setFetch(() => ok(pageOf([entry()])));

    render(<ReflectionCatalogue />);
    await screen.findByText('What foods are you allergic to?');

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Filter by category' }), { key: 'ArrowDown' });
    await screen.findByRole('option', { name: 'All categories' });

    const list = document.querySelector('[data-slot="select-content"]');
    expect(list?.className).toContain(
      'data-[side=top]:max-h-[calc(var(--radix-select-content-available-height)-var(--safe-area-top,0px))]',
    );
    expect(list?.className).toContain(
      'data-[side=bottom]:max-h-[calc(var(--radix-select-content-available-height)-var(--safe-area-bottom,0px))]',
    );
  });

  // `line-clamp-1` only clamps a block-level box, and the trigger also made the value `display: flex`,
  // which switches the clamp off: a long category ("Relationships & People") was cut off mid-letter
  // with no ellipsis. The value is a truncating block now.
  it('ends a long category name in an ellipsis instead of cutting it off mid-letter', async () => {
    setFetch(() => ok(pageOf([entry()])));

    render(<ReflectionCatalogue />);
    await screen.findByText('What foods are you allergic to?');

    const trigger = screen.getByLabelText('Filter by category');

    expect(trigger.className).toContain('*:data-[slot=select-value]:truncate');
    expect(trigger.className).not.toContain('*:data-[slot=select-value]:flex');
  });

  // The facet counts ignore the category / answer-type / answered filters, so once one narrows the list
  // "23 answered, 1,261 unanswered" no longer adds up to what is listed: it has to say it is a total.
  it('labels the answered and unanswered counts as totals once a filter narrows the list', async () => {
    setFetch(() => ok(pageOf([entry()], { totalCount: 157 })));

    render(<ReflectionCatalogue />);

    const header = await screen.findByText(/1,261 unanswered/);
    expect(header).not.toHaveTextContent('in total');

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Filter by category' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /Health & Body/ }));

    await waitFor(() =>
      expect(screen.getByText(/1,261 unanswered/)).toHaveTextContent('1,261 unanswered in total'),
    );
  });

  it('says so when a filter combination matches nothing', async () => {
    setFetch(() => ok(pageOf([])));

    render(<ReflectionCatalogue />);

    expect(await screen.findByText('No reflections match these filters.')).toBeInTheDocument();
  });
});
