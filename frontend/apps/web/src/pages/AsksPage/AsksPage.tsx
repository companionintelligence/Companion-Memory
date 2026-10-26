import { type ReactNode, useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { EmptyState, LoadingPage, usePageTitle } from '@ci/common';
import { Badge, Button, Card } from '@ci/shadcn';

import { PageContent } from '@/components/layout';
import { PersonAvatar } from '@/components/PersonAvatar';
import type { AnswerForm } from '@/graphql/graphql';

import { AnswerPanel } from './AnswerPanel';
import {
  grantLabel,
  knownAskerLabel,
  partyAvatar,
  partyLabel,
  peerLinksByHandle,
  scopeSummary,
  searchBreadthNote,
} from './askBinding';
import { AskComposer } from './AskComposer';
import {
  grantsLapsingWithin,
  lapseNudge,
  type AskAuditOutcome,
  askDecisionState,
  askStatusLabel,
  type AskStatus,
  OWNER_ANSWER_FORMS,
  peerTrustLabel,
} from './askPresentation';
import { AskReviewCard } from './AskReviewCard';
import {
  APPROVE_ASK,
  ASK_DISCLOSURE_HISTORY,
  ASK_DISCLOSURE_SUMMARY,
  ASK_INBOX,
  ASK_OUTBOX,
  CREATE_ASK,
  CREATE_ASK_GRANT,
  CREATE_PEER_LINK,
  DECLINE_ASK,
  MY_ASK_ADDRESS,
  MY_ASK_GRANTS,
  MY_PEER_LINKS,
  MY_HOUSEHOLD_TIERS,
  REVOKE_ASK_GRANT,
  SET_HOUSEHOLD_TIER,
  REVOKE_PEER_LINK,
  RUN_ASK,
  UPDATE_ASK_GRANT,
  UPDATE_PEER_LINK,
} from './asksOperations';
import { COMPOSER_SHAPES, composeRecipients, unreachablePeers } from './composeRecipients';
import { DisclosureHistory } from './DisclosureHistory';
import { DisclosureRelationships } from './DisclosureRelationships';
import { GrantManager, type GranteeGroup } from './GrantManager';
import { NewGrantForm } from './NewGrantForm';
import { PeerManager } from './PeerManager';
import type { RelationshipSummary } from './relationshipPresentation';

/**
 * The recency window the relationship fold reports against, and the cap the
 * fold runs over.
 *
 * Both MIRROR the server (`DEFAULT_WINDOW_MS` and `MAX_AUDIT_ROWS` in the asks
 * domain) rather than being sent to it: the client does not get to choose how
 * much of the owner's history is counted. They exist here only so the copy can
 * say "the last 30 days" and "your 5,000 most recent" in words rather than
 * leaving the reader to guess what window a number covers.
 */
const DISCLOSURE_WINDOW_DAYS = 30;

/**
 * How far ahead the Grant Manager looks for grants about to lapse.
 *
 * A month, matching the disclosure window above — the unit people reason about
 * consent in. Far enough ahead to act on, near enough that the nudge stays rare.
 */
const LAPSE_HORIZON_DAYS = 30;
const MAX_COUNTED_DISCLOSURES = 5_000;

type Tab = 'inbox' | 'compose' | 'outbox' | 'grants' | 'peers' | 'history';

/**
 * The asks surface.
 *
 * ═══ WHAT THIS PAGE USED TO NOT DO, AND WHY IT DOES IT NOW ═══
 *
 * Four components for this feature merged with the trust-graph work and sat
 * unreachable. The container that followed made the READ-AND-REACT half work —
 * an owner could see who was asking and approve, cap or decline — and stopped
 * there, wiring seven of sixteen operations and none of the writes. Three of the
 * four gaps it documented as "the API cannot supply this" were true when it was
 * written and are not true now:
 *
 *   - `AnswerCard` needed an `autoAnswered` discriminator. It still does not
 *     exist on `AskAnswerType`, and the honest resolution turned out not to be
 *     omitting the card but giving provenance a THIRD value — see
 *     {@link AnswerPanel}. The card renders; it just does not claim a review
 *     that nobody disclosed.
 *   - A recipient for `createAsk` looked impossible without a user-search
 *     endpoint. It is possible without one: the owner's own grants, inbox and
 *     outbox already name everybody they have a relationship with. See
 *     {@link composeRecipients}.
 *   - Grant expiry and mode changes were called "not on the wire". Both are, and
 *     were: `AskGrantType.expiresAt`/`active` and `updateAskGrant`. The page was
 *     printing a false limitation, which an owner plans around — "I cannot
 *     time-limit this, so I will remember to revoke it" is a worse plan than the
 *     one they would have made knowing the truth.
 *
 * What remains genuinely absent is named where it bites: a display NAME for a
 * local user (so every party is an opaque, visibly-truncated id), per-item
 * LABELS on a disclosed reference, and any way to address an ask to a linked
 * PEER from this client.
 */
export function AsksPage() {
  usePageTitle('Asks');

  const [tab, setTab] = useState<Tab>('inbox');
  /** Whether the Grants tab is showing the write form rather than the matrix. */
  const [addingGrant, setAddingGrant] = useState(false);
  // The owner's own ask address, so the form can offer it for copying. There is
  // no directory on this box — an address is handed over out of band — and the
  // only address anyone can read is their own, which is what keeps that true.
  // Failure is not surfaced: the address is a convenience on one form, and an
  // error banner over the whole Asks page for it would be louder than the thing
  // it reports. The form simply omits the block when there is nothing to show.
  const myAddress = useQuery(MY_ASK_ADDRESS).data?.me?.id ?? null;
  const [openAnswerId, setOpenAnswerId] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const inbox = useQuery(ASK_INBOX);
  const outbox = useQuery(ASK_OUTBOX);
  const grants = useQuery(MY_ASK_GRANTS);
  const peers = useQuery(MY_PEER_LINKS);
  // The relationship fold is the index; the flat list is the drill-in, and it
  // is NOT fetched until a relationship is opened. Loading every audit row to
  // render a summary would reintroduce the unbounded read the fold exists to
  // replace.
  const [openRelationship, setOpenRelationship] = useState<RelationshipSummary | null>(null);
  const disclosureSummary = useQuery(ASK_DISCLOSURE_SUMMARY);
  const history = useQuery(ASK_DISCLOSURE_HISTORY, {
    variables: { input: { counterpartyKey: openRelationship?.key } },
    skip: openRelationship == null,
  });

  const refetchAll = () => {
    void inbox.refetch();
    void grants.refetch();
    // The owner's receipt of what left the box. Re-read after every decision,
    // because the whole point of the history is that it is not stale.
    void history.refetch();
  };

  const householdTiers = useQuery(MY_HOUSEHOLD_TIERS);

  const [approveAsk, approving] = useMutation(APPROVE_ASK, { onCompleted: refetchAll });
  const [declineAsk, declining] = useMutation(DECLINE_ASK, { onCompleted: refetchAll });
  const [runAsk, running] = useMutation(RUN_ASK, { onCompleted: refetchAll });
  const [revokeGrant, revoking] = useMutation(REVOKE_ASK_GRANT, {
    onCompleted: () => void grants.refetch(),
  });
  // Refetches the TIER LIST, not the grants: demoting somebody changes the
  // ceiling on every future disclosure to them, and none of the grant rows.
  const [setHouseholdTier] = useMutation(SET_HOUSEHOLD_TIER, {
    onCompleted: () => void householdTiers.refetch(),
  });
  const [updateGrant, updatingGrant] = useMutation(UPDATE_ASK_GRANT, {
    onCompleted: () => void grants.refetch(),
  });
  // Re-reads the INBOX as well as the grants. A new grant changes who may ask,
  // and `composeRecipients` is built from grants + inbox + outbox — so without
  // this the row the owner just wrote would not appear in the composer until a
  // reload, which is the exact bootstrap this control exists to provide.
  const [createGrant, creatingGrant] = useMutation(CREATE_ASK_GRANT, {
    onCompleted: () => {
      void grants.refetch();
      void inbox.refetch();
    },
  });
  const [createAsk, creating] = useMutation(CREATE_ASK, {
    onCompleted: () => void outbox.refetch(),
  });
  const [createPeerLink, linking] = useMutation(CREATE_PEER_LINK, {
    onCompleted: () => void peers.refetch(),
  });
  const [updatePeerLink, retiering] = useMutation(UPDATE_PEER_LINK, {
    onCompleted: () => void peers.refetch(),
  });
  const [revokePeerLink, unlinking] = useMutation(REVOKE_PEER_LINK, {
    onCompleted: () => void peers.refetch(),
  });

  const busy = approving.loading || declining.loading || running.loading;
  const grantBusy = revoking.loading || updatingGrant.loading || creatingGrant.loading;
  const peerBusy = linking.loading || retiering.loading || unlinking.loading;

  /**
   * The first mutation that failed, if any.
   *
   * Read for the same reason the queries' `error` is: a consent gesture that did
   * not happen must not look like one that did. `useMutation` records the error
   * here, but every mutate() below is fired from an event handler, so nothing
   * awaits its rejection — without {@link runAction} it surfaces as an unhandled
   * rejection in a console the owner will never open, and on screen as a Decline
   * button that appeared to work.
   *
   * Every mutation on the page is in this chain, including the ones added since.
   * A peer whose tier LOOKED lowered because the mutation failed silently is the
   * same defect as an approval that did not land, pointed the other way.
   */
  const actionError =
    approving.error ??
    running.error ??
    declining.error ??
    revoking.error ??
    updatingGrant.error ??
    creating.error ??
    linking.error ??
    retiering.error ??
    unlinking.error;

  /**
   * Fire a mutation, and on failure re-read the server rather than guessing.
   *
   * The refetch is the important half. The banner says the action failed; the
   * refetch is what stops the list underneath it from continuing to show the
   * state the owner THOUGHT they had reached — which matters most for the
   * approve/answer chain, where the first mutation can land and the second fail,
   * leaving a real, changed ask behind a failed gesture.
   */
  const runAction = (action: Promise<unknown>, onFailure: () => void = refetchAll): void => {
    void action.catch(() => onFailure());
  };

  /**
   * Approve then answer.
   *
   * These are two mutations because the server models them as two transitions:
   * approving moves the ask to `answering`, and `runAsk` is what actually
   * produces and discloses the answer. Chaining them here keeps the owner's
   * single "Approve" gesture matching the single decision they think they are
   * making, while leaving the server's gate intact — `runAsk` re-checks the
   * lifecycle itself and refuses a non-answerable ask, so a failure between the
   * two cannot disclose anything.
   *
   * `disclosureForm` carries the owner's "answer with less" pick. It is passed
   * through UNCHANGED and unvalidated on purpose: `runAsk` clamps it against the
   * form the archetype implies and keeps whichever discloses less, so the client
   * cannot use it to widen anything, and second-guessing it here would only
   * create a second, drifting copy of that rule.
   */
  const handleApprove = (id: string, disclosureForm?: AnswerForm): void => {
    runAction(
      approveAsk({ variables: { id } }).then(() =>
        runAsk({ variables: { id, redactItemIds: [], disclosureForm } }),
      ),
    );
  };

  const pending = (inbox.data?.askInbox ?? []).filter(
    (ask) => ask.status === 'delivered' || ask.status === 'under_review',
  );

  // Every counterparty avatar on this page joins against this one map — built
  // once per render rather than per row. See `partyAvatar` in askBinding.ts.
  const peerLinks = peerLinksByHandle(peers.data?.myPeerLinks ?? []);

  // The peer roster is passed in, not looked up inside: a grant to a PEER is
  // capped by that peer's trust tier on top of whatever the grant says, so a
  // matrix that cannot see the tier shows a `full` grant as full when the peer
  // is a `stranger` and the answer will be a yes/no.
  const grantGroups: GranteeGroup[] = groupGrants(
    // Only rows the owner ACTIVELY set. An account with no row is at the
    // default, and materializing one for every local user would turn "I have
    // not thought about this" into "I decided household".
    new Map((householdTiers.data?.myHouseholdTiers ?? []).map((row) => [row.memberId, row.trustTier])),
    grants.data?.myAskGrants ?? [],
    peers.data?.myPeerLinks ?? [],
  );

  let content: ReactNode;

  /**
   * Every tab reads ITS OWN query's loading and error state.
   *
   * The guard used to be `inbox.loading && outbox.loading && grants.loading`,
   * which is false the instant any one of the three resolves — so a still-loading
   * grants query rendered "No standing grants. Every ask comes to you for
   * review." And neither `error` was read at all, so a failed request painted the
   * same reassuring empty page. On a consent surface both are the same bug: an
   * absence of information rendered as a positive claim that nothing is shared.
   */
  if (tab === 'inbox') {
    if (inbox.error) {
      content = <LoadFailure what="your inbox" onRetry={() => void inbox.refetch()} />;
    } else if (inbox.loading) {
      content = <LoadingPage />;
    } else {
      content = pending.length ? (
        <div className="flex flex-col gap-3">
          {pending.map((ask) => {
            const decision = askDecisionState(ask.status as AskStatus, ask.consentBasis);
            const asker = partyAvatar(ask.peerHandle, ask.askerId, peerLinks);

            return (
              <AskReviewCard
                key={ask.id}
                askerName={asker.name}
                askerAvatarUrl={asker.avatarUrl}
                tier={knownAskerLabel(ask.consentBasis)}
                decision={decision}
                prompt={ask.query.prompt}
                promptHiddenCharactersRemoved={ask.query.promptHiddenCharactersRemoved}
                scopeSummary={scopeSummary(ask.query)}
                searchBreadth={searchBreadthNote(ask.query)}
                downgrades={[...OWNER_ANSWER_FORMS]}
                actor={ask.query.actor}
                statedPurpose={ask.query.purpose}
                busy={busy}
                onApprove={() => handleApprove(ask.id)}
                onDowngrade={(form) => handleApprove(ask.id, form)}
                onDecline={() => runAction(declineAsk({ variables: { id: ask.id } }))}
              />
            );
          })}
        </div>
      ) : (
        <EmptyState message="No one is waiting on you. Asks needing your review appear here." />
      );
    }
  } else if (tab === 'compose') {
    // The composer needs three queries to build its recipient list, so it waits
    // for all three rather than offering a partial one. A picker that silently
    // omits somebody is a picker that quietly says "you have no relationship
    // with them", which on this page is a claim, not a loading state.
    if (inbox.error || outbox.error || grants.error) {
      content = <LoadFailure what="the people you can ask" onRetry={refetchAll} />;
    } else if (inbox.loading || outbox.loading || grants.loading || peers.loading) {
      content = <LoadingPage />;
    } else {
      content = (
        <div className="flex flex-col gap-3">
          {sent ? (
            <Card className="flex flex-col gap-1 p-3" role="status">
              <p className="font-medium">Sent.</p>
              <p className="text-muted-foreground text-sm">
                It is in “Sent” now. You will not be told whether a person reads it or a standing rule answers
                it — only whether an answer arrives.
              </p>
            </Card>
          ) : null}
          <AskComposer
            recipients={composeRecipients({
              grants: grants.data?.myAskGrants ?? [],
              inbox: inbox.data?.askInbox ?? [],
              outbox: outbox.data?.askOutbox ?? [],
            })}
            unreachable={unreachablePeers(peers.data?.myPeerLinks ?? [])}
            shapes={COMPOSER_SHAPES}
            busy={creating.loading}
            onSend={(ask) => {
              // Cleared UP FRONT, before the request goes out, and that ordering
              // is the whole control. A green "Sent." belongs to one specific
              // ask, so the moment the owner sends another it must stop
              // referring to the previous one — while the new request is still
              // in flight, not once it resolves. Clearing it in the failure
              // handler instead would leave the old confirmation standing over a
              // send that had not landed yet, which is the same reassuring-lie
              // shape as an error rendered as an empty state.
              setSent(false);
              runAction(
                createAsk({
                  variables: {
                    input: {
                      responderId: ask.responderId,
                      query: { queryType: ask.queryType, dataClass: ask.dataClass, prompt: ask.prompt },
                    },
                  },
                }).then(() => setSent(true)),
                // Nothing to re-read on failure: no ask was created, and the
                // confirmation was already cleared above. Overriding the default
                // `refetchAll` keeps a failed send from firing three pointless
                // reads of the owner's own inbox, grants and history.
                () => undefined,
              );
            }}
          />
        </div>
      );
    }
  } else if (tab === 'grants') {
    if (grants.error) {
      content = <LoadFailure what="your standing grants" onRetry={() => void grants.refetch()} />;
    } else if (grants.loading || peers.loading) {
      // Waits on the PEER roster too. A peer grant rendered before its link
      // resolves shows no ceiling, and a ceiling shown late is a ceiling the
      // owner may have already read past.
      content = <LoadingPage />;
    } else {
      const newGrantForm = (
        <NewGrantForm
          myAddress={myAddress}
          busy={grantBusy}
          onCancel={() => setAddingGrant(false)}
          onCreate={(grant) => {
            setAddingGrant(false);
            runAction(
              createGrant({
                variables: {
                  input: {
                    granteeId: grant.granteeId,
                    queryType: grant.queryType,
                    dataClass: grant.dataClass,
                    mode: grant.mode,
                  },
                },
              }),
              // Nothing to re-read on failure — no grant was written, and the
              // form has already closed. The default `refetchAll` would fire
              // three pointless reads of the owner's own surfaces.
              () => undefined,
            );
          }}
        />
      );

      // The empty state gets the SAME affordance as the populated one. It used
      // to be a bare sentence, which is how the Grants tab ended up permanently
      // read-only: `GrantManager` carries the "New grant" button, and
      // `GrantManager` is only rendered once at least one grant exists — so the
      // one screen a new owner actually sees was the one screen with no way to
      // write the first grant.
      // Grants that will lapse ON THEIR OWN soon. Rendered above the matrix
      // and only when there is something to say — a banner that appears every
      // time teaches people to look past the banner, and then the one time it
      // matters they look past it too.
      const lapsing = lapseNudge(
        grantsLapsingWithin(grants.data?.myAskGrants ?? [], LAPSE_HORIZON_DAYS).length,
        LAPSE_HORIZON_DAYS,
      );

      content = grantGroups.length ? (
        <div className="flex flex-col gap-4">
          {lapsing ? (
            <p className="text-muted-foreground bg-muted rounded-md px-3 py-2 text-xs">{lapsing}</p>
          ) : null}
          {addingGrant ? newGrantForm : null}
          <GrantManager
            groups={grantGroups}
            defaultMode="review"
            busy={grantBusy}
            onChangeMode={(grantId, mode) =>
              runAction(updateGrant({ variables: { id: grantId, input: { mode } } }))
            }
            onSetExpiry={(grantId, expiresAt) =>
              runAction(updateGrant({ variables: { id: grantId, input: { expiresAt } } }))
            }
            onSetHouseholdTier={(memberId, trustTier) =>
              runAction(setHouseholdTier({ variables: { input: { memberId, trustTier } } }))
            }
            onRevoke={(grantId) => runAction(revokeGrant({ variables: { id: grantId } }))}
            onAddGrant={addingGrant ? undefined : () => setAddingGrant(true)}
            onOpenHistory={() => setTab('history')}
          />
        </div>
      ) : addingGrant ? (
        newGrantForm
      ) : (
        <div className="flex flex-col items-center gap-4">
          <EmptyState message="No standing grants. Every ask comes to you for review." />
          <Button onClick={() => setAddingGrant(true)}>New grant</Button>
        </div>
      );
    }
  } else if (tab === 'peers') {
    if (peers.error) {
      content = <LoadFailure what="the people you are linked to" onRetry={() => void peers.refetch()} />;
    } else if (peers.loading) {
      content = <LoadingPage />;
    } else {
      content = (
        <PeerManager
          peers={peers.data?.myPeerLinks ?? []}
          busy={peerBusy}
          onChangeTier={(id, trustTier) =>
            runAction(updatePeerLink({ variables: { input: { id, trustTier } } }))
          }
          onRevoke={(id) => runAction(revokePeerLink({ variables: { id } }))}
          onAdd={(input) =>
            runAction(
              createPeerLink({
                variables: {
                  // No `trustTier`. The resolver defaults an omitted tier to
                  // `stranger`, and that default is the safety property — see
                  // CREATE_PEER_LINK.
                  input: {
                    peerHandle: input.peerHandle,
                    memoryEndpoint: input.memoryEndpoint,
                    displayName: input.displayName,
                  },
                },
              }),
            )
          }
        />
      );
    }
  } else if (tab === 'history' && openRelationship != null) {
    // ── Drill-in: one relationship's individual disclosures ──────────────
    if (history.error) {
      content = <LoadFailure what="what you have shared" onRetry={() => void history.refetch()} />;
    } else if (history.loading) {
      content = <LoadingPage />;
    } else {
      const rows = history.data?.askDisclosureHistory?.rows ?? [];

      content = (
        <div className="flex flex-col gap-3">
          <Button variant="ghost" size="sm" className="self-start" onClick={() => setOpenRelationship(null)}>
            ← All relationships
          </Button>

          <DisclosureHistory
            rows={rows.map((row) => {
              const asker = partyAvatar(row.peerHandle, row.askerId, peerLinks);

              return {
                id: row.id,
                askerName: asker.name,
                askerAvatarUrl: asker.avatarUrl,
                outcome: row.outcome as AskAuditOutcome,
                disclosedCount: row.disclosedCount,
                consentBasis: row.consentBasis,
                createdAt: row.createdAt as string,
                query: row.query,
              };
            })}
          />
        </div>
      );
    }
  } else if (tab === 'history') {
    // ── Index: the same record, folded by relationship ───────────────────
    if (disclosureSummary.error) {
      content = <LoadFailure what="what you have shared" onRetry={() => void disclosureSummary.refetch()} />;
    } else if (disclosureSummary.loading) {
      content = <LoadingPage />;
    } else {
      const payload = disclosureSummary.data?.askDisclosureSummary;
      const summaries = payload?.summaries ?? [];

      content = summaries.length ? (
        <DisclosureRelationships
          summaries={summaries}
          windowDays={DISCLOSURE_WINDOW_DAYS}
          truncated={payload?.truncated ?? false}
          countedRows={MAX_COUNTED_DISCLOSURES}
          onOpen={setOpenRelationship}
        />
      ) : (
        <EmptyState message="Nothing has been shared from your Companion yet." />
      );
    }
  } else if (outbox.error) {
    content = <LoadFailure what="the asks you have sent" onRetry={() => void outbox.refetch()} />;
  } else if (outbox.loading) {
    content = <LoadingPage />;
  } else {
    const asked = outbox.data?.askOutbox ?? [];

    content = asked.length ? (
      <div className="flex flex-col gap-2">
        {asked.map((ask) => {
          // `askerVisibleStatus` collapses everything the asker may not know
          // into `delivered`, so `answered` really is "there is something to
          // read" and nothing else on this list ever is.
          const answered = ask.status === 'answered';
          const open = openAnswerId === ask.id;
          const responder = partyAvatar(ask.peerHandle, ask.responderId, peerLinks);

          return (
            <Card key={ask.id} className="flex flex-col gap-2 p-3">
              <div className="flex flex-wrap items-center gap-3">
                <PersonAvatar name={responder.name} avatarUrl={responder.avatarUrl} size="xs" />
                <span className="font-medium">{responder.name}</span>
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
                  {ask.query.prompt}
                </span>
                <Badge variant="secondary">{askStatusLabel(ask.status as AskStatus)}</Badge>
                {answered ? (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-expanded={open}
                    onClick={() => setOpenAnswerId(open ? null : ask.id)}
                  >
                    {open ? 'Hide answer' : 'Read answer'}
                  </Button>
                ) : null}
              </div>

              {answered && open ? (
                <AnswerPanel
                  askId={ask.id}
                  responderName={responder.name}
                  // The viewer is the ASKER on this tab, always. Their copy of
                  // the answer is the narrowed projection, and saying so is what
                  // stops a masked zero reading as "nothing was shared".
                  isResponder={false}
                />
              ) : null}
            </Card>
          );
        })}
      </div>
    ) : (
      <EmptyState message="You haven't asked anyone anything yet." />
    );
  }

  return (
    <PageContent>
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Asks</h1>
          <p className="text-muted-foreground text-sm">
            Questions between Companions — answered only with what you allow.
          </p>
        </div>

        {/* Text, not colour alone, carries which tab is current (WCAG 1.4.1);
            the count is part of the label so a pending queue is visible without
            opening the tab. */}
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['inbox', `For you${pending.length ? ` (${pending.length})` : ''}`],
              ['compose', 'Ask someone'],
              ['outbox', 'Sent'],
              ['grants', 'Who can ask me what'],
              ['peers', 'People I’m linked to'],
              ['history', 'What I’ve shared'],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={tab === key ? 'default' : 'outline'}
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => setTab(key)}
            >
              {label}
            </Button>
          ))}
        </div>

        {/* Above the list, not inside a tab: the action that failed may have
            been taken on a tab the owner has since left. */}
        {actionError ? (
          <Card className="flex flex-col gap-1 p-3" role="alert">
            <p className="font-medium">That didn’t go through.</p>
            <p className="text-muted-foreground text-sm">
              {actionError.message} — the list below has been re-read from your Companion, so trust it over
              what you expected to happen.
            </p>
          </Card>
        ) : null}

        {content}
      </div>
    </PageContent>
  );
}

