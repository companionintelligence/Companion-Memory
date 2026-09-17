import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  IconButton,
  Input,
  Label,
  Select,
  Switch,
  Tabs,
  Textarea,
} from '@ci/shadcn';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Pencil,
  Plus,
  RefreshCw,
  Trash,
  X,
} from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { useAuth, useCurrentUser } from '@/hooks';

type McpTransport = 'stdio' | 'http';
type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
type AuthType = 'none' | 'bearer' | 'basic' | 'api_key';

interface McpTool {
  name: string;
  description: string;
}

/**
 * Per-tool approval state, computed server-side (`buildToolApprovals`). The sha256 digest is
 * deliberately NOT recomputed here — a second canonicalisation implementation in the browser would
 * silently disagree with the backend's on key order and turn every reconnect into false drift.
 */
type McpToolApprovalState = 'approved' | 'new' | 'schema_changed' | 'unavailable' | 'legacy';

interface McpToolApproval {
  name: string;
  schemaDigest: string | null;
  state: McpToolApprovalState;
  approvedAt: string | null;
  approvedDigest: string | null;
}

/** States that mean the tool is NOT currently reachable by chat and wants a human decision. */
const PENDING_APPROVAL_STATES = new Set<McpToolApprovalState>(['new', 'schema_changed']);

function approvalBadge(state: McpToolApprovalState) {
  switch (state) {
    case 'approved':
      return (
        <Badge variant="outline" className="text-[10px] text-green-700 dark:text-green-400">
          Approved
        </Badge>
      );
    case 'new':
      return (
        <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-400">
          New — not approved
        </Badge>
      );
    case 'schema_changed':
      return (
        <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-400">
          Schema changed
        </Badge>
      );
    case 'unavailable':
      return (
        <Badge variant="outline" className="text-[10px] text-muted-foreground">
          No longer offered
        </Badge>
      );
    case 'legacy':
    default:
      return (
        <Badge variant="outline" className="text-[10px] text-muted-foreground">
          Approve to pin
        </Badge>
      );
  }
}

interface McpEnvVar {
  key: string;
  label?: string;
  secret?: boolean;
  isSet?: boolean;
  value?: string | null;
}

interface McpAuthRead {
  type: AuthType;
  /**
   * Named field entries, same shape as {@link McpEnvVar} — the server has no fixed "username"/
   * "password" columns, just a generic list keyed by conventional names per `type`
   * (`token` for bearer; `username`+`password` for basic; `headerName`+`value` for api_key).
   */
  fields?: McpEnvVar[];
}

interface McpServerConfig {
  id: string;
  name: string;
  slug: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: McpEnvVar[];
  url?: string;
  auth?: McpAuthRead;
  enabled: boolean;
  source: 'user_added' | 'catalog';
  catalogSlug?: string;
  discoveredTools?: McpTool[];
  /**
   * Union of what the server currently offers and what was previously approved. Only `approved`
   * (and, on a pre-gate row, `legacy`) tools are visible to the assistant — see McpToolProvider.
   */
  toolApprovals?: McpToolApproval[];
  connectionStatus: McpConnectionStatus;
  lastConnectedAt?: string;
  lastError?: string;
}

interface CatalogEnvSpec {
  key: string;
  label?: string;
  hint?: string;
  required?: boolean;
  secret?: boolean;
}

interface CatalogEntry {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: CatalogEnvSpec[];
  auth?: { type: AuthType };
  requires?: { hostSoftware?: string[] };
  warning?: string;
}

interface McpCatalogResponse {
  normal: CatalogEntry[];
  highRisk: CatalogEntry[];
}

interface TestConnectionResult {
  ok: boolean;
  tools?: McpTool[];
  error?: string;
}

/** One row in the Add/Edit dialog's environment-variable editor. */
interface EnvRowDraft {
  key: string;
  label?: string;
  secret: boolean;
  /** True when the server already stores a value for this key (edit mode only). */
  isSet: boolean;
  /** New value to send. Ignored (omitted from the payload) when `secret && isSet && !editingSecret`. */
  value: string;
  /** User clicked "Change" on an already-set secret row, so its masked placeholder gave way to an editable field. */
  editingSecret: boolean;
}

/** The Add/Edit dialog's authentication sub-form, for `transport: 'http'`. */
interface AuthDraft {
  type: AuthType;
  isSet: boolean;
  editingSecret: boolean;
  value: string;
  username: string;
  password: string;
  /** `api_key` only — the HTTP header name the key value is sent under. Never secret itself. */
  headerName: string;
}

interface FormState {
  name: string;
  transport: McpTransport;
  command: string;
  /** One argument per line; split/joined at the payload boundary. */
  argsText: string;
  env: EnvRowDraft[];
  url: string;
  auth: AuthDraft;
  enabled: boolean;
  catalogSlug?: string;
}

function emptyAuth(): AuthDraft {
  return {
    type: 'none',
    isSet: false,
    editingSecret: false,
    value: '',
    username: '',
    password: '',
    headerName: '',
  };
}

/** Read one named field's value out of an `auth.fields`/`env`-shaped array, or '' if absent. */
function fieldValue(fields: McpEnvVar[] | undefined, key: string): string {
  return fields?.find((f) => f.key === key)?.value ?? '';
}

