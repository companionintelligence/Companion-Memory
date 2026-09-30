import type { PersonContactDraft, PersonContactKind, PersonDraft } from './personDraft';

/**
 * A contact value the server would not store for this person. `extension` is a
 * real number that cannot identify anybody — its last ten digits would run the
 * office line and the extension together into someone else's number — so it is
 * worth keeping somewhere else. `unusable` is not a number at all.
 */
export interface RefusedContact {
  kind: PersonContactKind;
  value: string;
  /**
   * The label it was sent with (`null`: none). A number the record already
   * holds is refused only when the user relabelled it, so putting the label
   * back retires the refusal. Absent from an API that predates it — then any
   * label matches.
   */
  label?: string | null;
  reason: 'extension' | 'unusable';
}

function isRefusedContact(entry: unknown): entry is RefusedContact {
  if (entry == null || typeof entry !== 'object') {
    return false;
  }

  const { kind, value, label, reason } = entry as Record<string, unknown>;

  return (
    (kind === 'email' || kind === 'phone') &&
    typeof value === 'string' &&
    (label === undefined || label === null || typeof label === 'string') &&
    (reason === 'extension' || reason === 'unusable')
  );
}

/**
 * The contacts a failed save was refused over, from the GraphQL error's
 * `extensions.details.refusedContacts` (see `refusedContactsException` in the
 * API's PersonResolver). Empty for any other failure, so a caller can always
 * hand the result to `PersonForm`.
 */
export function refusedContactsFrom(error: unknown): RefusedContact[] {
  const graphQLErrors = (error as { graphQLErrors?: unknown } | null)?.graphQLErrors;
  if (!Array.isArray(graphQLErrors)) {
    return [];
  }

  return graphQLErrors.flatMap((graphQLError: unknown) => {
    const details = (graphQLError as { extensions?: { details?: { refusedContacts?: unknown } } } | null)
      ?.extensions?.details;
    const refused = details?.refusedContacts;

    return Array.isArray(refused)
      ? refused.filter(isRefusedContact).map(({ kind, value, label, reason }) => ({
          kind,
          value,
          ...(label !== undefined ? { label } : {}),
          reason,
        }))
      : [];
  });
}

/**
 * The refusal that applies to this row, if any. The server names each value
 * exactly as it was sent — the row's value and label, trimmed — so editing the
 * row retires its refusal until the next save says otherwise.
 */
export function refusalFor(
  contact: PersonContactDraft,
  refused: readonly RefusedContact[],
): RefusedContact | undefined {
  const value = contact.value.trim();
  const label = contact.label.trim() || null;

  return refused.find(
    (entry) =>
      entry.kind === contact.kind &&
      entry.value === value &&
      (entry.label === undefined || entry.label === label),
  );
}

/** The refusals the draft has not dealt with yet: rows still holding a refused value. */
export function pendingRefusals(draft: PersonDraft, refused: readonly RefusedContact[]): RefusedContact[] {
  return refused.filter((entry) => draft.contacts.some((contact) => refusalFor(contact, [entry]) != null));
}

/** `Work phone: 212-555-0148 x31`, or `Phone: …` with no label. */
function noteLine(contact: PersonContactDraft): string {
  const label = contact.label.trim();
  const lead = label !== '' ? `${label} ${contact.kind}` : contact.kind;

  return `${lead.charAt(0).toUpperCase()}${lead.slice(1)}: ${contact.value.trim()}`;
}

/**
 * Move one contact row into the notes: drop the row, and add a line naming it
 * to the description. What the server tells the user to do with a number it
 * cannot store — the number is still how to reach them, it just cannot sit
 * among the contact methods.
 */
export function keepContactInNote(draft: PersonDraft, key: string): PersonDraft {
  const contact = draft.contacts.find((row) => row.key === key);
  if (contact == null) {
    return draft;
  }

  const line = noteLine(contact);
  const description = draft.description.trimEnd();
  const noted = description.split('\n').some((existing) => existing.trim() === line);

  return {
    ...draft,
    contacts: draft.contacts.filter((row) => row.key !== key),
    description: noted ? draft.description : description === '' ? line : `${description}\n${line}`,
  };
}
