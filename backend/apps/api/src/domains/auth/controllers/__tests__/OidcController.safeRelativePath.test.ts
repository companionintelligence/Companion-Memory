import { safeRelativePath } from '../OidcController';

/**
 * The OIDC post-login redirect is attacker-influenceable (it rides in on a query
 * param), so safeRelativePath is the open-redirect guard. These tests pin that it
 * accepts only same-origin relative paths and rejects every escape hatch.
 */
describe('safeRelativePath (OIDC open-redirect guard)', () => {
  it.each(['/shared/abc123', '/memory?from=2024-01-01&to=2024-12-31&view=map', '/', '/feed'])(
    'accepts the same-origin relative path %s',
    (input) => {
      expect(safeRelativePath(input)).toBe(input);
    },
  );

  it.each([
    ['//evil.com', 'protocol-relative'],
    ['https://evil.com', 'absolute https'],
    ['http://evil.com/path', 'absolute http'],
    ['/\\evil.com', 'leading backslash host'],
    ['/foo\\bar', 'embedded backslash'],
    ['javascript:alert(1)', 'javascript scheme'],
    ['evil.com', 'no leading slash'],
    ['', 'empty string'],
    ['/foo\nbar', 'newline smuggling'],
    ['/foo\tbar', 'tab smuggling'],
  ])('rejects the unsafe target %s (%s)', (input) => {
    expect(safeRelativePath(input)).toBeNull();
  });

  it('rejects non-string and over-long inputs', () => {
    expect(safeRelativePath(undefined)).toBeNull();
    expect(safeRelativePath(null)).toBeNull();
    expect(safeRelativePath(42)).toBeNull();
    expect(safeRelativePath(`/${'a'.repeat(3000)}`)).toBeNull();
  });
});
