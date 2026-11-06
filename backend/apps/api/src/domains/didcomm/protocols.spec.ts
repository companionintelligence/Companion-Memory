import {
  answerQueries,
  buildDisclose,
  buildQueries,
  DISCLOSE_TYPE,
  matchesPattern,
  QUERIES_TYPE,
} from './discoverFeatures';
import { DidcommError } from './errors';
import { createMessage, parseMessage } from './message';
import {
  buildInvitation,
  decodeInvitationUrl,
  encodeInvitationUrl,
  OOB_INVITATION_TYPE,
  replyParentThread,
} from './outOfBand';
import { belongsToProtocol, messageName, normalizeName, parseMessageType, parseProtocolId } from './piuri';
import {
  buildProblemReport,
  interpolateComment,
  isProblemCode,
  parseProblemReport,
  PROBLEM_REPORT_TYPE,
} from './problemReport';
import { buildPing, buildPingResponse, PING_RESPONSE_TYPE, PING_TYPE, wantsResponse } from './trustPing';

describe('protocol and message type URIs', () => {
  it('splits the forms the specification lists', () => {
    expect(parseMessageType('https://didcomm.org/trust-ping/2.0/ping')).toEqual({
      docUri: 'https://didcomm.org/',
      protocol: 'trust-ping',
      version: '2.0',
      major: 2,
      minor: 0,
      name: 'ping',
    });
    expect(parseMessageType('https://example.com/protocols?which=lets_do_lunch/1.0/proposal')).toMatchObject({
      docUri: 'https://example.com/protocols?which=',
      protocol: 'lets_do_lunch',
      name: 'proposal',
    });
    expect(parseMessageType('did:example:1234567890;spec/lets_do_lunch/1.0/proposal')).toMatchObject({
      docUri: 'did:example:1234567890;spec/',
      protocol: 'lets_do_lunch',
    });
    expect(parseProtocolId('https://didcomm.org/routing/2.0')).toMatchObject({
      protocol: 'routing',
      major: 2,
      minor: 0,
    });
    expect(parseMessageType('https://didcomm.org/basicmessage/2.3/message')).toMatchObject({
      major: 2,
      minor: 3,
    });
  });

  it.each(['', 'https://didcomm.org/trust-ping/ping', 'https://didcomm.org/trust-ping/x.y/ping', 'nonsense'])(
    'does not parse %p as a message type',
    (type) => {
      expect(parseMessageType(type)).toBeUndefined();
    },
  );

  it('matches by doc URI, protocol name and major version, ignoring case and punctuation', () => {
    const ping = 'https://didcomm.org/trust-ping/2.0';

    expect(belongsToProtocol('https://didcomm.org/trust-ping/2.0/ping', ping)).toBe(true);
    expect(belongsToProtocol('https://didcomm.org/trust-ping/2.1/ping', ping)).toBe(true);
    expect(belongsToProtocol('https://didcomm.org/Trust_Ping/2.0/PING', ping)).toBe(true);
    expect(belongsToProtocol('https://didcomm.org/trust-ping/3.0/ping', ping)).toBe(false);
    expect(belongsToProtocol('https://didcomm.org/trust-ping/1.0/ping', ping)).toBe(false);
    expect(belongsToProtocol('https://evil.example/trust-ping/2.0/ping', ping)).toBe(false);
    expect(belongsToProtocol('https://didcomm.org/routing/2.0/forward', ping)).toBe(false);
    expect(belongsToProtocol('garbage', ping)).toBe(false);
    expect(belongsToProtocol(PING_TYPE, 'garbage')).toBe(false);
    expect(normalizeName('Ping_Response')).toBe('pingresponse');
    expect(messageName('https://didcomm.org/trust-ping/2.0/ping-response')).toBe('pingresponse');
    expect(messageName('garbage')).toBeUndefined();
  });
});

