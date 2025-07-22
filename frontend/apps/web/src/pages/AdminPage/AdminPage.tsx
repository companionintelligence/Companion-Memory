import { useState, useEffect } from 'react';

import { Badge, Button, Card, Input, Progress, Select, Table, Tabs } from '@ci/shadcn';
import {
  AlertCircle,
  RefreshCw,
  Play,
  Pause,
  Trash2,
  RotateCcw,
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
} from '@ci/shadcn/icons';

import { useAuth } from '@/hooks';

const API_BASE = '/api';

interface JobStatus {
  id: string;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  progress: number;
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused';
  createdAt: string;
  processedAt?: string;
  finishedAt?: string;
  attempts: number;
  failedReason?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  returnValue?: any;
  queue: string;
  priority: number;
}

interface QueueStats {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  total: number;
}

export function AdminPage() {
  const [{ user }] = useAuth();
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [queueStats, setQueueStats] = useState<QueueStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('jobs');
  const [filterQueue, setFilterQueue] = useState<string>('');
  const [filterState, setFilterState] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState<string>('');

  const fetchJobs = async () => {
    try {
      setLoading(true);
      setError(null);

      const token = localStorage.getItem('feathers-jwt');
      const params = new URLSearchParams();
      if (filterQueue) {
        params.append('queue', filterQueue);
      }

      if (filterState) {
        params.append('state', filterState);
      }

      const res = await fetch(`${API_BASE}/admin/jobs?${params}`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        throw new Error(res.statusText);
      }

      const data = await res.json();
      setJobs(data.jobs || []);
    } catch (err) {
      setError((err as Error).message || 'Failed to fetch jobs');
    } finally {
      setLoading(false);
    }
  };

  const fetchQueueStats = async () => {
    try {
      const token = localStorage.getItem('feathers-jwt');
      const res = await fetch(`${API_BASE}/dashboard/queues`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(res.statusText);
      }

      const data = await res.json();
      setQueueStats(data);
    } catch (err) {
      setError((err as Error).message || 'Failed to fetch queue stats');
    }
  };

  const performJobAction = async (action: string, jobId?: string, queueName?: string) => {
    try {
      const response = await fetch(`${API_BASE}/admin/jobs`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('feathers-jwt')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action, jobId, queueName }),
      });

      if (!response.ok) {
        throw new Error(`Failed to perform action: ${response.statusText}`);
      }

      // Refresh data after action
      await fetchJobs();
      await fetchQueueStats();
    } catch (error) {
      console.error('Error performing action:', error);
      alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  useEffect(() => {
    fetchJobs();
    fetchQueueStats();
  }, [filterQueue, filterState]);

  const getStateIcon = (state: string) => {
    switch (state) {
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'failed':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'active':
        return <RefreshCw className="h-4 w-4 text-blue-500 animate-spin" />;
      case 'waiting':
        return <Clock className="h-4 w-4 text-yellow-500" />;
      case 'delayed':
        return <AlertTriangle className="h-4 w-4 text-orange-500" />;
      case 'paused':
        return <Pause className="h-4 w-4 text-gray-500" />;
      default:
        return <AlertCircle className="h-4 w-4 text-gray-500" />;
    }
  };

  const getStateBadgeVariant = (state: string) => {
    switch (state) {
      case 'completed':
        return 'default';
      case 'failed':
        return 'destructive';
      case 'active':
        return 'default';
      case 'waiting':
        return 'secondary';
      case 'delayed':
        return 'outline';
      case 'paused':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  const filteredJobs = jobs.filter((job) => {
    const matchesSearch =
      !searchTerm ||
      job.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      job.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      job.queue.toLowerCase().includes(searchTerm.toLowerCase());

    return matchesSearch;
  });

  if (!user) {
    return <div>Please log in to access the admin panel.</div>;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Job Queue Administration</h1>
        <Button
          onClick={() => {
            fetchJobs();
            fetchQueueStats();
          }}
          disabled={loading}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <Card className="border-red-200 bg-red-50">
          <Card.Content className="pt-6">
            <div className="flex items-center space-x-2 text-red-600">
              <AlertCircle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          </Card.Content>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <Tabs.List>
          <Tabs.Trigger value="jobs">Jobs Management</Tabs.Trigger>
          <Tabs.Trigger value="queues">Queue Statistics</Tabs.Trigger>
          <Tabs.Trigger value="health">System Health</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="jobs" className="space-y-4">
          <Card>
            <Card.Header>
              <Card.Title>Job Filters</Card.Title>
            </Card.Header>
            <Card.Content>
              <div className="flex space-x-4">
                <Input
                  placeholder="Search jobs..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="flex-1"
                />
                <Select value={filterQueue} onValueChange={setFilterQueue}>
                  <Select.Trigger className="w-48">
                    <Select.Value placeholder="Filter by queue" />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="">All Queues</Select.Item>
                    <Select.Item value="ai-processing">AI Processing</Select.Item>
                    <Select.Item value="notifications">Notifications</Select.Item>
                    <Select.Item value="data-processing">Data Processing</Select.Item>
                    <Select.Item value="batch-processing">Batch Processing</Select.Item>
                    <Select.Item value="pipeline">Pipeline</Select.Item>
                  </Select.Content>
                </Select>
                <Select value={filterState} onValueChange={setFilterState}>
                  <Select.Trigger className="w-48">
                    <Select.Value placeholder="Filter by state" />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="">All States</Select.Item>
                    <Select.Item value="waiting">Waiting</Select.Item>
                    <Select.Item value="active">Active</Select.Item>
                    <Select.Item value="completed">Completed</Select.Item>
                    <Select.Item value="failed">Failed</Select.Item>
                    <Select.Item value="delayed">Delayed</Select.Item>
                    <Select.Item value="paused">Paused</Select.Item>
                  </Select.Content>
                </Select>
              </div>
            </Card.Content>
          </Card>

          <Card>
            <Card.Header>
              <Card.Title>Jobs ({filteredJobs.length})</Card.Title>
            </Card.Header>
            <Card.Content>
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>ID</Table.Head>
                    <Table.Head>Name</Table.Head>
                    <Table.Head>Queue</Table.Head>
                    <Table.Head>State</Table.Head>
                    <Table.Head>Progress</Table.Head>
                    <Table.Head>Priority</Table.Head>
                    <Table.Head>Created</Table.Head>
                    <Table.Head>Actions</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {filteredJobs.map((job) => (
                    <Table.Row key={job.id}>
                      <Table.Cell className="font-mono text-sm">{job.id}</Table.Cell>
                      <Table.Cell>{job.name}</Table.Cell>
                      <Table.Cell>
                        <Badge variant="outline">{job.queue}</Badge>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex items-center space-x-2">
                          {getStateIcon(job.state)}
                          <Badge variant={getStateBadgeVariant(job.state)}>{job.state}</Badge>
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex items-center space-x-2">
                          <Progress value={job.progress} className="w-16" />
                          <span className="text-sm text-gray-500">{job.progress}%</span>
                        </div>
                      </Table.Cell>
                      <Table.Cell>{job.priority}</Table.Cell>
                      <Table.Cell className="text-sm text-gray-500">
                        {new Date(job.createdAt).toLocaleString()}
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex space-x-1">
                          {job.state === 'failed' && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => performJobAction('retry', job.id)}
                            >
                              <RotateCcw className="h-3 w-3" />
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => performJobAction('remove', job.id)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </Card.Content>
          </Card>
        </Tabs.Content>

        <Tabs.Content value="queues" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {queueStats.map((queue) => (
              <Card key={queue.name}>
                <Card.Header>
                  <div className="flex items-center justify-between">
                    <Card.Title className="text-lg">{queue.name}</Card.Title>
                    <div className="flex space-x-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => performJobAction('pause', undefined, queue.name)}
                      >
                        <Pause className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => performJobAction('resume', undefined, queue.name)}
                      >
                        <Play className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => performJobAction('clean', undefined, queue.name)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </Card.Header>
                <Card.Content>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span>Waiting:</span>
                      <Badge variant="secondary">{queue.waiting}</Badge>
                    </div>
                    <div className="flex justify-between">
                      <span>Active:</span>
                      <Badge variant="default">{queue.active}</Badge>
                    </div>
                    <div className="flex justify-between">
                      <span>Completed:</span>
                      <Badge variant="outline">{queue.completed}</Badge>
                    </div>
                    <div className="flex justify-between">
                      <span>Failed:</span>
                      <Badge variant="destructive">{queue.failed}</Badge>
                    </div>
                    <div className="flex justify-between font-medium">
                      <span>Total:</span>
                      <Badge>{queue.total}</Badge>
                    </div>
                  </div>
                </Card.Content>
              </Card>
            ))}
          </div>
        </Tabs.Content>

        <Tabs.Content value="health">
          <SystemHealthComponent />
        </Tabs.Content>
      </Tabs>
    </div>
  );
}

// System Health Component
function SystemHealthComponent() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [healthData, setHealthData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHealthData = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('feathers-jwt');
      const res = await fetch(`${API_BASE}/health/detailed`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(res.statusText);
      }

      const data = await res.json();
      setHealthData(data);
    } catch (err) {
      setError((err as Error).message || 'Failed to fetch health data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHealthData();
    const interval = setInterval(fetchHealthData, 30000); // Refresh every 30 seconds

    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <div>Loading health data...</div>;
  }

  if (error) {
    return <div className="text-red-600">Error: {error}</div>;
  }

  return (
    <div className="space-y-6">
      <Card>
        <Card.Header>
          <Card.Title className="flex items-center space-x-2">
            <span>System Status</span>
            <Badge variant={healthData.status === 'healthy' ? 'default' : 'destructive'}>
              {healthData.status}
            </Badge>
          </Card.Title>
        </Card.Header>
        <Card.Content>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <h4 className="font-medium mb-2">Uptime</h4>
              <p className="text-sm text-gray-600">
                {Math.floor(healthData.uptime / 3600000)}h {Math.floor((healthData.uptime % 3600000) / 60000)}
                m
              </p>
            </div>
            <div>
              <h4 className="font-medium mb-2">Memory Usage</h4>
              <div className="space-y-1">
                <Progress value={healthData.memory.percentage} />
                <p className="text-sm text-gray-600">
                  {Math.round(healthData.memory.percentage)}% (
                  {Math.round(healthData.memory.used / 1024 / 1024)}MB used)
                </p>
              </div>
            </div>
            <div>
              <h4 className="font-medium mb-2">Redis</h4>
              <div className="flex items-center space-x-2">
                {healthData.redis.connected ? (
                  <CheckCircle className="h-4 w-4 text-green-500" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-500" />
                )}
                <span className="text-sm">
                  {healthData.redis.connected ? 'Connected' : 'Disconnected'}
                  {healthData.redis.connected && ` (${healthData.redis.ping}ms)`}
                </span>
              </div>
            </div>
          </div>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Service Health</Card.Title>
        </Card.Header>
        <Card.Content>
          <div className="space-y-3">
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {Object.entries(healthData.services).map(([name, service]: [string, any]) => (
              <div key={name} className="flex items-center justify-between p-3 border rounded">
                <div className="flex items-center space-x-3">
                  {service.status === 'up' ? (
                    <CheckCircle className="h-5 w-5 text-green-500" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-500" />
                  )}
                  <span className="font-medium">{name}</span>
                </div>
                <div className="text-sm text-gray-600">
                  {service.responseTime && `${service.responseTime}ms`}
                  <Badge variant={service.status === 'up' ? 'default' : 'destructive'} className="ml-2">
                    {service.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}
