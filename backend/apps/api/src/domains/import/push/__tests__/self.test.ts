import {
  decideSelfCollation,
  isExactOwnerIdentifier,
  isOwnerContact,
  readSentLabelSenders,
  makeIsSelf,
  matchOwner,
  matchOwnerIdentifier,
  matchParticipantOwner,
  NOBODY_IS_SELF,
  OWNER_MATCH_CONFIDENCE,
  readSelfIdentity,
  shouldMapContactToSelf,
  type SelfIdentity,
  type SelfIdentityReader,
} from '../self';

/**
 * The predicate that decides whether a chat message is one the owner SENT.
 *
 * WhatsApp and Messenger exports carry no is-from-me column, so this is the
 * only thing standing between "the owner's 437 sent messages" and "4,205
 * messages, all inbound". Two properties matter more than any individual match
 * rule: it must be built once (a run is hundreds of thousands of records), and
 * it must fail to `false` — never to `true`, and never by throwing — because a
 * wrong `true` writes a false authorship claim into somebody's memory.
 */

function identity(over: Partial<SelfIdentity> = {}): SelfIdentity {
  return { names: ['Liam Broza'], email: 'liam.broza@example.com', phones: [], ...over };
}

describe('makeIsSelf', () => {
  it('matches the owner exactly, and past case, diacritics and punctuation', () => {
    const isSelf = makeIsSelf(identity());

    expect(isSelf('Liam Broza')).toBe(true);
    expect(isSelf('liam  broza')).toBe(true);
    expect(isSelf('Líam Broza')).toBe(true);
    expect(isSelf('Broza, Liam')).toBe(true);
  });

  it('matches a shortened or padded form of the same name', () => {
    const isSelf = makeIsSelf(identity());

    // Token containment either way: WhatsApp shows whatever the owner set as
    // their profile name, which is routinely just the first name.
    expect(isSelf('Liam')).toBe(true);
    expect(isSelf('Liam A Broza')).toBe(true);
    // One edit — under the similarity floor rather than an exact match.
    expect(isSelf('Liam Brozer')).toBe(true);
  });

  it('falls back to the email local part when the account has no name', () => {
    const isSelf = makeIsSelf(identity({ names: [] }));

    expect(isSelf('Liam Broza')).toBe(true);
  });

  it('matches the email local part exactly, never by a shared token', () => {
    // A local part is often a household or role word. Containment against
    // "bennett family" would claim every "Family" and every "Bennett Smith".
    const isSelf = makeIsSelf({ names: [], email: 'bennett.family@example.com', phones: [] });

    expect(isSelf('Bennett Family')).toBe(true);
    expect(isSelf('Family')).toBe(false);
    expect(isSelf('Bennett Smith')).toBe(false);
    expect(isSelf('Bennett Familly')).toBe(false);
  });

  it('reads the self Person row as well as the account name', () => {
    // The name onboarding let the owner choose, which is often not the name
    // their identity provider handed over.
    const isSelf = makeIsSelf({ names: ['lbroza', 'Liam Broza'], email: null, phones: [] });

    expect(isSelf('Liam Broza')).toBe(true);
  });

  it('does not claim other people', () => {
    const isSelf = makeIsSelf(identity());

    expect(isSelf('Alice Example')).toBe(false);
    expect(isSelf('Bob Sample')).toBe(false);
    expect(isSelf('Dana Broza')).toBe(false);
    expect(isSelf('')).toBe(false);
    // A lone initial is not a name: without the substantial-token anchor in
    // containsAll it would be a subset of every name containing it.
    expect(isSelf('L')).toBe(false);
  });

  it('is NOBODY_IS_SELF when there is nothing to match against', () => {
    // The fail-safe. No name and no email is not an error and not a guess: the
    // caller keeps the inbound default it had before this predicate existed.
    expect(makeIsSelf({ names: [], email: null, phones: [] })).toBe(NOBODY_IS_SELF);
    expect(makeIsSelf({ names: ['   '], email: null, phones: [] })).toBe(NOBODY_IS_SELF);
    expect(NOBODY_IS_SELF('Liam Broza')).toBe(false);
  });
});

