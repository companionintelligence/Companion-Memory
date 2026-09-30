import { type ReactNode, useMemo, useState } from 'react';

import { useMutation } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import { Badge, Button } from '@ci/shadcn';
import { Loader2, Merge } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { PersonAvatar } from '@/components/PersonAvatar';
import { gql } from '@/graphql';
import type { GetMergeCandidatesQuery } from '@/graphql/graphql';

import { isGivenNameOnly, sharedNameTokens, tokenizeDisplayName } from './peopleNameTokens';

const MERGE_PEOPLE = gql(`
  mutation MergePeople($input: MergePeopleInput!) {
    mergePeople(input: $input) {
      success
      person {
        id
        name
      }
    }
  }
`);

const REJECT_PERSON_DUPLICATES = gql(`
  mutation RejectPersonDuplicates($personIds: [ID!]!) {
    rejectPersonDuplicates(personIds: $personIds)
  }
`);

export interface MergeOutcome {
  removedIds: string[];
  keptId: string | null;
}

export type MergeCandidate = GetMergeCandidatesQuery['mergeCandidates']['edges'][number]['node'];
type MergablePerson = MergeCandidate['people'][number];
type PersonIdentifier = NonNullable<MergablePerson['identifiers']>[number];

type MergeGroup =
  | { type: 'pair'; candidate: MergeCandidate }
  | { type: 'cluster'; token: string; anchor: MergablePerson; members: MergeCandidate[] };

export function groupMergeCandidates(candidates: readonly MergeCandidate[]): MergeGroup[] {
  const used = new Set<string>();
  const groups: MergeGroup[] = [];
  const byPerson = new Map<string, MergeCandidate[]>();

  for (const candidate of candidates) {
    for (const person of candidate.people) {
      const list = byPerson.get(person.id) ?? [];
      list.push(candidate);
      byPerson.set(person.id, list);
    }
  }

  for (const [personId, list] of byPerson) {
    if (list.length < 2) {
      continue;
    }

    const person = list[0]?.people.find((item) => item.id === personId);
    if (person == null || !isGivenNameOnly(person.name)) {
      continue;
    }

    // A pair whose people state different LinkedIn profiles, or the same
    // phone digits in different countries, never joins a "which one is
    // them?" picker: the picker shows no reason line, so the conflict would be
    // invisible exactly where one click merges the pair.
    const clusterable = list.filter(
      (candidate) =>
        !isIdentityVetoed(candidate.evidence) &&
        candidate.evidence.some((item) => item.kind === 'name_cluster' || item.kind === 'name_overlap'),
    );

    if (clusterable.length < 2 || clusterable.some((candidate) => used.has(candidate.id))) {
      continue;
    }

    for (const candidate of clusterable) {
      used.add(candidate.id);
    }

    const token = tokenizeDisplayName(person.name)?.given ?? person.name ?? 'this person';
    groups.push({ type: 'cluster', token, anchor: person, members: clusterable });
  }

  for (const candidate of candidates) {
    if (!used.has(candidate.id)) {
      groups.push({ type: 'pair', candidate });
    }
  }

  return groups;
}

export function MergeCandidateCard({
  candidate,
  onMerged,
}: {
  candidate: MergeCandidate;
  onMerged: (outcome: MergeOutcome) => Promise<unknown>;
}) {
  const sharedPhones = useMemo(() => sharedPhoneNumbers(candidate.evidence), [candidate.evidence]);

  return (
    <MergeSuggestionCard
      people={candidate.people}
      sharedPhones={sharedPhones}
      onMerged={onMerged}
      heading={<CandidateHeading candidate={candidate} />}
      note={<CandidateDiff people={candidate.people} sharedPhones={sharedPhones} />}
    />
  );
}

