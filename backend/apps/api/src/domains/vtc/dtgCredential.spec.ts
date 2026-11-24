import { DTG_CONTEXT_V1, W3C_CREDENTIALS_V2 } from './contexts';
import { DTG_SUBTYPES, DtgParseError, parseDtgCredential, type DtgParseCode } from './dtgCredential';

/**
 * The membership credential shape from the OpenVTC Verifiable Trust Infrastructure documentation
 * (docs/03-vtc/credentials.md, "VMC details"), with its placeholders filled in.
 */
const MEMBER = 'did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2';
const LIST_URL = 'https://community.example.com/v1/status-lists/revocation';

const vmc = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  '@context': [W3C_CREDENTIALS_V2, DTG_CONTEXT_V1],
  id: 'urn:uuid:7c2a4f9e-3b1d-4a56-9d0e-1f2a3b4c5d6e',
  type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential', 'PersonhoodCredential'],
  issuer: 'did:webvh:community.example.com:abc',
  issuerScope: 'public',
  validFrom: '2026-05-14T10:00:00Z',
  validUntil: '2026-06-13T10:00:00Z',
  credentialSubject: { id: MEMBER },
  credentialStatus: {
    id: `${LIST_URL}#42`,
    type: 'BitstringStatusListEntry',
    statusPurpose: 'revocation',
    statusListIndex: '42',
    statusListCredential: LIST_URL,
  },
  proof: { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022' },
  ...changes,
});

function codeOf(document: unknown): DtgParseCode | 'accepted' {
  try {
    parseDtgCredential(document);
  } catch (error) {
    if (error instanceof DtgParseError) {
      return error.code;
    }

    throw error;
  }

  return 'accepted';
}

