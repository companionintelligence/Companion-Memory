import { partyLabel } from './askBinding';
import type { ComposerRecipient, ComposerShape, UnreachableRecipient } from './AskComposer';
import { peerTrustLabel } from './askPresentation';

/**
 * Where the recipient list comes from, and why it is not a user search.
 *
 * ═══ THE PICKER PROBLEM ═══
 *
 * `createAsk` needs `responderId` — an opaque user id. Nothing on this schema
 * lists users, and adding such a query would hand any signed-in account a roster
 * of everyone on an appliance that holds one person's entire life. The backend
 * has already gone to some trouble to prevent exactly that: `AskService.create`
 * gives "you cannot ask yourself" and "no such user" the IDENTICAL error, so
 * `createAsk` cannot be used as an enumeration oracle either.
 *
 * So the picker is built from ids the owner is ALREADY LOOKING AT on this page:
 *
 *  - `myAskGrants[].granteeId` — somebody they wrote a standing grant for;
 *  - `askInbox[].askerId` — somebody who has asked them something;
 *  - `askOutbox[].responderId` — somebody they have asked before.
 *
 * Every one of those is rendered elsewhere on this same page, so assembling
 * them here discloses nothing that was not already on screen. It is also the
 * right SHAPE for a consent surface: the people you can ask are the people you
 * have a relationship with, not a directory.
 *
 * The obvious objection is that it cannot bootstrap — two accounts on a fresh
 * box with no history between them cannot reach each other. That is true, and
 * it is stated in the composer's empty state rather than papered over with a
 * search box. The fix is a real one (an invite, or a household roster the owner
 * opts into), and it is a backend change.
 */

/** One id the owner already has a relationship with, and how we know. */
interface Candidate {
  id: string;
  /** Ranked: a lower number wins when the same person appears twice. */
  rank: number;
  why: string;
  autoAnswers?: boolean;
}

export interface RecipientSources {
  readonly grants: readonly {
    granteeId?: string | null;
    mode?: string | null;
    active?: boolean | null;
    revokedAt?: string | null;
  }[];
  readonly inbox: readonly { askerId?: string | null; peerHandle?: string | null }[];
  readonly outbox: readonly { responderId?: string | null; peerHandle?: string | null }[];
}

/**
 * Build the composer's recipient list.
 *
 * ═══ TWO EXCLUSIONS THAT ARE NOT TIDYING ═══
 *
 * 1. A row carrying a `peerHandle` is SKIPPED, even though it also carries an
 *    id. A federated ask's local id belongs to whichever side of the link is
 *    local, and for an inbound peer ask `askerId` is null anyway — but an
 *    OUTBOUND row's `responderId` is null too, and the one that is populated
 *    would address the wrong box. Peers are surfaced separately, as
 *    unreachable, with the reason.
 *
 * 2. A grant whose `active` is `false`, or that carries a `revokedAt`, does not
 *    put its grantee in the list. Consent the owner has withdrawn is not a
 *    relationship the page should keep suggesting they act on — and a revoked
 *    grant is precisely the case where "we still have their id" is true and
 *    irrelevant.
 *
 * Pure.
 */
export function composeRecipients(sources: RecipientSources): ComposerRecipient[] {
  const byId = new Map<string, Candidate>();

  const offer = (candidate: Candidate) => {
    const existing = byId.get(candidate.id);

    if (existing == null || candidate.rank < existing.rank) {
      byId.set(candidate.id, { ...candidate, autoAnswers: candidate.autoAnswers || existing?.autoAnswers });

      return;
    }

    if (candidate.autoAnswers) {
      byId.set(candidate.id, { ...existing, autoAnswers: true });
    }
  };

  for (const grant of sources.grants) {
    if (!grant.granteeId || grant.revokedAt != null || grant.active === false) {
      continue;
    }

    offer({
      id: grant.granteeId,
      rank: 0,
      why: 'you have given them a standing grant',
      autoAnswers: grant.mode === 'auto',
    });
  }

  for (const ask of sources.inbox) {
    if (!ask.askerId || ask.peerHandle) {
      continue;
    }

    offer({ id: ask.askerId, rank: 1, why: 'they have asked you something' });
  }

  for (const ask of sources.outbox) {
    if (!ask.responderId || ask.peerHandle) {
      continue;
    }

    offer({ id: ask.responderId, rank: 2, why: 'you have asked them before' });
  }

  return [...byId.values()]
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
    .map((candidate) => ({
      id: candidate.id,
      // Never invented — `partyLabel` shortens an opaque id and marks it as a
      // truncation rather than dressing it up as somebody's name.
      name: partyLabel(null, candidate.id),
      // No photo either, for the same reason: every id here is a LOCAL
      // relationship (see the exclusion above), and nothing on this schema
      // resolves one to a Person's avatar. `PersonAvatar` still renders a real
      // avatar for these — initials on a deterministic colour, seeded from the
      // same opaque label — rather than leaving the picker's rows as bare text.
      avatarUrl: null,
      // The composer's badge asserts whatever it is handed, so it is handed the
      // one thing that is true of everybody in this list.
      tier: 'on this Companion',
      why: candidate.why,
      autoAnswers: candidate.autoAnswers,
    }));
}

