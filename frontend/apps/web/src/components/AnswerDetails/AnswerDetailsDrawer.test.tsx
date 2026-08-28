import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { AnswerDetailsDrawer, type AnswerDetails } from './AnswerDetailsDrawer';

const INFERRED: AnswerDetails = {
  question: 'Are you a morning person or a night owl?',
  answerText: 'Morning person.',
  source: 'inferred',
  confidence: 0.82,
  rationale: 'You send messages before 7am on most weekdays and almost never after 11pm.',
  answeredAt: '2026-03-04T09:12:00.000Z',
};

function open(details: Partial<AnswerDetails> = {}) {
  return renderWithProviders(
    <AnswerDetailsDrawer open onOpenChange={() => undefined} details={{ ...INFERRED, ...details }} />,
  );
}

function citations() {
  return screen.queryAllByTestId('answer-citation');
}

function panel() {
  return document.querySelector('[data-slot="sheet-content"]');
}

const originalMatchMedia = window.matchMedia;

/** `useDeviceLayout` reads `(max-width: 895px)`; the setup file stubs it to never match. */
function stubViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes('max-width'),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('AnswerDetailsDrawer — the panel itself', () => {
  it('is a side panel anchored to the right on a desktop, not a centred dialog', () => {
    // The owner asked for a drawer and got a modal. `dialog-content` is the
    // centred box; a sheet sliding in from the right is what this must be.
    open();

    const sheet = panel();
    expect(sheet).toBeInTheDocument();
    expect(sheet).toHaveClass('data-[state=open]:slide-in-from-right');
    expect(sheet).toHaveClass('right-0', 'inset-y-0', 'h-full');
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  });

  it('is wider than the stock sheet, because the content is denser than a stock sheet', () => {
    // 24rem leaves ~316px of text inside a citation card: every `text-sm`
    // snippet wraps at ~45 characters and the confidence sentence goes to
    // three lines.
    open();

    expect(panel()).toHaveClass('sm:max-w-[36rem]');
    expect(panel()).not.toHaveClass('sm:max-w-sm');
  });

  it('scrolls its body, not the whole panel, so the header and the edit action stay put', () => {
    open({ onEdit: () => undefined });

    const sheet = panel()!;
    // The frame itself must NOT be the scroller, or the title scrolls away.
    expect(sheet).not.toHaveClass('overflow-y-auto');

    const scroller = sheet.querySelector('.overflow-y-auto');
    expect(scroller).toBeInTheDocument();
    // Without `min-h-0` a flex child refuses to shrink and pushes the footer
    // — and "Correct this answer" with it — off the bottom of the panel.
    expect(scroller).toHaveClass('min-h-0', 'flex-1');
    expect(scroller).toContainElement(screen.getByText('Morning person.'));
    expect(scroller).not.toContainElement(screen.getByRole('button', { name: /Correct this answer/ }));
  });

  it('still announces itself as a dialog, which is what the badge promises', () => {
    // The badge carries `aria-haspopup="dialog"`; anything that is not a
    // dialog here makes that a lie.
    open();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-slot', 'sheet-content');
    expect(dialog).toHaveAccessibleName('Where this answer came from');
    expect(dialog).toHaveAccessibleDescription('Are you a morning person or a night owl?');
  });

  it('slides up from the bottom on a phone — a right-hand panel at 375px is just the screen', () => {
    stubViewport(true);
    open();

    const sheet = panel();
    expect(sheet).toHaveClass('data-[state=open]:slide-in-from-bottom');
    expect(sheet).not.toHaveClass('data-[state=open]:slide-in-from-right');
    // Not the full screen: the row the reader tapped stays visible above it.
    expect(sheet).toHaveClass('max-h-[min(90dvh,var(--vv-height,100dvh))]');
  });
});

describe('AnswerDetailsDrawer — the answer itself', () => {
  it('shows the question and the answer exactly as stored', () => {
    open();

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Are you a morning person or a night owl?')).toBeInTheDocument();
    expect(within(dialog).getByText('Morning person.')).toBeInTheDocument();
  });

  it('spells confidence out in words and in full, not as the compact band alone', () => {
    open();

    // The badge shows "good" and nothing else; here the reader gets the number
    // and what the band is actually claiming.
    expect(screen.getByText(/good confidence \(0\.82\)/)).toBeInTheDocument();
    expect(screen.getByText(/Strongly implied by repeated, consistent evidence/)).toBeInTheDocument();
  });

  it('says so when nothing ever scored the answer, rather than implying zero', () => {
    open({ confidence: null });

    expect(screen.getByText(/Confidence was never recorded/)).toBeInTheDocument();
    expect(screen.queryByText(/0\.00/)).not.toBeInTheDocument();
  });

  it('carries the one-sentence reasoning', () => {
    open();

    expect(
      screen.getByText('You send messages before 7am on most weekdays and almost never after 11pm.'),
    ).toBeInTheDocument();
  });

  it('says the reasoning is missing rather than leaving the section blank', () => {
    open({ rationale: null });

    expect(screen.getByText(/No reasoning sentence was recorded/)).toBeInTheDocument();
  });
});

