/**
 * Turning what the API returns into what the ask components require.
 *
 * This file exists because the two do not line up, and the gap is the honest
 * part of this page. The components were designed against a mock that assumed
 * a display NAME for each party, a trust TIER, an `autoAnswered` discriminator
 * and per-item LABELS. None of those exist on the schema today.
 *
 * The temptation is to pass plausible-looking values so the UI looks finished.
 * That is exactly the defect an audit already found in these components: `tier`
 * is an untyped display string, so the badge asserts whatever the caller says —
 * rendering `tier="ceo-of-everything"` produced a convincing trust badge. A
 * consent surface that displays an unearned claim is worse than one that admits
 * it does not know, because the whole point is that the owner can trust what it
 * says. So every helper below either DERIVES its answer from a field that
 * actually exists, or returns an explicitly unknown value.
 */

/**
 * How many trailing characters of an opaque id we show.
 *
 * Six is enough to tell two ids apart at a glance and short enough not to read
 * as a name.
 */
const ID_TAIL = 6;

/**
 * The tail of an opaque id, presented so it reads as a TRUNCATION rather than
 * as corrupted text.
 *
 * `id.slice(-6)` alone produced "Peer __devon", "Peer r_maya" and "photo
 * a3f2b1": a bare fragment with nothing marking it as one, so it reads either
 * as a rendering bug or — worse — as a name. The single leading ellipsis says
 * out loud that characters precede it, which is the whole fix; "…_devon" is
 * plainly the end of a longer identifier in a way that "__devon" is not.
 *
 * NOT DROPPED: the leading `_`/`-` a base64url slice often starts on. Trimming
 * it reads more smoothly and was tried first — and it is exactly the wrong
 * trade here, twice over. It shortens the discriminating tail, so two ids that
 * differ only in that position stop being distinguishable; and "…devon" reads
 * far more like somebody's name than "…_devon" does, which is the one thing
 * this whole file exists to avoid. The fragment stays a faithful suffix.
 */
function idFragment(id: string): string {
  return `…${id.slice(-ID_TAIL)}`;
}

/** A party we can only identify opaquely. */
export function partyLabel(handle: string | null | undefined, id: string | null | undefined): string {
  if (handle) {
    return handle;
  }

  if (!id) {
    return 'Unknown';
  }

  // Never invented, just shortened — see idFragment.
  return `Peer ${idFragment(id)}`;
}

/**
 * The slice of `myPeerLinks` a party join needs — just enough to name a
 * counterparty and show their photo, not the whole `PeerRow` shape.
 */
export interface PeerLinkLookup {
  peerHandle: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}

/**
 * Index `myPeerLinks` by handle, once per render, so every row on the page
 * can join against it in O(1) instead of each doing its own `.find()`.
 *
 * This is the SAME pattern `composeRecipients`/`unreachablePeers` already use
 * the peer roster for (reading it as a lookup keyed by an id it already has,
 * rather than adding a second query) — a party row already carries the
 * `peerHandle` a federated ask was addressed with or from, exactly the way a
 * composer row already carries the ids it renders against.
 */
export function peerLinksByHandle(links: readonly PeerLinkLookup[]): ReadonlyMap<string, PeerLinkLookup> {
  return new Map(links.map((link) => [link.peerHandle, link]));
}

/** What a party avatar needs: a name to show and initial from, and a photo if there is one. */
export interface PartyAvatar {
  name: string;
  avatarUrl: string | null;
}

/**
 * Name and photo for a party, joining a known peer link by handle when there
 * is one.
 *
 * A row carrying a `peerHandle` that resolves against `myPeerLinks` gets that
 * link's `displayName` (falling back to the handle itself, same as
 * {@link partyLabel}) and its `avatarUrl`. Everything else — a local
 * relationship id, or a handle the roster has not resolved (still loading, or
 * the link was since revoked) — falls back to {@link partyLabel}'s opaque,
 * never-invented text and no photo. `PersonAvatar` turns that text into
 * initials on its own, so an unresolved party still renders as a real avatar,
 * just without a photo.
 */
