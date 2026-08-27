import { gql } from '@/graphql';

/**
 * Every ask operation this page issues.
 *
 * Kept in one file so the wire surface is auditable at a glance: a consent
 * feature should make it easy to see exactly what the client asks the server
 * for, rather than scattering fragments across components.
 *
 * These are deliberately narrow. Some fields the original design called for
 * still do not exist — a display NAME for a local user, per-item LABELS, an
 * `autoAnswered` flag on the ANSWER — so the page derives what it can and
 * declines to assert the rest. Two that USED to be missing now exist and are
 * selected here: a peer link carries a real `trustTier`, and `AskGrantType`
 * carries `expiresAt`/`active`. See askBinding.ts and AsksPage.tsx.
 */

export const ASK_INBOX = gql(`
  query AskInbox {
    askInbox {
      id
      status
      createdAt
      consentBasis
      askerId
      peerHandle
      query {
        queryType
        dataClass
        prompt
        purpose
        actor {
          kind
          label
        }
      }
    }
  }
`);

export const ASK_OUTBOX = gql(`
  query AskOutbox {
    askOutbox {
      id
      status
      createdAt
      responderId
      peerHandle
      query {
        queryType
        dataClass
        prompt
        purpose
        actor {
          kind
          label
        }
      }
    }
  }
`);

/**
 * The standing-grant matrix.
 *
 * `revokedAt` is selected AND READ (see groupGrants): the server's
 * `listForOwner` filters revoked and lapsed rows out today, but a client that
 * renders a grant as live because it never looked is one resolver change away
 * from showing withdrawn consent as current.
 *
 * `expiresAt` and `active` are selected for exactly the same reason, and they
 * are NEW here. The page used to print "when a grant lapses isn’t on the wire
 * yet" beside every row — which was true of an older checked-in schema and is
 * now false: `AskGrantType` declares both. Saying a capability is missing when
 * it is not is the same class of defect as inventing one, because the owner
 * plans around it ("I cannot time-limit this, so I will remember to revoke it").
 *
 * `active` is not derivable from the other two on the client: it is the
 * server’s own `isGrantActive`, and re-deriving it from `revokedAt`/`expiresAt`
 * here would be a second copy of a liveness rule that must not drift.
 */
export const MY_ASK_GRANTS = gql(`
  query MyAskGrants {
    myAskGrants {
      id
      mode
      queryType
      dataClass
      purpose
      granteeId
      granteePeerLinkId
      revokedAt
      expiresAt
      active
      # Whether this grant has ever actually fired, and when last. A grant
      # firing daily and one that has never matched look identical without
      # these, and they call for opposite actions.
      useCount
      lastUsedAt
      createdAt
    }
  }
`);

export const APPROVE_ASK = gql(`
  mutation ApproveAsk($id: ID!) {
    approveAsk(id: $id) {
      success
    }
  }
`);

export const DECLINE_ASK = gql(`
  mutation DeclineAsk($id: ID!) {
    declineAsk(id: $id) {
      success
    }
  }
`);

/**
 * Produce and disclose the answer.
 *
 * `disclosureForm` is the owner's "answer with less" choice and it MUST be on
 * the wire. The backend has accepted it for a while — `runAsk` clamps it with
 * `narrowerForm`, so the owner can cap a retrieval ask down to a yes/no but can
 * never widen one — and this document simply omitted the argument, which left
 * the entire disclosure ladder unreachable from the UI: every ask ran at
 * whatever form `inferAnswerForm` read out of the ASKER's own `queryType`. The
 * owner's only options were approve-in-full or decline.
 *
 * Note the type: `AnswerForm`, not `DisclosureRung`. See OWNER_ANSWER_FORMS in
 * askPresentation.ts for why the two ladders are not interchangeable.
 */
export const RUN_ASK = gql(`
  mutation RunAsk($id: ID!, $redactItemIds: [String!], $disclosureForm: AnswerForm) {
    runAsk(id: $id, redactItemIds: $redactItemIds, disclosureForm: $disclosureForm) {
      success
      disclosedCount
      withheldCount
    }
  }
`);

/**
 * WRITE a standing grant — the control this page has never had.
 *
 * `createAskGrant` has been on the schema and complete in the resolver for the
 * whole life of this feature; nothing on the client selected it. `GrantManager`
 * even declares an `onAddGrant` prop and renders a "New grant" button for it,
 * and the page simply never passed one, so the button never rendered and the
 * Grants tab was permanently read-only: it printed "No standing grants. Every
 * ask comes to you for review." and offered no way to write one.
 *
 * That is worse than a missing feature on THIS surface, because the recipient
 * picker is bootstrapped from grants. `composeRecipients` builds its list from
 * (grants I have given, asks sent to me, asks I have sent) and nothing else —
 * there is deliberately no user-search endpoint — so on a box where nobody has
 * ever asked anybody anything, all three sources are empty and the composer
 * says "There is nobody to ask yet." A grant is the ONLY way to seed that list,
 * which made standing consent both the missing control and the missing
 * bootstrap.
 *
 * `granteeId` rather than `granteePeerLinkId`: this page writes grants for
 * people with accounts on THIS appliance. The peer path exists in the input and
 * is left to the federated flow, which needs a Portal access token this page
 * cannot mint (see `unreachablePeers`).
 *
 * The selection mirrors MY_ASK_GRANTS so the new row lands in the cache with
 * every field the matrix reads — `active` in particular is the server's own
 * liveness verdict and must not be re-derived here.
 */