describe('AnswerDetailsDrawer — evidence', () => {
  it('lists each cited object with its snippet and date', () => {
    open({
      record: {
        citations: [
          {
            type: 'communication',
            id: 'c-1',
            snippet: 'up at 5:40 again, going for a run',
            date: '2026-02-02T05:41:00.000Z',
            voice: 'own',
          },
          {
            type: 'event',
            id: 'e-9',
            label: 'Sunrise hike',
            snippet: '06:00 — Eagle Ridge',
            date: '2026-02-08T06:00:00.000Z',
            voice: 'own',
          },
        ],
      },
    });

    const rows = citations();
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('up at 5:40 again, going for a run')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Message')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/2026/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Sunrise hike')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Event')).toBeInTheDocument();

    // The count that leads is the count of THIS list — see the scope-sentence
    // tests below for why it is no longer on the heading.
    expect(screen.getByText('2 records support this answer.')).toBeInTheDocument();
  });

  it('keeps the owner’s words apart from someone else’s, per citation', () => {
    // The attribution work exists because an INBOUND message is evidence about
    // a conversation, not a first-person statement by the owner. Flattening
    // that away here would undo it at the last step.
    open({
      record: {
        citations: [
          { type: 'communication', snippet: 'heading to bed, early start', voice: 'own' },
          { type: 'communication', snippet: 'you are always up before me', voice: 'other' },
        ],
      },
    });

    const rows = citations();
    expect(rows[0]).toHaveAttribute('data-citation-voice', 'own');
    expect(within(rows[0]!).getByText('Your words')).toBeInTheDocument();
    expect(rows[1]).toHaveAttribute('data-citation-voice', 'other');
    expect(within(rows[1]!).getByText("Someone else's words")).toBeInTheDocument();
  });

  it('admits when a citation’s speaker was never recorded instead of picking a side', () => {
    open({ record: { citations: [{ type: 'content', snippet: 'wakes at 5' }] } });

    const [row] = citations();
    expect(row).toHaveAttribute('data-citation-voice', 'unknown');
    expect(within(row!).getByText('Speaker not recorded')).toBeInTheDocument();
    expect(within(row!).queryByText('Your words')).not.toBeInTheDocument();
  });

  it('leads with what the answer rests on, and only then with what was searched', () => {
    // THE BUG THIS PANEL SHIPPED WITH. The old copy printed "12 records were
    // put in front of the model, 4 of them your own" directly above a list of
    // one, and the owner read it exactly as written: eleven records withheld.
    // The count that leads must be the count of the list underneath it.
    open({
      record: {
        evidence: {
          citations: [{ type: 'communication', snippet: 'up at 5:40', voice: 'own' }],
          linesShown: 12,
          linesOwn: 4,
          model: 'qwen3:8b',
        },
      },
    });

    expect(
      screen.getByText('1 record supports this answer. 12 were searched, 4 of them your own.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/put in front of the model/)).not.toBeInTheDocument();
    expect(screen.getByText('qwen3:8b')).toBeInTheDocument();
  });

  it('shows the records that were searched and NOT used, behind a disclosure', () => {
    // The other half of the same bug: the panel used to assert a retrieval
    // total it could not show. `uncited` is that total, minus the citations,
    // as rows the owner can actually read.
    open({
      record: {
        evidence: {
          citations: [{ type: 'communication', snippet: 'up at 5:40', voice: 'own' }],
          uncited: [
            { type: 'communication', snippet: 'you are always up before me', voice: 'other' },
            { type: 'event', snippet: '06:00 — Eagle Ridge', voice: 'own' },
          ],
          linesShown: 3,
          linesOwn: 2,
          model: 'gemma4:e4b',
        },
      },
    });

    // Collapsed by default: these are the records the answer does NOT rest on.
    expect(screen.queryAllByTestId('answer-uncited-record')).toHaveLength(0);

    const toggle = screen.getByTestId('answer-also-searched-toggle');
    expect(toggle).toHaveTextContent('Also searched: 2 records the model read and did not use');

    fireEvent.click(toggle);

    const unused = screen.queryAllByTestId('answer-uncited-record');
    expect(unused).toHaveLength(2);
    // The own/other distinction is the reason this group is worth showing at
    // all, so it survives into it per row.
    expect(unused[0]).toHaveAttribute('data-citation-voice', 'other');
    expect(within(unused[0]!).getByText("Someone else's words")).toBeInTheDocument();
    expect(unused[1]).toHaveAttribute('data-citation-voice', 'own');
    // …and is summarised, because "retrieved and correctly not used" is the
    // speaker gate working rather than a miss.
    expect(
      screen.getByText(/1 of these are your own records; 1 is someone else's words/),
    ).toBeInTheDocument();

    // The cited row is never mixed into the unused ones.
    expect(citations()).toHaveLength(1);
  });

  it('offers no "also searched" group for a row that never kept its unused lines', () => {
    // `uncited` ABSENT is not `uncited: []`. An empty group would read as
    // "nothing else was searched", contradicting the 12 printed beside it.
    open({
      record: {
        evidence: {
          citations: [{ type: 'communication', snippet: 'up at 5:40', voice: 'own' }],
          linesShown: 12,
          linesOwn: 4,
          model: 'qwen3:8b',
        },
      },
    });

    expect(screen.queryByTestId('answer-also-searched-toggle')).not.toBeInTheDocument();
    // …and the shortfall is admitted rather than left as arithmetic the reader
    // does and gets wrong.
    expect(
      screen.getByText('11 more records were searched but not kept on this answer.'),
    ).toBeInTheDocument();
  });

  it('claims no shortfall when the two lists account for everything searched', () => {
    open({
      record: {
        evidence: {
          citations: [{ type: 'communication', snippet: 'up at 5:40', voice: 'own' }],
          uncited: [{ type: 'event', snippet: '06:00 — Eagle Ridge', voice: 'own' }],
          linesShown: 2,
          linesOwn: 2,
          model: 'gemma4:e4b',
        },
      },
    });

    expect(screen.queryByTestId('answer-evidence-shortfall')).not.toBeInTheDocument();
    expect(
      screen.getByText('1 record supports this answer. 2 were searched, all of them your own.'),
    ).toBeInTheDocument();
  });

  it('renders a graceful empty state for an inferred answer with no citations', () => {
    // The state every answer written before evidence tracking is in.
    open({ record: undefined });

    expect(citations()).toHaveLength(0);
    expect(screen.getByText(/No source records were kept for this answer/)).toBeInTheDocument();
    // Not a count of zero, and not an error.
    expect(screen.getByText('Evidence')).toBeInTheDocument();
  });

  it('survives a citation payload in a shape nobody planned for', () => {
    open({ record: { citations: 'three messages and a calendar entry' } });

    expect(citations()).toHaveLength(0);
    expect(screen.getByText(/No source records were kept/)).toBeInTheDocument();
  });

  it('omits the retrieval line entirely when nothing recorded one', () => {
    open({ record: { evidence: { citations: [{ text: 'x' }] } } });

    expect(citations()).toHaveLength(1);
    expect(screen.queryByText(/put in front of the model/)).not.toBeInTheDocument();
  });
});

describe('AnswerDetailsDrawer — a hand-typed answer', () => {
  const MANUAL: Partial<AnswerDetails> = {
    source: 'user_input',
    confidence: null,
    rationale: null,
  };

  it('says you wrote it, and shows no reasoning section at all', () => {
    open(MANUAL);

    expect(screen.getByText(/You wrote this answer yourself/)).toBeInTheDocument();
    // There is no model reasoning to report, so the heading does not appear
    // empty — it does not appear.
    expect(screen.queryByText('Reasoning')).not.toBeInTheDocument();
  });

  it('explains the empty evidence list differently — nothing was guessed', () => {
    open(MANUAL);

    expect(screen.getByText(/nothing for the appliance to cite/)).toBeInTheDocument();
  });
});

describe('AnswerDetailsDrawer — correcting the answer', () => {
  it('hands back to the caller’s existing edit path and closes first', () => {
    const onEdit = vi.fn();
    const onOpenChange = vi.fn();

    renderWithProviders(
      <AnswerDetailsDrawer open onOpenChange={onOpenChange} details={{ ...INFERRED, onEdit }} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Correct this answer/ }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    // Closed before handing over: every caller reveals its own inline editor
    // underneath, and that editor autofocuses.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('hides the affordance on a surface with no answer-edit path, rather than showing it dead', () => {
    open({ onEdit: undefined });

    expect(screen.queryByRole('button', { name: /Correct this answer/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit this answer/ })).not.toBeInTheDocument();
  });
});

describe('AnswerDetailsDrawer — degenerate input', () => {
  it('never announces a blank dialog when the question did not come back with the answer', () => {
    // `/api/answers` can return an answer whose `question` relation is absent.
    open({ question: '   ' });

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/wording was not returned with the answer/)).toBeInTheDocument();
  });
});

