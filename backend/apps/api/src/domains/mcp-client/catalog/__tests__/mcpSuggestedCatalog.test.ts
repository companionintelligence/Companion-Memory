import { getMcpSuggestedCatalog, type McpCatalogEntry } from '../mcpSuggestedCatalog';

/**
 * npx and uvx fetch whatever a package name resolves to when the server starts, so an entry
 * without an exact version ran whatever was published last, on the host, with the server's access
 * (2026-11-20 audit). Every stdio entry must name one.
 */

const { normal, highRisk } = getMcpSuggestedCatalog();
const stdioEntries = [...normal, ...highRisk].filter((entry) => entry.transport === 'stdio');

/** The package argument npx or uvx installs: the first argument that is not a flag. */
function packageArgument(entry: McpCatalogEntry): string | undefined {
  return (entry.args ?? []).find((arg) => !arg.startsWith('-'));
}

/** `name@1.2.3` or `@scope/name@1.2.3`, with an exact version (digits and dots). */
const EXACT_PIN = /^(@[^/\s]+\/)?[^@\s]+@\d+(\.\d+)+$/;

describe('the suggested MCP catalog', () => {
  it('has stdio entries to check', () => {
    expect(stdioEntries.length).toBeGreaterThan(0);
  });

  it.each(stdioEntries.map((entry) => [entry.slug, entry] as const))(
    '%s installs an exact package version',
    (_slug, entry) => {
      expect(['npx', 'uvx']).toContain(entry.command);
      expect(packageArgument(entry)).toMatch(EXACT_PIN);
    },
  );

  it.each([
    ['@modelcontextprotocol/server-filesystem@latest', false],
    ['mcp-server-git', false],
    ['@qwen-code/open-computer-use', false],
    ['mcp-server-fetch@2026.11.18', true],
    ['@modelcontextprotocol/server-filesystem@2.4.0', true],
  ])('reads %s as pinned: %s', (argument, pinned) => {
    expect(EXACT_PIN.test(argument)).toBe(pinned);
  });
});