/** True when the given named field is stored server-side as a secret the client can't read back. */
function fieldIsSet(fields: McpEnvVar[] | undefined, key: string): boolean {
  return !!fields?.find((f) => f.key === key)?.isSet;
}

function authDraftFromRead(auth: McpAuthRead | undefined): AuthDraft {
  if (!auth) {
    return emptyAuth();
  }

  const { fields } = auth;

  return {
    type: auth.type,
    // Only the SECRET half of an auth block ever gets masked server-side — basic's username and
    // api_key's header name are plain values the read response returns outright, so "isSet" only
    // needs to track whichever field actually carries the secret.
    isSet:
      auth.type === 'bearer'
        ? fieldIsSet(fields, 'token')
        : auth.type === 'basic'
          ? fieldIsSet(fields, 'password')
          : auth.type === 'api_key'
            ? fieldIsSet(fields, 'value')
            : false,
    editingSecret: false,
    value: fieldValue(fields, 'token') || fieldValue(fields, 'value'),
    username: fieldValue(fields, 'username'),
    password: fieldValue(fields, 'password'),
    headerName: fieldValue(fields, 'headerName'),
  };
}

function emptyForm(): FormState {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    argsText: '',
    env: [],
    url: '',
    auth: emptyAuth(),
    enabled: true,
    catalogSlug: undefined,
  };
}

function formFromServer(server: McpServerConfig): FormState {
  return {
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    argsText: (server.args ?? []).join('\n'),
    env: (server.env ?? []).map((e) => ({
      key: e.key,
      label: e.label,
      secret: !!e.secret,
      isSet: !!e.isSet,
      value: '',
      editingSecret: false,
    })),
    url: server.url ?? '',
    auth: authDraftFromRead(server.auth),
    enabled: server.enabled,
    catalogSlug: server.catalogSlug,
  };
}

// Prefilled from the catalog entry's schema with every value left empty — the user still has to
// supply their own command args (rare) and, especially, any secrets the entry declares.
function formFromCatalogEntry(entry: CatalogEntry): FormState {
  return {
    name: entry.name,
    transport: entry.transport,
    command: entry.command ?? '',
    argsText: (entry.args ?? []).join('\n'),
    env: (entry.env ?? []).map((e) => ({
      key: e.key,
      label: e.label,
      secret: !!e.secret,
      isSet: false,
      value: '',
      editingSecret: false,
    })),
    url: entry.url ?? '',
    auth: entry.auth ? { ...emptyAuth(), type: entry.auth.type } : emptyAuth(),
    enabled: true,
    catalogSlug: entry.slug,
  };
}

/**
 * A row's value is only included when there is something new to send: plain values always are,
 * but a secret already stored server-side (`isSet`) keeps its value unless the user explicitly
 * clicked "Change" — mirroring the "omit to keep existing" convention the BlueBubbles password
 * field and the API key dialogs already use.
 */
function buildEnvPayload(rows: EnvRowDraft[]): Array<Record<string, unknown>> {
  return rows
    .filter((row) => row.key.trim().length > 0)
    .map((row) => {
      const entry: Record<string, unknown> = { key: row.key.trim(), secret: row.secret };

      if (row.label) {
        entry.label = row.label;
      }

      const keepExisting = row.secret && row.isSet && !row.editingSecret;

      // `value` is a required (nullable) key on the wire, never an omittable one — the server
      // reads an explicit `null` as "keep the encrypted value already stored" (see
      // McpSecretCodec.mergeEntriesForUpdate), and a zod-required key with no default rejects a
      // request body that leaves it out entirely.
      entry.value = keepExisting ? null : row.value;

      return entry;
    });
}

/**
 * `auth.fields` uses the conventional per-type key names `McpClientManagerService.buildAuthHeaders`
 * reads on the server: `token` (bearer); `username`/`password` (basic); `headerName`/`value`
 * (api_key, where `headerName` is the plain HTTP header name and `value` is the actual secret).
 * `none` has no fields at all — sent as `auth: null`, not `{type:'none'}`, since 'none' is not a
 * member of the server's `auth.type` enum.
 */
function buildAuthPayload(auth: AuthDraft): Record<string, unknown> | null {
  if (auth.type === 'none') {
    return null;
  }

  const keepExisting = auth.isSet && !auth.editingSecret;
  const field = (key: string, value: string, secret: boolean) => ({
    key,
    secret,
    value: secret && keepExisting ? null : value,
  });

  if (auth.type === 'basic') {
    return {
      type: 'basic',
      fields: [field('username', auth.username, false), field('password', auth.password, true)],
    };
  }

  if (auth.type === 'api_key') {
    return {
      type: 'api_key',
      fields: [field('headerName', auth.headerName, false), field('value', auth.value, true)],
    };
  }

  return { type: 'bearer', fields: [field('token', auth.value, true)] };
}

function buildServerPayload(
  form: FormState,
  options: { includeCatalogSlug: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    transport: form.transport,
    enabled: form.enabled,
  };

  if (form.transport === 'stdio') {
    body.command = form.command.trim();
    const args = form.argsText
      .split('\n')
      .map((arg) => arg.trim())
      .filter(Boolean);

    if (args.length > 0) {
      body.args = args;
    }

    const env = buildEnvPayload(form.env);

    if (env.length > 0) {
      body.env = env;
    }
  } else {
    body.url = form.url.trim();
    body.auth = buildAuthPayload(form.auth);
  }

  if (options.includeCatalogSlug && form.catalogSlug) {
    body.catalogSlug = form.catalogSlug;
  }

  return body;
}

