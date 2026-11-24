import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { McpSection } from './McpSection';

// McpSection reads useAuth and useCurrentUser from the @/hooks barrel and talks to /api/mcp/*
// through fetchJson.
const h = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  // Every config-changing route is admin-gated server-side, and the section disables its controls
  // to match, so these tests need an owner. `isAdmin: false` is exercised separately below.
  isAdmin: true,
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: 'token' }, {}],
  useCurrentUser: () => ({ user: { id: 'user-1', isAdmin: h.isAdmin }, loading: false }),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: h.fetchJson,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const server = {
  id: 'config-1',
  name: 'Files',
  slug: 'files',
  transport: 'stdio' as const,
  command: 'files-mcp',
  args: [],
  env: [],
  enabled: true,
  source: 'user_added' as const,
  connectionStatus: 'connected' as const,
  discoveredTools: [
    { name: 'read_file', description: 'Read a file' },
    { name: 'exfiltrate', description: 'Totally benign' },
  ],
  toolApprovals: [
    {
      name: 'read_file',
      schemaDigest: 'digest-read',
      state: 'approved' as const,
      approvedAt: '2026-08-26T00:00:00.000Z',
      approvedDigest: 'digest-read',
    },
    {
      name: 'exfiltrate',
      schemaDigest: 'digest-exfil',
      state: 'new' as const,
      approvedAt: null,
      approvedDigest: null,
    },
  ],
};

/** The parsed body of the approve-tools POST, or undefined if it was never sent. */
function approveBody(): Record<string, unknown> | undefined {
  const call = h.fetchJson.mock.calls.find(([url]) => url === '/api/mcp/servers/config-1/approve-tools');

  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

async function renderAndExpand() {
  render(<McpSection />);
  fireEvent.click(await screen.findByRole('button', { name: /2 tools/i }));
}

describe('McpSection tool approval', () => {
  beforeEach(() => {
    h.isAdmin = true;
    h.fetchJson.mockReset();
    h.fetchJson.mockImplementation((url: string) => {
      if (url === '/api/mcp/servers') {
        return Promise.resolve([server]);
      }

      if (url === '/api/mcp/catalog') {
        return Promise.resolve({ normal: [], highRisk: [] });
      }

      return Promise.resolve({ ...server, toolApprovals: [] });
    });
  });

  it('counts the tools awaiting approval on the collapsed row', async () => {
    render(<McpSection />);

    expect(await screen.findByText(/1 awaiting approval/i)).toBeInTheDocument();
  });

  it('marks an unapproved tool as new and an approved one as approved', async () => {
    await renderAndExpand();

    expect(await screen.findByText('New — not approved')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('sends the digest the row was rendered from, so the server can reject stale approvals', async () => {
    await renderAndExpand();

    fireEvent.click((await screen.findAllByRole('button', { name: /^approve$/i }))[0]!);

    await waitFor(() => expect(approveBody()).toBeDefined());
    expect(approveBody()).toStrictEqual({ tools: [{ name: 'exfiltrate', schemaDigest: 'digest-exfil' }] });
  });

  it('offers no Approve button for a tool that is already approved at its current digest', async () => {
    await renderAndExpand();

    // Only the drifted/new tool gets one; the approved one does not.
    expect(await screen.findAllByRole('button', { name: /^approve$/i })).toHaveLength(1);
  });

  it('offers a one-click approve-all so a legitimately updated server is not a dead end', async () => {
    await renderAndExpand();

    fireEvent.click(await screen.findByRole('button', { name: /approve all changes/i }));

    await waitFor(() => expect(approveBody()).toBeDefined());
    expect(approveBody()).toStrictEqual({ approveAll: true });
  });

  it('hides the approve-all affordance once nothing is pending', async () => {
    h.fetchJson.mockImplementation((url: string) => {
      if (url === '/api/mcp/servers') {
        return Promise.resolve([
          {
            ...server,
            toolApprovals: server.toolApprovals.map((entry) => ({ ...entry, state: 'approved' })),
          },
        ]);
      }

      return Promise.resolve({ normal: [], highRisk: [] });
    });

    await renderAndExpand();

    expect(await screen.findAllByText('Approved')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /approve all changes/i })).toBeNull();
    expect(screen.queryByText(/awaiting approval/i)).toBeNull();
  });
});

/**
 * A server can keep a tool's schema and change its description, which is the text the assistant
 * reads. The backend pins that prose too and reports `description_changed`; the tool is withheld
 * from chat until someone approves it again, so the row has to say so and offer the approval.
 */
describe('McpSection description drift', () => {
  const drifted = {
    ...server,
    discoveredTools: [
      { name: 'read_file', description: 'Read a file' },
      { name: 'exfiltrate', description: 'Now says something else' },
    ],
    toolApprovals: [
      server.toolApprovals[0],
      {
        name: 'exfiltrate',
        schemaDigest: 'digest-exfil',
        descriptionDigest: 'prose-now',
        state: 'description_changed' as const,
        approvedAt: '2026-08-26T00:00:00.000Z',
        approvedDigest: 'digest-exfil',
      },
    ],
  };

  beforeEach(() => {
    h.isAdmin = true;
    h.fetchJson.mockReset();
    h.fetchJson.mockImplementation((url: string) => {
      if (url === '/api/mcp/servers') {
        return Promise.resolve([drifted]);
      }

      if (url === '/api/mcp/catalog') {
        return Promise.resolve({ normal: [], highRisk: [] });
      }

      return Promise.resolve({ ...drifted, toolApprovals: [] });
    });
  });

  it('badges the tool and counts it as awaiting approval', async () => {
    render(<McpSection />);

    expect(await screen.findByText(/1 awaiting approval/i)).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /2 tools/i }));

    expect(await screen.findByText('Description changed')).toBeInTheDocument();
  });

  it('sends back the description digest the row was rendered from', async () => {
    await renderAndExpand();

    fireEvent.click((await screen.findAllByRole('button', { name: /^approve$/i }))[0]!);

    await waitFor(() => expect(approveBody()).toBeDefined());
    expect(approveBody()).toStrictEqual({
      tools: [{ name: 'exfiltrate', schemaDigest: 'digest-exfil', descriptionDigest: 'prose-now' }],
    });
  });
});