/**
 * A query that failed, said plainly.
 *
 * Deliberately NOT an `EmptyState` with a sad message: "we could not ask" and
 * "the answer was none" are different facts, and on this page the second one is
 * a claim about what is being shared. The retry is here because a transient
 * failure otherwise strands the owner on a page that looks settled.
 */
function LoadFailure({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <Card className="flex flex-col items-start gap-2 p-4" role="alert">
      <p className="font-medium">Couldn’t load {what}.</p>
      <p className="text-muted-foreground text-sm">
        This is a failed request, not an empty one — read nothing into it about what is or isn’t being shared.
      </p>
      <Button size="sm" onClick={onRetry}>
        Try again
      </Button>
    </Card>
  );
}

/**
 * One group per grantee.
 *
 * The component's `GranteeGroup` wants a display name and a tier per grantee.
 * Neither is on the wire for a LOCAL grantee — `granteeId` is an opaque
 * GlobalUID and there is no user query to resolve it — so the group is named by
 * the same opaque label used everywhere else rather than by a person's name that
 * would be invented.
 *
 * A PEER grantee is different, and the difference is now readable: `myPeerLinks`
 * resolves `granteePeerLinkId` to a handle and a real trust tier. That tier is
 * the ceiling on everything the grant can ever release, so showing it beside the
 * grant is not decoration — a `full` grant to a `stranger` peer still discloses
 * a yes/no, and an owner reading the grant alone would not know that.
 *
 * `revokedAt` and `active` are carried through rather than dropped. The server's
 * `listForOwner` filters revoked and lapsed rows out today, so in practice every
 * row here is live — but "the server probably filtered it" is not something a
 * consent matrix may assume on the owner's behalf, and the fields are already in
 * the selection set.
 */