/**
 * The people the owner has linked, and cannot ask from this page.
 *
 * Revoked links are dropped — an ended relationship is not a thing to explain
 * the unavailability of. Everything else is listed WITH ITS TIER, because the
 * tier is the ceiling on what that peer could ever be told and it is the fact
 * the owner came to this page holding.
 *
 * ═══ THE REASON NAMES THE WAY OUT, NOT JUST THE WALL ═══
 *
 * `sendPeerAsk` takes a `peerAccessToken` that nothing on this page can mint,
 * so a linked peer genuinely is un-askable from here. But an owner reading only
 * that concluded the whole feature was inert, which is not true: an account on
 * THIS appliance is askable today, and the grant they need to make that work is
 * one tab away. Saying so is the difference between "this is broken" and "you
 * are on the federated path, and the local one works".
 *
 * Pure.
 */
export function unreachablePeers(
  links: readonly {
    id: string;
    peerHandle: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    trustTier: string;
    status?: string | null;
    revokedAt?: string | null;
  }[],
): UnreachableRecipient[] {
  return links
    .filter((link) => link.revokedAt == null && link.status !== 'revoked')
    .map((link) => ({
      id: link.id,
      name: link.displayName || link.peerHandle,
      avatarUrl: link.avatarUrl ?? null,
      tier: peerTrustLabel(link.trustTier),
      reason:
        'asking across boxes needs an access token from the Portal that your Companion cannot issue from this page yet — someone with an account on this Companion can be asked once you grant them under “Who can ask me what”',
    }));
}

/**
 * The archetype vocabulary the server accepts, mirrored from
 * `backend/apps/api/src/domains/asks/askGrammar.ts`.
 *
 * Duplicated rather than imported because the web app cannot import from the
 * API package, and left as a named export so `composeRecipients.test.ts` can
 * assert every shape below names one. That assertion is the whole point of the
 * constant — see the block comment on {@link COMPOSER_SHAPES}.
 */
export const ASK_ARCHETYPES = [
  'relationship',
  'content',
  'availability',
  'attribute',
  'identity',
] as const;

export type AskArchetype = (typeof ASK_ARCHETYPES)[number];

/**
 * The kinds of question the composer offers, and the wire values behind each.
 *
 * ═══ TWO OF THESE USED TO BE REJECTED OUTRIGHT ═══
 *
 * `queryType` is not free text on the server any more. `parseAskQueryType`
 * closes it to {@link ASK_ARCHETYPES} and THROWS a 400 on anything else, and
 * `createAsk` runs every ask through it. This list still carried the pre-closure
 * vocabulary: `existence` and `photos` are not archetypes, so two of the four
 * question shapes the composer offered failed with
 * "queryType must be one of: relationship, content, availability, attribute,
 * identity" the moment Send was pressed. Nothing caught it, because every test
 * on this page mocks the mutation and never reaches the resolver.
 *
 * The mapping back is not a rename — the old list confused the answer FORM with
 * the archetype that produces it:
 *
 *   existence (a form) -> content     (the archetype whose form IS existence)
 *   photos (a data class) -> content  + dataClass: 'photos'
 *
 * `relationship` and `attribute` were already archetypes and are unchanged.
 *
 * Each entry states its ceiling in the owner's words, and those words are now
 * true of what the server will actually do: `formForArchetype` is consulted
 * FIRST by `inferAnswerForm`, so a `content` ask is capped at a count. Note the
 * photos entry no longer promises item references — it cannot deliver them.
 * `dataClass` is carried on exactly one shape, and its copy is careful not to
 * claim it narrows the search; `searchBreadthNote` explains why a class the
 * responder's box does not recognise searches everything.
 */
export const COMPOSER_SHAPES: readonly ComposerShape[] = [
  {
    id: 'relationship',
    label: 'Do you know…?',
    queryType: 'relationship',
    ceiling: 'They can answer at most yes or no.',
  },
  {
    id: 'existence',
    label: 'Do you have any…?',
    queryType: 'content',
    ceiling: 'They can answer at most how many — never which ones.',
  },
  {
    id: 'attribute',
    label: 'What is…?',
    queryType: 'attribute',
    ceiling: 'They can answer at most with a summary.',
  },
  {
    id: 'availability',
    label: 'Are you free…?',
    queryType: 'availability',
    ceiling: 'They can answer at most with a summary — never your calendar.',
  },
  {
    id: 'photos',
    label: 'Do you have photos of…?',
    queryType: 'content',
    dataClass: 'photos',
    ceiling:
      'They can answer at most how many — never which ones. Naming “photos” does not narrow what their Companion searches.',
  },
];