describe('readSelfIdentity', () => {
  /** A SelfIdentityReader over fixed rows, recording what it was asked. */
  function readerFor(rows: Array<{ name: string | null; email: string | null; phones_json?: unknown }>) {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const db: SelfIdentityReader = {
      query: (async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });

        return rows;
      }) as SelfIdentityReader['query'],
    };

    return { db, calls };
  }

  it('collects every name row and the first non-empty email', async () => {
    const { db, calls } = readerFor([
      { name: null, email: 'liam.broza@example.com', phones_json: null },
      { name: 'Liam Broza', email: null, phones_json: ['+15551212'] },
    ]);

    await expect(readSelfIdentity(db, 'user-1')).resolves.toEqual({
      names: ['Liam Broza'],
      email: 'liam.broza@example.com',
      emails: [],
      phones: ['+15551212'],
    });
    expect(calls[0].params).toEqual(['user-1']);
  });

  it("collects the self Person's own addresses, from its properties and its identifier rows", async () => {
    const { db, calls } = readerFor([
      { name: null, email: 'liam.broza@example.com', phones_json: null },
      {
        name: 'Liam Broza',
        email: null,
        phones_json: [],
        emails_json: ['liam.broza@example.com', 'liam@work.example'],
      },
      { name: null, email: null, phones_json: [], emails_json: ['lb@alias.example'] },
      { name: null, email: null, phones_json: ['4155550100'], emails_json: [] },
    ] as never);

    await expect(readSelfIdentity(db, 'user-1')).resolves.toEqual({
      names: ['Liam Broza'],
      email: 'liam.broza@example.com',
      emails: ['liam.broza@example.com', 'liam@work.example', 'lb@alias.example'],
      phones: ['4155550100'],
    });
    expect(calls[0].sql).toContain('FROM ci.entity_identifiers i');
    expect(calls[0].sql).toContain("i.kind IN ('email', 'phone')");
  });

  it('asks for the account row and the un-merged is_self Person, in one round-trip', async () => {
    const { db, calls } = readerFor([]);

    await readSelfIdentity(db, 'user-1');

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('FROM ci.users u');
    expect(calls[0].sql).toContain("e.entity_type = 'Person'");
    // Both spellings of the flag: the typed column and the pre-migration key.
    expect(calls[0].sql).toContain('e.is_self IS TRUE');
    expect(calls[0].sql).toContain("e.properties ->> 'is_self' = 'true'");
    // A merge tombstone keeps its name; it must not answer for the owner.
    expect(calls[0].sql).toContain('e.merged_into_entity_id IS NULL');
  });

  it('yields an empty identity for a user with no rows at all', async () => {
    const { db } = readerFor([]);

    await expect(readSelfIdentity(db, 'user-1')).resolves.toEqual({
      names: [],
      email: null,
      emails: [],
      phones: [],
    });
  });
});

describe('matchOwner / shouldMapContactToSelf', () => {
  it('matches exact email and phone with high confidence', () => {
    const id = identity({ phones: ['+1 415-555-0100'] });

    expect(matchOwner(id, 'liam.broza@example.com')).toEqual({
      kind: 'email',
      confidence: OWNER_MATCH_CONFIDENCE.email,
      raw: 'liam.broza@example.com',
    });
    expect(matchOwner(id, '(415) 555-0100')).toMatchObject({ kind: 'phone' });
    expect(isExactOwnerIdentifier(matchOwner(id, 'liam.broza@example.com')!)).toBe(true);
  });

  it('maps exact identifiers in every trust mode; name only outside cautious', () => {
    const id = identity();
    const email = matchOwner(id, 'liam.broza@example.com');
    const name = matchOwner(id, 'Liam Broza');

    expect(shouldMapContactToSelf(email, 'cautious')).toBe(true);
    expect(shouldMapContactToSelf(email, 'balanced')).toBe(true);
    expect(shouldMapContactToSelf(name, 'cautious')).toBe(false);
    expect(shouldMapContactToSelf(name, 'balanced')).toBe(true);
    expect(shouldMapContactToSelf(name, 'hands_off')).toBe(true);
  });
});