export function MergeClusterCard({
  token,
  anchor,
  members,
  onMerged,
}: {
  token: string;
  anchor: MergablePerson;
  members: readonly MergeCandidate[];
  onMerged: (outcome: MergeOutcome) => Promise<unknown>;
}) {
  const [mergePeople, { loading: merging }] = useMutation(MERGE_PEOPLE);
  const [rejectDuplicates, { loading: rejecting }] = useMutation(REJECT_PERSON_DUPLICATES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = members.flatMap((member) => member.people.filter((person) => person.id !== anchor.id));
  const allIds = [...new Set([anchor.id, ...options.map((person) => person.id)])];
  const inFlight = busy || merging || rejecting;

  const choose = async (personId: string) => {
    // The sparse name is the unknown. Fold it into the chosen person — never
    // the other unchosen Williams.
    const targetId = anchor.isSelf ? anchor.id : personId;
    const sourceId = targetId === personId ? anchor.id : personId;
    setBusy(true);
    setError(null);

    try {
      await mergePeople({ variables: { input: { targetId, sourceIds: [sourceId] } } });
      await onMerged({ removedIds: [sourceId], keptId: targetId });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The merge failed. Please try again.');
      setBusy(false);
    }
  };

  const rejectAll = async () => {
    setBusy(true);
    setError(null);

    try {
      await rejectDuplicates({ variables: { personIds: allIds } });
      await onMerged({ removedIds: [], keptId: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record that. Please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Merge className="h-4 w-4" />
        <span>
          <span className="font-medium text-foreground">{anchor.name || token}</span> might be one of these
          people
        </span>
      </div>

      <div className="mb-3 rounded-md bg-muted/50 px-3 py-2">
        <PersonSummary
          person={anchor}
          shared={new Set()}
          counterpart={null}
          sharedPhones={NO_SHARED_PHONES}
        />
      </div>

      <div className="flex flex-col gap-2">
        {options.map((person) => (
          <div
            key={person.id}
            className="flex flex-col gap-2 rounded-md border p-2 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1">
              <PersonSummary
                person={person}
                shared={sharedNameTokens(anchor.name, person.name)}
                counterpart={anchor}
                sharedPhones={NO_SHARED_PHONES}
              />
            </div>
            <Button
              size="sm"
              className="self-start sm:self-auto shrink-0"
              disabled={inFlight}
              onClick={() => {
                void choose(person.id);
              }}
            >
              {inFlight ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  Merging…
                </span>
              ) : (
                'This is them'
              )}
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-3 border-t pt-2">
        {error && <span className="text-sm text-destructive">{error}</span>}
        <Button size="sm" variant="ghost" disabled={inFlight} onClick={() => void rejectAll()}>
          {inFlight && rejecting ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Saving…
            </span>
          ) : (
            'None of these'
          )}
        </Button>
      </div>
    </div>
  );
}

function MergeSuggestionCard({
  people,
  sharedPhones,
  heading,
  note,
  onMerged,
}: {
  people: readonly MergablePerson[];
  sharedPhones: readonly SharedPhone[];
  heading: ReactNode;
  note?: ReactNode;
  onMerged: (outcome: MergeOutcome) => Promise<unknown>;
}) {
  const [mergePeople] = useMutation(MERGE_PEOPLE);
  const [rejectDuplicates] = useMutation(REJECT_PERSON_DUPLICATES);
  const [busy, setBusy] = useState<'merge' | 'reject' | null>(null);
  const [busyTargetId, setBusyTargetId] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const orderedPeople = useMemo(
    () => [...people].sort((a, b) => Number(b.isSelf) - Number(a.isSelf)),
    [people],
  );
  const hasSelf = orderedPeople.some((person) => person.isSelf);
  const defaultTargetId = orderedPeople.find((person) => person.isSelf)?.id ?? orderedPeople[0]?.id ?? null;
  const shared = sharedNameTokens(orderedPeople[0]?.name, orderedPeople[1]?.name);
  const inFlight = busy != null;

  const merge = async (targetId: string) => {
    const sourceIds = people.map((person) => person.id).filter((id) => id !== targetId);
    setBusy('merge');
    setBusyTargetId(targetId);
    setMergeError(null);

    try {
      await mergePeople({ variables: { input: { targetId, sourceIds } } });
      await onMerged({ removedIds: sourceIds, keptId: targetId });
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'The merge failed. Please try again.');
      setBusy(null);
      setBusyTargetId(null);
    }
  };

  const reject = async () => {
    setBusy('reject');
    setMergeError(null);

    try {
      await rejectDuplicates({ variables: { personIds: people.map((person) => person.id) } });
      await onMerged({ removedIds: [], keptId: null });
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Could not record that. Please try again.');
      setBusy(null);
    }
  };

  return (
    <div className={`rounded-md border p-3 ${inFlight ? 'opacity-80' : ''}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">{heading}</div>

      {note}

      <div className="flex flex-col gap-2">
        {orderedPeople.map((person) => (
          <div
            key={person.id}
            className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3"
          >
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <PersonAvatar name={person.name} avatarUrl={person.avatarUrl} size="sm" />
              <PersonSummary
                person={person}
                shared={shared}
                counterpart={orderedPeople.find((other) => other.id !== person.id) ?? null}
                sharedPhones={sharedPhones}
              />
            </div>

            {(!hasSelf || person.isSelf) && (
              <Button
                size="sm"
                variant="ghost"
                className="self-start sm:self-auto shrink-0"
                disabled={inFlight}
                onClick={() => {
                  void merge(person.id);
                }}
              >
                {busy === 'merge' && busyTargetId === person.id ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    Merging…
                  </span>
                ) : (
                  'Use as the kept person'
                )}
              </Button>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-3 border-t pt-2">
        {mergeError && <span className="text-sm text-destructive">{mergeError}</span>}
        <Button size="sm" variant="ghost" disabled={inFlight} onClick={() => void reject()}>
          {busy === 'reject' ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Saving…
            </span>
          ) : (
            'Not the same person'
          )}
        </Button>
        <Button
          size="sm"
          disabled={inFlight || defaultTargetId == null}
          aria-label={busy === 'merge' ? 'Merging' : 'Merge into one person'}
          onClick={() => {
            if (defaultTargetId != null) {
              void merge(defaultTargetId);
            }
          }}
        >
          {busy === 'merge' ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Merging…
            </span>
          ) : (
            'Merge into one person'
          )}
        </Button>
      </div>
    </div>
  );
}

function CandidateHeading({ candidate }: { candidate: MergeCandidate }) {
  return (
    <>
      <Merge className="h-4 w-4" />
      <Badge variant="secondary">{Math.round(candidate.score * 100)}% match</Badge>
      <span>{humanReason(candidate.evidence)}</span>
    </>
  );
}

function CandidateDiff({
  people,
  sharedPhones,
}: {
  people: readonly MergablePerson[];
  sharedPhones: readonly SharedPhone[];
}) {
  const differences = describeDifferences(people, sharedPhones);
  if (differences.length === 0) {
    return null;
  }

  return (
    <ul className="mb-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
      {differences.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function PersonSummary({
  person,
  shared,
  counterpart,
  sharedPhones,
}: {
  person: MergablePerson;
  shared: Set<string>;
  counterpart: MergablePerson | null;
  /**
   * The numbers the pair's phone evidence says BOTH records carry. The server
   * re-checks that evidence against the live records before the queue is
   * shown, so a number here is on both people — even when this person's
   * contact list cannot show it: `identifiers` is read from an index that can
   * hold a number for only one person, and from `phone`/`phones`, never from a
   * contact card's full typed list.
   */
  sharedPhones: readonly SharedPhone[];
}) {
  const identifiers = person.identifiers ?? [];
  const counterpartKeys = new Set((counterpart?.identifiers ?? []).map(identifierKey));
  const sharedPhoneKeys = new Set(sharedPhones.map((phone) => phone.key));
  const listedPhoneKeys = new Set(
    identifiers
      .filter((identifier) => identifier.kind === 'phone')
      .map((identifier) => phoneKey(identifier.value)),
  );
  // The evidence number this person's list does not show: listed here so the
  // card never claims a shared number it then shows on one side only.
  const unlistedShared = sharedPhones.filter((phone) => !listedPhoneKeys.has(phone.key));
  const channels = channelLabels(person);
  const stats = person.interactionStats;

  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to={`/people/${GlobalUID.parse('person', person.id)}`}
          className="truncate font-medium hover:underline"
        >
          <HighlightedName name={person.name} shared={shared} />
        </Link>
        {person.isSelf && <Badge variant="secondary">You</Badge>}
        {channels.map((channel) => (
          <Badge key={channel} variant="outline">
            {channel}
          </Badge>
        ))}
      </div>

      {(identifiers.length > 0 || unlistedShared.length > 0) && (
        <div className="mt-1 flex flex-col gap-0.5 text-sm text-muted-foreground">
          {identifiers.map((identifier) => {
            const unique =
              counterpart != null &&
              !counterpartKeys.has(identifierKey(identifier)) &&
              !(identifier.kind === 'phone' && sharedPhoneKeys.has(phoneKey(identifier.value)));

            return (
              <div key={`${identifier.kind}:${identifier.value}`}>
                {formatIdentifier(identifier)}
                {unique && <span className="ml-1 text-xs">only here</span>}
                {!unique && counterpart != null && <span className="ml-1 text-xs">shared</span>}
              </div>
            );
          })}
          {unlistedShared.map((phone) => (
            <div key={`shared-phone:${phone.key}`}>
              {phone.display}
              <span className="ml-1 text-xs">shared</span>
            </div>
          ))}
        </div>
      )}

      {stats != null && (stats.eventCount > 0 || stats.communicationCount > 0) && (
        <div className="mt-1 text-xs text-muted-foreground">
          {stats.eventCount} events · {stats.communicationCount} messages
        </div>
      )}

      {person.description && identifiers.length === 0 && unlistedShared.length === 0 && (
        <div className="truncate text-sm text-muted-foreground">{person.description}</div>
      )}
    </div>
  );
}

function HighlightedName({ name, shared }: { name: string | null | undefined; shared: Set<string> }) {
  if (name == null || name === '') {
    return <>Unnamed</>;
  }

  if (shared.size === 0) {
    return <>{name}</>;
  }

  const parts = name.split(/(\s+)/);

  return (
    <>
      {parts.map((part, index) => {
        const token = tokenizeDisplayName(part);
        const isShared = token != null && token.values.some((value) => shared.has(value));
        if (!isShared || part.trim() === '') {
          return <span key={`${part}:${index}`}>{part}</span>;
        }

        return (
          <span key={`${part}:${index}`} className="underline decoration-dotted underline-offset-2">
            {part}
          </span>
        );
      })}
    </>
  );
}

/**
 * The two people state different LinkedIn profiles (`profile_url_conflict`),
 * one card lists a profile the other does not (`profile_url_partial`), or the
 * same phone digits are two numbers in two countries
 * (`phone_country_conflict`). Evidence that they are two people, which the
 * reviewer must see before merging.
 */
function isIdentityVetoed(evidence: MergeCandidate['evidence']): boolean {
  return evidence.some(
    (item) =>
      item.kind === 'profile_url_conflict' ||
      item.kind === 'profile_url_partial' ||
      item.kind === 'phone_country_conflict',
  );
}

/**
 * Why a same-number pair was held for review, in words, most specific first.
 * The reasons are `phone_check` values written by the server's phone
 * adjudicator (`memory/utils/phoneIdentity.ts`).
 */
function phoneCheckReason(value: string): string {
  const reasons = new Set(value.split(',').map((reason) => reason.trim()));

  if (reasons.has('self_endpoint')) {
    return 'one side is you';
  }

  if (reasons.has('suffix_conflict')) {
    return 'names are a Jr/Sr pair';
  }

  if (
    [
      'given_name_conflict',
      'given_name_prefix',
      'family_name_conflict',
      'relational_name',
      'unknown_name',
      'numeric_name_mismatch',
    ].some((reason) => reasons.has(reason))
  ) {
    return 'names differ';
  }

  if (reasons.has('shared_line')) {
    return 'shared household line';
  }

  return 'not yet checked against both records';
}

/**
 * The one line that tells a reviewer why a pair is on the queue.
 *
 * Profile-URL verdicts are checked FIRST: a LinkedIn conflict outranks a
 * shared email (it is why an email pair is on the queue at all instead of
 * having been merged), and a contested profile match is the most specific
 * thing that can be said about a pair. A phone country conflict comes next,
 * for the same reason. A shared phone that the server held back
 * (`phone_check`) says why; "country not confirmed" is only for a phone
 * match below the exact tier with no such reason.
 */
export function humanReason(evidence: MergeCandidate['evidence']): string {
  if (evidence.some((item) => item.kind === 'profile_url_conflict')) {
    return 'Different LinkedIn profiles — likely two people';
  }

  if (evidence.some((item) => item.kind === 'profile_url_partial')) {
    return 'One card lists two LinkedIn profiles';
  }

  const profile = evidence.find((item) => item.kind === 'profile_url');
  if (profile != null) {
    if (evidence.some((item) => item.kind === 'profile_url_check') || (profile.score ?? 0) < 0.95) {
      return 'Same LinkedIn profile, but names or connection dates differ';
    }

    return `Same LinkedIn profile: ${profile.value}`;
  }

  if (evidence.some((item) => item.kind === 'phone_country_conflict')) {
    return 'Same digits, different countries — likely two people';
  }

  const email = evidence.find((item) => item.kind === 'email');

  // The server holds a shared email back from its automatic merge when the
  // names say two people (`email_check`, written by
  // `memory/utils/emailIdentity.ts`): one side is you and the other side's
  // name is someone else's (`self_endpoint`), or two names share nothing
  // (`name_conflict`) — a card that lists one person's address under
  // another person's name.
  const emailCheck = evidence.find((item) => item.kind === 'email_check');
  if (emailCheck != null) {
    if (emailCheck.value === 'self_endpoint') {
      return email != null
        ? `Same email ${email.value}, but one side is you and the names differ`
        : 'Shares an email with you, but the names differ';
    }

    return email != null
      ? `Same email ${email.value}, but the names differ`
      : 'Same email, but the names differ';
  }

  if (email != null) {
    return `Same email: ${email.value}`;
  }

  const phone = evidence.find((item) => item.kind === 'phone');
  if (phone != null) {
    // Always name the number: a "same phone" line that does not say which one
    // leaves the reviewer comparing two lists of different numbers.
    const numbers = phoneNumbersIn(phone.value)
      .map((number) => number.display)
      .join(', ');
    const check = evidence.find((item) => item.kind === 'phone_check');
    if (check != null) {
      return `Same phone number ${numbers}, but ${phoneCheckReason(check.value)}`;
    }

    if ((phone.score ?? 0) >= 0.95) {
      return `Same phone: ${numbers}`;
    }

    return `Same phone digits: ${numbers} — country not confirmed`;
  }

  const overlap = evidence.find((item) => item.kind === 'name_overlap');
  if (overlap != null) {
    return `Names share “${overlap.value}”`;
  }

  const cluster = evidence.find((item) => item.kind === 'name_cluster');
  if (cluster != null) {
    return `This first name matches more than one person`;
  }

  const handle = evidence.find((item) => item.kind === 'handle');
  if (handle != null) {
    return `Same handle: ${handle.value}`;
  }

  const name = evidence.find((item) => item.kind === 'name');
  if (name != null) {
    return `Same display name: ${name.value}`;
  }

  return 'Proposed as the same person';
}

function describeDifferences(
  people: readonly MergablePerson[],
  sharedPhones: readonly SharedPhone[],
): string[] {
  if (people.length < 2) {
    return [];
  }

  const sharedPhoneKeys = new Set(sharedPhones.map((phone) => phone.key));
  const isSharedPhone = (item: PersonIdentifier) =>
    item.kind === 'phone' && sharedPhoneKeys.has(phoneKey(item.value));

  const [left, right] = people;
  const lines: string[] = [];
  const leftTokens = tokenizeDisplayName(left.name);
  const rightTokens = tokenizeDisplayName(right.name);

  if (
    left.name &&
    right.name &&
    (left.name.trim().toLowerCase() !== right.name.trim().toLowerCase() ||
      (leftTokens != null &&
        rightTokens != null &&
        [...leftTokens.set].join() !== [...rightTokens.set].join()))
  ) {
    lines.push(`Names differ: “${left.name}” vs “${right.name}”`);
  }

  const leftKeys = new Set((left.identifiers ?? []).map(identifierKey));
  const rightKeys = new Set((right.identifiers ?? []).map(identifierKey));
  const onlyLeft = (left.identifiers ?? []).filter(
    (item) => !rightKeys.has(identifierKey(item)) && !isSharedPhone(item),
  );
  const onlyRight = (right.identifiers ?? []).filter(
    (item) => !leftKeys.has(identifierKey(item)) && !isSharedPhone(item),
  );

  if (onlyLeft.length > 0 || onlyRight.length > 0) {
    const leftBit =
      onlyLeft.length > 0 ? `${left.name || 'Left'} has ${onlyLeft.map(formatIdentifier).join(', ')}` : null;
    const rightBit =
      onlyRight.length > 0
        ? `${right.name || 'Right'} has ${onlyRight.map(formatIdentifier).join(', ')}`
        : null;
    lines.push([leftBit, rightBit].filter(Boolean).join('; '));
  }

  const leftChannels = channelLabels(left);
  const rightChannels = channelLabels(right);
  if (leftChannels.join() !== rightChannels.join() && (leftChannels.length > 0 || rightChannels.length > 0)) {
    lines.push(
      `Sources: ${leftChannels.join(', ') || 'unknown'} vs ${rightChannels.join(', ') || 'unknown'}`,
    );
  }

  return lines;
}

function identifierKey(identifier: PersonIdentifier): string {
  return `${identifier.kind}:${identifier.value}`;
}

/** One number a pair's phone evidence names: its join key and how a reviewer reads it. */
export interface SharedPhone {
  /** The last ten digits — the server's join key for a phone, and what `identifiers[].value` holds. */
  key: string;
  display: string;
}

const NO_SHARED_PHONES: readonly SharedPhone[] = [];

function phoneKey(value: string): string {
  const digits = value.replace(/\D/g, '');

  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * A phone number as a reviewer reads it. North American E.164 — the only
 * country the server ever infers — gets its usual grouping; ten bare digits
 * (a number whose country was NOT confirmed) are grouped without inventing
 * one; anything else is shown as stored.
 */
export function formatPhoneNumber(value: string): string {
  const trimmed = value.trim();
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(trimmed);

  if (nanp != null) {
    return `+1 (${nanp[1]}) ${nanp[2]}-${nanp[3]}`;
  }

  const ten = /^(\d{3})(\d{3})(\d{4})$/.exec(trimmed);

  return ten != null ? `${ten[1]}-${ten[2]}-${ten[3]}` : trimmed;
}

/** The numbers in one evidence value — every writer joins several with `, `. */
function phoneNumbersIn(value: string): SharedPhone[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => phoneKey(part).length > 0)
    .map((part) => ({ key: phoneKey(part), display: formatPhoneNumber(part) }));
}

/**
 * The numbers a pair's `phone` evidence says both records carry, once each.
 * Markers (`phone_check`, `phone_country_conflict`) name no shared number.
 */
export function sharedPhoneNumbers(evidence: MergeCandidate['evidence']): SharedPhone[] {
  const byKey = new Map<string, SharedPhone>();

  for (const item of evidence) {
    if (item.kind !== 'phone') {
      continue;
    }

    for (const number of phoneNumbersIn(item.value)) {
      if (!byKey.has(number.key)) {
        byKey.set(number.key, number);
      }
    }
  }

  return [...byKey.values()];
}

function formatIdentifier(identifier: PersonIdentifier): string {
  const value = identifier.rawValue?.trim() || identifier.value;
  if (identifier.kind === 'email') {
    return value;
  }

  if (identifier.kind === 'phone') {
    return value;
  }

  return `${identifier.kind} ${value}`;
}

function channelLabels(person: MergablePerson): string[] {
  const labels = new Set<string>();

  for (const identifier of person.identifiers ?? []) {
    const source = (identifier.source ?? '').toLowerCase();
    if (source.includes('discord')) {
      labels.add('Discord');
    } else if (source.includes('sms') || source.includes('imessage') || source.includes('signal')) {
      labels.add('SMS');
    } else if (source.includes('contact') || source.includes('vcard') || source.includes('apple')) {
      labels.add('Contacts');
    } else if (identifier.kind === 'email' || source.includes('google') || source.includes('microsoft')) {
      labels.add('Email');
    } else if (identifier.kind === 'phone') {
      labels.add('Phone');
    } else if (identifier.kind === 'handle') {
      labels.add('Chat');
    }
  }

  return [...labels];
}