describe('AnswerDetailsDrawer — sources that are neither inferred nor typed', () => {
  it('does not tell the reader they wrote an imported answer', () => {
    // The badge shows one green dot for everything that is not `inferred`,
    // because at 6px that is all it can say. The drawer has room to be exact.
    open({ source: 'imported', confidence: null, rationale: null });

    expect(screen.getByText(/arrived with an import of your own data/)).toBeInTheDocument();
    expect(screen.queryByText(/You wrote this answer yourself/)).not.toBeInTheDocument();
  });

  it('names an observed answer as observed', () => {
    open({ source: 'observed', confidence: null, rationale: null });

    expect(screen.getByText(/recorded from something you actually did/)).toBeInTheDocument();
  });
});

describe('AnswerDetailsDrawer — payloads a happy-path build never sees', () => {
  /** The wrapper exactly as the API sends it. */
  function wrapper(citationCount: number, snippet = 'up at 5:40 again, going for a run') {
    return {
      citations: Array.from({ length: citationCount }, (_unused, index) => ({
        line: index + 1,
        type: 'communication',
        id: `0198f0aa-0000-7000-8000-${String(index).padStart(12, '0')}`,
        at: '2026-02-02T05:41:00.000Z',
        voice: 'own' as const,
        snippet,
      })),
      linesShown: 21,
      linesOwn: 15,
      model: 'gemma4:e4b',
    };
  }

  it('renders every citation of an over-long list rather than dropping or colliding on them', () => {
    // The write path caps at 8, but the column is jsonb: a row written by
    // another build can carry more, and silently showing some of the evidence
    // is worse than showing all of it in a panel that already scrolls.
    open({ record: { evidence: wrapper(20) } });

    expect(citations()).toHaveLength(20);
    expect(
      screen.getByText('20 records support this answer. 21 were searched, 15 of them your own.'),
    ).toBeInTheDocument();
  });

  it('shows an over-long snippet in full instead of truncating the evidence', () => {
    // 280 chars is the writer's cap, not a guarantee — and a drawer that quietly
    // shortens a quote is showing the reader something the model did not read.
    const long = `${'a'.repeat(4000)} END`;
    open({ record: { evidence: wrapper(1, long) } });

    expect(screen.getByText(long)).toBeInTheDocument();
  });

  it('separates "nothing was recorded" from "records were read and none were named"', () => {
    // Different facts. Saying no records were kept while also reporting that 21
    // were put in front of the model contradicts itself on screen.
    open({ record: { evidence: { ...wrapper(0) } } });

    expect(screen.getByText(/named none of them/)).toBeInTheDocument();
    expect(screen.queryByText(/No source records were kept/)).not.toBeInTheDocument();
    expect(screen.getByText(/21 were searched, 15 of them your own/)).toBeInTheDocument();
  });

  it('says nothing was recorded for an inferred answer written before evidence existed', () => {
    // ci.answers.answer_evidence IS NULL on every inferred row older than the
    // column — four of five answers on the reference appliance at the time.
    open({ record: { id: 'a1', answerEvidence: null } });

    expect(screen.getByText(/No source records were kept/)).toBeInTheDocument();
    expect(screen.queryByText(/put in front of the model/)).not.toBeInTheDocument();
  });

  it('renders a citation that names no moment and no speaker without claiming either', () => {
    // `at` is null for every resolution type with no moment of its own, and
    // `voice` is absent on anything an older build wrote.
    open({
      record: {
        evidence: {
          citations: [{ line: 1, type: 'graph-node', id: 'n-1', at: null, snippet: 'TAG (charity)' }],
          linesShown: 3,
          linesOwn: 3,
          model: 'gemma4:e4b',
        },
      },
    });

    const [citation] = citations();
    expect(citation).toHaveAttribute('data-citation-voice', 'unknown');
    expect(within(citation!).getByText('Speaker not recorded')).toBeInTheDocument();
    expect(within(citation!).getByText('Graph node')).toBeInTheDocument();
  });

  it('still shows a citation whose row has since been deleted', () => {
    // Nothing is re-fetched to build this list: the snippet was stored verbatim
    // at inference time, so provenance survives the row being removed. A drawer
    // that resolved ids live would go blank exactly when the reader most needs
    // to see what the appliance had believed.
    open({ record: { evidence: wrapper(1) } });

    expect(screen.getByText('up at 5:40 again, going for a run')).toBeInTheDocument();
    expect(screen.getByText(/0198f0aa-0000-7000-8000-000000000000/)).toBeInTheDocument();
  });

  it('does not offer evidence for an answer the user has since rewritten', () => {
    // AnswerService clears answer_evidence on a user correction, so this is what
    // the drawer gets: a typed answer with no citations and nothing to imply
    // the appliance stands behind the new words.
    open({ source: 'user_input', confidence: null, rationale: null, record: { answerEvidence: null } });

    expect(citations()).toHaveLength(0);
    expect(screen.getByText(/You wrote this yourself/)).toBeInTheDocument();
    expect(screen.queryByText(/put in front of the model/)).not.toBeInTheDocument();
  });
});