function groupGrants(
  householdTiers: ReadonlyMap<string, string>,
  rows: readonly {
    id: string;
    mode: string;
    queryType: string;
    dataClass?: string | null;
    purpose?: string | null;
    granteeId?: string | null;
    granteePeerLinkId?: string | null;
    revokedAt?: unknown;
    expiresAt?: unknown;
    active?: boolean | null;
    useCount?: number | null;
    lastUsedAt?: unknown;
  }[],
  peerLinks: readonly {
    id: string;
    peerHandle: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    trustTier: string;
  }[] = [],
): GranteeGroup[] {
  const byGrantee = new Map<string, GranteeGroup>();
  const links = new Map(peerLinks.map((link) => [link.id, link]));

  for (const row of rows) {
    const key = row.granteeId ?? row.granteePeerLinkId ?? 'unknown';
    const link = row.granteePeerLinkId ? links.get(row.granteePeerLinkId) : undefined;

    let group = byGrantee.get(key);

    if (!group) {
      group = {
        id: key,
        name: link ? link.displayName || link.peerHandle : partyLabel(null, key === 'unknown' ? null : key),
        // A local grantee has no photo on the wire at all — same reasoning as
        // the tier below, just with no "not loaded" middle state to report,
        // since a local id was never going to resolve one.
        avatarUrl: link?.avatarUrl ?? null,
        // THREE cases, not two, because "we do not have it" and "there is none"
        // are different facts and only one of them is stable:
        //   - a peer grantee whose link resolved has a REAL tier, and it is the
        //     ceiling on everything that grant can release;
        //   - a peer grantee whose link did NOT resolve (roster still loading,
        //     or the link was hard-deleted) has a tier this page simply failed
        //     to read — saying "unknown" there would read as "there is no
        //     ceiling", which is the opposite of what a missing read means;
        //   - a LOCAL grantee's tier is the OWNER's own verdict, read from
        //     `myHouseholdTiers`. Absent means they have said nothing, which is
        //     the default (`household`) rather than "unknown" — and the select
        //     beside it is what makes that a choice instead of a fact.
        tier: link
          ? peerTrustLabel(link.trustTier)
          : row.granteePeerLinkId
            ? 'tier not loaded'
            : (householdTiers.get(row.granteeId ?? '') ?? 'household'),
        grants: [],
        // Only a LOCAL grantee: a peer's tier lives on their peer link and is
        // set in "People I'm linked to". Present here is what turns the tier
        // badge into a control.
        memberId: row.granteePeerLinkId ? null : (row.granteeId ?? null),
      };
      byGrantee.set(key, group);
    }

    group.grants.push({
      id: row.id,
      label: grantLabel(row.queryType, row.dataClass),
      mode: row.mode as GranteeGroup['grants'][number]['mode'],
      note: row.purpose ?? undefined,
      expiresAt: asIsoString(row.expiresAt),
      revokedAt: asIsoString(row.revokedAt),
      active: row.active ?? undefined,
      useCount: row.useCount ?? 0,
      lastUsedAt: asIsoString(row.lastUsedAt),
    });
  }

  return [...byGrantee.values()];
}

/**
 * A `DateTime` scalar as a string this component can render.
 *
 * Codegen types `DateTime` as `any`, and Apollo hands back whatever the link
 * produced — a string over HTTP, a `Date` from a cache normalizer or a test
 * fixture. Narrowing here rather than at each render site keeps a `Date` from
 * reaching `formatDate` as an object and stringifying as `[object Object]` on
 * the one row the owner most needs to read.
 */
function asIsoString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return null;
}