describe('trust ping', () => {
  it('builds the ping the specification shows and asks for a response by default', () => {
    const ping = buildPing({ from: 'did:example:alice', to: ['did:example:bob'] }, 1700000000);

    expect(ping).toMatchObject({
      type: PING_TYPE,
      from: 'did:example:alice',
      to: ['did:example:bob'],
      body: { response_requested: true },
    });
    expect(wantsResponse(ping)).toBe(true);
    expect(wantsResponse(buildPing({ to: ['did:example:bob'], responseRequested: false }))).toBe(false);
    expect(wantsResponse(parseMessage({ ...ping, body: {} }))).toBe(true);
  });

  it("answers in the ping's thread, to its sender", () => {
    const ping = buildPing({ from: 'did:example:alice', to: ['did:example:bob'] });
    const response = buildPingResponse(ping, { from: 'did:example:bob' });

    expect(response).toMatchObject({
      type: PING_RESPONSE_TYPE,
      from: 'did:example:bob',
      to: ['did:example:alice'],
      thid: ping.id,
    });
    expect(buildPingResponse({ ...ping, thid: 'thread-9' }).thid).toBe('thread-9');
  });

  it('refuses to answer an anonymous ping or to read a non-ping as one', () => {
    expect(() => buildPingResponse(buildPing({ to: ['did:example:bob'] }))).toThrow(DidcommError);
    expect(() => wantsResponse(createMessage({ type: 'https://example.com/p/1.0/m' }))).toThrow(DidcommError);
  });
});

describe('discover features', () => {
  it('matches with * as the only wildcard and treats everything else literally', () => {
    expect(matchesPattern('https://didcomm.org/tictactoe/1.*', 'https://didcomm.org/tictactoe/1.0')).toBe(
      true,
    );
    expect(matchesPattern('https://didcomm.org/tictactoe/1.*', 'https://didcomm.org/tictactoe/2.0')).toBe(
      false,
    );
    expect(matchesPattern('*', 'anything at all')).toBe(true);
    expect(matchesPattern('org.didcomm.*', 'org.didcomm.sell.goods.consumer')).toBe(true);
    expect(matchesPattern('a.c', 'abc')).toBe(false);
    expect(matchesPattern('a+b', 'a+b')).toBe(true);
    expect(matchesPattern('(x)', '(x)')).toBe(true);
    expect(matchesPattern('exact', 'exactly')).toBe(false);
  });

  it("answers only with features the asker's queries match, of the matching feature type", () => {
    const supported = [
      { 'feature-type': 'protocol', id: 'https://didcomm.org/trust-ping/2.0', roles: ['sender', 'receiver'] },
      { 'feature-type': 'protocol', id: 'https://example.com/protocols/lunch/1.0' },
      { 'feature-type': 'goal-code', id: 'org.didcomm.sell.goods.consumer' },
    ];
    const query = buildQueries(
      [
        { 'feature-type': 'protocol', match: 'https://didcomm.org/*' },
        { 'feature-type': 'goal-code', match: 'com.other.*' },
        { 'feature-type': 'header', match: '*' },
      ],
      { from: 'did:example:alice', to: ['did:example:bob'] },
    );

    expect(query.type).toBe(QUERIES_TYPE);
    expect(answerQueries(query, supported)).toEqual([supported[0]]);

    const disclose = buildDisclose(query, answerQueries(query, supported), { from: 'did:example:bob' });

    expect(disclose).toMatchObject({
      type: DISCLOSE_TYPE,
      to: ['did:example:alice'],
      thid: query.id,
      body: { disclosures: [supported[0]] },
    });
  });

  it('refuses malformed or excessive queries and queries it cannot answer', () => {
    const base = { from: 'did:example:alice', to: ['did:example:bob'] };
    const make = (queries: unknown) => parseMessage({ ...buildQueries([], base), body: { queries } });

    expect(() => answerQueries(make('nope'), [])).toThrow(DidcommError);
    expect(() => answerQueries(make([{ match: 'x' }]), [])).toThrow(DidcommError);
    expect(() => answerQueries(make([null]), [])).toThrow(DidcommError);
    expect(() =>
      answerQueries(make(Array.from({ length: 33 }, () => ({ 'feature-type': 'protocol', match: '*' }))), []),
    ).toThrow(DidcommError);
    expect(() => answerQueries(make([{ 'feature-type': 'protocol', match: 'x'.repeat(600) }]), [])).toThrow(
      DidcommError,
    );
    expect(() => answerQueries(createMessage({ type: 'https://example.com/p/1.0/m' }), [])).toThrow(
      DidcommError,
    );
    expect(() => buildDisclose(buildQueries([], { to: ['did:example:bob'] }), [])).toThrow(DidcommError);
  });
});

