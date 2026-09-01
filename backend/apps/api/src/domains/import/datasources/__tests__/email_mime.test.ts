import { parseMime } from '../email_mime';

describe('parseMime charset-aware body decoding', () => {
  it('decodes a UTF-8 quoted-printable body whose multi-byte sequence spans several =XX escapes', () => {
    // Previously each escaped byte was individually re-encoded as if it were
    // its own Unicode code point (String.fromCharCode(0xc3) + fromCharCode(0xa9)
    // joined into a string, then THAT re-encoded as UTF-8) — 4 bytes instead
    // of the original 2, corrupting any multi-byte quoted-printable sequence.
    const headers = 'Content-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: quoted-printable';
    const result = parseMime(headers, 'caf=C3=A9 au lait');

    expect(result.textBody).toBe('café au lait');
  });

  it('decodes an ISO-8859-1 quoted-printable body using the declared charset, not UTF-8', () => {
    // 'é' is the single byte 0xE9 in ISO-8859-1/Latin-1.
    const headers =
      'Content-Type: text/plain; charset=ISO-8859-1\nContent-Transfer-Encoding: quoted-printable';
    const result = parseMime(headers, 'caf=E9');

    expect(result.textBody).toBe('café');
  });

  it('decodes a windows-1252 base64 body using the declared charset', () => {
    // The Euro sign is 0x80 in windows-1252 — undefined in ISO-8859-1 proper,
    // which is why the two labels are not interchangeable.
    const bytes = Buffer.concat([Buffer.from([0x80]), Buffer.from('100', 'ascii')]);
    const headers = 'Content-Type: text/plain; charset=windows-1252\nContent-Transfer-Encoding: base64';
    const result = parseMime(headers, bytes.toString('base64'));

    expect(result.textBody).toBe('€100');
  });

  it('decodes an ISO-8859-1 HTML body using the declared charset', () => {
    const headers =
      'Content-Type: text/html; charset=ISO-8859-1\nContent-Transfer-Encoding: quoted-printable';
    const result = parseMime(headers, '<p>caf=E9</p>');

    expect(result.htmlBody).toBe('<p>café</p>');
  });

  it('falls back to UTF-8 for an unrecognized charset label rather than throwing', () => {
    const headers = 'Content-Type: text/plain; charset=bogus-charset-xyz';

    expect(() => parseMime(headers, 'hello')).not.toThrow();
    expect(parseMime(headers, 'hello').textBody).toBe('hello');
  });

  it('treats a missing charset as UTF-8, matching prior behavior', () => {
    const headers = 'Content-Type: text/plain';
    const result = parseMime(headers, 'plain ascii body');

    expect(result.textBody).toBe('plain ascii body');
  });
});

describe('parseMime RFC 2231 extended-notation attachment filenames', () => {
  function multipartWithAttachment(dispositionLine: string): { headers: string; body: string } {
    const boundary = 'B';
    const headers = `Content-Type: multipart/mixed; boundary="${boundary}"`;
    const body = [
      `--${boundary}`,
      'Content-Type: application/pdf',
      dispositionLine,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('PDFDATA').toString('base64'),
      `--${boundary}--`,
      '',
    ].join('\n');

    return { headers, body };
  }

  it('decodes a UTF-8 percent-encoded filename', () => {
    const { headers, body } = multipartWithAttachment(
      "Content-Disposition: attachment; filename*=UTF-8''caf%C3%A9.pdf",
    );
    const result = parseMime(headers, body);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe('café.pdf');
  });

  it('prefers the extended form over a plain fallback when both are present', () => {
    const { headers, body } = multipartWithAttachment(
      'Content-Disposition: attachment; filename="cafe.pdf"; filename*=UTF-8\'\'caf%C3%A9.pdf',
    );
    const result = parseMime(headers, body);

    expect(result.attachments[0].filename).toBe('café.pdf');
  });

  it('still resolves a plain ASCII filename when there is no extended form', () => {
    const { headers, body } = multipartWithAttachment(
      'Content-Disposition: attachment; filename="report.pdf"',
    );
    const result = parseMime(headers, body);

    expect(result.attachments[0].filename).toBe('report.pdf');
  });
});