/**
 * The owner's OWN ask address, and nobody else's.
 *
 * A grant names its grantee by opaque user id, and there is no directory on
 * this box to look one up in — `composeRecipients` documents at length why a
 * user-search endpoint is not on the table. So an address is handed over out of
 * band, which only works if a person can read their own. This query is that,
 * and its scope is the safety property: `me` is the session's own user, so no
 * amount of calling it enumerates anybody else.
 *
 * A separate document rather than `useCurrentUser` on purpose. That hook reads
 * auth context, and this page's tests deliberately mount without an
 * AuthProvider (see `renderWithProviders`) — a page that cannot render without
 * one is a page whose consent logic stops being testable.
 */
export const MY_ASK_ADDRESS = gql(`
  query MyAskAddress {
    me {
      id
    }
  }
`);

export const CREATE_ASK_GRANT = gql(`
  mutation CreateAskGrant($input: CreateAskGrantInput!) {
    createAskGrant(input: $input) {
      success
      grant {
        id
        mode
        queryType
        dataClass
        purpose
        granteeId
        granteePeerLinkId
        revokedAt
        expiresAt
        active
        createdAt
      }
    }
  }
`);

export const REVOKE_ASK_GRANT = gql(`
  mutation RevokeAskGrant($id: ID!) {
    revokeAskGrant(id: $id) {
      success
    }
  }
`);

/**
 * CHANGE a standing grant — the control the Grant Manager rendered `disabled`
 * for the whole life of this page, beside the sentence "Changing a grant’s mode
 * isn’t available yet."
 *
 * That sentence was false. `updateAskGrant` has been on the schema and the
 * resolver has been complete; nothing on the client selected it. The page was
 * telling the owner that the only way to tighten a grant was to revoke and
 * recreate it, which is worse advice than it sounds: a revoke-then-create leaves
 * a window in which the grantee has NO grant, and the recreated row is a
 * different grant with no link back to what it replaced.
 *
 * Only `mode` and `expiresAt` are sent from here. The other input fields
 * (`dataClass`, `dataClasses`, `maxDisclosure`, `purpose`) are scope dimensions,
 * and `supersede` MERGES the ones it is given — so sending a partially-filled
 * scope from a mode toggle would silently rewrite dimensions the owner never
 * touched. Omitting them inherits them whole, which is what a mode change means.
 *
 * `clearExpiry` is deliberately NOT sent by this page: removing an expiry makes
 * a grant permanent, which is the one edit here that WIDENS, and it is not
 * needed by any control the page offers.
 */
export const UPDATE_ASK_GRANT = gql(`
  mutation UpdateAskGrant($id: ID!, $input: UpdateAskGrantInput!) {
    updateAskGrant(id: $id, input: $input) {
      success
      grant {
        id
        mode
        expiresAt
        active
        revokedAt
        supersedesGrantId
      }
    }
  }
`);

/**
 * The owner's own disclosure receipt — every terminal outcome of an ask they
 * responded to, including the ones a standing grant answered without them.
 *
 * `outcome` is the reason this query is worth its round-trip and the reason the
 * history is not merely a prettier inbox: it is the ONLY field on the wire that
 * separates `answered` (a human read it and said yes) from `auto_answered` (a
 * grant released it). `AskAnswerType` has no such flag — see AnswerPanel.tsx for
 * why the asker's copy of an answer therefore cannot claim either.
 *
 * `disclosedCount` is the responder-true number: this query is responder-scoped,
 * so unlike `askAnswer` it is not narrowed for an asker.
 */
export const ASK_DISCLOSURE_HISTORY = gql(`
  query AskDisclosureHistory($input: AskDisclosureHistoryInput) {
    askDisclosureHistory(input: $input) {
      truncated
      rows {
        id
        askId
        askerId
        peerHandle
        responderId
        consentBasis
        outcome
        disclosedCount
        createdAt
        query {
          queryType
          dataClass
          prompt
          purpose
          actor {
            kind
            label
          }
        }
      }
    }
  }
`);

