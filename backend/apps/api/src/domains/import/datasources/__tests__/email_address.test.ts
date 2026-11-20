import { decodeAddressList, parseEmailAddress, splitAddressList } from '../email_address';

describe('splitAddressList', () => {
  it('keeps a quoted "Last, First" name in one piece', () => {
    expect(
      splitAddressList(
        '"Quillfeather, Zephyrine" <z.q@example.com>, "Pembury-Vale, Thaddeus" <t.pv@example.com>, Corvina Haskett <c.h@example.org>',
      ),
    ).toEqual([
      '"Quillfeather, Zephyrine" <z.q@example.com>',
      '"Pembury-Vale, Thaddeus" <t.pv@example.com>',
      'Corvina Haskett <c.h@example.org>',
    ]);
  });

  it('splits a plain list exactly as a split on every comma would', () => {
    expect(splitAddressList('Alice <a@example.com>, b@example.com,c@example.com')).toEqual([
      'Alice <a@example.com>',
      'b@example.com',
      'c@example.com',
    ]);
    expect(splitAddressList('Alice Smith, Bob Jones')).toEqual(['Alice Smith', 'Bob Jones']);
  });

  it('ignores commas in an escaped quote, a comment and an address', () => {
    expect(
      splitAddressList('"Doe \\"Jr, the second\\"" <j@example.com>, Ann (work, mostly) <a@example.com>, <"odd,local"@example.com>'),
    ).toEqual([
      '"Doe \\"Jr, the second\\"" <j@example.com>',
      'Ann (work, mostly) <a@example.com>',
      '<"odd,local"@example.com>',
    ]);
  });

  it('drops empty entries', () => {
    expect(splitAddressList(' , a@example.com,, ')).toEqual(['a@example.com']);
  });

  it('stays linear on a pathological header', () => {
    for (const unit of ['"', '<', '(', '\\', ',']) {
      const started = Date.now();
      splitAddressList(unit.repeat(300_000));
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  });
});

describe('parseEmailAddress', () => {
  it('unquotes the display name', () => {
    expect(parseEmailAddress('"Brightwater, Ottilie" <o.b@example.org>')).toEqual({
      name: 'Brightwater, Ottilie',
      email: 'o.b@example.org',
    });
    expect(parseEmailAddress('"Doe \\"Jr\\"" <j@example.com>')).toEqual({ name: 'Doe "Jr"', email: 'j@example.com' });
  });

  it('reads a bare address and a name without one', () => {
    expect(parseEmailAddress('a@example.com')).toEqual({ email: 'a@example.com' });
    expect(parseEmailAddress('<a@example.com>')).toEqual({ name: undefined, email: 'a@example.com' });
    expect(parseEmailAddress('Just A Name')).toEqual({ name: 'Just A Name' });
  });
});

describe('decodeAddressList', () => {
  it('quotes an encoded name that decodes to "Last, First", so it still splits as one mailbox', () => {
    const decoded = decodeAddressList('=?UTF-8?Q?M=C3=BCller=2C_Hans?= <h.m@example.de>, Ann <a@example.com>');

    expect(decoded).toBe('"Müller, Hans" <h.m@example.de>, Ann <a@example.com>');
    expect(splitAddressList(decoded).map(parseEmailAddress)).toEqual([
      { name: 'Müller, Hans', email: 'h.m@example.de' },
      { name: 'Ann', email: 'a@example.com' },
    ]);
  });

  it('leaves an encoded name with no comma, and an already quoted one, as decoded', () => {
    expect(decodeAddressList('=?utf-8?q?Zo=C3=AB_Brightwater?= <z@example.org>')).toBe('Zoë Brightwater <z@example.org>');
    expect(decodeAddressList('"=?iso-8859-1?Q?M=FCller=2C_Hans?=" <h@example.de>')).toBe('"Müller, Hans" <h@example.de>');
  });

  it('returns a header with no encoded word unchanged', () => {
    const raw = '"Quillfeather, Zephyrine" <z.q@example.com>,  b@example.com';

    expect(decodeAddressList(raw)).toBe(raw);
  });
});
