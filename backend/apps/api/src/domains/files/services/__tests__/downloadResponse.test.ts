import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  attachmentDisposition,
  downloadResponseOverrides,
  isInlineSafeContentType,
} from '../downloadResponse';

describe('isInlineSafeContentType', () => {
  it.each([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/heic',
    'video/mp4',
    'video/quicktime',
    'audio/mpeg',
    'audio/ogg',
    'application/pdf',
    'text/plain',
    'TEXT/PLAIN; charset=UTF-8',
  ])('opens %s inline', (type) => {
    expect(isInlineSafeContentType(type)).toBe(true);
  });

  it.each([
    'text/html',
    'application/xhtml+xml',
    'image/svg+xml',
    'text/xml',
    'application/xml',
    'text/javascript',
    'application/javascript',
    'text/markdown',
    'application/octet-stream',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png, text/html',
    '',
  ])('does not open %s inline', (type) => {
    expect(isInlineSafeContentType(type)).toBe(false);
  });

  it('treats a missing type as not inline-safe', () => {
    expect(isInlineSafeContentType(null)).toBe(false);
    expect(isInlineSafeContentType(undefined)).toBe(false);
  });
});

describe('downloadResponseOverrides', () => {
  it('sends anything that is not inline-safe as an octet-stream attachment', () => {
    expect(downloadResponseOverrides('text/html; charset=utf-8', 'page.html')).toEqual({
      ResponseContentType: 'application/octet-stream',
      ResponseContentDisposition: `attachment; filename="page.html"; filename*=UTF-8''page.html`,
    });
  });

  it('keeps an SVG typed as SVG, but as an attachment', () => {
    expect(downloadResponseOverrides('image/SVG+XML', null)).toEqual({
      ResponseContentType: 'image/svg+xml',
      ResponseContentDisposition: 'attachment',
    });
  });

  it('sends an inline-safe type bare, with no disposition', () => {
    expect(downloadResponseOverrides('application/pdf; name=x', 'x.pdf')).toEqual({
      ResponseContentType: 'application/pdf',
    });
    expect(downloadResponseOverrides('Image/JPEG', 'x.jpg')).toEqual({ ResponseContentType: 'image/jpeg' });
  });

  it('keeps a plain-text charset, and only a charset', () => {
    expect(downloadResponseOverrides('text/plain; charset=ISO-8859-1', 'a.txt')).toEqual({
      ResponseContentType: 'text/plain; charset=ISO-8859-1',
    });
    expect(downloadResponseOverrides('text/plain; charset="a\r\nb"', 'a.txt')).toEqual({
      ResponseContentType: 'text/plain',
    });
  });
});

describe('attachmentDisposition', () => {
  it('names the file so the download is not saved as the object key', () => {
    expect(attachmentDisposition('report.docx')).toBe(
      `attachment; filename="report.docx"; filename*=UTF-8''report.docx`,
    );
  });

  it('keeps quotes, backslashes and line breaks out of the quoted name', () => {
    const value = attachmentDisposition('a"b\\c\r\nd.txt');

    expect(value).toContain('filename="a_b_c__d.txt"');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).toContain(`filename*=UTF-8''a%22b%5Cc%0D%0Ad.txt`);
  });

  it('carries a non-ASCII name in filename* and an ASCII stand-in in filename', () => {
    expect(attachmentDisposition("Café (1)'s.pdf")).toBe(
      `attachment; filename="Caf_ (1)'s.pdf"; filename*=UTF-8''Caf%C3%A9%20%281%29%27s.pdf`,
    );
  });

  it('cuts a long name on a code point, so an emoji at the cut cannot make signing throw', () => {
    // The stem keeps 196 code points ahead of `.eml`. Cut as UTF-16 units it
    // would end on the first half of the emoji.
    const value = attachmentDisposition(`${'a'.repeat(195)}\u{1F600}${'b'.repeat(10)}.eml`);

    expect(value.endsWith(`filename*=UTF-8''${'a'.repeat(195)}%F0%9F%98%80.eml`)).toBe(true);
  });

  it('shortens a long name from the end of its stem and keeps the extension', () => {
    expect(attachmentDisposition(`${'x'.repeat(230)}.pdf`)).toBe(
      `attachment; filename="${'x'.repeat(196)}.pdf"; filename*=UTF-8''${'x'.repeat(196)}.pdf`,
    );
    // No extension, or one too long to be an extension: a plain cut at 200.
    expect(attachmentDisposition('y'.repeat(230))).toContain(`filename="${'y'.repeat(200)}"`);
    expect(attachmentDisposition(`z.${'q'.repeat(230)}`)).toContain(`filename="z.${'q'.repeat(198)}"`);
  });

  it('turns an unpaired surrogate into U+FFFD instead of throwing', () => {
    expect(() => attachmentDisposition('a\uD800b.txt')).not.toThrow();
    expect(attachmentDisposition('a\uD800b.txt')).toContain(`filename*=UTF-8''a%EF%BF%BDb.txt`);
  });

  it('is a bare attachment when the row has no filename', () => {
    expect(attachmentDisposition(null)).toBe('attachment');
    expect(attachmentDisposition('   ')).toBe('attachment');
  });
});