function connectionIcon(status: McpConnectionStatus) {
  switch (status) {
    case 'connected':
      return <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500 flex-shrink-0" />;
    case 'connecting':
      return <RefreshCw className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-500 flex-shrink-0" />;
    case 'error':
      return <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-500 flex-shrink-0" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
  }
}

function connectionLabel(status: McpConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'error':
      return 'Error';
    default:
      return 'Disconnected';
  }
}

function formatDateTime(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

interface EnvRowsEditorProps {
  rows: EnvRowDraft[];
  onChange: (rows: EnvRowDraft[]) => void;
}

/** Repeatable key/value/secret rows, shared by the Add/Edit dialog's stdio environment section. */
function EnvRowsEditor({ rows, onChange }: EnvRowsEditorProps) {
  const updateRow = (index: number, patch: Partial<EnvRowDraft>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const removeRow = (index: number) => {
    onChange(rows.filter((_, i) => i !== index));
  };

  const addRow = () => {
    onChange([...rows, { key: '', secret: false, isSet: false, value: '', editingSecret: false }]);
  };

  return (
    <div className="space-y-3">
      {rows.map((row, index) => {
        const showMasked = row.secret && row.isSet && !row.editingSecret;

        return (
          <div key={index} className="flex items-start gap-2 rounded-md border p-3">
            <div className="grid flex-1 gap-2">
              <Input
                placeholder="KEY"
                value={row.key}
                onChange={(e) => updateRow(index, { key: e.target.value })}
                className="font-mono text-sm"
              />
              {showMasked ? (
                <div className="flex items-center gap-2">
                  <Input disabled value="•••••••• (saved)" className="flex-1" />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => updateRow(index, { editingSecret: true })}
                  >
                    Change
                  </Button>
                </div>
              ) : (
                <Input
                  type={row.secret ? 'password' : 'text'}
                  placeholder="value"
                  value={row.value}
                  onChange={(e) => updateRow(index, { value: e.target.value })}
                />
              )}
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`mcp-env-secret-${index}`}
                  checked={row.secret}
                  onCheckedChange={(checked) => updateRow(index, { secret: checked === true })}
                />
                <Label
                  htmlFor={`mcp-env-secret-${index}`}
                  className="cursor-pointer text-xs font-normal text-muted-foreground"
                >
                  Secret
                </Label>
              </div>
            </div>
            <IconButton
              variant="ghost"
              size="icon-sm"
              label="Remove variable"
              className="text-red-600 hover:text-red-700"
              onClick={() => removeRow(index)}
            >
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <Plus className="h-4 w-4 mr-1" />
        Add variable
      </Button>
    </div>
  );
}

interface AuthFieldsEditorProps {
  auth: AuthDraft;
  onChange: (auth: AuthDraft) => void;
}

/** Auth-type selector plus its corresponding masked value field(s), for `transport: 'http'`. */
function AuthFieldsEditor({ auth, onChange }: AuthFieldsEditorProps) {
  const showMasked = auth.isSet && !auth.editingSecret && auth.type !== 'none';

  return (
    <div className="space-y-3">
      <div className="grid gap-2">
        <Label htmlFor="mcp-auth-type">Authentication</Label>
        <Select
          value={auth.type}
          onValueChange={(value) =>
            // Changing type invalidates any "already saved" masking from the previous type —
            // there is nothing stored for a type the server never had a value for.
            onChange({ ...emptyAuth(), type: value as AuthType })
          }
        >
          <Select.Trigger id="mcp-auth-type" className="w-full">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="none">None</Select.Item>
            <Select.Item value="bearer">Bearer token</Select.Item>
            <Select.Item value="basic">Basic (username / password)</Select.Item>
            <Select.Item value="api_key">API key</Select.Item>
          </Select.Content>
        </Select>
      </div>

      {auth.type === 'basic' &&
        (showMasked ? (
          <div className="flex items-center gap-2">
            <Input disabled value="•••••••• (saved)" className="flex-1" />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange({ ...auth, editingSecret: true })}
            >
              Change
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-auth-username">Username</Label>
              <Input
                id="mcp-auth-username"
                value={auth.username}
                onChange={(e) => onChange({ ...auth, username: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-auth-password">Password</Label>
              <Input
                id="mcp-auth-password"
                type="password"
                value={auth.password}
                onChange={(e) => onChange({ ...auth, password: e.target.value })}
              />
            </div>
          </div>
        ))}

      {auth.type === 'api_key' && (
        <div className="grid gap-1.5">
          <Label htmlFor="mcp-auth-header-name">Header name</Label>
          <Input
            id="mcp-auth-header-name"
            placeholder="X-API-Key"
            value={auth.headerName}
            onChange={(e) => onChange({ ...auth, headerName: e.target.value })}
          />
        </div>
      )}

      {(auth.type === 'bearer' || auth.type === 'api_key') &&
        (showMasked ? (
          <div className="flex items-center gap-2">
            <Input disabled value="•••••••• (saved)" className="flex-1" />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange({ ...auth, editingSecret: true })}
            >
              Change
            </Button>
          </div>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-auth-value">{auth.type === 'bearer' ? 'Bearer token' : 'API key'}</Label>
            <Input
              id="mcp-auth-value"
              type="password"
              value={auth.value}
              onChange={(e) => onChange({ ...auth, value: e.target.value })}
            />
          </div>
        ))}
    </div>
  );
}

/**
 * List + CRUD for configured MCP servers (same REST pattern as ApiKeysSection), plus a "Browse
 * suggested MCPs" tab backed by the catalog endpoint. High-risk catalog entries never reach the
 * generic Add dialog — they route through their own confirmation dialog, which is the only path
 * that can send `acknowledgedHighRisk: true`.
 */
export function McpSection() {
  const { t } = useTranslation();
  const [{ authToken }] = useAuth();

  /**
   * Every route that CHANGES a server config is admin-gated server-side (`AdminOnlyGuard` on
   * create, update, delete, enable, disable, approve-tools and both test-connection routes);
   * only `GET servers` and `GET catalog` are not. Without this the page rendered all of it to
   * everyone and each 403 surfaced as a generic "Failed to …", so a non-owner met a dead button
   * with no explanation.
   *
   * Presentation only — the guard is still the boundary. Defaults to false, so the controls stay
   * disabled while `me` is in flight rather than flickering live and then dead; a request fired
   * in that window would 403 anyway.
   */
  const { user } = useCurrentUser();
  const canManageServers = user?.isAdmin ?? false;

  const [activeTab, setActiveTab] = useState<'servers' | 'catalog'>('servers');

  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<McpCatalogResponse>({ normal: [], highRisk: [] });
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // Add/Edit dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<'create' | 'edit'>('create');
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [dialogSaving, setDialogSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogTesting, setDialogTesting] = useState(false);
  const [dialogTestResult, setDialogTestResult] = useState<TestConnectionResult | null>(null);

  // Delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<McpServerConfig | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // High-risk confirmation dialog
  const [highRiskEntry, setHighRiskEntry] = useState<CatalogEntry | null>(null);
  const [highRiskAck, setHighRiskAck] = useState(false);
  const [highRiskEnv, setHighRiskEnv] = useState<Record<string, string>>({});
  const [highRiskAuthValue, setHighRiskAuthValue] = useState('');
  const [highRiskAuthUsername, setHighRiskAuthUsername] = useState('');
  const [highRiskAuthPassword, setHighRiskAuthPassword] = useState('');
  const [highRiskSaving, setHighRiskSaving] = useState(false);
  const [highRiskError, setHighRiskError] = useState<string | null>(null);

  const headers = useCallback(
    () => ({
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    }),
    [authToken],
  );

  const fetchServers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchJson<McpServerConfig[]>('/api/mcp/servers', { headers: headers() });
      setServers(data ?? []);
    } catch {
      setError('Failed to load MCP servers');
    } finally {
      setLoading(false);
    }
  }, [headers]);

  const fetchCatalog = useCallback(async () => {
    try {
      setCatalogLoading(true);
      setCatalogError(null);
      const data = await fetchJson<McpCatalogResponse>('/api/mcp/catalog', { headers: headers() });
      setCatalog(data ?? { normal: [], highRisk: [] });
    } catch {
      setCatalogError('Failed to load the suggested MCP catalog');
    } finally {
      setCatalogLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  const toggleToolsExpanded = (id: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  };

  const handleToggleEnabled = async (server: McpServerConfig) => {
    try {
      setTogglingId(server.id);
      const endpoint = `/api/mcp/servers/${server.id}/${server.enabled ? 'disable' : 'enable'}`;
      const updated = await fetchJson<McpServerConfig>(endpoint, { method: 'POST', headers: headers() });

      if (updated) {
        setServers((prev) => prev.map((s) => (s.id === server.id ? updated : s)));
      }
    } catch {
      setError(`Failed to ${server.enabled ? 'disable' : 'enable'} “${server.name}”`);
    } finally {
      setTogglingId(null);
    }
  };

  /**
   * Approving is the grant — adding the server never was. `tools[]` carries back the exact digest
   * this list was rendered from, and the server rejects it if the schema moved in between, so a
   * tool cannot be approved on the strength of a description the user is no longer looking at.
   *
   * `approveAll` is the one-click path for a legitimately-updated upstream server. Without it a
   * strict pin is the kind of thing people switch off wholesale after the second false alarm.
   */
  const handleApproveTools = async (
    server: McpServerConfig,
    body: { approveAll: true } | { tools: Array<{ name: string; schemaDigest: string }> },
  ) => {
    try {
      setApprovingId(server.id);
      setError(null);
      const updated = await fetchJson<McpServerConfig>(`/api/mcp/servers/${server.id}/approve-tools`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });

      if (updated) {
        setServers((prev) => prev.map((s) => (s.id === server.id ? updated : s)));
      }
    } catch {
      setError(`Failed to approve tools for “${server.name}”`);
    } finally {
      setApprovingId(null);
    }
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingServerId(null);
    setDialogTestResult(null);
    setDialogError(null);
  };

  const openCreate = () => {
    setForm(emptyForm());
    setDialogMode('create');
    setEditingServerId(null);
    setDialogTestResult(null);
    setDialogError(null);
    setDialogOpen(true);
  };

  const openEdit = (server: McpServerConfig) => {
    setForm(formFromServer(server));
    setDialogMode('edit');
    setEditingServerId(server.id);
    setDialogTestResult(null);
    setDialogError(null);
    setDialogOpen(true);
  };

  const openCreateFromCatalog = (entry: CatalogEntry) => {
    setForm(formFromCatalogEntry(entry));
    setDialogMode('create');
    setEditingServerId(null);
    setDialogTestResult(null);
    setDialogError(null);
    setDialogOpen(true);
  };

  const handleDialogTestConnection = async () => {
    try {
      setDialogTesting(true);
      setDialogTestResult(null);

      const result = editingServerId
        ? await fetchJson<TestConnectionResult>(`/api/mcp/servers/${editingServerId}/test-connection`, {
            method: 'POST',
            headers: headers(),
          })
        : await fetchJson<TestConnectionResult>('/api/mcp/test-connection', {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(buildServerPayload(form, { includeCatalogSlug: false })),
          });

      setDialogTestResult(result ?? { ok: false, error: 'No response from server' });
    } catch (err) {
      setDialogTestResult({
        ok: false,
        error: err instanceof Error ? err.message : 'Test connection failed',
      });
    } finally {
      setDialogTesting(false);
    }
  };

  const handleDialogSave = async () => {
    if (!form.name.trim()) {
      setDialogError('Name is required.');

      return;
    }

    if (form.transport === 'stdio' && !form.command.trim()) {
      setDialogError('Command is required for a stdio server.');

      return;
    }

    if (form.transport === 'http' && !form.url.trim()) {
      setDialogError('URL is required for an HTTP server.');

      return;
    }

    try {
      setDialogSaving(true);
      setDialogError(null);

      const body = buildServerPayload(form, { includeCatalogSlug: dialogMode === 'create' });

      if (dialogMode === 'create') {
        const created = await fetchJson<McpServerConfig>('/api/mcp/servers', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(body),
        });

        if (created) {
          setServers((prev) => [...prev, created]);
        }
      } else if (editingServerId) {
        const updated = await fetchJson<McpServerConfig>(`/api/mcp/servers/${editingServerId}`, {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify(body),
        });

        if (updated) {
          setServers((prev) => prev.map((s) => (s.id === editingServerId ? updated : s)));
        }
      }

      closeDialog();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'Failed to save the server');
    } finally {
      setDialogSaving(false);
    }
  };

  const openDelete = (server: McpServerConfig) => {
    setDeleteTarget(server);
    setDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) {
      return;
    }

    try {
      setDeleteLoading(true);
      await fetchJson(`/api/mcp/servers/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: headers(),
      });
      setServers((prev) => prev.filter((s) => s.id !== deleteTarget.id));
      setDeleteOpen(false);
      setDeleteTarget(null);
    } catch {
      setError(`Failed to delete “${deleteTarget.name}”`);
    } finally {
      setDeleteLoading(false);
    }
  };

  // High-risk flow: no direct "Add" from the catalog card. "Learn more" opens this dialog, which
  // is the only place `acknowledgedHighRisk: true` is ever sent.
  const openHighRisk = (entry: CatalogEntry) => {
    setHighRiskEntry(entry);
    setHighRiskAck(false);
    const initialEnv: Record<string, string> = {};
    (entry.env ?? []).forEach((e) => {
      initialEnv[e.key] = '';
    });
    setHighRiskEnv(initialEnv);
    setHighRiskAuthValue('');
    setHighRiskAuthUsername('');
    setHighRiskAuthPassword('');
    setHighRiskError(null);
  };

  const closeHighRisk = () => {
    setHighRiskEntry(null);
  };

  const highRiskCommandLine = highRiskEntry
    ? highRiskEntry.transport === 'stdio'
      ? [highRiskEntry.command, ...(highRiskEntry.args ?? [])].filter(Boolean).join(' ')
      : (highRiskEntry.url ?? '')
    : '';

  const highRiskMissingRequired = highRiskEntry
    ? (highRiskEntry.env ?? []).some((e) => e.required && !highRiskEnv[e.key]?.trim())
    : false;

  const handleHighRiskAdd = async () => {
    if (!highRiskEntry || !highRiskAck || highRiskMissingRequired) {
      return;
    }

    try {
      setHighRiskSaving(true);
      setHighRiskError(null);

      const body: Record<string, unknown> = {
        name: highRiskEntry.name,
        transport: highRiskEntry.transport,
        enabled: true,
        catalogSlug: highRiskEntry.slug,
        // The one and only place this ever gets sent — reaching this call requires the checkbox
        // above to have been checked, which the disabled state on the Add button enforces.
        acknowledgedHighRisk: true,
      };

      if (highRiskEntry.transport === 'stdio') {
        body.command = highRiskEntry.command;

        if (highRiskEntry.args && highRiskEntry.args.length > 0) {
          body.args = highRiskEntry.args;
        }

        if (highRiskEntry.env && highRiskEntry.env.length > 0) {
          body.env = highRiskEntry.env.map((e) => ({
            key: e.key,
            ...(e.label ? { label: e.label } : {}),
            secret: !!e.secret,
            value: highRiskEnv[e.key] ?? '',
          }));
        }
      } else {
        body.url = highRiskEntry.url;

        if (highRiskEntry.auth && highRiskEntry.auth.type !== 'none') {
          body.auth =
            highRiskEntry.auth.type === 'basic'
              ? { type: 'basic', username: highRiskAuthUsername, password: highRiskAuthPassword }
              : { type: highRiskEntry.auth.type, value: highRiskAuthValue };
        } else {
          body.auth = { type: 'none' };
        }
      }

      const created = await fetchJson<McpServerConfig>('/api/mcp/servers', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });

      if (created) {
        setServers((prev) => [...prev, created]);
      }

      closeHighRisk();
      setActiveTab('servers');
    } catch (err) {
      setHighRiskError(err instanceof Error ? err.message : 'Failed to add the server');
    } finally {
      setHighRiskSaving(false);
    }
  };

  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">MCP Servers</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Connect Model Context Protocol servers to give the assistant more tools.
        </p>
      </div>

      {user != null && !canManageServers && (
        <div className="mb-4 flex items-start gap-2 rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Only the appliance owner can add or change MCP servers. You can see what is configured here, but
            the controls are disabled.
          </p>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'servers' | 'catalog')}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <Tabs.List>
            <Tabs.Trigger value="servers">Configured</Tabs.Trigger>
            <Tabs.Trigger value="catalog">Browse suggested MCPs</Tabs.Trigger>
          </Tabs.List>
          {activeTab === 'servers' && (
            <IconButton
              variant="outline"
              label={t('SETTINGS_MCP_CREATE')}
              onClick={openCreate}
              disabled={!canManageServers}
            >
              <Plus className="h-4 w-4" />
            </IconButton>
          )}
        </div>

        <Tabs.Content value="servers">
          {error && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              Loading…
            </div>
          ) : servers.length === 0 ? (
            <Card>
              <Card.Content className="flex flex-col items-center justify-center py-12 text-center">
                <p className="text-sm text-muted-foreground">No MCP servers configured yet.</p>
              </Card.Content>
            </Card>
          ) : (
            <div className="space-y-3">
              {servers.map((server) => {
                const expanded = expandedTools.has(server.id);
                const toolCount = server.discoveredTools?.length;
                const approvals = server.toolApprovals ?? [];
                const descriptionOf = new Map(
                  (server.discoveredTools ?? []).map((tool) => [tool.name, tool.description]),
                );
                const pending = approvals.filter((entry) => PENDING_APPROVAL_STATES.has(entry.state));

                return (
                  <Card key={server.id}>
                    <Card.Content className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium truncate">{server.name}</span>
                            <Badge variant="outline" className="text-xs uppercase">
                              {server.transport}
                            </Badge>
                            {server.source === 'catalog' && (
                              <Badge variant="outline" className="text-xs">
                                From catalog
                              </Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1.5">
                              {connectionIcon(server.connectionStatus)}
                              {connectionLabel(server.connectionStatus)}
                            </span>
                            {server.lastConnectedAt && (
                              <span>Last connected {formatDateTime(server.lastConnectedAt)}</span>
                            )}
                          </div>
                          {server.lastError && (
                            <p className="text-xs text-red-600 dark:text-red-400">{server.lastError}</p>
                          )}
                          {toolCount != null && (
                            <div>
                              <button
                                type="button"
                                onClick={() => toggleToolsExpanded(server.id)}
                                className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium text-foreground hover:bg-accent cursor-pointer"
                              >
                                {expanded ? (
                                  <ChevronDown className="h-3 w-3" />
                                ) : (
                                  <ChevronRight className="h-3 w-3" />
                                )}
                                {toolCount} {toolCount === 1 ? 'tool' : 'tools'}
                              </button>
                              {pending.length > 0 && (
                                <span className="ml-2 inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-400">
                                  <AlertTriangle className="h-3 w-3" />
                                  {pending.length} awaiting approval
                                </span>
                              )}
                              {expanded && approvals.length > 0 && (
                                <div className="mt-2 space-y-2 rounded-md border bg-muted/40 p-3">
                                  {pending.length > 0 && (
                                    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                                      <p className="text-xs text-muted-foreground">
                                        Tools awaiting approval are not available to the assistant.
                                      </p>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={approvingId === server.id || !canManageServers}
                                        onClick={() => void handleApproveTools(server, { approveAll: true })}
                                      >
                                        Approve all changes
                                      </Button>
                                    </div>
                                  )}
                                  <ul className="space-y-1.5">
                                    {approvals.map((approval) => (
                                      <li
                                        key={approval.name}
                                        className="flex items-start justify-between gap-2 text-xs"
                                      >
                                        <span className="min-w-0">
                                          <span className="font-mono font-medium">{approval.name}</span>{' '}
                                          {approvalBadge(approval.state)}
                                          <span className="block text-muted-foreground">
                                            {descriptionOf.get(approval.name) ??
                                              'This tool is no longer offered by the server.'}
                                          </span>
                                        </span>
                                        {approval.schemaDigest && approval.state !== 'approved' && (
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            className="shrink-0"
                                            disabled={approvingId === server.id || !canManageServers}
                                            onClick={() =>
                                              void handleApproveTools(server, {
                                                tools: [
                                                  {
                                                    name: approval.name,
                                                    schemaDigest: approval.schemaDigest!,
                                                  },
                                                ],
                                              })
                                            }
                                          >
                                            Approve
                                          </Button>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Switch
                            checked={server.enabled}
                            onCheckedChange={() => void handleToggleEnabled(server)}
                            disabled={togglingId === server.id || !canManageServers}
                          />
                          <IconButton
                            variant="ghost"
                            className="h-8 w-8"
                            onClick={() => openEdit(server)}
                            disabled={!canManageServers}
                            label={t('SETTINGS_MCP_EDIT_SERVER', { name: server.name })}
                          >
                            <Pencil className="h-4 w-4" />
                          </IconButton>
                          <IconButton
                            variant="ghost"
                            className="h-8 w-8 text-red-600 hover:text-red-700"
                            onClick={() => openDelete(server)}
                            disabled={!canManageServers}
                            label={t('SETTINGS_MCP_DELETE_SERVER', { name: server.name })}
                          >
                            <Trash className="h-4 w-4" />
                          </IconButton>
                        </div>
                      </div>
                    </Card.Content>
                  </Card>
                );
              })}
            </div>
          )}
        </Tabs.Content>

        <Tabs.Content value="catalog">
          {catalogError && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
              {catalogError}
            </div>
          )}

          {catalogLoading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              Loading…
            </div>
          ) : (
            <div className="space-y-6">
              <div className="space-y-3">
                {catalog.normal.length === 0 && (
                  <p className="text-sm text-muted-foreground">No suggested servers yet.</p>
                )}
                {catalog.normal.map((entry) => (
                  <Card key={entry.slug}>
                    <Card.Content className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <h4 className="font-medium">{entry.name}</h4>
                          <p className="text-sm text-muted-foreground">{entry.description}</p>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => openCreateFromCatalog(entry)}
                          disabled={!canManageServers}
                        >
                          <Plus className="h-4 w-4 mr-1" />
                          Add
                        </Button>
                      </div>
                      {entry.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {entry.tags.map((tag) => (
                            <Badge key={tag} variant="outline" className="text-xs">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {entry.requires?.hostSoftware && entry.requires.hostSoftware.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Requires: {entry.requires.hostSoftware.join(', ')}
                        </p>
                      )}
                    </Card.Content>
                  </Card>
                ))}
              </div>

              {catalog.highRisk.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">
                    Advanced — full device access
                  </h3>
                  {catalog.highRisk.map((entry) => (
                    <Card
                      key={entry.slug}
                      className="border-red-300 bg-red-50/50 dark:border-red-800 dark:bg-red-950/20"
                    >
                      <Card.Content className="space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-start gap-2">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                            <div className="min-w-0 space-y-1">
                              <h4 className="font-medium">{entry.name}</h4>
                              <p className="text-sm text-muted-foreground">{entry.description}</p>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0 border-red-300 text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                            onClick={() => openHighRisk(entry)}
                          >
                            Learn more
                          </Button>
                        </div>
                        {entry.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {entry.tags.map((tag) => (
                              <Badge key={tag} variant="outline" className="text-xs">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </Card.Content>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}
        </Tabs.Content>
      </Tabs>

      {/* Add/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}>
        <Dialog.Content className="sm:max-w-[560px] max-h-[85vh] overflow-y-auto">
          <Dialog.Header>
            <Dialog.Title>{dialogMode === 'create' ? 'Add MCP Server' : 'Edit MCP Server'}</Dialog.Title>
            {form.catalogSlug && dialogMode === 'create' && (
              <Dialog.Description>
                From the suggested MCP catalog. Fill in any credentials it needs before adding.
              </Dialog.Description>
            )}
          </Dialog.Header>

          <div className="space-y-4 py-2">
            {dialogError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
                {dialogError}
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="mcp-transport">Transport</Label>
              <Select
                value={form.transport}
                onValueChange={(value) => setForm({ ...form, transport: value as McpTransport })}
              >
                <Select.Trigger id="mcp-transport" className="w-full">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="stdio">stdio (local command)</Select.Item>
                  <Select.Item value="http">HTTP</Select.Item>
                </Select.Content>
              </Select>
            </div>

            {form.transport === 'stdio' ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="mcp-command">Command</Label>
                  <Input
                    id="mcp-command"
                    placeholder="uvx some-mcp-server@latest"
                    value={form.command}
                    onChange={(e) => setForm({ ...form, command: e.target.value })}
                    className="font-mono text-sm"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="mcp-args">Arguments (one per line)</Label>
                  <Textarea
                    id="mcp-args"
                    rows={3}
                    value={form.argsText}
                    onChange={(e) => setForm({ ...form, argsText: e.target.value })}
                    className="font-mono text-sm"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Environment variables</Label>
                  <EnvRowsEditor rows={form.env} onChange={(env) => setForm({ ...form, env })} />
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="mcp-url">URL</Label>
                  <Input
                    id="mcp-url"
                    placeholder="https://example.com/mcp"
                    value={form.url}
                    onChange={(e) => setForm({ ...form, url: e.target.value })}
                  />
                </div>
                <AuthFieldsEditor auth={form.auth} onChange={(auth) => setForm({ ...form, auth })} />
              </>
            )}

            <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
              <Label htmlFor="mcp-enabled" className="font-medium">
                Enabled
              </Label>
              <Switch
                id="mcp-enabled"
                checked={form.enabled}
                onCheckedChange={(enabled) => setForm({ ...form, enabled })}
              />
            </div>

            <div className="space-y-3 border-t border-border pt-4">
              <Button
                type="button"
                variant="outline"
                disabled={dialogTesting || !canManageServers}
                onClick={() => void handleDialogTestConnection()}
              >
                {dialogTesting ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                    Testing…
                  </>
                ) : (
                  'Test connection'
                )}
              </Button>

              {dialogTestResult && (
                <div
                  className={`rounded-md border p-3 text-sm ${
                    dialogTestResult.ok
                      ? 'border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-300'
                      : 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
                  }`}
                >
                  {dialogTestResult.ok ? (
                    <>
                      <p className="font-medium">
                        Connected
                        {dialogTestResult.tools
                          ? ` — ${dialogTestResult.tools.length} tool${dialogTestResult.tools.length === 1 ? '' : 's'} found`
                          : ''}
                      </p>
                      {dialogTestResult.tools && dialogTestResult.tools.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {dialogTestResult.tools.map((tool) => (
                            <li key={tool.name} className="text-xs">
                              <span className="font-mono font-medium">{tool.name}</span>
                              <span className="text-muted-foreground"> — {tool.description}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <p>{dialogTestResult.error ?? 'Test connection failed'}</p>
                  )}
                </div>
              )}
            </div>
          </div>

          <Dialog.Footer>
            <Button variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleDialogSave()}
              disabled={dialogSaving || !form.name.trim() || !canManageServers}
            >
              {dialogSaving ? 'Saving…' : dialogMode === 'create' ? 'Add' : 'Save'}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>

      {/* Delete confirmation dialog — mirrors ApiKeysSection's. */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Delete MCP Server</Dialog.Title>
            <Dialog.Description>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? Any agent relying on its
              tools will lose access. This action cannot be undone.
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Footer>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deleteLoading || !canManageServers}
            >
              {deleteLoading ? 'Deleting…' : 'Delete'}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>

      {/* High-risk catalog confirmation — the only path that can send acknowledgedHighRisk: true. */}
      <Dialog open={highRiskEntry != null} onOpenChange={(open) => !open && closeHighRisk()}>
        <Dialog.Content className="sm:max-w-[520px] max-h-[85vh] overflow-y-auto">
          <Dialog.Header>
            <Dialog.Title className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
              {highRiskEntry?.name}
            </Dialog.Title>
            <Dialog.Description>{highRiskEntry?.description}</Dialog.Description>
          </Dialog.Header>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>This will run</Label>
              <pre className="overflow-x-auto rounded-md border bg-muted p-3 font-mono text-sm">
                {highRiskCommandLine}
              </pre>
            </div>

            {highRiskEntry?.warning && (
              <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2.5 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{highRiskEntry.warning}</span>
              </div>
            )}

            {highRiskEntry?.env && highRiskEntry.env.length > 0 && (
              <div className="space-y-3">
                <Label>Configuration</Label>
                {highRiskEntry.env.map((e) => (
                  <div key={e.key} className="grid gap-1.5">
                    <Label htmlFor={`hr-env-${e.key}`} className="text-xs font-normal text-muted-foreground">
                      {e.label ?? e.key}
                      {e.required ? ' *' : ''}
                    </Label>
                    <Input
                      id={`hr-env-${e.key}`}
                      type={e.secret ? 'password' : 'text'}
                      placeholder={e.hint}
                      value={highRiskEnv[e.key] ?? ''}
                      onChange={(ev) => setHighRiskEnv((prev) => ({ ...prev, [e.key]: ev.target.value }))}
                    />
                  </div>
                ))}
              </div>
            )}

            {highRiskEntry?.auth &&
              highRiskEntry.auth.type !== 'none' &&
              (highRiskEntry.auth.type === 'basic' ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="hr-auth-username" className="text-xs font-normal text-muted-foreground">
                      Username
                    </Label>
                    <Input
                      id="hr-auth-username"
                      value={highRiskAuthUsername}
                      onChange={(e) => setHighRiskAuthUsername(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="hr-auth-password" className="text-xs font-normal text-muted-foreground">
                      Password
                    </Label>
                    <Input
                      id="hr-auth-password"
                      type="password"
                      value={highRiskAuthPassword}
                      onChange={(e) => setHighRiskAuthPassword(e.target.value)}
                    />
                  </div>
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <Label htmlFor="hr-auth-value" className="text-xs font-normal text-muted-foreground">
                    {highRiskEntry.auth.type === 'bearer' ? 'Bearer token' : 'API key'}
                  </Label>
                  <Input
                    id="hr-auth-value"
                    type="password"
                    value={highRiskAuthValue}
                    onChange={(e) => setHighRiskAuthValue(e.target.value)}
                  />
                </div>
              ))}

            <div className="flex items-start gap-3 rounded-md border p-3">
              <Checkbox
                id="hr-ack"
                checked={highRiskAck}
                onCheckedChange={(c) => setHighRiskAck(c === true)}
              />
              <Label htmlFor="hr-ack" className="cursor-pointer text-sm font-normal leading-snug">
                I understand this server can act with broad, unsandboxed control of this device — as described
                above — and I want to add it anyway.
              </Label>
            </div>

            {highRiskError && <p className="text-sm text-destructive">{highRiskError}</p>}
          </div>

          <Dialog.Footer>
            <Button variant="outline" onClick={closeHighRisk}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!highRiskAck || highRiskMissingRequired || highRiskSaving || !canManageServers}
              onClick={() => void handleHighRiskAdd()}
            >
              {highRiskSaving ? 'Adding…' : 'Add'}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  );
}
