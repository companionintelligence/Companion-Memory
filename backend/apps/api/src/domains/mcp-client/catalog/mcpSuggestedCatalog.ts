/**
 * Curated "suggested MCPs" catalog, browsable by any signed-in user (`GET mcp/catalog`) and used
 * to pre-fill the create form — the user still reviews/edits before an admin actually adds one.
 *
 * Split into two tiers:
 * - `normal`: read/write scoped servers (filesystem, a git remote, a database, …).
 * - `highRisk`: full, unsandboxed desktop control. Disabled by default in the UI behind an
 *   explicit checkbox-gated confirmation; {@link HIGH_RISK_CATALOG_SLUGS} is the slug set
 *   `McpServerConfigService.create()` independently re-checks against `acknowledgedHighRisk`
 *   server-side — the UI gate alone is not the enforcement.
 */

export interface McpCatalogEnvSpec {
  key: string;
  label?: string;
  hint?: string;
  required?: boolean;
  secret?: boolean;
}

export interface McpCatalogAuthSpec {
  type: 'bearer' | 'basic' | 'api_key';
}

export interface McpCatalogManifestTool {
  name: string;
  description: string;
}

export interface McpCatalogEntry {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: McpCatalogEnvSpec[];
  auth?: McpCatalogAuthSpec;
  manifest?: { tools: McpCatalogManifestTool[] };
  requires?: { host_software?: string[] };
  riskTier: 'normal' | 'high_risk';
  /** Required (and shown before add) when `riskTier === 'high_risk'`. */
  warning?: string;
}

const NORMAL_CATALOG: McpCatalogEntry[] = [
  {
    slug: 'filesystem-mcp',
    name: 'Filesystem',
    description: 'Read and write files under one allow-listed directory on this machine.',
    tags: ['files', 'local'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem@latest', '${ALLOWED_PATH}'],
    env: [
      {
        key: 'ALLOWED_PATH',
        label: 'Allowed path',
        hint: 'Absolute path this server may read and write.',
        required: true,
      },
    ],
    riskTier: 'normal',
  },
  {
    slug: 'github-mcp',
    name: 'GitHub',
    description: 'Search repos, read issues/PRs, and open/comment on them via the GitHub API.',
    tags: ['github', 'dev'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github@latest'],
    env: [{ key: 'GITHUB_TOKEN', label: 'GitHub personal access token', required: true, secret: true }],
    riskTier: 'normal',
  },
  {
    slug: 'git-mcp',
    name: 'Git',
    description: 'Inspect and operate on a local git repository (log, diff, status, commit).',
    tags: ['git', 'dev'],
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git'],
    env: [
      {
        key: 'REPOSITORY_PATH',
        label: 'Repository path',
        hint: 'Absolute path to the local git repository.',
        required: false,
      },
    ],
    requires: { host_software: ['uv'] },
    riskTier: 'normal',
  },
  {
    slug: 'fetch-mcp',
    name: 'Fetch',
    description: 'Fetch and convert a web page to markdown for the assistant to read.',
    tags: ['web', 'http'],
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    requires: { host_software: ['uv'] },
    riskTier: 'normal',
  },
  {
    slug: 'sqlite-mcp',
    name: 'SQLite',
    description: 'Query and inspect a local SQLite database file.',
    tags: ['database', 'sql'],
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', '${DB_PATH}'],
    env: [{ key: 'DB_PATH', label: 'Database file path', required: true }],
    requires: { host_software: ['uv'] },
    riskTier: 'normal',
  },
  {
    slug: 'postgres-mcp',
    name: 'Postgres',
    description: 'Run read queries against a Postgres database via a connection string.',
    tags: ['database', 'postgres'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres@latest'],
    env: [{ key: 'DATABASE_URL', label: 'Postgres connection string', required: true, secret: true }],
    riskTier: 'normal',
  },
  {
    slug: 'context7',
    name: 'Context7',
    description: 'Up-to-date library/framework documentation lookup, hosted by Context7.',
    tags: ['docs', 'search'],
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    auth: { type: 'api_key' },
    riskTier: 'normal',
  },
];

const HIGH_RISK_CATALOG: McpCatalogEntry[] = [
  {
    slug: 'computer-control-mcp',
    name: 'Computer Control (AB498)',
    description: 'Full mouse, keyboard, and screen control of this device.',
    tags: ['desktop', 'automation', 'high-risk'],
    transport: 'stdio',
    command: 'uvx',
    args: ['computer-control-mcp@latest'],
    requires: { host_software: ['uv'] },
    riskTier: 'high_risk',
    warning:
      "Gives the assistant full, unsandboxed control of this device's mouse, keyboard, and screen. It can see " +
      'everything on screen and act as if it were you. Only enable this if you fully trust every model you route ' +
      'chats through and are running it in an isolated environment with no sensitive logins.',
  },
  {
    slug: 'open-computer-use',
    name: 'Open Computer Use (Qwen)',
    description: 'Full mouse, keyboard, and screen control of this device.',
    tags: ['desktop', 'automation', 'high-risk'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@qwen-code/open-computer-use', 'mcp'],
    riskTier: 'high_risk',
    warning:
      "Gives the assistant full, unsandboxed control of this device's mouse, keyboard, and screen. It can see " +
      'everything on screen and act as if it were you. Requires macOS Accessibility and Screen Recording ' +
      'permissions (or the equivalent on other OSes) to function. Only enable this if you fully trust every model ' +
      'you route chats through and are running it in an isolated environment with no sensitive logins.',
  },
];

/** Re-checked server-side by `McpServerConfigService.create()` — the UI gate is not the enforcement. */
export const HIGH_RISK_CATALOG_SLUGS: ReadonlySet<string> = new Set(HIGH_RISK_CATALOG.map((entry) => entry.slug));

export function getMcpSuggestedCatalog(): { normal: McpCatalogEntry[]; highRisk: McpCatalogEntry[] } {
  return { normal: NORMAL_CATALOG, highRisk: HIGH_RISK_CATALOG };
}