/**
 * The gateway half of the same rule, read from the real file: what `/static/`
 * adds on top of the signed headers above.
 */
describe('gateway /static/ location', () => {
  function staticLocation(): string {
    let dir = __dirname;

    while (!existsSync(join(dir, 'infrastructure/gateway/nginx.conf'))) {
      const parent = dirname(dir);

      if (parent === dir) {
        throw new Error('infrastructure/gateway/nginx.conf not found');
      }

      dir = parent;
    }

    const conf = readFileSync(join(dir, 'infrastructure/gateway/nginx.conf'), 'utf8');
    const start = conf.indexOf('location /static/ {');
    const end = conf.indexOf('\n    }\n', start);

    expect(start).toBeGreaterThan(-1);

    // Directives only: the comments above them talk about the very tokens checked here.
    return conf
      .slice(start, end)
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
  }

  function pdfExemption(block: string): RegExp {
    const match = /if \(\$args ~\* "([^"]+)"\) \{\s*set \$static_sandbox "";/.exec(block);

    expect(match).not.toBeNull();

    return new RegExp(match![1], 'i');
  }

  it('sandboxes every response by default, ahead of the rewrite that ends the rewrite phase', () => {
    const block = staticLocation();
    const sandbox = block.indexOf('set $static_sandbox "sandbox allow-same-origin; ";');

    expect(sandbox).toBeGreaterThan(-1);
    expect(sandbox).toBeLessThan(block.indexOf('rewrite ^/static/'));
    expect(block).toMatch(
      /add_header Content-Security-Policy "\$\{static_sandbox\}default-src 'none';[^"]*" always;/,
    );
    expect(block).not.toMatch(/allow-scripts/);
  });

  it('lifts the sandbox only for the PDF type the API signs', () => {
    const exemption = pdfExemption(staticLocation());
    const query = (type: string) =>
      `X-Amz-Algorithm=AWS4-HMAC-SHA256&response-content-type=${encodeURIComponent(type)}&X-Amz-Signature=0`;

    expect(
      exemption.test(query(downloadResponseOverrides('application/pdf', null).ResponseContentType)),
    ).toBe(true);

    for (const type of ['text/html', 'image/svg+xml', 'application/octet-stream', 'image/png', 'video/mp4']) {
      expect(exemption.test(query(downloadResponseOverrides(type, null).ResponseContentType))).toBe(false);
    }

    // Only the exact bare value: a longer type that starts the same way is not a PDF.
    expect(exemption.test(query('application/pdfx'))).toBe(false);
    expect(exemption.test(query('application/pdf; charset=utf-8'))).toBe(false);
    expect(exemption.test(`response-content-type=application%2Fpdf`)).toBe(true);
  });
});
