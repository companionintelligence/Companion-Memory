import { appendAudit, AUDIT_GENESIS, verifyAuditChain, type AuditEntry } from './auditChain';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);

function chainOf(length: number, key: Uint8Array = KEY): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (let index = 0; index < length; index += 1) {
    entries.push(
      appendAudit(
        entries.at(-1) ?? null,
        { type: 'MembershipIssued', member: `did:key:z6Mk${index}`, statusIndex: 100 + index },
        key,
        new Date(Date.UTC(2026, 10, 5, 12, 0, index)),
      ),
    );
  }

  return entries;
}

describe('the audit chain', () => {
  it('starts at the genesis marker with sequence 0 and links each entry to the one before', () => {
    const chain = chainOf(3);

    expect(chain[0]).toMatchObject({ seq: 0, prev: AUDIT_GENESIS });
    expect(chain[1]).toMatchObject({ seq: 1, prev: chain[0]?.mac });
    expect(chain[2]).toMatchObject({ seq: 2, prev: chain[1]?.mac });
    expect(chain[0]?.at).toBe('2026-11-05T12:00:00Z');
  });

  it('verifies an intact chain and reports its length and head', () => {
    const chain = chainOf(5);

    expect(verifyAuditChain(chain, KEY)).toEqual({ ok: true, length: 5, head: chain[4]?.mac });
  });

  it('verifies an empty chain', () => {
    expect(verifyAuditChain([], KEY)).toEqual({ ok: true, length: 0, head: null });
  });

  it('gives the same MAC whatever order the event members were written in', () => {
    const a = appendAudit(null, { x: 1, y: 2 }, KEY, new Date(0));
    const b = appendAudit(null, { y: 2, x: 1 }, KEY, new Date(0));

    expect(a.mac).toBe(b.mac);
  });

  it('gives a different MAC under a different key', () => {
    expect(appendAudit(null, { x: 1 }, KEY, new Date(0)).mac).not.toBe(
      appendAudit(null, { x: 1 }, OTHER_KEY, new Date(0)).mac,
    );
  });

  describe('detects', () => {
    it('an edited event', () => {
      const chain = chainOf(5);
      chain[2] = {
        ...(chain[2] as AuditEntry),
        event: { type: 'MembershipIssued', member: 'did:key:attacker' },
      };

      expect(verifyAuditChain(chain, KEY)).toEqual({ ok: false, index: 2, reason: 'BAD_MAC' });
    });

    it('an edited timestamp', () => {
      const chain = chainOf(3);
      chain[1] = { ...(chain[1] as AuditEntry), at: '2026-11-05T12:59:59Z' };

      expect(verifyAuditChain(chain, KEY)).toEqual({ ok: false, index: 1, reason: 'BAD_MAC' });
    });

    it('a removed entry from the middle', () => {
      const chain = chainOf(5);
      chain.splice(2, 1);

      expect(verifyAuditChain(chain, KEY)).toEqual({ ok: false, index: 2, reason: 'BAD_SEQUENCE' });
    });

    it('a removed first entry', () => {
      const chain = chainOf(3);
      chain.shift();

      expect(verifyAuditChain(chain, KEY)).toEqual({ ok: false, index: 0, reason: 'BAD_SEQUENCE' });
    });

    it('two entries swapped', () => {
      const chain = chainOf(4);
      [chain[1], chain[2]] = [chain[2] as AuditEntry, chain[1] as AuditEntry];

      expect(verifyAuditChain(chain, KEY)).toMatchObject({ ok: false, index: 1, reason: 'BAD_SEQUENCE' });
    });

    it('an inserted entry that carries a correct MAC but does not link', () => {
      const chain = chainOf(3);
      // Built by appendAudit after a predecessor that is not chain[0], so its MAC really is correct
      // for the entry as stored, and only its link to the entry before is wrong.
      const imaginary = { ...(chain[0] as AuditEntry), mac: 'f'.repeat(43) };
      const forged = appendAudit(imaginary, { type: 'Forged' }, KEY, new Date(0));
      chain[1] = forged;

      expect(forged).toMatchObject({ seq: 1, prev: imaginary.mac });
      expect(verifyAuditChain(chain, KEY)).toMatchObject({ ok: false, index: 1, reason: 'BAD_LINK' });
    });

    it('a rewritten link', () => {
      const chain = chainOf(3);
      chain[1] = { ...(chain[1] as AuditEntry), prev: AUDIT_GENESIS };

      expect(verifyAuditChain(chain, KEY)).toEqual({ ok: false, index: 1, reason: 'BAD_LINK' });
    });

    it.each([
      ['a different MAC', 'AAAA'],
      ['an empty MAC', ''],
      ['a MAC that is not a string', 7],
    ])('%s', (_name, mac) => {
      const chain = chainOf(2);
      chain[1] = { ...(chain[1] as AuditEntry), mac: mac as string };

      expect(verifyAuditChain(chain, KEY)).toEqual({ ok: false, index: 1, reason: 'BAD_MAC' });
    });

    it('a chain checked under the wrong key', () => {
      expect(verifyAuditChain(chainOf(3), OTHER_KEY)).toEqual({ ok: false, index: 0, reason: 'BAD_MAC' });
    });

    it('an event that cannot be canonicalized, as a bad MAC and not a crash', () => {
      const chain = chainOf(2);
      chain[1] = { ...(chain[1] as AuditEntry), event: { broken: undefined } };

      expect(verifyAuditChain(chain, KEY)).toEqual({ ok: false, index: 1, reason: 'BAD_MAC' });
    });
  });

  describe('truncation from the tail', () => {
    it('is invisible without a recorded head, which is why the head must be kept elsewhere', () => {
      const chain = chainOf(5);
      const head = chain[4]?.mac;

      const truncated = chain.slice(0, 3);

      expect(verifyAuditChain(truncated, KEY)).toMatchObject({ ok: true, length: 3 });
      expect(verifyAuditChain(truncated, KEY, { expectedHead: head })).toEqual({
        ok: false,
        index: 2,
        reason: 'HEAD_MISMATCH',
      });
    });

    it('accepts the intact chain against its recorded head', () => {
      const chain = chainOf(5);

      expect(verifyAuditChain(chain, KEY, { expectedHead: chain[4]?.mac })).toMatchObject({ ok: true });
    });

    it('refuses an empty chain when a head was recorded', () => {
      expect(verifyAuditChain([], KEY, { expectedHead: 'some-mac' })).toMatchObject({
        ok: false,
        reason: 'HEAD_MISMATCH',
      });
      expect(verifyAuditChain([], KEY, { expectedHead: null })).toMatchObject({ ok: true });
    });

    it('refuses a chain that has entries when the recorded head says it was empty', () => {
      expect(verifyAuditChain(chainOf(2), KEY, { expectedHead: null })).toMatchObject({
        ok: false,
        reason: 'HEAD_MISMATCH',
      });
    });
  });

  it('refuses a key shorter than the hash output, when appending and when verifying', () => {
    expect(() => appendAudit(null, {}, Buffer.alloc(31), new Date(0))).toThrow(RangeError);
    expect(() => verifyAuditChain(chainOf(1), Buffer.alloc(31))).toThrow(RangeError);
  });
});