/**
 * The same record, folded BY RELATIONSHIP — the unit an owner actually arrives
 * with.
 *
 * A flat event list makes "what has Ana been getting?" a scrolling-and-tallying
 * exercise, and it is at its LEAST usable exactly when it has accumulated the
 * most to say. This is the index; `ASK_DISCLOSURE_HISTORY` filtered by
 * `counterpartyKey` is the drill-in.
 *
 * `autoAnswered` and `reviewed` stay SEPARATE on the wire rather than summing
 * to "answered", because "a rule you wrote once released this without asking
 * you" is the number an owner needs to notice and the other is not.
 *
 * `truncated` says the fold ran over a capped read, so the totals are floors
 * rather than totals. Rendering a floor as a total on a completeness surface is
 * the failure this flag exists to prevent.
 */
export const ASK_DISCLOSURE_SUMMARY = gql(`
  query AskDisclosureSummary($input: AskDisclosureSummaryInput) {
    askDisclosureSummary(input: $input) {
      truncated
      summaries {
        key
        askerId
        peerLinkId
        peerHandle
        total
        autoAnswered
        reviewed
        declined
        expired
        itemsDisclosed
        asksInWindow
        itemsInWindow
        firstAt
        lastAt
      }
    }
  }
`);

/**
 * The answer to ONE ask, read by whoever is entitled to it.
 *
 * The resolver returns null unless the caller is a participant AND the ask has
 * actually reached `answered`, so this cannot be used to watch an ask progress.
 *
 * What comes back is NOT the same document for both parties, and the difference
 * is the point: `AskAnswerType.toType` narrows the projection for the asker —
 * `consentBasis` becomes null, a non-itemizing form reports `disclosedCount: 0`
 * and `withheldCount: 0`, and the summary is swapped for a count-free one. The
 * card that renders this must therefore never treat a zero as "nothing was
 * shared"; see AnswerPanel.tsx.
 */
export const ASK_ANSWER = gql(`
  query AskAnswer($id: ID!) {
    askAnswer(id: $id) {
      id
      askId
      form
      answerSource
      summary
      disclosedCount
      withheldCount
      consentBasis
      createdAt
      items {
        id
        type
      }
    }
  }
`);

/**
 * Send an ask.
 *
 * `CreateAskPayload.decision` is deliberately NOT selected. The resolver already
 * collapses it to a constant precisely so the asker cannot read the responder's
 * grant posture off it, and selecting a field whose only value is a constant
 * would invite a future reader to render it as if it meant something.
 *
 * `ask.status` IS selected, and it is safe: `askerVisibleStatus` collapses every
 * state the asker may not know about down to `delivered`, in the projection, for
 * every read path.
 */
export const CREATE_ASK = gql(`
  mutation CreateAsk($input: CreateAskInput!) {
    createAsk(input: $input) {
      success
      ask {
        id
        status
        createdAt
        responderId
        peerHandle
        query {
          queryType
          dataClass
          prompt
          purpose
          actor {
            kind
            label
          }
        }
      }
    }
  }
`);

/**
 * The people this box exchanges asks with — and how far each is trusted.
 *
 * `trustTier` is the field that makes this query worth having on a consent
 * surface. It is not a label: `policy.ts` maps each tier to a maximum
 * disclosure rung, so it is the CEILING on everything that peer can ever be
 * told, and lowering it narrows every future answer without touching a grant.
 * An owner who cannot see it cannot govern it, which is why the peer tab exists
 * at all.
 *
 * `status` and `revokedAt` are both selected because `myPeerLinks` returns
 * revoked links on purpose — "who did I used to share with" is a question the
 * owner is entitled to ask, and a revocation the UI hides is one they cannot
 * verify happened.
 */
export const MY_PEER_LINKS = gql(`
  query MyPeerLinks {
    myPeerLinks {
      id
      peerHandle
      displayName
      memoryEndpoint
      personEntityId
      avatarUrl
      trustTier
      status
      revokedAt
      createdAt
    }
  }
`);

/**
 * Add a peer.
 *
 * `trustTier` is NOT sent. The resolver defaults an omitted tier to `stranger`
 * — the narrowest — and that default is the safety property: adding a person is
 * not the same gesture as trusting them. Sending a tier from the add form would
 * let one gesture do both, so raising a tier is a separate, deliberate act on a
 * link that already exists.
 */
export const CREATE_PEER_LINK = gql(`
  mutation CreatePeerLink($input: CreatePeerLinkInput!) {
    createPeerLink(input: $input) {
      success
      peerLink {
        id
        peerHandle
        displayName
        memoryEndpoint
        avatarUrl
        trustTier
        status
        revokedAt
      }
    }
  }
`);

export const UPDATE_PEER_LINK = gql(`
  mutation UpdatePeerLink($input: UpdatePeerLinkInput!) {
    updatePeerLink(input: $input) {
      success
      peerLink {
        id
        peerHandle
        displayName
        memoryEndpoint
        avatarUrl
        trustTier
        status
        revokedAt
      }
    }
  }
`);

export const REVOKE_PEER_LINK = gql(`
  mutation RevokePeerLink($id: ID!) {
    revokePeerLink(id: $id) {
      success
      peerLink {
        id
        peerHandle
        avatarUrl
        trustTier
        status
        revokedAt
      }
    }
  }
`);
