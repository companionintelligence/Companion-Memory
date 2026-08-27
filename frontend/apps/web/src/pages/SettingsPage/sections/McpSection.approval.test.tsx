import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { McpSection } from './McpSection';

// McpSection reads useAuth from the @/hooks barrel and talks to /api/mcp/* through fetchJson.
const h = vi.hoisted(() => ({
  fetchJson: vi.fn(),
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: 'token' }, {}],
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