describe('a second address on the self Person', () => {
  const id = identity({ emails: ['Liam@Work.example'] });

  it('is the owner, as an identifier, a participant and a contact', () => {
    expect(matchOwnerIdentifier(id, 'email', 'liam@work.example')).toMatchObject({ kind: 'email' });
    expect(matchOwner(id, '"LB" <liam@work.example>')).toMatchObject({ kind: 'email' });
    expect(isOwnerContact(id, { name: 'LB', emails: ['liam@work.example'], phones: [] }, 'cautious')).toBe(
      true,
    );
  });

  it('is never read as a name: only the account address lends its local part', () => {
    const work = identity({ names: [], email: null, emails: ['info@work.example'] });

    expect(makeIsSelf(work)).toBe(NOBODY_IS_SELF);
    expect(matchOwner(work, 'Info')).toBeNull();
  });

  it('counts only a value with an @ as an address', () => {
    const junk = identity({ names: [], email: null, emails: ['Info'] });

    expect(matchOwner(junk, 'Info')).toBeNull();
    expect(matchOwnerIdentifier(junk, 'email', 'info')).toBeNull();
  });
});

describe('isOwnerContact', () => {
  const id = identity({ phones: ['+1 415-555-0100'] });

  it("is not the owner when the contact has the owner's name but somebody else's address", () => {
    // A mail from "Liam Broza" <stranger@example.net>: the push filed it as sent by the owner.
    for (const trust of ['cautious', 'balanced', 'hands_off'] as const) {
      expect(
        isOwnerContact(id, { name: 'Liam Broza', emails: ['stranger@example.net'], phones: [] }, trust),
      ).toBe(false);
    }

    expect(
      isOwnerContact(id, { name: 'Liam Broza', emails: [], phones: ['+1 212-555-0199'] }, 'balanced'),
    ).toBe(false);
  });

  it("is the owner when one of the contact's handles is the owner's, whatever the name", () => {
    expect(
      isOwnerContact(
        id,
        { name: 'LB', emails: ['other@example.org', 'Liam.Broza@example.com'], phones: [] },
        'cautious',
      ),
    ).toBe(true);
    expect(isOwnerContact(id, { name: null, emails: [], phones: ['(415) 555-0100'] }, 'cautious')).toBe(true);
  });

  it('still matches a contact with no handle by name, outside cautious', () => {
    // A WhatsApp sender name: the case the name match exists for.
    expect(isOwnerContact(id, { name: 'Liam Broza', emails: [], phones: [] }, 'balanced')).toBe(true);
    expect(isOwnerContact(id, { name: 'Liam Broza', emails: [], phones: [] }, 'cautious')).toBe(false);
    expect(isOwnerContact(id, { name: 'Alice Example', emails: [], phones: [] }, 'hands_off')).toBe(false);
  });
});

describe('matchOwner reads each part of a participant only for what it is', () => {
  const id = identity({ phones: ['+1 415-555-0100'] });

  it("does not take the owner's phone digits out of a display name or a mailbox", () => {
    expect(matchOwner(id, 'Support 415 555 0100')).toBeNull();
    expect(matchOwner(id, '"Call 415-555-0100" <promo@other.example>')).toBeNull();
  });

  it('tests the display name without the address after it', () => {
    // A name match, not an email one: the address is somebody else's.
    expect(matchOwner(id, '"Liam Broza" <someone@other.example>')).toMatchObject({ kind: 'name' });
    // And the address cannot lend its own tokens to a name that does not match.
    expect(matchOwner(id, '"Support" <liam.broza@other.example>')).toBeNull();
  });

  it('does not read a bare address as a name', () => {
    // "liam.broza@other.example" folded to "liam broza other example", which
    // contained the owner's name.
    expect(matchOwner(id, 'liam.broza@other.example')).toBeNull();
  });

  it("still matches the owner's own address behind any display name", () => {
    expect(matchOwner(id, '"Work" <Liam.Broza@Example.com>')).toMatchObject({ kind: 'email' });
  });
});