describe('problem reports', () => {
  it.each([
    'e.p.xfer.cant-use-endpoint',
    'w.m.trust.crypto',
    'e.get-pay-details.payment-failed',
    'e.m.me.res.storage.message_too_big',
    'e.p.req.max-errors-exceeded',
  ])('accepts the code %s', (code) => {
    expect(isProblemCode(code)).toBe(true);
  });

  it.each(['', 'e', 'e.p', 'x.p.msg', 'E.p.msg', 'e.p.Msg', 'e.p..msg', 'e.p.msg.', 'e p msg', 5, undefined])(
    'rejects %p',
    (code) => {
      expect(isProblemCode(code)).toBe(false);
    },
  );

  it('builds the report the specification shows and reads it back', () => {
    const report = buildProblemReport({
      code: 'e.p.xfer.cant-use-endpoint',
      comment: 'Unable to use the {1} endpoint for {2}.',
      args: ['https://agents.r.us/inbox', 'did:sov:C805sNYhMrjHiqZDTUASHg'],
      pthid: '1e513ad4-48c9-444e-9e7e-5b8b45c5e325',
      ack: ['1e513ad4-48c9-444e-9e7e-5b8b45c5e325'],
      escalateTo: 'mailto:admin@foo.org',
    });

    expect(report).toMatchObject({
      type: PROBLEM_REPORT_TYPE,
      pthid: '1e513ad4-48c9-444e-9e7e-5b8b45c5e325',
      ack: ['1e513ad4-48c9-444e-9e7e-5b8b45c5e325'],
      body: { code: 'e.p.xfer.cant-use-endpoint', escalate_to: 'mailto:admin@foo.org' },
    });
    expect(parseProblemReport(report)).toEqual({
      code: 'e.p.xfer.cant-use-endpoint',
      comment: 'Unable to use the {1} endpoint for {2}.',
      args: ['https://agents.r.us/inbox', 'did:sov:C805sNYhMrjHiqZDTUASHg'],
      escalateTo: 'mailto:admin@foo.org',
      pthid: '1e513ad4-48c9-444e-9e7e-5b8b45c5e325',
    });
  });

  it('refuses an invalid code, a missing thread, and reports it cannot read', () => {
    expect(() => buildProblemReport({ code: 'oops', pthid: 't' })).toThrow(DidcommError);
    expect(() => buildProblemReport({ code: 'e.p.msg', pthid: 'bad thread' })).toThrow(DidcommError);
    expect(() => parseProblemReport(createMessage({ type: 'https://example.com/p/1.0/m' }))).toThrow(
      DidcommError,
    );
    expect(() =>
      parseProblemReport(parseMessage({ id: 'a', type: PROBLEM_REPORT_TYPE, body: { code: 'bad' } })),
    ).toThrow(DidcommError);
    expect(() =>
      parseProblemReport(
        parseMessage({ id: 'a', type: PROBLEM_REPORT_TYPE, body: { code: 'e.p.msg', args: [1] } }),
      ),
    ).toThrow(DidcommError);
  });

  it("interpolates with the protocol's rules: missing args become ?, extra args are appended", () => {
    expect(
      interpolateComment('Unable to use the {1} endpoint for {2}.', ['https://a.example', 'did:x:y']),
    ).toBe('Unable to use the https://a.example endpoint for did:x:y.');
    expect(interpolateComment('Unable to use the {1} endpoint for {2}.', ['https://a.example'])).toBe(
      'Unable to use the https://a.example endpoint for ?.',
    );
    expect(interpolateComment('Unable to use the {1} endpoint for {2}.', [null, 'did:x:y'])).toBe(
      'Unable to use the ? endpoint for did:x:y.',
    );
    expect(interpolateComment('Failed: {1}', ['a', 'b', 'c'])).toBe('Failed: a b, c');
    expect(interpolateComment('Static text')).toBe('Static text');
    expect(interpolateComment('{2} then {1}', ['one', 'two'])).toBe('two then one');
  });
});

