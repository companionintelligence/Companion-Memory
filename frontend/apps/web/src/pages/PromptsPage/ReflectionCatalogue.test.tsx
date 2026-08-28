import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CatalogueEntry, CataloguePage } from './catalogue';
import { ReflectionCatalogue } from './ReflectionCatalogue';

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: 'tok', expired: false, loading: false, error: null }, {}],
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

  it('says so when a filter combination matches nothing', async () => {
    setFetch(() => ok(pageOf([])));

    render(<ReflectionCatalogue />);

    expect(await screen.findByText('No reflections match these filters.')).toBeInTheDocument();
  });
});
