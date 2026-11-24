import { parseTypeUri, registryTypeUri, responseTypeUri } from './typeUri';

describe('parseTypeUri', () => {
  describe('accepts', () => {
    it('the public registry form', () => {
      const parsed = parseTypeUri('https://trusttasks.org/spec/acl/grant/0.1');

      expect(parsed).toEqual({
        ok: true,
        value: {
          raw: 'https://trusttasks.org/spec/acl/grant/0.1',
          bare: 'https://trusttasks.org/spec/acl/grant/0.1',
          variant: 'request',
          form: 'path',
          slug: 'acl/grant',
          version: '0.1',
          registry: true,
          reserved: false,
        },
      });
    });

    it('the explicit #request and #response fragments, and keeps them in `raw`', () => {
      const request = parseTypeUri('https://trusttasks.org/spec/acl/grant/0.1#request');
      const response = parseTypeUri('https://trusttasks.org/spec/acl/grant/0.1#response');

      expect(request).toMatchObject({
        ok: true,
        value: { variant: 'request', bare: 'https://trusttasks.org/spec/acl/grant/0.1' },
      });
      expect(response).toMatchObject({
        ok: true,
        value: {
          variant: 'response',
          raw: 'https://trusttasks.org/spec/acl/grant/0.1#response',
          bare: 'https://trusttasks.org/spec/acl/grant/0.1',
        },
      });
    });

    it('the framework slug with its three-part version, and the framework-defined response types', () => {
      expect(parseTypeUri('https://trusttasks.org/spec/trust-task/0.7.0')).toMatchObject({
        ok: true,
        value: { slug: 'trust-task', version: '0.7.0', reserved: true, registry: true },
      });
      expect(parseTypeUri('https://trusttasks.org/spec/trust-task-error/0.6')).toMatchObject({
        ok: true,
        value: { slug: 'trust-task-error', reserved: true, registry: true },
      });
      expect(parseTypeUri('https://trusttasks.org/spec/trust-task-discovery/0.4#response')).toMatchObject({
        ok: true,
        value: { slug: 'trust-task-discovery', variant: 'response' },
      });
    });

    it('private specifications under an authority the publisher controls', () => {
      expect(parseTypeUri('https://ci.computer/trust-tasks/spec/ask/request/0.1')).toMatchObject({
        ok: true,
        value: { form: 'path', slug: 'ask/request', version: '0.1', registry: false, reserved: false },
      });
      expect(parseTypeUri('did:example:123456789abcdefghi/spec/acl/grant/0.1')).toMatchObject({
        ok: true,
        value: { form: 'path', slug: 'acl/grant', registry: false },
      });
    });

    it('the URN form, with the slug segments rejoined by "/"', () => {
      expect(parseTypeUri('urn:example:tasks:spec:acl:grant:0.1')).toMatchObject({
        ok: true,
        value: { form: 'urn', slug: 'acl/grant', version: '0.1', registry: false },
      });
    });
  });

  describe('rejects', () => {
    const cases: [string, unknown, string][] = [
      ['a non-string', 42, 'malformed'],
      ['an empty string', '', 'malformed'],
      ['an oversized string', `https://example.com/spec/${'a'.repeat(3000)}/0.1`, 'malformed'],
      ['whitespace', 'https://example.com/spec/acl/grant/0.1 ', 'malformed'],
      ['a non-ASCII code point', 'https://example.com/spec/acl/gränt/0.1', 'malformed'],
      ['the http scheme', 'http://example.com/spec/acl/grant/0.1', 'scheme'],
      ['no scheme', '/spec/acl/grant/0.1', 'scheme'],
      [
        'a fragment other than #request / #response',
        'https://example.com/spec/acl/grant/0.1#other',
        'fragment',
      ],
      ['a query', 'https://example.com/spec/acl/grant/0.1?x=1', 'shape'],
      ['no /spec/ segment', 'https://example.com/acl/grant/0.1', 'shape'],
      ['a binding URI, which is not a Type URI', 'https://trusttasks.org/binding/https/0.3', 'shape'],
      [
        'a ceremony definition URI, which is not a Type URI',
        'https://trusttasks.org/ceremony/onboarding/0.1',
        'shape',
      ],
      ['an upper-case slug', 'https://example.com/spec/Acl/grant/0.1', 'slug'],
      ['consecutive hyphens in a slug', 'https://example.com/spec/acl--grant/0.1', 'slug'],
      ['consecutive slashes in a slug', 'https://example.com/spec/acl//grant/0.1', 'slug'],
      ['a one-part version', 'https://example.com/spec/acl/grant/1', 'version'],
      ['a leading zero in a version', 'https://example.com/spec/acl/grant/01.0', 'version'],
      ['a three-part version on an ordinary slug', 'https://trusttasks.org/spec/acl/grant/0.1.0', 'version'],
      ['a two-part version on the framework slug', 'https://trusttasks.org/spec/trust-task/0.7', 'version'],
      [
        'a private URI at the registry host',
        'https://trusttasks.org/foo/spec/acl/grant/0.1',
        'registry-authority',
      ],
      [
        'the registry host in another case',
        'https://TrustTasks.org/spec/acl/grant/0.1',
        'registry-authority',
      ],
      [
        'the registry host with a port',
        'https://trusttasks.org:8443/spec/acl/grant/0.1',
        'registry-authority',
      ],
      [
        'a reserved slug under a private authority',
        'https://example.com/spec/trust-task-error/0.6',
        'reserved-slug',
      ],
      [
        'a reserved slug in the URN form',
        'urn:example:tasks:spec:trust-ceremony-receipt:0.1',
        'reserved-slug',
      ],
      ['a URN with no slug', 'urn:example:tasks:spec:0.1', 'shape'],
    ];

    for (const [label, input, reason] of cases) {
      it(`${label}`, () => {
        expect(parseTypeUri(input)).toEqual({ ok: false, reason });
      });
    }
  });
});

describe('type URI helpers', () => {
  it('builds registry and response URIs', () => {
    expect(registryTypeUri('acl/grant', '0.1')).toBe('https://trusttasks.org/spec/acl/grant/0.1');
    expect(responseTypeUri('https://ci.computer/trust-tasks/spec/ask/request/0.1')).toBe(
      'https://ci.computer/trust-tasks/spec/ask/request/0.1#response',
    );
  });
});
