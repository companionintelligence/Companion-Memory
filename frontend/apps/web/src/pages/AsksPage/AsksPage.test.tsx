import type { MockedResponse } from '@apollo/client/testing';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import {
  APPROVE_ASK,
  ASK_ANSWER,
  ASK_DISCLOSURE_HISTORY,
  ASK_DISCLOSURE_SUMMARY,
  MY_HOUSEHOLD_TIERS,
  ASK_INBOX,
  ASK_OUTBOX,
  CREATE_ASK,
  CREATE_ASK_GRANT,
  CREATE_PEER_LINK,
  MY_ASK_GRANTS,
  MY_PEER_LINKS,
  REVOKE_PEER_LINK,
  RUN_ASK,
  UPDATE_ASK_GRANT,
  UPDATE_PEER_LINK,
} from './asksOperations';
import { AsksPage } from './AsksPage';
import { COMPOSER_SHAPES } from './composeRecipients';

vi.mock('@ci/common', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@ci/common');

  return { ...actual, usePageTitle: () => {} };
});

function askRow(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'AskType',
    id: 'ask-1',
    status: 'delivered',
    createdAt: '2026-08-20T00:00:00.000Z',
    consentBasis: null,
    askerId: 'globaluid-abc123',
    peerHandle: null,
    query: {
      __typename: 'AskQueryType',
      queryType: 'photos',
      dataClass: 'photos',
      prompt: 'Lake trip photos?',
    },
    ...overrides,
  };
}

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'AskGrantType',
    id: 'grant-1',
    mode: 'auto',
    queryType: 'photos',
    dataClass: 'photos',
    purpose: null,
    granteeId: 'globaluid-sam001',
    granteePeerLinkId: null,
    revokedAt: null,
    expiresAt: null,
    active: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Repeat a mock so a post-mutation refetch has something to land on. */
function repeated(mock: MockedResponse, times = 3): MockedResponse[] {
  return Array.from({ length: times }, () => mock);
}

function peerRow(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'PeerLinkType',
    id: 'peer-link-1',
    peerHandle: 'ada',
    displayName: null,
    memoryEndpoint: 'https://ada.example/api/peer',
    personEntityId: null,
    avatarUrl: null,
    trustTier: 'stranger',
    status: 'active',
    revokedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function auditRow(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'AskAuditType',
    id: 'audit-1',
    askId: 'ask-1',
    askerId: 'globaluid-abc123',
    peerHandle: null,
    responderId: 'globaluid-me',
    consentBasis: null,
    outcome: 'answered',
    disclosedCount: 2,
    createdAt: '2026-08-19T10:00:00.000Z',
    query: {
      __typename: 'AskQueryType',
      queryType: 'photos',
      dataClass: 'photos',
      prompt: 'Lake trip photos?',
    },
    ...overrides,
  };
}

const inboxOk = (asks: unknown[]) => ({
  request: { query: ASK_INBOX },
  result: { data: { askInbox: asks } },
});
const outboxAsks = (asks: unknown[]) => ({
  request: { query: ASK_OUTBOX },
  result: { data: { askOutbox: asks } },
});
const outboxOk = outboxAsks([]);
const grantsOk = (grants: unknown[]) => ({
  request: { query: MY_ASK_GRANTS },
  result: { data: { myAskGrants: grants } },
});
const peersOk = (links: unknown[]) => ({
  request: { query: MY_PEER_LINKS },
  result: { data: { myPeerLinks: links } },
});
/**
 * The DRILL-IN read. Scoped to one counterparty, because the history tab now
 * opens on the relationship fold and only fetches individual rows once a
 * relationship is opened.
 */
const historyOk = (rows: unknown[], counterpartyKey = SUMMARY_KEY) => ({
  request: { query: ASK_DISCLOSURE_HISTORY, variables: { input: { counterpartyKey } } },
  result: { data: { askDisclosureHistory: { truncated: false, rows } } },
});

const SUMMARY_KEY = 'peer:link-1';

/** The owner's own verdicts about other LOCAL accounts. Absent = the default. */
const householdTiersOk = (rows: unknown[] = []) => ({
  request: { query: MY_HOUSEHOLD_TIERS },
  result: { data: { myHouseholdTiers: rows } },
});

/** The INDEX read — what the history tab shows first. */
const summaryOk = (summaries: unknown[]) => ({
  request: { query: ASK_DISCLOSURE_SUMMARY, variables: { input: undefined } },
  result: { data: { askDisclosureSummary: { truncated: false, summaries } } },
});

const summaryRow = (overrides: Record<string, unknown> = {}) => ({
  __typename: 'AskDisclosureSummaryType',
  key: SUMMARY_KEY,
  askerId: null,
  peerLinkId: 'link-1',
  peerHandle: 'ana',
  total: 2,
  autoAnswered: 1,
  reviewed: 1,
  declined: 0,
  expired: 0,
  itemsDisclosed: 4,
  asksInWindow: 2,
  itemsInWindow: 4,
  firstAt: new Date('2026-08-01T00:00:00.000Z').toISOString(),
  lastAt: new Date('2026-08-20T00:00:00.000Z').toISOString(),
  ...overrides,
});

/** Open the history tab and drill into the one relationship the mocks provide. */
async function openRelationship(): Promise<void> {
  openTab('What I’ve shared');
  const seeAll = await screen.findByRole('button', { name: /See all/i });
  fireEvent.click(seeAll);
}

function renderPage(mocks: readonly MockedResponse[]) {
  // The shared helper supplies every provider the app shell expects (router,
  // auth, features, Apollo) — rendering the page bare fails with the
  // deliberately unhelpful "undefined must be used within the associated
  // Provider".
  return renderWithProviders(<AsksPage />, { mocks, route: '/asks' });
}

