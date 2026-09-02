import { cleanMessageId, emailThreadId, parseMessageIds } from '../email_thread';

describe('emailThreadId', () => {
  it('prefers the Gmail thread id a Takeout mbox carries, in the API’s hex spelling', () => {
    // X-GM-THRID is the same 64-bit number the Gmail API reports as `threadId`
    // in hex, so a connection sync and an archive import of one message agree
    // on thread_id (registry: emailThreadKey / gmailThreadKeyFromApi).
    expect(
      emailThreadId({
        'X-GM-THRID': '1783885820400625399',
        'Message-ID': '<reply@mx.example.com>',
        References: '<root@mx.example.com>',
      }),
    ).toBe('18c1a2b3c4d5e6f7');
  });

  it('uses the first References id as the conversation root', () => {
    expect(
      emailThreadId({
        'Message-ID': '<reply@mx.example.com>',
        'In-Reply-To': '<parent@mx.example.com>',
        References: '<root@mx.example.com> <parent@mx.example.com>',
      }),
    ).toBe('root@mx.example.com');
  });

  it('falls back to In-Reply-To when References is absent', () => {
    expect(
      emailThreadId({
        'Message-ID': '<reply@mx.example.com>',
        'In-Reply-To': '<parent@mx.example.com>',
      }),
    ).toBe('parent@mx.example.com');
  });

  it('uses the message own id only as a new-thread last resort', () => {
    expect(emailThreadId({ 'Message-ID': '<lonely@mx.example.com>' })).toBe('lonely@mx.example.com');
  });

  it('looks up headers case-insensitively', () => {
    expect(
      emailThreadId({
        'message-id': '<reply@mx.example.com>',
        'in-reply-to': '<parent@mx.example.com>',
      }),
    ).toBe('parent@mx.example.com');
  });

  it('returns undefined when there is no id at all', () => {
    expect(emailThreadId({ Subject: 'no ids' })).toBeUndefined();
  });
});

describe('parseMessageIds / cleanMessageId', () => {
  it('prefers bracketed ids in listed order', () => {
    expect(parseMessageIds('<a@x> <b@x>')).toEqual(['a@x', 'b@x']);
  });

  it('splits a bare list when there are no brackets', () => {
    expect(parseMessageIds('a@x b@x')).toEqual(['a@x', 'b@x']);
  });

  it('strips brackets from a single id', () => {
    expect(cleanMessageId('<abc@mx.example.com>')).toBe('abc@mx.example.com');
  });
});
