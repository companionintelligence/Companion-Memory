/**
 * Pure presentation helpers for the CONSENT and CHANNEL facts behind a
 * disclosure — the data the lock icon summarizes and the signature modal spells
 * out.
 *
 * Kept free of React, like `askPresentation.ts` beside it, because this is the
 * vocabulary in which an owner is told what protected a disclosure. If it drifts
 * from what the backend actually enforced, the lock becomes a decoration that
 * asserts a guarantee nobody made.
 *
 * ═══ TWO INDEPENDENT AXES, ONE ICON ═══
 *
 * A disclosure is governed by two separate things, and they fail separately:
 *
 *   CONSENT  — what authorized it. A standing grant the owner wrote, a decision
 *              the owner made in the moment, or nothing yet.
 *   CHANNEL  — how the request arrived. Signed by the peer's own key (RFC 9421,
 *              verified against the key on their peer link), or merely carrying
 *              a bearer token that names them.
 *
 * The lock shows the weaker of the two, never the stronger: a signed request
 * with no consent is not "protected", and neither is a consented one that
 * arrived over a channel anybody holding a leaked token could have used. The
 * modal then shows BOTH, because which one is missing decides what the owner
 * should do about it.
 */

/** How the request that produced a disclosure arrived. */
export interface ChannelFacts {
  /** RFC 7638 thumbprint of the key that signed it. Null = unsigned channel. */
  keyThumbprint: string | null;
  /** When the responder's box verified that signature. */
  verifiedAt: string | null;
  /** Signature base components the signature actually covered. */
  covered: readonly string[];
}

/** What authorized a disclosure. */
export type ConsentSource =
  /** A standing grant the owner wrote earlier. */
  | 'standing-grant'
  /** The owner decided this one personally. */
  | 'owner-decision'
  /** Not decided yet — the ask is sitting in the review inbox. */
  | 'undecided';

/**
 * The lock's four states, weakest first.
 *
 * `open` is deliberately NOT alarming and `sealed` is deliberately not the
 * default: signatures ship off (`peers.requireHttpSignature`), and a local ask
 * never crosses a network boundary at all, so most disclosures are honestly
 * `consented`. A UI that painted the common case as a warning would train
 * people to ignore the warning.
 */
export type ConsentLockState = 'open' | 'pending' | 'consented' | 'sealed';

/**
 * Reduce the two axes to the one state the lock shows.
 *
 * WEAKEST WINS, and the order below is the whole rule. A signature over a
 * request nobody consented to is not protection — it proves who asked, not that
 * they were allowed to — so `undecided` outranks a verified signature.
 */
export function consentLockState(params: {
  consent: ConsentSource;
  channel: ChannelFacts;
}): ConsentLockState {
  if (params.consent === 'undecided') {
    return 'pending';
  }

  const signed = params.channel.keyThumbprint != null && params.channel.verifiedAt != null;

  return signed ? 'sealed' : 'consented';
}

/**
 * The lock's label and its one-line meaning.
 *
 * Both are TEXT. The icon and the badge variant only reinforce what the words
 * already say — WCAG 1.4.1, the same rule the rest of the ask surfaces follow.
 */
export function consentLockLabel(state: ConsentLockState): { label: string; meaning: string } {
  switch (state) {
    case 'sealed':
      return {
        label: 'Signed',
        meaning: 'Signed by the asker’s own key, and covered by consent you gave.',
      };
    case 'consented':
      return {
        label: 'Consented',
        meaning: 'Covered by consent you gave. The request itself was not signed.',
      };
    case 'pending':
      return {
        label: 'Awaiting you',
        meaning: 'Nothing has been shared. This is waiting on your decision.',
      };
    case 'open':
    default:
      return {
        label: 'No record',
        meaning: 'No consent basis was recorded for this disclosure.',
      };
  }
}

/**
 * What each RFC 9421 covered component actually protects, in the owner's terms.
 *
 * This is the table the signature modal renders, and it exists because a list of
 * component names is not an explanation. "`@target-uri`" tells an owner nothing;
 * "stops the same signature being replayed at a different endpoint" tells them
 * what they would lose without it.
 *
 * Only the three our profile accepts are named. An unrecognized component gets a
 * deliberately flat description rather than a guess — see
 * {@link coveredComponentPurpose}.
 */