/**
 * ═══ WHY THE UI GATES AT ALL ═══
 *
 * Every route that CHANGES an MCP server config carries `AdminOnlyGuard` server-side — create,
 * update, delete, enable, disable, approve-tools and both test-connection routes; only
 * `GET servers` and `GET catalog` do not. The client had no notion of role, so it rendered all of
 * it to everyone and each 403 came back as a generic "Failed to …". A non-owner met a dead button
 * with no explanation, and on a fresh appliance — where nothing granted the admin role at all —
 * that was every user.
 *
 * These pin the presentation, not the boundary: the guard still refuses the request. What they
 * protect against is the section quietly drifting back to offering what the server will refuse.
 */
describe('McpSection admin gating', () => {
  beforeEach(() => {
    h.isAdmin = false;
    h.fetchJson.mockReset();
    h.fetchJson.mockImplementation((url: string) => {
      if (url === '/api/mcp/servers') {
        return Promise.resolve([server]);
      }

      if (url === '/api/mcp/catalog') {
        return Promise.resolve({ normal: [], highRisk: [] });
      }

      return Promise.resolve({ ...server, toolApprovals: [] });
    });
  });

  it('says why the controls are inert rather than leaving a non-owner to guess', async () => {
    render(<McpSection />);

    expect(await screen.findByText(/only the appliance owner can add or change/i)).toBeInTheDocument();
  });

  it('disables approval for a non-owner, the control the server would 403', async () => {
    await renderAndExpand();

    const approve = (await screen.findAllByRole('button', { name: /^approve$/i }))[0]!;

    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    expect(approveBody()).toBeUndefined();
  });

  it('disables approve-all for a non-owner', async () => {
    await renderAndExpand();

    expect(await screen.findByRole('button', { name: /approve all changes/i })).toBeDisabled();
  });

  it('still SHOWS what is configured — reading is not admin-gated', async () => {
    // `GET servers` carries no AdminOnlyGuard, so hiding the list would withhold something the
    // server is willing to serve. The gate is on changing, not on seeing.
    await renderAndExpand();

    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByText('exfiltrate')).toBeInTheDocument();
    expect(await screen.findByText(/1 awaiting approval/i)).toBeInTheDocument();
  });

  it('leaves an owner every control, so the gate is the role and not the page', async () => {
    h.isAdmin = true;

    await renderAndExpand();

    expect((await screen.findAllByRole('button', { name: /^approve$/i }))[0]!).toBeEnabled();
    expect(screen.getByRole('button', { name: /approve all changes/i })).toBeEnabled();
    expect(screen.queryByText(/only the appliance owner can add or change/i)).toBeNull();
  });
});
