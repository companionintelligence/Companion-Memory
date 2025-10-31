import { useEffect, useMemo, useState } from 'react';

import { Portal, fetchJson, usePageTitle } from '@ci/common';
import { Badge, Breadcrumb, Button, Card, Drawer, Input, Skeleton, Textarea } from '@ci/shadcn';

import { useGraphOverview } from '@/api/useGraphOverview';
import { ForceGraph } from '@/components/ForceGraph';
import { PageContent } from '@/components/layout';
import { useAuth } from '@/hooks';

import { useNodeDetails } from './use-node-details';

type GraphSummary = {
  nodeCount: number;
  linkCount: number;
  topTypes: Array<{ type: string; count: number }>;
};

type EditableProperty = {
  id: string;
  key: string;
  value: string;
};

export function KnowledgePage() {
  usePageTitle('Knowledge - Companion Intelligence');

  const [{ user, loading: authLoading, error: authError, authToken }] = useAuth();
  const {
    loading: graphLoading,
    error: graphError,
    subgraph,
    userEntityId,
    quickStats,
    currentUser,
  } = useGraphOverview(authToken);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [nodeRevision, setNodeRevision] = useState(0);
  const [nodeLimitInput, setNodeLimitInput] = useState('10');
  const [activeType, setActiveType] = useState<string>('ALL');
  const [editableName, setEditableName] = useState('');
  const [editableDescription, setEditableDescription] = useState('');
  const [editableProperties, setEditableProperties] = useState<EditableProperty[]>([]);
  const [savingNode, setSavingNode] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const {
    loading: nodeLoading,
    error: nodeError,
    data: nodeData,
  } = useNodeDetails(drawerOpen ? selectedNodeId : null, authToken, nodeRevision);
  const [relationshipFilter, setRelationshipFilter] = useState<string>('ALL');

  useEffect(() => {
    if (!nodeData) {
      setEditableName('');
      setEditableDescription('');
      setEditableProperties([]);
      setRelationshipFilter('ALL');
      setSaveError(null);
      setSaveSuccess(null);

      return;
    }

    setEditableName(nodeData.node.name ?? '');
    setEditableDescription(nodeData.node.description ?? '');
    setEditableProperties(
      Object.entries(nodeData.node.properties ?? {}).map(([key, value]) => ({
        id: `${key}-${Math.random().toString(36).slice(2, 8)}`,
        key,
        value: formatPropertyValue(value),
      })),
    );
    setRelationshipFilter('ALL');
    setSaveError(null);
    setSaveSuccess(null);
  }, [nodeData?.node.entityId]);

  useEffect(() => {
    setSaveSuccess(null);
  }, [editableName, editableDescription, editableProperties]);

  const handleNodeSelect = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setDrawerOpen(true);
  };

  const availableTypes = useMemo(() => {
    if (!subgraph) {
      return new Set<string>();
    }

    const types = new Set<string>();
    for (const node of subgraph.nodes) {
      if (node.entity_type) {
        types.add(node.entity_type);
      }
    }

    return types;
  }, [subgraph]);

  const nodeLimit = useMemo(() => {
    const parsed = Number.parseInt(nodeLimitInput, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      return 10;
    }

    return Math.min(parsed, 100);
  }, [nodeLimitInput]);

  const filteredGraph = useMemo(() => {
    if (!subgraph || !userEntityId) {
      return subgraph;
    }

    const centerNode = subgraph.nodes.find((node) => node.id === userEntityId);
    if (!centerNode) {
      return subgraph;
    }

    const others = subgraph.nodes.filter((node) => node.id !== userEntityId);

    let candidateNodes = others;
    if (activeType !== 'ALL') {
      candidateNodes = candidateNodes.filter((node) => node.entity_type === activeType);
    }

    const selectionLimit = Math.max(0, nodeLimit - 1);
    const limitedNodes =
      candidateNodes.length <= selectionLimit
        ? candidateNodes
        : pickRandomSubset(candidateNodes, selectionLimit);

    const selectedIds = new Set<string>([userEntityId, ...limitedNodes.map((node) => node.id)]);

    const nodes = subgraph.nodes.filter((node) => selectedIds.has(node.id));
    const links = subgraph.links.filter(
      (link) => selectedIds.has(link.source) && selectedIds.has(link.target),
    );

    return { nodes, links };
  }, [subgraph, userEntityId, activeType, nodeLimit]);

  const nodePropertiesPayload = useMemo(
    () => buildPropertiesPayload(editableProperties),
    [editableProperties],
  );

  const originalNodeName = nodeData?.node.name ?? '';
  const originalNodeDescription = nodeData?.node.description ?? '';
  const originalProperties = nodeData?.node.properties ?? {};
  const propertiesDirty = useMemo(
    () => serializeProperties(nodePropertiesPayload) !== serializeProperties(originalProperties),
    [nodePropertiesPayload, originalProperties],
  );

  const isDirty =
    (nodeData &&
      (editableName !== originalNodeName ||
        editableDescription !== originalNodeDescription ||
        propertiesDirty)) ||
    false;

  const handleResetNode = () => {
    if (!nodeData) {
      return;
    }

    setEditableName(nodeData.node.name ?? '');
    setEditableDescription(nodeData.node.description ?? '');
    setEditableProperties(
      Object.entries(nodeData.node.properties ?? {}).map(([key, value]) => ({
        id: `${key}-${Math.random().toString(36).slice(2, 8)}`,
        key,
        value: formatPropertyValue(value),
      })),
    );
    setSaveError(null);
    setSaveSuccess(null);
  };

  const handleSaveNode = async () => {
    if (!nodeData || !isDirty) {
      return;
    }

    setSavingNode(true);
    setSaveError(null);
    try {
      await fetchJson('/api/graph/node/update', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          entityId: nodeData.node.entityId,
          name: editableName.trim() === '' ? null : editableName.trim(),
          description: editableDescription.trim() === '' ? null : editableDescription.trim(),
          properties: nodePropertiesPayload,
        }),
      });

      setSaveSuccess('Changes saved');
      setNodeRevision((prev) => prev + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save changes';
      setSaveError(message);
    } finally {
      setSavingNode(false);
    }
  };

  const handlePropertyKeyChange = (id: string, value: string) => {
    setEditableProperties((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, key: value } : entry)),
    );
  };

  const handlePropertyValueChange = (id: string, value: string) => {
    setEditableProperties((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, value } : entry)),
    );
  };

  const handleRemoveProperty = (id: string) => {
    setEditableProperties((current) => current.filter((entry) => entry.id !== id));
  };

  const handleAddProperty = () => {
    setEditableProperties((current) => [
      ...current,
      {
        id: `property-${Math.random().toString(36).slice(2, 8)}`,
        key: '',
        value: '',
      },
    ]);
  };

  const graphSummary = useMemo<GraphSummary>(() => {
    const fallback: GraphSummary = { nodeCount: 0, linkCount: 0, topTypes: [] };

    if (!subgraph) {
      return fallback;
    }

    const typeCounts = new Map<string, number>();
    for (const node of subgraph.nodes) {
      typeCounts.set(node.entity_type, (typeCounts.get(node.entity_type) ?? 0) + 1);
    }

    const topTypes = Array.from(typeCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, count]) => ({ type, count }));

    return {
      nodeCount: subgraph.nodes.length,
      linkCount: subgraph.links.length,
      topTypes,
    };
  }, [subgraph]);

  if (authLoading) {
    return <div className="p-6">Loading analytics…</div>;
  }

  if (authError) {
    return <div className="p-6 text-red-600">Error: {String(authError)}</div>;
  }

  if (!user) {
    return <div className="p-6">Please log in to view analytics.</div>;
  }

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link href="/">Home</Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Knowledge</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <Card.Header>
              <Card.Title className="flex items-center gap-2">Knowledge Graph</Card.Title>
              <Card.Description>
                {currentUser ? `Connections around ${currentUser.name}` : 'Connections around your profile'}
              </Card.Description>
            </Card.Header>
            <Card.Content>
              {graphLoading ? (
                <Skeleton className="h-[420px] w-full" />
              ) : graphError ? (
                <p className="text-sm text-red-600">{graphError}</p>
              ) : filteredGraph && userEntityId ? (
                <ForceGraph
                  nodes={filteredGraph.nodes}
                  links={filteredGraph.links}
                  highlightedNodeId={userEntityId}
                  centerNodeId={userEntityId}
                  selectedNodeId={selectedNodeId}
                  onNodeSelect={handleNodeSelect}
                />
              ) : (
                <p className="text-sm text-muted-foreground">No graph data available yet.</p>
              )}
            </Card.Content>
          </Card>

          <Card>
            <Card.Header>
              <Card.Title>Graph Stats</Card.Title>
              <Card.Description>Live numbers from your personal graph</Card.Description>
            </Card.Header>
            <Card.Content className="space-y-4">
              <div className="space-y-2 text-sm">
                <StatLine label="Nodes in view" value={graphSummary.nodeCount} />
                <StatLine label="Relationships in view" value={graphSummary.linkCount} />
                <StatLine label="Total entities" value={quickStats?.totalEntities ?? '—'} />
                <StatLine label="Family connections" value={quickStats?.familySize ?? '—'} />
                <StatLine label="Preferences" value={quickStats?.totalPreferences ?? '—'} />
                <StatLine label="Dislikes" value={quickStats?.totalDislikes ?? '—'} />
              </div>

              {graphSummary.topTypes.length > 0 && (
                <div className="border-t pt-4">
                  <h3 className="text-sm font-medium mb-2">Top node types</h3>
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    {graphSummary.topTypes.map((item) => (
                      <li key={item.type} className="flex items-center justify-between">
                        <span>{item.type}</span>
                        <span>{item.count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card.Content>
          </Card>
        </div>
        <Card>
          <Card.Header>
            <Card.Title>Filters</Card.Title>
            <Card.Description>Adjust which neighbors appear in the graph</Card.Description>
          </Card.Header>
          <Card.Content className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs uppercase text-muted-foreground" htmlFor="graph-node-limit">
                Node limit
              </label>
              <Input
                id="graph-node-limit"
                type="number"
                min={1}
                max={100}
                value={nodeLimitInput}
                onChange={(event) => setNodeLimitInput(event.target.value)}
                className="w-32"
              />
            </div>

            <div className="space-y-2">
              <p className="text-xs uppercase text-muted-foreground">Entity types</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={activeType === 'ALL' ? 'default' : 'secondary'}
                  onClick={() => setActiveType('ALL')}
                >
                  All
                </Button>
                {Array.from(availableTypes)
                  .sort()
                  .map((type) => (
                    <Button
                      key={type}
                      type="button"
                      size="sm"
                      variant={activeType === type ? 'default' : 'secondary'}
                      onClick={() => setActiveType(type)}
                    >
                      {type}
                    </Button>
                  ))}
              </div>
            </div>
          </Card.Content>
        </Card>
      </PageContent>

      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
        <Drawer.Content className="flex max-h-[85vh] flex-col">
          <Drawer.Header>
            <Drawer.Title>
              {nodeLoading
                ? 'Loading node…'
                : (nodeData?.node.name ?? nodeData?.node.entityType ?? 'Node details')}
            </Drawer.Title>
            <Drawer.Description>
              {nodeLoading ? 'Fetching the latest information from your graph' : (nodeError ?? '')}
            </Drawer.Description>
          </Drawer.Header>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto px-6 pb-6">
              {nodeLoading && <Skeleton className="h-24 w-full" />}

              {!nodeLoading && nodeData && (
                <div className="space-y-6">
                  <section className="space-y-3 text-sm">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs uppercase text-muted-foreground">Node</h3>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={handleResetNode}
                          disabled={!isDirty || savingNode}
                        >
                          Reset
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={handleSaveNode}
                          disabled={!isDirty || savingNode}
                        >
                          {savingNode ? 'Saving…' : 'Save'}
                        </Button>
                      </div>
                    </div>
                    {saveError && <p className="text-xs text-red-600">{saveError}</p>}
                    {saveSuccess && <p className="text-xs text-emerald-600">{saveSuccess}</p>}

                    <div className="space-y-4 rounded-lg border bg-background p-4">
                      <div>
                        <label className="text-xs uppercase text-muted-foreground" htmlFor="node-name">
                          Name
                        </label>
                        <Input
                          id="node-name"
                          placeholder={nodeData.node.entityType}
                          value={editableName}
                          onChange={(event) => setEditableName(event.target.value)}
                        />
                      </div>

                      <div>
                        <label className="text-xs uppercase text-muted-foreground" htmlFor="node-description">
                          Description
                        </label>
                        <Textarea
                          id="node-description"
                          rows={4}
                          placeholder="Add a description"
                          value={editableDescription}
                          onChange={(event) => setEditableDescription(event.target.value)}
                        />
                      </div>

                      <dl className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                        <div>
                          <dt>Entity ID</dt>
                          <dd className="font-mono text-[11px] text-foreground">{nodeData.node.entityId}</dd>
                        </div>
                        <div>
                          <dt>Type</dt>
                          <dd className="text-foreground">{nodeData.node.entityType}</dd>
                        </div>
                        <div>
                          <dt>Created</dt>
                          <dd>{new Date(nodeData.node.createdAt).toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Updated</dt>
                          <dd>{new Date(nodeData.node.updatedAt).toLocaleString()}</dd>
                        </div>
                      </dl>
                    </div>
                  </section>

                  <section className="space-y-3 text-sm">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs uppercase text-muted-foreground">Properties</h3>
                      <Button type="button" size="sm" variant="secondary" onClick={handleAddProperty}>
                        Add property
                      </Button>
                    </div>

                    {editableProperties.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No custom properties defined.</p>
                    ) : (
                      <div className="space-y-3">
                        {editableProperties.map((entry) => (
                          <div key={entry.id} className="space-y-3 rounded-lg border bg-background p-4">
                            <div className="flex items-center gap-3">
                              <div className="flex-1">
                                <label
                                  className="text-xs uppercase text-muted-foreground"
                                  htmlFor={`prop-key-${entry.id}`}
                                >
                                  Key
                                </label>
                                <Input
                                  id={`prop-key-${entry.id}`}
                                  value={entry.key}
                                  onChange={(event) => handlePropertyKeyChange(entry.id, event.target.value)}
                                  placeholder="property_key"
                                />
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => handleRemoveProperty(entry.id)}
                                title="Remove property"
                              >
                                ×
                              </Button>
                            </div>

                            <div>
                              <label
                                className="text-xs uppercase text-muted-foreground"
                                htmlFor={`prop-value-${entry.id}`}
                              >
                                Value
                              </label>
                              <Textarea
                                id={`prop-value-${entry.id}`}
                                rows={3}
                                value={entry.value}
                                onChange={(event) => handlePropertyValueChange(entry.id, event.target.value)}
                                placeholder="value or JSON"
                              />
                              {(() => {
                                const preview = tryParseJsonList(entry.value);
                                if (!preview) {
                                  return null;
                                }

                                return (
                                  <div className="mt-2 flex gap-2 overflow-x-auto">
                                    {preview.map((item, index) => (
                                      <span
                                        key={`${entry.id}-${index}`}
                                        className="whitespace-nowrap rounded-md border bg-muted/70 px-2 py-1 text-[11px]"
                                      >
                                        {formatPropertyValue(item)}
                                      </span>
                                    ))}
                                  </div>
                                );
                              })()}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              )}

              {!nodeLoading && nodeError && <p className="text-sm text-red-600">{nodeError}</p>}
            </div>

            <section className="border-t bg-muted/50 px-6 py-4">
              <div className="mb-2 flex items-center justify-between text-xs uppercase text-muted-foreground">
                <span>Relationships</span>
                <span>{nodeData?.relationships.length ?? 0} linked</span>
              </div>
              {nodeLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : !nodeData || nodeData.relationships.length === 0 ? (
                <p className="text-xs text-muted-foreground">No relationships recorded.</p>
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={relationshipFilter === 'ALL' ? 'default' : 'secondary'}
                      onClick={() => setRelationshipFilter('ALL')}
                    >
                      All
                    </Button>
                    {Array.from(
                      new Set(
                        nodeData.relationships
                          .map((rel) => rel.otherEntity?.entityType)
                          .filter((type): type is string => Boolean(type)),
                      ),
                    )
                      .sort()
                      .map((type) => (
                        <Button
                          key={type}
                          type="button"
                          size="sm"
                          variant={relationshipFilter === type ? 'default' : 'secondary'}
                          onClick={() => setRelationshipFilter(type)}
                        >
                          {type}
                        </Button>
                      ))}
                  </div>

                  <div className="flex gap-3 overflow-x-auto pb-2">
                    {nodeData.relationships
                      .filter((rel) => {
                        if (relationshipFilter === 'ALL') {
                          return true;
                        }

                        return rel.otherEntity?.entityType === relationshipFilter;
                      })
                      .map((rel) => {
                        const canNavigate = !!rel.otherEntity;
                        const handleRelationshipClick = () => {
                          if (rel.otherEntity) {
                            handleNodeSelect(rel.otherEntity.entityId);
                          }
                        };

                        return (
                          <button
                            key={rel.relationshipId}
                            type="button"
                            disabled={!canNavigate}
                            onClick={handleRelationshipClick}
                            className="min-w-[220px] rounded-lg border bg-background p-4 text-left shadow-sm transition-colors hover:border-primary/60 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <span>{rel.direction === 'outbound' ? 'Outbound' : 'Inbound'}</span>
                              <span>{rel.relationshipType}</span>
                            </div>
                            {rel.otherEntity && (
                              <div className="mt-2 text-sm text-foreground">
                                <p className="font-medium">
                                  {rel.otherEntity.name ?? rel.otherEntity.entityType}
                                </p>
                                <p className="text-xs text-muted-foreground">{rel.otherEntity.entityId}</p>
                              </div>
                            )}
                            {Object.keys(rel.properties ?? {}).length > 0 && (
                              <div className="mt-3">
                                <PropertyBlocks properties={rel.properties ?? {}} size="sm" />
                              </div>
                            )}
                          </button>
                        );
                      })}
                  </div>
                </>
              )}
            </section>
          </div>
        </Drawer.Content>
      </Drawer>
    </>
  );
}

function StatLine({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

function pickRandomSubset<T>(items: T[], limit: number): T[] {
  if (limit <= 0) {
    return [];
  }

  const pool = [...items];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }

  return pool.slice(0, limit);
}

function buildPropertiesPayload(entries: EditableProperty[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) {
      continue;
    }

    payload[key] = parsePropertyValueForUpdate(entry.value);
  }

  return payload;
}

function parsePropertyValueForUpdate(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === '') {
    return '';
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function serializeProperties(properties: Record<string, unknown>): string {
  return stableSerialize(properties);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const body = entries.map(([key, val]) => `${JSON.stringify(key)}:${stableSerialize(val)}`).join(',');

    return `{${body}}`;
  }

  return JSON.stringify(value);
}

function PropertyBlocks({
  properties,
  size = 'md',
}: {
  properties: Record<string, unknown>;
  size?: 'sm' | 'md';
}) {
  const entries = Object.entries(properties ?? {});
  if (entries.length === 0) {
    return null;
  }

  const containerClass = size === 'sm' ? 'gap-2 text-xs' : 'gap-3 text-sm';
  const blockClass =
    size === 'sm' ? 'rounded-md border bg-muted/40 p-2' : 'rounded-md border bg-muted/40 p-3';

  return (
    <div className={`grid ${containerClass}`}>
      {entries.map(([key, value]) => (
        <div key={key} className={blockClass}>
          <div className="mb-1 flex items-center justify-between">
            <span className="font-medium text-foreground">{key}</span>
            <Badge variant="secondary" className="uppercase tracking-wide text-[10px]">
              {typeof value}
            </Badge>
          </div>
          {renderPropertyValue(key, value)}
        </div>
      ))}
    </div>
  );
}

function renderPropertyValue(key: string, rawValue: unknown) {
  if (Array.isArray(rawValue)) {
    return (
      <div className="mt-2 flex gap-2 overflow-x-auto">
        {rawValue.map((item, index) => (
          <span
            key={`${key}-${index}`}
            className="whitespace-nowrap rounded-md border bg-muted/70 px-2 py-1 text-[11px]"
          >
            {formatPropertyValue(item)}
          </span>
        ))}
      </div>
    );
  }

  if (typeof rawValue === 'string') {
    const parsedList = tryParseJsonList(rawValue);
    if (parsedList) {
      return (
        <div className="mt-2 flex gap-2 overflow-x-auto">
          {parsedList.map((item, index) => (
            <span
              key={`${key}-${index}`}
              className="whitespace-nowrap rounded-md border bg-muted/70 px-2 py-1 text-[11px]"
            >
              {formatPropertyValue(item)}
            </span>
          ))}
        </div>
      );
    }
  }

  return (
    <p className="whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
      {formatPropertyValue(rawValue)}
    </p>
  );
}

function tryParseJsonList(value: string): unknown[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);

    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function formatPropertyValue(value: unknown): string {
  if (value == null) {
    return 'null';
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '[unserializable]';
    }
  }

  return String(value);
}