describe('out-of-band invitations', () => {
  /** The example URL printed in the specification. */
  const SPEC_URL =
    'https://example.com/path?_oob=eyJ0eXBlIjoiaHR0cHM6Ly9kaWRjb21tLm9yZy9vdXQtb2YtYmFuZC8yLjAvaW52aXRhdGlvbiIsImlkIjoiNjkyMTJhM2EtZDA2OC00ZjlkLWEyZGQtNDc0MWJjYTg5YWYzIiwiZnJvbSI6ImRpZDpleGFtcGxlOmFsaWNlIiwiYm9keSI6eyJnb2FsX2NvZGUiOiIiLCJnb2FsIjoiIn0sImF0dGFjaG1lbnRzIjpbeyJpZCI6InJlcXVlc3QtMCIsIm1lZGlhX3R5cGUiOiJhcHBsaWNhdGlvbi9qc29uIiwiZGF0YSI6eyJqc29uIjoiPGpzb24gb2YgcHJvdG9jb2wgbWVzc2FnZT4ifX1dfQ';

  it('decodes the specification example', () => {
    const invitation = decodeInvitationUrl(SPEC_URL);

    expect(invitation).toMatchObject({
      type: OOB_INVITATION_TYPE,
      id: '69212a3a-d068-4f9d-a2dd-4741bca89af3',
      from: 'did:example:alice',
      body: { goal_code: '', goal: '' },
    });
    expect(replyParentThread(invitation)).toBe('69212a3a-d068-4f9d-a2dd-4741bca89af3');
  });

  it('encodes it back to the identical URL (whitespace-free JSON, key order kept)', () => {
    expect(encodeInvitationUrl('https://example.com/path', decodeInvitationUrl(SPEC_URL))).toBe(SPEC_URL);
  });

  it('builds an invitation, round-trips it through a URL and keeps the other query parameters', () => {
    const invitation = buildInvitation(
      {
        from: 'did:example:alice',
        goalCode: 'meet',
        goal: 'Meet Alice',
        accept: ['didcomm/v2'],
        expiresTime: 1700003600,
      },
      1700000000,
    );
    const link = encodeInvitationUrl('https://example.com/invite?campaign=spring', invitation);

    expect(new URL(link).searchParams.get('campaign')).toBe('spring');
    expect(decodeInvitationUrl(link)).toEqual(invitation);
    expect(invitation.body).toEqual({ goal_code: 'meet', goal: 'Meet Alice', accept: ['didcomm/v2'] });
    expect(invitation.expires_time).toBe(1700003600);
  });

  it.each([
    ['not a URL', 'nope'],
    ['no _oob', 'https://example.com/path'],
    ['two _oob parameters', `${SPEC_URL}&_oob=${SPEC_URL.split('_oob=')[1]}`],
    ['the short form (_oobid)', 'https://example.com/path?_oobid=5f0e3ffb-3f92-4648-9868-0d6f8889e6f3'],
    ['standard base64 with padding', `${SPEC_URL}=`],
    ['a payload that is not JSON', `https://example.com/p?_oob=${Buffer.from('nope').toString('base64url')}`],
    [
      'another message type',
      `https://example.com/p?_oob=${Buffer.from(JSON.stringify({ id: 'a', type: 'https://didcomm.org/trust-ping/2.0/ping', from: 'did:example:a', body: {} })).toString('base64url')}`,
    ],
    [
      'an invitation with no sender',
      `https://example.com/p?_oob=${Buffer.from(JSON.stringify({ id: 'a', type: OOB_INVITATION_TYPE, body: {} })).toString('base64url')}`,
    ],
    ['an oversized parameter', `https://example.com/p?_oob=${'A'.repeat(70000)}`],
  ])('refuses %s', (_name, link) => {
    expect(() => decodeInvitationUrl(link)).toThrow(DidcommError);
  });

  it('refuses to encode over http, onto a URL that already carries an invitation, or a non-invitation', () => {
    const invitation = buildInvitation({ from: 'did:example:alice' });

    expect(() => encodeInvitationUrl('http://example.com/p', invitation)).toThrow(DidcommError);
    expect(() => encodeInvitationUrl(SPEC_URL, invitation)).toThrow(DidcommError);
    expect(() => encodeInvitationUrl('https://example.com/p', buildPing({ to: ['did:example:b'] }))).toThrow(
      DidcommError,
    );
  });
});