export const COVERED_COMPONENT_PURPOSE: Readonly<Record<string, { title: string; protects: string }>> = {
  '@method': {
    title: 'Request method',
    protects: 'Stops a signed read being replayed as a write, or the reverse.',
  },
  '@target-uri': {
    title: 'Destination',
    protects: 'Stops the same signature being replayed against a different endpoint or a different box.',
  },
  'content-digest': {
    title: 'The question itself',
    protects:
      'Stops anything on the network path altering the question between them sending it and you seeing it.',
  },
};

/**
 * Describe one covered component.
 *
 * An unknown component is reported AS UNKNOWN rather than hidden. Our parser
 * only accepts three today, so anything else means the profile widened and this
 * table did not — and silently dropping the row would show an owner a signature
 * that covers more than the modal admits.
 */
export function coveredComponentPurpose(name: string): { title: string; protects: string } {
  return (
    COVERED_COMPONENT_PURPOSE[name] ?? {
      title: name,
      protects: 'Covered by the signature. This app does not have a description for it.',
    }
  );
}

/**
 * The components our profile requires but this signature did NOT cover.
 *
 * Shown so the modal can state a gap rather than only listing what is present.
 * A reader comparing two signatures should not have to know the required set by
 * heart to notice one is short.
 *
 * `content-digest` is only required when there was a body: a collect request has
 * none, and reporting it missing there would be a false negative on every poll.
 */
export function uncoveredComponents(covered: readonly string[], hasBody: boolean): string[] {
  const required = ['@method', '@target-uri', ...(hasBody ? ['content-digest'] : [])];

  return required.filter((component) => !covered.includes(component));
}

/**
 * An abbreviated key thumbprint, for a line of prose.
 *
 * The full 43-character value is still rendered in the modal's detail row and is
 * selectable — this is for the sentence, not a replacement for the value. Short
 * enough to read, long enough that two of the owner's peers do not collide in
 * practice.
 *
 * A value that is not thumbprint-shaped is returned UNCHANGED rather than
 * truncated: if something other than a thumbprint reached this field, hiding its
 * middle would make it harder to recognize that, not easier.
 */
export function shortThumbprint(thumbprint: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(thumbprint)) {
    return thumbprint;
  }

  return `${thumbprint.slice(0, 6)}…${thumbprint.slice(-4)}`;
}

/**
 * One sentence describing how the request arrived.
 *
 * The unsigned case is stated PLAINLY and without alarm. It is the common case
 * today, it is not a defect, and an owner who cannot tell "arrived unsigned"
 * from "we did not record how it arrived" cannot act on either.
 */
export function channelSentence(channel: ChannelFacts, askerName: string): string {
  if (channel.keyThumbprint == null || channel.verifiedAt == null) {
    return `This arrived over an unsigned channel — ${askerName}’s Companion did not sign the request, so it is trusted on the strength of their sign-in alone.`;
  }

  return `${askerName}’s Companion signed this request with key ${shortThumbprint(channel.keyThumbprint)}, and your Companion checked that signature against the key on their peer link.`;
}

/**
 * One sentence describing what authorized the disclosure.
 *
 * Mirrors the split `DisclosureHistory` already makes between `auto_answered`
 * and `answered`, for the same reason: "a rule you wrote once released this
 * without asking you" is the outcome an owner needs to notice, and "you decided
 * this yourself" is not.
 */
export function consentSentence(consent: ConsentSource, askerName: string): string {
  switch (consent) {
    case 'standing-grant':
      return `A standing grant you gave ${askerName} authorized this — it was answered without asking you.`;
    case 'owner-decision':
      return 'You decided this one yourself. No standing grant covered it.';
    case 'undecided':
    default:
      return 'Nothing has been shared yet. This is waiting on your decision.';
  }
}

/**
 * A timestamp an owner can act on.
 *
 * Date AND time, locale-formatted, never relative — the same choice
 * `DisclosureHistory.formatWhen` makes and for the same reason: the question
 * these surfaces answer is "did this happen when I think it did", and a relative
 * label is the wrong shape for comparing against a memory of a conversation.
 *
 * An unparseable value falls back to the raw string. Showing what is stored
 * beats showing "Invalid Date" on somebody's own audit trail.
 */
export function formatMoment(iso: string): string {
  const at = new Date(iso);

  if (Number.isNaN(at.getTime())) {
    return iso;
  }

  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