describe('matchOwnerIdentifier', () => {
  const id = identity({ phones: ['+1 415-555-0100'] });

  it("matches the owner's own address and number, normalized", () => {
    expect(matchOwnerIdentifier(id, 'email', 'liam.broza@example.com')).toMatchObject({ kind: 'email' });
    expect(matchOwnerIdentifier(id, 'phone', '4155550100')).toMatchObject({ kind: 'phone' });
  });

  it('matches nothing else, whatever name came with it', () => {
    expect(matchOwnerIdentifier(id, 'email', 'liam.broza@other.example')).toBeNull();
    expect(matchOwnerIdentifier(id, 'phone', '4155550199')).toBeNull();
    expect(matchOwnerIdentifier(id, 'email', '')).toBeNull();
    expect(matchOwnerIdentifier({ names: [], email: null, phones: [] }, 'email', 'a@b.example')).toBeNull();
  });
});

describe('matchParticipantOwner', () => {
  const id = identity({ phones: ['+1 415-555-0100'] });

  it('matches an email or phone participant on its identifier, never on the name in front of it', () => {
    const stranger = { kind: 'email' as const, valueNormalized: 'someone@other.example' };
    const owner = { kind: 'email' as const, valueNormalized: 'liam.broza@example.com' };
    const ownerPhone = { kind: 'phone' as const, valueNormalized: '4155550100' };

    expect(matchParticipantOwner(id, stranger, '"Liam Broza" <someone@other.example>')).toBeNull();
    expect(matchParticipantOwner(id, owner, '"Anyone" <liam.broza@example.com>')).toMatchObject({
      kind: 'email',
    });
    expect(matchParticipantOwner(id, ownerPhone, 'Liam Broza')).toMatchObject({ kind: 'phone' });
  });

  it('matches a name-only participant by name, falling back to its normalized value', () => {
    const name = { kind: 'name' as const, valueNormalized: 'liam broza' };

    expect(matchParticipantOwner(id, name, 'Liam Broza')).toMatchObject({ kind: 'name' });
    expect(matchParticipantOwner(id, name, '')).toMatchObject({ kind: 'name' });
  });
});

describe('decideSelfCollation', () => {
  it('merges on its own only on an exact identifier, in every trust mode', () => {
    const email = { kind: 'email' as const, confidence: OWNER_MATCH_CONFIDENCE.email };
    const phone = { kind: 'phone' as const, confidence: OWNER_MATCH_CONFIDENCE.phone };
    const name = { kind: 'name' as const, confidence: OWNER_MATCH_CONFIDENCE.nameExact };

    expect(decideSelfCollation('hands_off', email)).toBe('auto');
    expect(decideSelfCollation('hands_off', phone)).toBe('auto');
    expect(decideSelfCollation('hands_off', name)).toBe('review');
    expect(decideSelfCollation('balanced', email)).toBe('review');
    expect(decideSelfCollation('cautious', email)).toBe('review');
  });
});

describe('readSentLabelSenders', () => {
  it("reads the From addresses of the run's Sent mail as the owner's", async () => {
    const query = jest.fn(async () => [
      { sender: '"Liam Broza" <Liam@Alias.example>' },
      { sender: 'liam@alias.example' },
      { sender: 'old.account@example.org' },
      { sender: 'Liam Broza' },
      { sender: null },
    ]);

    await expect(readSentLabelSenders({ query } as never, 'run-1')).resolves.toEqual([
      'liam@alias.example',
      'old.account@example.org',
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("'sent_label'"), ['run-1']);
  });

  it('maps a contact holding one of those addresses to the owner', () => {
    const identity = {
      names: ['Liam Broza'],
      email: 'liam@example.com',
      emails: ['liam@alias.example'],
      phones: [],
    };

    expect(
      isOwnerContact(
        identity,
        { name: 'Liam Broza', emails: ['liam@alias.example'], phones: [] },
        'balanced',
      ),
    ).toBe(true);
    expect(
      isOwnerContact(
        identity,
        { name: 'Liam Broza', emails: ['stranger@example.net'], phones: [] },
        'balanced',
      ),
    ).toBe(false);
  });
});