const defaultMocks = [
  ...repeated(inboxOk([askRow()])),
  ...repeated(outboxOk),
  ...repeated(grantsOk([])),
  ...repeated(peersOk([])),
  ...repeated(summaryOk([])),
  ...repeated(householdTiersOk()),
];

/** Open a tab by its button label and wait for the switch to take effect. */
function openTab(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('AsksPage', () => {
  it('renders a pending ask from the inbox', async () => {
    renderPage(defaultMocks);

    // AskReviewCard wraps the prompt in typographic quotes, so match on the
    // words rather than pinning the punctuation.
    expect(await screen.findByText(/Lake trip photos\?/)).toBeInTheDocument();
    // The count rides in the tab label so a waiting queue is visible without
    // opening the tab.
    expect(screen.getByText('For you (1)')).toBeInTheDocument();
  });

  it('does not invent a trust tier or a display name', async () => {
    renderPage(defaultMocks);
    await screen.findByText(/Lake trip photos\?/);

    // The mock's five-tier vocabulary must never appear from a wire that
    // carries no tier — asserting an unearned trust level is the exact defect
    // this binding exists to avoid.
    for (const tier of ['household', 'family', 'trusted', 'stranger']) {
      expect(screen.queryByText(tier)).toBeNull();
    }

    // No grant matched, so the honest label is shown and the asker is opaque —
    // and the shortened id reads as a truncation, not as corrupted text.
    expect(screen.getByText('no standing grant')).toBeInTheDocument();
    // Twice, not once: the card names the asker AND the quote is attributed to
    // them, which is the whole point of AskerQuote.
    expect(screen.getAllByText(/Peer …abc123/).length).toBeGreaterThan(0);
  });

  it('shows a real photo for an asker resolved via myPeerLinks, and initials for one that is not', async () => {
    renderPage([
      ...repeated(
        inboxOk([
          askRow({ id: 'ask-peer', peerHandle: 'ada', askerId: null }),
          askRow({ id: 'ask-local', peerHandle: null, askerId: 'globaluid-abc123' }),
        ]),
      ),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([peerRow({ peerHandle: 'ada', avatarUrl: '/avatars/ada.png' })])),
      ...repeated(historyOk([])),
    ]);

    await screen.findByText('For you (2)');

    // The peer-handled ask joins against myPeerLinks and gets a real photo.
    const photo = screen.getByRole('img', { name: 'ada' });
    expect(photo.tagName).toBe('IMG');
    expect(photo).toHaveAttribute('src', '/static/avatars/ada.png');

    // The local, opaque-id ask has nothing to resolve a photo from — it still
    // renders a real avatar (initials on a deterministic colour), not a
    // broken image and not the bare truncated-id text alone.
    const initials = screen.getByRole('img', { name: 'Peer …abc123' });
    expect(initials.tagName).not.toBe('IMG');
    expect(initials).toHaveTextContent('PA');
  });

  it('shows the structured scope, which is all that is on the wire', async () => {
    renderPage(defaultMocks);

    await waitFor(() => expect(screen.getByText(/photos · photos/)).toBeInTheDocument());
  });

  it('never lets the declared data class read as a narrower search than runs', async () => {
    // `location` is not in AskExecutorService's hint table, so the executed
    // search is unfiltered across the responder's whole memory.
    renderPage([
      ...repeated(
        inboxOk([
          askRow({
            query: {
              __typename: 'AskQueryType',
              queryType: 'location',
              dataClass: 'location',
              prompt: 'Where do you live?',
            },
          }),
        ]),
      ),
      outboxOk,
      ...repeated(grantsOk([])),
    ]);

    expect(await screen.findByText(/every kind of thing in your memory/i)).toBeInTheDocument();
  });

  it('does not present an already-authorized ask as a consent decision', async () => {
    renderPage([
      ...repeated(inboxOk([askRow({ status: 'delivered', consentBasis: 'grant-1' })])),
      outboxOk,
      ...repeated(grantsOk([])),
    ]);

    expect(await screen.findByText('Already authorized')).toBeInTheDocument();
    // The quarantine warning belongs to asks nothing covers, and to no others.
    expect(screen.queryByText(/No standing grant covers this request/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Answer now' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve and answer' })).toBeNull();
  });

  it('sends the owner’s disclosure choice on the wire', async () => {
    const runVariables: Record<string, unknown>[] = [];

    renderPage([
      ...repeated(inboxOk([askRow()])),
      outboxOk,
      ...repeated(grantsOk([])),
      {
        request: { query: APPROVE_ASK, variables: { id: 'ask-1' } },
        result: { data: { approveAsk: { __typename: 'AskPayload', success: true } } },
      },
      {
        request: {
          query: RUN_ASK,
          variables: { id: 'ask-1', redactItemIds: [], disclosureForm: 'boolean' },
        },
        result: (variables: Record<string, unknown>) => {
          runVariables.push(variables);

          return {
            data: {
              runAsk: {
                __typename: 'RunAskPayload',
                success: true,
                disclosedCount: 0,
                withheldCount: 0,
              },
            },
          };
        },
      },
    ]);

    await screen.findByText(/Lake trip photos\?/);
    fireEvent.click(screen.getByRole('button', { name: /At most yes or no/i }));

    // The ladder is worthless unless the chosen form reaches runAsk — the whole
    // point is that the owner can cap an answer without declining outright.
    await waitFor(() => expect(runVariables).toHaveLength(1));
    expect(runVariables[0]).toMatchObject({ disclosureForm: 'boolean' });
  });

  it('does not let a failed approval look like one that worked', async () => {
    renderPage([
      ...repeated(inboxOk([askRow()])),
      outboxOk,
      ...repeated(grantsOk([])),
      {
        request: { query: APPROVE_ASK, variables: { id: 'ask-1' } },
        error: new Error('approve rejected'),
      },
    ]);

    await screen.findByText(/Lake trip photos\?/);
    fireEvent.click(screen.getByRole('button', { name: 'Approve and answer' }));

    // The gesture is the owner consenting to a disclosure. A silent failure
    // leaves them believing they answered someone they did not.
    expect(await screen.findByText(/didn.t go through/i)).toBeInTheDocument();
    expect(screen.getByText(/approve rejected/i)).toBeInTheDocument();
  });

  it('does not claim an empty inbox when the request failed', async () => {
    renderPage([
      { request: { query: ASK_INBOX }, error: new Error('network down') },
      outboxOk,
      ...repeated(grantsOk([])),
    ]);

    expect(await screen.findByText(/Couldn.t load your inbox/i)).toBeInTheDocument();
    // "we could not ask" must never render as "nothing is being shared".
    expect(screen.queryByText(/No one is waiting on you/i)).toBeNull();
  });

  it('does not claim there are no standing grants when that request failed', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      outboxOk,
      { request: { query: MY_ASK_GRANTS }, error: new Error('network down') },
    ]);

    await screen.findByText(/No one is waiting on you/i);
    fireEvent.click(screen.getByRole('button', { name: 'Who can ask me what' }));

    expect(await screen.findByText(/Couldn.t load your standing grants/i)).toBeInTheDocument();
    // "Every ask comes to you for review" is a promise about consent. It must
    // never be printed on the strength of a request that never answered.
    expect(screen.queryByText(/No standing grants/i)).toBeNull();
  });

  it('does not claim you have sent nothing when that request failed', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      { request: { query: ASK_OUTBOX }, error: new Error('network down') },
      ...repeated(grantsOk([])),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    fireEvent.click(screen.getByRole('button', { name: 'Sent' }));

    expect(await screen.findByText(/Couldn.t load the asks you have sent/i)).toBeInTheDocument();
    expect(screen.queryByText(/haven't asked anyone anything yet/i)).toBeNull();
  });

  it('does not claim there are no standing grants while that query is in flight', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      outboxOk,
      // Never resolves: the grants tab must stay silent rather than assert an
      // empty consent matrix on the strength of the OTHER queries settling.
      { request: { query: MY_ASK_GRANTS }, delay: 30_000, result: { data: { myAskGrants: [] } } },
    ]);

    await screen.findByText(/No one is waiting on you/i);
    fireEvent.click(screen.getByRole('button', { name: 'Who can ask me what' }));

    expect(screen.queryByText(/No standing grants/i)).toBeNull();
  });

  it('really changes a grant mode instead of claiming it cannot', async () => {
    const updates: Record<string, unknown>[] = [];

    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([grantRow()])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
      {
        request: { query: UPDATE_ASK_GRANT, variables: { id: 'grant-1', input: { mode: 'block' } } },
        result: (variables: Record<string, unknown>) => {
          updates.push(variables);

          return {
            data: {
              updateAskGrant: {
                __typename: 'AskGrantPayload',
                success: true,
                grant: {
                  __typename: 'AskGrantType',
                  id: 'grant-2',
                  mode: 'block',
                  expiresAt: null,
                  active: true,
                  revokedAt: null,
                  supersedesGrantId: 'grant-1',
                },
              },
            },
          };
        },
      },
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Who can ask me what');

    const block = await screen.findByRole('button', { name: 'Blocked' });

    // The page used to print this sentence beside three dead buttons while
    // `updateAskGrant` sat unselected on the schema. Telling an owner a consent
    // control does not exist is the same class of defect as faking one: they
    // plan around it, and "revoke and recreate" leaves a window with no grant
    // at all.
    expect(screen.queryByText(/Changing a grant’s mode isn’t available yet/i)).toBeNull();
    expect(block).toBeEnabled();

    fireEvent.click(block);

    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ id: 'grant-1', input: { mode: 'block' } });
  });

  it('makes turning a grant to automatic take a second, explicit tap', async () => {
    const updates: Record<string, unknown>[] = [];

    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([grantRow({ mode: 'review' })])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
      {
        request: { query: UPDATE_ASK_GRANT, variables: { id: 'grant-1', input: { mode: 'auto' } } },
        result: (variables: Record<string, unknown>) => {
          updates.push(variables);

          return {
            data: {
              updateAskGrant: {
                __typename: 'AskGrantPayload',
                success: true,
                grant: {
                  __typename: 'AskGrantType',
                  id: 'grant-2',
                  mode: 'auto',
                  expiresAt: null,
                  active: true,
                  revokedAt: null,
                  supersedesGrantId: 'grant-1',
                },
              },
            },
          };
        },
      },
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Who can ask me what');

    fireEvent.click(await screen.findByRole('button', { name: 'Answers automatically' }));

    // `auto` is the ONLY mode that discloses without the owner present, so one
    // stray tap on a three-button row must not arm it.
    expect(updates).toHaveLength(0);
    expect(await screen.findByRole('alertdialog', { name: /automatic/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Yes, answer automatically/i }));

    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ input: { mode: 'auto' } });
  });

  it('says a grant has no end date rather than leaving the owner to guess', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([grantRow({ expiresAt: null, active: true })])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Who can ask me what');

    // Silence here reads as "I must have set one". The page used to go further
    // and assert that expiry was not on the wire at all, which was false.
    expect(await screen.findByText(/No end date — this does not expire/i)).toBeInTheDocument();
    expect(screen.queryByText(/isn’t on the wire yet/i)).toBeNull();
  });

  it('does not present a lapsed grant as one the owner withdrew', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(
        grantsOk([grantRow({ expiresAt: '2026-07-01T23:59:59.999Z', active: false, revokedAt: null })]),
      ),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Who can ask me what');

    // Two different facts. "Revoked" credits the owner with a decision they
    // never made; "Lapsed" is what actually happened.
    expect(await screen.findByText('Lapsed')).toBeInTheDocument();
    expect(screen.queryByText('Revoked')).toBeNull();
    expect(screen.queryByText('Auto')).toBeNull();
  });

  it('never renders a revoked grant as live consent', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([grantRow({ revokedAt: '2026-08-03T00:00:00.000Z', active: false })])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    fireEvent.click(screen.getByRole('button', { name: 'Who can ask me what' }));

    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(screen.getByText(/no longer in force/i)).toBeInTheDocument();
    // An `auto` badge on a withdrawn grant reads as "this still answers".
    expect(screen.queryByText('Auto')).toBeNull();
  });

  // ── Sending an ask ────────────────────────────────────────────────────────

  it('offers only people the owner already has a relationship with', async () => {
    renderPage([
      ...repeated(inboxOk([askRow({ askerId: 'globaluid-abc123' })])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([grantRow({ granteeId: 'globaluid-sam001' })])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
    ]);

    await screen.findByText(/Lake trip photos\?/);
    openTab('Ask someone');

    // Both ids come from rows already rendered elsewhere on this page, so the
    // picker discloses nothing new. There is deliberately NO search box: a
    // user-lookup query would be an enumeration surface over everybody on an
    // appliance holding one person's whole life.
    expect(await screen.findByRole('radio', { name: /Peer …sam001/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Peer …abc123/ })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
  });

  it('sends exactly the structured ask it previewed', async () => {
    const created: Record<string, unknown>[] = [];

    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([grantRow({ granteeId: 'globaluid-sam001' })])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
      {
        request: {
          query: CREATE_ASK,
          variables: {
            input: {
              responderId: 'globaluid-sam001',
              query: { queryType: 'relationship', dataClass: undefined, prompt: 'Do you know Carol?' },
            },
          },
        },
        result: (variables: Record<string, unknown>) => {
          created.push(variables);

          return {
            data: {
              createAsk: {
                __typename: 'CreateAskPayload',
                success: true,
                ask: {
                  __typename: 'AskType',
                  id: 'ask-new',
                  status: 'delivered',
                  createdAt: '2026-08-21T00:00:00.000Z',
                  responderId: 'globaluid-sam001',
                  peerHandle: null,
                  query: {
                    __typename: 'AskQueryType',
                    queryType: 'relationship',
                    dataClass: null,
                    prompt: 'Do you know Carol?',
                  },
                },
              },
            },
          };
        },
      },
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Ask someone');

    fireEvent.click(await screen.findByRole('radio', { name: /Do you know…\?/ }));
    fireEvent.change(screen.getByPlaceholderText(/lake trip/i), {
      target: { value: 'Do you know Carol?' },
    });

    // The preview IS the wire format — {queryType, dataClass, prompt} is the
    // whole of AskQueryInput — so a mismatch between what is shown and what is
    // sent is a hidden widening.
    expect(screen.getByText('relationship')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send ask' }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({
      input: { responderId: 'globaluid-sam001', query: { queryType: 'relationship' } },
    });
  });

  it('does not leave a green “Sent.” standing over a send that failed', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([grantRow({ granteeId: 'globaluid-sam001' })])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
      { request: { query: CREATE_ASK }, variableMatcher: () => true, error: new Error('send rejected') },
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Ask someone');

    fireEvent.change(await screen.findByPlaceholderText(/lake trip/i), {
      target: { value: 'Do you have the lake photos?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send ask' }));

    expect(await screen.findByText(/didn.t go through/i)).toBeInTheDocument();
    expect(screen.queryByText('Sent.')).toBeNull();
  });

  it('retires the green “Sent.” the moment the NEXT ask is sent, not when it lands', async () => {
    const ok = {
      request: { query: CREATE_ASK },
      variableMatcher: () => true,
      result: {
        data: {
          createAsk: {
            __typename: 'CreateAskPayload',
            success: true,
            ask: {
              __typename: 'AskType',
              id: 'ask-new',
              status: 'delivered',
              createdAt: '2026-08-21T00:00:00.000Z',
              responderId: 'globaluid-sam001',
              peerHandle: null,
              query: {
                __typename: 'AskQueryType',
                queryType: 'relationship',
                dataClass: null,
                prompt: 'first',
              },
            },
          },
        },
      },
    };

    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([grantRow({ granteeId: 'globaluid-sam001' })])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
      ok,
      { request: { query: CREATE_ASK }, variableMatcher: () => true, error: new Error('send rejected') },
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Ask someone');

    const prompt = await screen.findByPlaceholderText(/lake trip/i);

    fireEvent.change(prompt, { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send ask' }));
    expect(await screen.findByText('Sent.')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/lake trip/i), { target: { value: 'second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send ask' }));

    // Checked SYNCHRONOUSLY, while the second request is still in flight. A
    // confirmation belongs to one specific ask; clearing it only when the next
    // one fails leaves the old "Sent." standing over an ask that has not landed,
    // which reads as though the second one had already succeeded.
    expect(screen.queryByText('Sent.')).toBeNull();

    expect(await screen.findByText(/didn.t go through/i)).toBeInTheDocument();
    expect(screen.queryByText('Sent.')).toBeNull();
  });

  it('carries a shape’s dataClass onto the wire, exactly as it previewed it', async () => {
    const created: Record<string, unknown>[] = [];

    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([grantRow({ granteeId: 'globaluid-sam001' })])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
      {
        request: { query: CREATE_ASK },
        variableMatcher: () => true,
        result: (variables: Record<string, unknown>) => {
          created.push(variables);

          return {
            data: {
              createAsk: {
                __typename: 'CreateAskPayload',
                success: true,
                ask: {
                  __typename: 'AskType',
                  id: 'ask-new',
                  status: 'delivered',
                  createdAt: '2026-08-21T00:00:00.000Z',
                  responderId: 'globaluid-sam001',
                  peerHandle: null,
                  query: {
                    __typename: 'AskQueryType',
                    queryType: 'content',
                    dataClass: 'photos',
                    prompt: 'Do you have the lake photos?',
                  },
                },
              },
            },
          };
        },
      },
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Ask someone');

    fireEvent.click(await screen.findByRole('radio', { name: /Do you have photos of…\?/ }));
    fireEvent.change(screen.getByPlaceholderText(/lake trip/i), {
      target: { value: 'Do you have the lake photos?' },
    });

    // This shape is the ONE carrying a dataClass, so it is the only one that can
    // catch a composer that previews a class and then sends none (or, worse,
    // sends one it never showed). The preview names the pair `AskQueryInput`
    // puts on the wire: archetype, then class.
    //
    // The two used to be the same word. `queryType: 'photos'` was NOT an
    // archetype, and `parseAskQueryType` rejects anything outside
    // {relationship, content, availability, attribute, identity} with a 400 —
    // so this shape's Send button always failed against a real server, and this
    // test asserted the failing value. It passed only because CREATE_ASK is
    // mocked here and never reaches the resolver. The archetype is `content`;
    // `photos` is the class narrowed within it.
    expect(screen.getByText('content')).toBeInTheDocument();
    expect(screen.getByText('photos')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send ask' }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({
      input: { query: { queryType: 'content', dataClass: 'photos' } },
    });
  });

  // ═══ THE GRANTS TAB USED TO BE PERMANENTLY READ-ONLY ═══
  //
  // `GrantManager` carries the "New grant" button and renders it only when an
  // `onAddGrant` handler is passed; the page never passed one, and no
  // CREATE_ASK_GRANT document existed on the client at all. So the Grants tab
  // could revoke and re-mode existing grants and never write one — and because
  // `composeRecipients` is built from grants + inbox + outbox with no directory
  // behind it, a box where nobody had ever asked anybody anything had no way
  // out of "There is nobody to ask yet." at all.
  it('offers a way to write the first grant from the empty state, not just the populated one', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Who can ask me what');

    // The empty state is the one screen a new owner actually sees, so it is the
    // one that most needs the control.
    expect(await screen.findByText(/No standing grants/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New grant' }));

    expect(await screen.findByText(/Let someone ask you/i)).toBeInTheDocument();
  });

  it('writes a grant naming an archetype the server accepts, defaulting to review', async () => {
    const created: Record<string, unknown>[] = [];

    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
      {
        request: { query: CREATE_ASK_GRANT },
        variableMatcher: () => true,
        result: (variables: Record<string, unknown>) => {
          created.push(variables);

          return {
            data: {
              createAskGrant: {
                __typename: 'AskGrantPayload',
                success: true,
                grant: grantRow({ id: 'grant-new', mode: 'review', queryType: 'relationship' }),
              },
            },
          };
        },
      },
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Who can ask me what');
    fireEvent.click(await screen.findByRole('button', { name: 'New grant' }));

    fireEvent.change(screen.getByPlaceholderText(/address they gave you/i), {
      target: { value: 'globaluid-sam001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create grant' }));

    await waitFor(() => expect(created).toHaveLength(1));

    // `review` — not `auto` — is the default. `auto` is the one setting on this
    // page that discloses without the owner present, so arriving at it must take
    // a deliberate tap rather than an unread default.
    expect(created[0]).toMatchObject({
      input: { granteeId: 'globaluid-sam001', queryType: 'relationship', mode: 'review' },
    });
  });

  // The grant form and the composer are matched on (grantee, queryType), so a
  // grant that names a kind of question the composer cannot send matches
  // nothing — the owner would be reading live protection off a dead row.
  it('offers the same question shapes for a grant as for an ask', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Who can ask me what');
    fireEvent.click(await screen.findByRole('button', { name: 'New grant' }));

    const shapes = screen.getByRole('radiogroup', { name: 'What may they ask about' });

    for (const shape of COMPOSER_SHAPES) {
      expect(within(shapes).getByRole('radio', { name: shape.label })).toBeInTheDocument();
    }
  });

  it('says a linked peer cannot be asked from here rather than omitting them', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([peerRow()])),
      ...repeated(historyOk([])),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Ask someone');

    // Dropping them silently would render "you have no relationship with this
    // person", which is a claim and not a loading state.
    expect(await screen.findByText(/cannot ask from here/i)).toBeInTheDocument();
    expect(screen.getByText(/ada/)).toBeInTheDocument();
  });

  // ── Reading an answer ─────────────────────────────────────────────────────

  it('shows the asker the answer, and claims no provenance the wire withheld', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(
        outboxAsks([
          {
            __typename: 'AskType',
            id: 'ask-1',
            status: 'answered',
            createdAt: '2026-08-20T00:00:00.000Z',
            responderId: 'globaluid-sam001',
            peerHandle: null,
            query: {
              __typename: 'AskQueryType',
              queryType: 'relationship',
              dataClass: null,
              prompt: 'Do you know Carol?',
            },
          },
        ]),
      ),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
      ...repeated({
        request: { query: ASK_ANSWER, variables: { id: 'ask-1' } },
        result: {
          data: {
            askAnswer: {
              __typename: 'AskAnswerType',
              id: 'answer-1',
              askId: 'ask-1',
              form: 'boolean',
              answerSource: 'self',
              summary: 'They confirmed a match.',
              // Masked for the asker by AskAnswerType.toType — a real zero and
              // a withheld zero look identical on the wire.
              disclosedCount: 0,
              withheldCount: 0,
              consentBasis: null,
              createdAt: '2026-08-20T01:00:00.000Z',
              items: [],
            },
          },
        },
      }),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Sent');

    fireEvent.click(await screen.findByRole('button', { name: 'Read answer' }));

    expect(await screen.findByText('They confirmed a match.')).toBeInTheDocument();
    // The asker's copy carries no auto/reviewed flag and a null consent basis.
    // Defaulting either would print a provenance claim the server never made.
    expect(
      screen.getByText(/whether Peer …sam001 saw this personally is not disclosed to you/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/reviewed by/i)).toBeNull();
    expect(screen.queryByText(/automatically/i)).toBeNull();
  });

  it('never renders a masked zero as “nothing was shared”', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(
        outboxAsks([
          {
            __typename: 'AskType',
            id: 'ask-1',
            status: 'answered',
            createdAt: '2026-08-20T00:00:00.000Z',
            responderId: 'globaluid-sam001',
            peerHandle: null,
            query: {
              __typename: 'AskQueryType',
              queryType: 'relationship',
              dataClass: null,
              prompt: 'Do you know Carol?',
            },
          },
        ]),
      ),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
      ...repeated({
        request: { query: ASK_ANSWER, variables: { id: 'ask-1' } },
        result: {
          data: {
            askAnswer: {
              __typename: 'AskAnswerType',
              id: 'answer-1',
              askId: 'ask-1',
              form: 'boolean',
              answerSource: 'self',
              summary: 'They confirmed a match.',
              disclosedCount: 0,
              withheldCount: 0,
              consentBasis: null,
              createdAt: '2026-08-20T01:00:00.000Z',
              items: [],
            },
          },
        },
      }),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Sent');
    fireEvent.click(await screen.findByRole('button', { name: 'Read answer' }));

    // The zero means "you are not being told", and saying so is the difference
    // between a withholding and a false reassurance.
    expect(await screen.findByText(/are not disclosed to you/i)).toBeInTheDocument();
    expect(screen.queryByText(/no individual items were sent/i)).toBeNull();
  });

  it('offers no way to read an answer for an ask that has none', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(
        outboxAsks([
          {
            __typename: 'AskType',
            id: 'ask-1',
            status: 'delivered',
            createdAt: '2026-08-20T00:00:00.000Z',
            responderId: 'globaluid-sam001',
            peerHandle: null,
            query: {
              __typename: 'AskQueryType',
              queryType: 'relationship',
              dataClass: null,
              prompt: 'Do you know Carol?',
            },
          },
        ]),
      ),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Sent');

    // `askerVisibleStatus` collapses every state the asker may not know about
    // down to `delivered`, so a Read-answer button on a non-answered row would
    // be a question the asker is not entitled to have answered.
    expect(await screen.findByText(/Waiting for them/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read answer' })).toBeNull();
  });

  // ── What I've shared ──────────────────────────────────────────────────────

  it('separates a grant answering for you from you answering', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(summaryOk([summaryRow()])),
      ...repeated(
        historyOk([
          auditRow({ id: 'audit-1', outcome: 'auto_answered', consentBasis: 'grant-1' }),
          auditRow({ id: 'audit-2', outcome: 'answered', consentBasis: null }),
        ]),
      ),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    await openRelationship();

    // Collapsing these into one "Answered" badge hides the only outcome in the
    // list an owner might want to go and stop — a rule they wrote once, acting
    // on their behalf while they were not looking.
    expect(await screen.findByText('Answered automatically')).toBeInTheDocument();
    expect(screen.getByText('You answered')).toBeInTheDocument();
    expect(screen.getByText(/without asking you/i)).toBeInTheDocument();
  });

  it('does not print “0 items shared” over an answer that still told them something', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(summaryOk([summaryRow()])),
      ...repeated(historyOk([auditRow({ outcome: 'answered', disclosedCount: 0 })])),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    await openRelationship();

    // A yes/no discloses no items and is still a disclosure. Rendering it the
    // same as a declined row makes the owner's own receipt understate itself.
    expect(await screen.findByText(/an answer is still something shared/i)).toBeInTheDocument();
  });

  it('lets the owner demote a LOCAL grantee — the control G6 said did not exist', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(
        grantsOk([
          {
            __typename: 'AskGrantType',
            id: 'g1',
            mode: 'auto',
            queryType: 'content',
            dataClass: 'photos',
            purpose: null,
            granteeId: 'user_sam',
            granteePeerLinkId: null,
            revokedAt: null,
            expiresAt: null,
            active: true,
            useCount: 0,
            lastUsedAt: null,
            createdAt: new Date('2026-08-01T00:00:00.000Z').toISOString(),
          },
        ]),
      ),
      ...repeated(peersOk([])),
      ...repeated(summaryOk([])),
      ...repeated(householdTiersOk()),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Who can ask me what');

    // Until `ci.household_tiers` existed, every local asker was `household` —
    // the widest ceiling on the ladder, exempt from the sensitive-class floor,
    // with nothing anywhere that could say otherwise.
    const select = await screen.findByRole('combobox', { name: /Trust tier for/i });
    expect(select).toHaveValue('household');
  });

  it('shows a peer’s tier as a LABEL, not a control — it belongs on their link', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(
        grantsOk([
          {
            __typename: 'AskGrantType',
            id: 'g1',
            mode: 'auto',
            queryType: 'content',
            dataClass: 'photos',
            purpose: null,
            granteeId: null,
            granteePeerLinkId: 'link-1',
            revokedAt: null,
            expiresAt: null,
            active: true,
            useCount: 0,
            lastUsedAt: null,
            createdAt: new Date('2026-08-01T00:00:00.000Z').toISOString(),
          },
        ]),
      ),
      ...repeated(peersOk([])),
      ...repeated(summaryOk([])),
      ...repeated(householdTiersOk()),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('Who can ask me what');

    await screen.findByText(/tier not loaded/i);
    expect(screen.queryByRole('combobox', { name: /Trust tier for/i })).toBeNull();
  });

  it('opens the history on RELATIONSHIPS, not on a flat event list', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(summaryOk([summaryRow()])),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('What I’ve shared');

    // The fold's whole reason for existing: "what has Ana been getting?" is
    // answered without scrolling and tallying.
    expect(await screen.findByText('ana')).toBeInTheDocument();
    expect(screen.getByText(/1 answered automatically/)).toBeInTheDocument();
    expect(screen.getByText(/4 items shared/)).toBeInTheDocument();
  });

  it('does not read a single audit row until a relationship is opened', async () => {
    // The index must not be built by loading every row — that is the unbounded
    // read the fold replaces. With no drill-in mock supplied, a page that
    // fetched the flat list here would error rather than render.
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(summaryOk([summaryRow()])),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('What I’ve shared');

    expect(await screen.findByText('ana')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t load/i)).toBeNull();
  });

  it('can get back to the index from a relationship', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(summaryOk([summaryRow()])),
      ...repeated(historyOk([auditRow({ outcome: 'answered' })])),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    await openRelationship();
    expect(await screen.findByText('You answered')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /All relationships/i }));

    expect(await screen.findByRole('button', { name: /See all/i })).toBeInTheDocument();
  });

  it('says the totals are minimums when the fold ran over a capped read', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated({
        request: { query: ASK_DISCLOSURE_SUMMARY, variables: { input: undefined } },
        result: { data: { askDisclosureSummary: { truncated: true, summaries: [summaryRow()] } } },
      }),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('What I’ve shared');

    // A completeness surface presenting a floor as a total is the failure the
    // flag was put on the wire to prevent.
    expect(await screen.findByText(/these totals are minimums/i)).toBeInTheDocument();
  });

  it('does not claim nothing has been shared when that request failed', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      {
        request: { query: ASK_DISCLOSURE_SUMMARY, variables: { input: undefined } },
        error: new Error('network down'),
      },
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('What I’ve shared');

    expect(await screen.findByText(/Couldn.t load what you have shared/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing has been shared/i)).toBeNull();
  });

  // ── Peers and the trust ceiling ───────────────────────────────────────────

  it('shows the trust tier and what it actually caps', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([peerRow({ trustTier: 'stranger' })])),
      ...repeated(historyOk([])),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('People I’m linked to');

    // The tier is the ceiling on everything this peer can ever be told, on top
    // of any grant. An owner who cannot read it cannot govern it — so it is
    // both stated (the badge) and changeable (the pressed dial button).
    expect(await screen.findByRole('button', { name: 'Stranger', pressed: true })).toBeInTheDocument();
    // Matched narrowly: the add-peer form carries its own "yes-or-no at most …
    // location is never disclosed" copy, so a loose location match finds two
    // nodes and the ceiling note is not the one being asserted.
    expect(screen.getByText(/yes or no at most/i)).toBeInTheDocument();
    // `strictestIn` gives an ask that names no class the tier's FLOOR, and
    // stranger's floor is `none` — so the narrowest tier answers an unlabelled
    // ask with nothing at all. That is the fact an owner picking this tier is
    // actually choosing, and it is not derivable from the `'*'` row alone.
    expect(screen.getByText(/names no data class gets nothing at all/i)).toBeInTheDocument();
  });

  it('lowers trust on the first tap and raises it only on the second', async () => {
    const updates: Record<string, unknown>[] = [];
    const link = (tier: string) => ({
      __typename: 'PeerLinkType',
      id: 'peer-link-1',
      peerHandle: 'ada',
      displayName: null,
      memoryEndpoint: 'https://ada.example/api/peer',
      avatarUrl: null,
      trustTier: tier,
      status: 'active',
      revokedAt: null,
    });

    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([peerRow({ trustTier: 'peer' })])),
      ...repeated(historyOk([])),
      ...repeated({
        request: {
          query: UPDATE_PEER_LINK,
          variables: { input: { id: 'peer-link-1', trustTier: 'stranger' } },
        },
        result: (variables: Record<string, unknown>) => {
          updates.push(variables);

          return {
            data: {
              updatePeerLink: {
                __typename: 'PeerLinkPayload',
                success: true,
                peerLink: link('stranger'),
              },
            },
          };
        },
      }),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('People I’m linked to');

    // Narrowing is the gesture you least want to slow down: nobody should have
    // to sit through a dialog at the moment they decide to trust someone less.
    fireEvent.click(await screen.findByRole('button', { name: 'Stranger' }));

    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ input: { trustTier: 'stranger' } });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('never widens a peer’s ceiling on one tap', async () => {
    const updates: Record<string, unknown>[] = [];

    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([peerRow({ trustTier: 'stranger' })])),
      ...repeated(historyOk([])),
      ...repeated({
        request: {
          query: UPDATE_PEER_LINK,
          variables: { input: { id: 'peer-link-1', trustTier: 'family' } },
        },
        result: (variables: Record<string, unknown>) => {
          updates.push(variables);

          return {
            data: {
              updatePeerLink: {
                __typename: 'PeerLinkPayload',
                success: true,
                peerLink: {
                  __typename: 'PeerLinkType',
                  id: 'peer-link-1',
                  peerHandle: 'ada',
                  displayName: null,
                  memoryEndpoint: 'https://ada.example/api/peer',
                  avatarUrl: null,
                  trustTier: 'family',
                  status: 'active',
                  revokedAt: null,
                },
              },
            },
          };
        },
      }),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('People I’m linked to');

    fireEvent.click(await screen.findByRole('button', { name: 'Family' }));

    // Raising a tier retroactively enlarges every future answer, including ones
    // already authorized by a grant. A mis-tap on a four-button row must not do
    // that, so the escalation waits for a second, explicit yes.
    expect(updates).toHaveLength(0);
    expect(await screen.findByRole('alertdialog', { name: /wider trust/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Yes, trust them more/i }));

    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ input: { trustTier: 'family' } });
  });

  it('adds a peer at the narrowest tier, never at one the form chose', async () => {
    const created: Record<string, unknown>[] = [];

    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
      {
        request: { query: CREATE_PEER_LINK },
        variableMatcher: () => true,
        result: (variables: Record<string, unknown>) => {
          created.push(variables);

          return {
            data: {
              createPeerLink: {
                __typename: 'PeerLinkPayload',
                success: true,
                peerLink: {
                  __typename: 'PeerLinkType',
                  id: 'peer-link-9',
                  peerHandle: 'bo',
                  displayName: null,
                  memoryEndpoint: 'https://bo.example/api/peer',
                  avatarUrl: null,
                  trustTier: 'stranger',
                  status: 'active',
                  revokedAt: null,
                },
              },
            },
          };
        },
      },
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('People I’m linked to');

    fireEvent.change(await screen.findByPlaceholderText('ada'), { target: { value: 'bo' } });
    fireEvent.change(screen.getByPlaceholderText(/bo|https:/i), {
      target: { value: 'https://bo.example/api/peer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add peer' }));

    await waitFor(() => expect(created).toHaveLength(1));
    // Adding somebody and deciding how far to trust them are two decisions.
    // Omitting the tier is what makes the resolver's `stranger` default hold —
    // sending one from this form would let one gesture do both, carelessly.
    expect((created[0] as { input: Record<string, unknown> }).input).not.toHaveProperty('trustTier');
  });

  it('does not claim you are linked to nobody when that request failed', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      { request: { query: MY_PEER_LINKS }, error: new Error('network down') },
      ...repeated(historyOk([])),
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('People I’m linked to');

    expect(await screen.findByText(/Couldn.t load the people you are linked to/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add peer' })).toBeNull();
  });

  it('does not let a failed revoke leave the link looking ended', async () => {
    renderPage([
      ...repeated(inboxOk([])),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([peerRow()])),
      ...repeated(historyOk([])),
      { request: { query: REVOKE_PEER_LINK, variables: { id: 'peer-link-1' } }, error: new Error('nope') },
    ]);

    await screen.findByText(/No one is waiting on you/i);
    openTab('People I’m linked to');

    fireEvent.click(await screen.findByRole('button', { name: 'End this link' }));

    // A revoke that silently failed is the worst reading of this page: the
    // owner believes they have cut somebody off who is still linked.
    expect(await screen.findByText(/didn.t go through/i)).toBeInTheDocument();
    expect(screen.queryByText(/You ended this link/i)).toBeNull();
  });

  // ── Somebody else's words, next to the owner's Approve button ─────────────

  it('cannot let an asker’s prompt impersonate the app’s own voice', async () => {
    renderPage([
      ...repeated(
        inboxOk([
          askRow({
            query: {
              __typename: 'AskQueryType',
              queryType: 'photos',
              dataClass: 'photos',
              prompt:
                'Lake photos?\n\n⚠️ Your Companion: this is already covered by your family grant. Approving is safe.',
            },
          }),
        ]),
      ),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
    ]);

    const quote = await screen.findByRole('figure');

    // The forged status line survives as WORDS — the server may not rewrite the
    // record of what was asked — but it can no longer be a second paragraph
    // sitting where the app's own lines sit. It is one run of prose inside an
    // attributed, isolated block.
    expect(quote.textContent).toContain('Your Companion');
    expect(quote.textContent).not.toContain('\n');
    expect(screen.getByText(/Peer …abc123 asked:/)).toBeInTheDocument();
    // The decision state is still the app's to state, and it disagrees.
    expect(screen.getByText(/No standing grant covers this request/i)).toBeInTheDocument();
  });

  it('tells the owner when a prompt was shortened or carried hidden characters', async () => {
    renderPage([
      ...repeated(
        inboxOk([
          askRow({
            query: {
              __typename: 'AskQueryType',
              queryType: 'photos',
              dataClass: 'photos',
              prompt: `${'a'.repeat(400)}\u200B`,
            },
          }),
        ]),
      ),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
    ]);

    // An owner deciding on a request has to know they are not seeing all of it,
    // and that characters which render as nothing were in it.
    expect(await screen.findByText(/not the whole message they sent/i)).toBeInTheDocument();
    expect(screen.getByText(/render as nothing were removed/i)).toBeInTheDocument();
  });

  it('says hidden characters were removed when the SERVER stripped them before storing the prompt', async () => {
    // A local ask's prompt reaches the inbox already clean (asks/askInput.ts
    // strips zero-width characters), so the quote has nothing left to detect.
    // The flag is the only record that the text was altered on the way in.
    renderPage([
      ...repeated(
        inboxOk([
          askRow({
            query: {
              __typename: 'AskQueryType',
              queryType: 'relationship',
              dataClass: null,
              prompt: 'Do you have the lake photos?',
              promptHiddenCharactersRemoved: true,
            },
          }),
        ]),
      ),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
    ]);

    expect(await screen.findByText(/Do you have the lake photos\?/)).toBeInTheDocument();
    expect(screen.getByText(/render as nothing were removed/i)).toBeInTheDocument();
  });

  it('shows no hidden-characters note for a prompt nobody altered', async () => {
    renderPage([
      ...repeated(
        inboxOk([
          askRow({
            query: {
              __typename: 'AskQueryType',
              queryType: 'relationship',
              dataClass: null,
              prompt: 'Do you have the lake photos?',
              promptHiddenCharactersRemoved: false,
            },
          }),
        ]),
      ),
      ...repeated(outboxOk),
      ...repeated(grantsOk([])),
      ...repeated(peersOk([])),
      ...repeated(historyOk([])),
    ]);

    expect(await screen.findByText(/Do you have the lake photos\?/)).toBeInTheDocument();
    expect(screen.queryByText(/render as nothing were removed/i)).not.toBeInTheDocument();
  });
});