describe('parseDtgCredential', () => {
  it('reads an OpenVTC membership credential', () => {
    const document = vmc();
    const credential = parseDtgCredential(document);

    expect(credential).toMatchObject({
      raw: document,
      id: 'urn:uuid:7c2a4f9e-3b1d-4a56-9d0e-1f2a3b4c5d6e',
      subtype: 'MembershipCredential',
      personhoodHint: true,
      issuer: 'did:webvh:community.example.com:abc',
      issuerScope: 'public',
      subject: MEMBER,
    });
    expect(credential.validFrom.toISOString()).toBe('2026-05-14T10:00:00.000Z');
    expect(credential.validUntil?.toISOString()).toBe('2026-06-13T10:00:00.000Z');
    expect(credential.status).toEqual([
      {
        id: `${LIST_URL}#42`,
        statusPurpose: 'revocation',
        statusListIndex: 42,
        statusListCredential: LIST_URL,
        statusSize: 1,
      },
    ]);
  });

  it('keeps the document it was handed, so the proof is checked against the original bytes', () => {
    const document = vmc();

    expect(parseDtgCredential(document).raw).toBe(document);
  });

  // The seven names are written out, not read from DTG_SUBTYPES: the constant is what is under test.
  const README_SUBTYPES = [
    'MembershipCredential',
    'RelationshipCredential',
    'DelegationCredential',
    'InvitationCredential',
    'PersonaCredential',
    'StatementCredential',
    'AuthorityCredential',
  ];

  it('knows exactly the seven subtypes the reference implementation lists', () => {
    expect([...DTG_SUBTYPES].sort()).toEqual([...README_SUBTYPES].sort());
  });

  it.each(README_SUBTYPES)('accepts the %s subtype', (subtype) => {
    expect(
      parseDtgCredential(vmc({ type: ['VerifiableCredential', 'DTGCredential', subtype] })).subtype,
    ).toBe(subtype);
  });

  describe('credentialSubject.digestMultibase, which marks a member’s acknowledgement', () => {
    it('is null on a grant and read when present', () => {
      expect(parseDtgCredential(vmc()).subjectDigest).toBeNull();
      expect(
        parseDtgCredential(vmc({ credentialSubject: { id: MEMBER, digestMultibase: 'uEiAbcdef' } }))
          .subjectDigest,
      ).toBe('uEiAbcdef');
    });

    it.each([
      ['a number', 7],
      ['an empty string', ''],
      ['a string with whitespace', 'uEi Abc'],
      ['an object', {}],
      ['null', null],
      ['a string of 257 characters', 'u'.repeat(257)],
    ])('refuses %s', (_name, digestMultibase) => {
      expect(() => parseDtgCredential(vmc({ credentialSubject: { id: MEMBER, digestMultibase } }))).toThrow(
        'SUBJECT',
      );
    });
  });

  it('allows a credential with no id, no expiry and no status', () => {
    const { id: _id, validUntil: _until, credentialStatus: _status, ...rest } = vmc();
    const credential = parseDtgCredential(rest);

    expect(credential).toMatchObject({ id: null, validUntil: null, status: [] });
  });

  it('reads a list of status entries, one per purpose', () => {
    const entries = ['revocation', 'suspension'].map((purpose, index) => ({
      type: 'BitstringStatusListEntry',
      statusPurpose: purpose,
      statusListIndex: String(index + 10),
      statusListCredential: `https://community.example.com/v1/status-lists/${purpose}`,
    }));

    expect(
      parseDtgCredential(vmc({ credentialStatus: entries })).status.map((entry) => entry.statusPurpose),
    ).toEqual(['revocation', 'suspension']);
  });

  it('reads no personhood hint from a plain membership credential', () => {
    const withoutHint = vmc({ type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential'] });

    expect(parseDtgCredential(withoutHint).personhoodHint).toBe(false);
  });

  // Two rows (an extra context after the two, the VC 1.1 context first) are read by the reference
  // implementation. Refusing them is a deliberate choice, explained in the header of dtgCredential.ts.
  describe('refuses a bad @context', () => {
    it.each([
      ['the contexts in the wrong order', [DTG_CONTEXT_V1, W3C_CREDENTIALS_V2]],
      ['no DTG context', [W3C_CREDENTIALS_V2]],
      ['no W3C context', [DTG_CONTEXT_V1]],
      ['an extra context after the two', [W3C_CREDENTIALS_V2, DTG_CONTEXT_V1, 'https://example.com/context']],
      ['an extra context between them', [W3C_CREDENTIALS_V2, 'https://example.com/context', DTG_CONTEXT_V1]],
      [
        'the retired firstperson.network context',
        [W3C_CREDENTIALS_V2, 'https://firstperson.network/credentials/dtg/v1'],
      ],
      ['the VC 1.1 context', ['https://www.w3.org/2018/credentials/v1', DTG_CONTEXT_V1]],
      ['a DTG context with a trailing slash', [W3C_CREDENTIALS_V2, `${DTG_CONTEXT_V1}/`]],
      ['a DTG context in another case', [W3C_CREDENTIALS_V2, DTG_CONTEXT_V1.toUpperCase()]],
      ['a context that is a string', W3C_CREDENTIALS_V2],
      ['an inline context object', [W3C_CREDENTIALS_V2, { '@vocab': 'https://example.com/' }]],
      ['no context', undefined],
    ])('%s', (_name, context) => {
      expect(codeOf(vmc({ '@context': context }))).toBe('CONTEXT');
    });
  });

  describe('refuses a bad type', () => {
    it.each([
      ['no DTGCredential', ['VerifiableCredential', 'MembershipCredential']],
      ['no VerifiableCredential', ['DTGCredential', 'MembershipCredential']],
      ['no subtype', ['VerifiableCredential', 'DTGCredential']],
      [
        'two subtypes',
        ['VerifiableCredential', 'DTGCredential', 'MembershipCredential', 'RelationshipCredential'],
      ],
      [
        'an unknown type',
        ['VerifiableCredential', 'DTGCredential', 'MembershipCredential', 'AlumniCredential'],
      ],
      ['an unknown type and no subtype', ['VerifiableCredential', 'DTGCredential', 'AlumniCredential']],
      [
        'a repeated type',
        ['VerifiableCredential', 'DTGCredential', 'MembershipCredential', 'MembershipCredential'],
      ],
      [
        'the personhood type on a relationship credential',
        ['VerifiableCredential', 'DTGCredential', 'RelationshipCredential', 'PersonhoodCredential'],
      ],
      ['the personhood type alone', ['VerifiableCredential', 'DTGCredential', 'PersonhoodCredential']],
      ['a type that is a string', 'MembershipCredential'],
      ['a type array holding a number', ['VerifiableCredential', 'DTGCredential', 'MembershipCredential', 7]],
      ['no type', undefined],
    ])('%s', (_name, type) => {
      expect(codeOf(vmc({ type }))).toBe('TYPE');
    });

    it.each(['EndorsementCredential', 'WitnessCredential', 'RCardCredential'])(
      'the retired %s, by name',
      (retired) => {
        expect(
          codeOf(vmc({ type: ['VerifiableCredential', 'DTGCredential', 'StatementCredential', retired] })),
        ).toBe('RETIRED_TYPE');
        expect(codeOf(vmc({ type: ['VerifiableCredential', 'DTGCredential', retired] }))).toBe(
          'RETIRED_TYPE',
        );
      },
    );
  });

  describe('refuses a bad issuer', () => {
    it.each([
      ['a URL', 'https://community.example.com'],
      ['a DID URL with a fragment', 'did:webvh:community.example.com:abc#key-0'],
      ['a DID with whitespace', 'did:webvh:community.example.com: abc'],
      ['an object', { id: 'did:webvh:community.example.com:abc' }],
      ['an empty string', ''],
      ['a number', 7],
      ['nothing', undefined],
    ])('%s', (_name, issuer) => {
      expect(codeOf(vmc({ issuer }))).toBe('ISSUER');
    });
  });

  describe('refuses a bad issuerScope', () => {
    it.each([
      ['missing', undefined],
      ['unknown', 'private'],
      ['in another case', 'Public'],
      ['not a string', ['public']],
    ])('one that is %s', (_name, issuerScope) => {
      expect(codeOf(vmc({ issuerScope }))).toBe('ISSUER_SCOPE');
    });

    it.each(['pairwise', 'directed', 'public'])('and accepts %s', (issuerScope) => {
      expect(parseDtgCredential(vmc({ issuerScope })).issuerScope).toBe(issuerScope);
    });
  });

  describe('refuses a bad validity period', () => {
    it.each([
      ['no validFrom', { validFrom: undefined }],
      ['a validFrom that is not a date-time', { validFrom: '2026-02-30T00:00:00Z' }],
      ['a validFrom with no time zone', { validFrom: '2026-05-14T10:00:00' }],
      ['a validUntil that is not a date-time', { validUntil: 'next month' }],
      ['a validUntil equal to validFrom', { validUntil: '2026-05-14T10:00:00Z' }],
      ['a validUntil before validFrom', { validUntil: '2026-05-13T10:00:00Z' }],
    ])('%s', (_name, changes) => {
      expect(codeOf(vmc(changes))).toBe('VALIDITY');
    });
  });

  describe('refuses a bad subject', () => {
    it.each([
      ['no subject', undefined],
      ['an array of subjects', [{ id: MEMBER }]],
      ['a subject with no id', {}],
      ['a subject whose id is not a DID', { id: 'https://example.com/member' }],
      ['a string subject', MEMBER],
    ])('%s', (_name, credentialSubject) => {
      expect(codeOf(vmc({ credentialSubject }))).toBe('SUBJECT');
    });
  });

  describe('refuses bad status', () => {
    it.each([
      ['an empty entry list', []],
      ['more than four entries', Array.from({ length: 5 }, () => vmc().credentialStatus)],
      ['an entry that is not an object', ['revoked']],
      ['an entry of another type', { type: 'StatusList2021Entry' }],
      ['a null status', null],
    ])('%s', (_name, credentialStatus) => {
      expect(codeOf(vmc({ credentialStatus }))).toBe('STATUS');
    });
  });

  it.each([
    ['whitespace in the id', { id: 'urn:uuid: 1' }],
    ['an empty id', { id: '' }],
    ['a numeric id', { id: 7 }],
  ])('refuses %s', (_name, changes) => {
    expect(codeOf(vmc(changes))).toBe('ID');
  });

  it.each([undefined, null, 'credential', 7, [], [vmc()]])('refuses the non-object %p', (document) => {
    expect(codeOf(document)).toBe('NOT_AN_OBJECT');
  });
});