export function partyAvatar(
  handle: string | null | undefined,
  id: string | null | undefined,
  links: ReadonlyMap<string, PeerLinkLookup>,
): PartyAvatar {
  const link = handle ? links.get(handle) : undefined;

  if (link) {
    return { name: link.displayName || link.peerHandle, avatarUrl: link.avatarUrl ?? null };
  }

  return { name: partyLabel(handle, id), avatarUrl: null };
}

/**
 * The only trust signal the API actually supports today.
 *
 * `consentBasis` is set when a standing grant matched the ask, so its presence
 * proves the asker is someone the owner has already made a decision about. That
 * is a real two-value fact. It is NOT the mock's five-tier vocabulary
 * (household/family/trusted/peer/stranger) — no tier reaches this client — so
 * this deliberately does not use those words.
 */
export function knownAskerLabel(consentBasis: string | null | undefined): string {
  return consentBasis ? 'known contact' : 'no standing grant';
}

/**
 * A legible rendering of the structured ask — what the asker SENT.
 *
 * The mock claims this rendering IS the wire format. Today that is nearly true
 * by accident: the wire carries exactly queryType/dataClass/prompt, so showing
 * all three shows everything that is sent. It stops being true the moment
 * who/when/where are added to the input without being added here.
 *
 * This is NOT a statement about what will be searched. See
 * {@link searchBreadthNote}.
 */
export function scopeSummary(query: { queryType: string; dataClass?: string | null }): string {
  return query.dataClass ? `${query.queryType} · ${query.dataClass}` : query.queryType;
}

/**
 * What the declared data class actually does to the search — the sentence that
 * stops the consent card promising a narrower scope than runs.
 *
 * ═══ WHY THIS IS VAGUE ON PURPOSE ═══
 *
 * The card used to print "Would search: photos · location" and nothing else,
 * which reads as "only your location data is searched". `AskExecutorService`
 * turns `dataClass` into an entity-type filter through a small hint table
 * (`photos`/`media`/`files` → file, `documents` → content+file, `events`/
 * `calendar` → event, `messages`/`communications` → communication) and, for
 * ANYTHING else — `location`, `health`, a typo, or a class the owner never saw
 * before — returns `undefined`, which means the search runs UNFILTERED across
 * every indexable entity in the responder's memory. The owner was consenting to
 * a strictly narrower scope than the one that executed.
 *
 * The obvious fix is to mirror that hint table here and render the real entity
 * types. It was rejected: the table lives in the backend and this copy would be
 * the third normalizer of `dataClass` in the system (canonical.ts already warns
 * that any consumer normalizing DIFFERENTLY is a security bug). Mirrored
 * constants drift, and the drift that matters here is one-directional — the day
 * a class is dropped from the backend table, a stale mirror keeps promising a
 * narrowing that no longer happens, which is precisely this defect growing back
 * silently. Over-stating breadth is safe in every direction; under-stating it is
 * never safe.
 *
 * So the card states the ceiling instead of guessing the filter: the search may
 * cover everything, and the class is a label on the request rather than a
 * guaranteed filter. If the executor ever returns its resolved entity types on
 * the wire, replace this with them — a fact beats a caveat.
 */
export function searchBreadthNote(query: { dataClass?: string | null }): string {
  if (!query.dataClass) {
    return 'This ask names no data class, so it searches every kind of thing in your memory.';
  }

  return (
    `“${query.dataClass}” is a label on the request, not a guaranteed filter — ` +
    'unless your Companion recognises it, this searches every kind of thing in your memory.'
  );
}

/**
 * A label for a disclosed item.
 *
 * `DisclosedItemType` is `{id, type}` — there is no title, name or caption on
 * the wire. Showing the type plus a truncated id is the most that can be said
 * truthfully; a real label needs the backend to resolve the entity.
 */
export function itemLabel(item: { id: string; type: string }): string {
  return `${item.type} ${idFragment(item.id)}`;
}

/** Owner-facing words for a data class + query type pair on a grant. */
export function grantLabel(queryType: string, dataClass: string | null | undefined): string {
  return dataClass ? `${queryType} · ${dataClass}` : `${queryType} · all classes`;
}
