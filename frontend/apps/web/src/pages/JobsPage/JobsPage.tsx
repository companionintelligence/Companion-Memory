import { useState, useEffect } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { 
  Breadcrumb, 
  Button, 
  Card, 
  Badge, 
  Dialog, 
  Input, 
  Label, 
  Tabs,
  Table,
  Alert,
  Progress,
  Select,
} from '@ci/shadcn';
import {
  CheckCircle,
  Plus,
  Edit,
  Trash2,
  RefreshCw,
  AlertCircle,
  X,
  Database,
  Activity,
  Timer,
  AlertTriangle,
  Clock,
  Play,
  Pause,
  Calendar,
  Zap,
  CalendarDays,
  Target,
  Users,
  FileText,
  ShoppingCart,
  BookOpen,
  Dumbbell,
  Music,
  Plane,
  Briefcase,
  Filter,
} from '@ci/shadcn/icons';

import { PageContent } from '@/components/layout';
import { useJobsService, type JobInfo } from '@/api';

// Mock UI Job interface (separate from PGBoss JobInfo)
export interface MockJob {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'scheduled';
  readonly priority: 'low' | 'medium' | 'high' | 'urgent';
  readonly category: 'personal' | 'work' | 'health' | 'learning' | 'entertainment' | 'travel' | 'shopping';
  readonly scheduledFor?: Date;
  readonly estimatedDuration: number; // in minutes
  readonly progress?: number; // 0-100
  readonly icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  readonly color: string;
  readonly tags: string[];
  readonly recurring?: {
    frequency: 'daily' | 'weekly' | 'monthly';
    nextOccurrence: Date;
  };
}

export function JobsPage() {
  usePageTitle('Server Task Scheduler - Companion Intelligence');

  const {
    jobs,
    stats,
    loading,
    error,
    fetchJobs,
    updateJobStatus,
    deleteJob,
    createJob,
  } = useJobsService();

  const [selectedJob, setSelectedJob] = useState<JobInfo | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [activeTab, setActiveTab] = useState('all');
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Mock UI state (separate from PGBoss)
  const [mockJobs, setMockJobs] = useState<MockJob[]>([]);
  const [mockLoading, setMockLoading] = useState(true);
  const [selectedMockJob, setSelectedMockJob] = useState<MockJob | null>(null);
  const [showCreateMockModal, setShowCreateMockModal] = useState(false);
  const [showEditMockModal, setShowEditMockModal] = useState(false);
  const [mockActiveTab, setMockActiveTab] = useState('all');
  const [mockSortBy, setMockSortBy] = useState<'priority' | 'time' | 'category'>('priority');

  // Auto-refresh every 5 seconds for live view
  useEffect(() => {
    if (autoRefresh) {
      const interval = setInterval(() => {
        fetchJobs();
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [autoRefresh, fetchJobs]);

  // Mock data initialization
  useEffect(() => {
    // Simulate loading
    setTimeout(() => {
      setMockJobs([
        {
          id: '1',
          title: 'Morning Workout',
          description: 'Complete 30-minute HIIT session with strength training',
          status: 'running',
          priority: 'high',
          category: 'health',
          estimatedDuration: 30,
          progress: 65,
          icon: Dumbbell,
          color: 'bg-blue-500',
          tags: ['fitness', 'morning-routine'],
          recurring: {
            frequency: 'daily',
            nextOccurrence: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        },
        {
          id: '2',
          title: 'Review Project Proposal',
          description: 'Analyze Q4 marketing strategy and provide feedback',
          status: 'pending',
          priority: 'urgent',
          category: 'work',
          scheduledFor: new Date(Date.now() + 2 * 60 * 60 * 1000),
          estimatedDuration: 45,
          icon: Briefcase,
          color: 'bg-purple-500',
          tags: ['work', 'review', 'deadline'],
        },
        {
          id: '3',
          title: 'Grocery Shopping',
          description: 'Buy ingredients for weekly meal prep',
          status: 'scheduled',
          priority: 'medium',
          category: 'shopping',
          scheduledFor: new Date(Date.now() + 4 * 60 * 60 * 1000),
          estimatedDuration: 60,
          icon: ShoppingCart,
          color: 'bg-green-500',
          tags: ['shopping', 'meal-prep'],
        },
        {
          id: '4',
          title: 'Read Design Patterns Book',
          description: 'Continue reading Chapter 5: Factory Pattern',
          status: 'pending',
          priority: 'low',
          category: 'learning',
          estimatedDuration: 30,
          icon: BookOpen,
          color: 'bg-orange-500',
          tags: ['learning', 'programming', 'design-patterns'],
        },
        {
          id: '5',
          title: 'Call Mom',
          description: 'Weekly check-in call',
          status: 'scheduled',
          priority: 'high',
          category: 'personal',
          scheduledFor: new Date(Date.now() + 6 * 60 * 60 * 1000),
          estimatedDuration: 20,
          icon: Users,
          color: 'bg-pink-500',
          tags: ['family', 'personal'],
        },
        {
          id: '6',
          title: 'Plan Weekend Trip',
          description: 'Research hotels and activities for upcoming vacation',
          status: 'pending',
          priority: 'medium',
          category: 'travel',
          estimatedDuration: 90,
          icon: Plane,
          color: 'bg-cyan-500',
          tags: ['travel', 'planning', 'vacation'],
        },
        {
          id: '7',
          title: 'Practice Guitar',
          description: 'Work on new chord progressions for 20 minutes',
          status: 'completed',
          priority: 'low',
          category: 'entertainment',
          estimatedDuration: 20,
          icon: Music,
          color: 'bg-indigo-500',
          tags: ['music', 'practice'],
        },
        {
          id: '8',
          title: 'Update Resume',
          description: 'Add recent project accomplishments and skills',
          status: 'failed',
          priority: 'medium',
          category: 'work',
          estimatedDuration: 45,
          icon: FileText,
          color: 'bg-red-500',
          tags: ['career', 'documents'],
        },
      ]);
      setMockLoading(false);
    }, 1000);
  }, []);

  const getPGBossStatusColor = (status: JobInfo['state']) => {
    switch (status) {
      case 'active':
        return 'bg-blue-500';
      case 'completed':
        return 'bg-green-500';
      case 'failed':
        return 'bg-red-500';
      case 'retry':
        return 'bg-orange-500';
      case 'cancelled':
        return 'bg-gray-500';
      case 'expired':
        return 'bg-purple-500';
      default:
        return 'bg-yellow-500';
    }
  };

  const getStatusIcon = (status: JobInfo['state']) => {
    switch (status) {
      case 'active':
        return <Activity className="h-4 w-4" />;
      case 'completed':
        return <CheckCircle className="h-4 w-4" />;
      case 'failed':
        return <AlertCircle className="h-4 w-4" />;
      case 'retry':
        return <RefreshCw className="h-4 w-4" />;
      case 'cancelled':
        return <X className="h-4 w-4" />;
      case 'expired':
        return <Clock className="h-4 w-4" />;
      default:
        return <Timer className="h-4 w-4" />;
    }
  };

  const getFilteredJobs = (tab: string) => {
    if (tab === 'all') {
      return jobs;
    }
    return jobs.filter((job) => job.state === tab);
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  };

  const formatDuration = (start?: Date, end?: Date) => {
    if (!start) return 'N/A';
    const endTime = end || new Date();
    const duration = Math.floor((endTime.getTime() - start.getTime()) / 1000);
    
    if (duration < 60) return `${duration}s`;
    if (duration < 3600) return `${Math.floor(duration / 60)}m ${duration % 60}s`;
    return `${Math.floor(duration / 3600)}h ${Math.floor((duration % 3600) / 60)}m`;
  };

  const handleAction = async (jobId: string, action: 'complete' | 'fail' | 'delete') => {
    if (action === 'delete') {
      await deleteJob(jobId);
    } else {
      await updateJobStatus(jobId, action === 'complete' ? 'completed' : 'failed');
    }
  };

  // Mock UI functions
  const getStatusColor = (status: MockJob['status']) => {
    switch (status) {
      case 'completed':
        return 'bg-green-500';
      case 'running':
        return 'bg-blue-500';
      case 'failed':
        return 'bg-red-500';
      case 'scheduled':
        return 'bg-purple-500';
      default:
        return 'bg-yellow-500';
    }
  };

  const getPriorityColor = (priority: MockJob['priority']) => {
    switch (priority) {
      case 'urgent':
        return 'bg-red-500';
      case 'high':
        return 'bg-orange-500';
      case 'medium':
        return 'bg-yellow-500';
      default:
        return 'bg-gray-500';
    }
  };

  const getPriorityText = (priority: MockJob['priority']) => {
    switch (priority) {
      case 'urgent':
        return 'Urgent';
      case 'high':
        return 'High';
      case 'medium':
        return 'Medium';
      default:
        return 'Low';
    }
  };

  const formatMockTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  };

  const getFilteredMockJobs = (tab: string) => {
    if (tab === 'all') {
      return mockJobs;
    }
    return mockJobs.filter((job) => job.status === tab);
  };

  const sortedMockJobs = [...getFilteredMockJobs(mockActiveTab)].sort((a, b) => {
    switch (mockSortBy) {
      case 'priority': {
        const priorityOrder = { urgent: 4, high: 3, medium: 2, low: 1 };
        return priorityOrder[b.priority] - priorityOrder[a.priority];
      }
      case 'time':
        if (a.scheduledFor && b.scheduledFor) {
          return a.scheduledFor.getTime() - b.scheduledFor.getTime();
        }
        return 0;
      case 'category':
        return a.category.localeCompare(b.category);
      default:
        return 0;
    }
  });

  const mockStats = {
    total: mockJobs.length,
    running: mockJobs.filter((j) => j.status === 'running').length,
    pending: mockJobs.filter((j) => j.status === 'pending').length,
    completed: mockJobs.filter((j) => j.status === 'completed').length,
    scheduled: mockJobs.filter((j) => j.status === 'scheduled').length,
  };

  const handleStartMockJob = (jobId: string) => {
    setMockJobs((prev) =>
      prev.map((job) => (job.id === jobId ? { ...job, status: 'running' as const, progress: 0 } : job)),
    );
  };

  const handlePauseMockJob = (jobId: string) => {
    setMockJobs((prev) => prev.map((job) => (job.id === jobId ? { ...job, status: 'pending' as const } : job)));
  };

  const handleCompleteMockJob = (jobId: string) => {
    setMockJobs((prev) =>
      prev.map((job) => (job.id === jobId ? { ...job, status: 'completed' as const, progress: 100 } : job)),
    );
  };

  const handleDeleteMockJob = (jobId: string) => {
    setMockJobs((prev) => prev.filter((job) => job.id !== jobId));
  };

  const filteredJobs = getFilteredJobs(activeTab);

  if (loading && jobs.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4 text-blue-500" />
          <p className="text-muted-foreground">Loading job queue...</p>
        </div>
      </div>
    );
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
              <Breadcrumb.Page>Server Task Scheduler</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        {/* Header and Controls */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Server Task Scheduler</h1>
            <p className="text-muted-foreground mt-1">Live view of the task queue system</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={autoRefresh ? 'bg-green-50 border-green-200' : ''}
            >
              <Activity className={`h-4 w-4 mr-2 ${autoRefresh ? 'animate-pulse text-green-600' : ''}`} />
              {autoRefresh ? 'Live' : 'Paused'}
            </Button>
            <Button onClick={fetchJobs} variant="outline" size="sm">
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <Button onClick={createJob}>
              <Plus className="h-4 w-4 mr-2" />
              Test Job
            </Button>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <Alert className="mb-4 border-red-200 bg-red-50">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <Alert.Title className="text-red-800">Error</Alert.Title>
            <Alert.Description className="text-red-700">{error}</Alert.Description>
          </Alert>
        )}

        {/* Stats Overview */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-6">
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Database className="h-4 w-4 text-blue-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Total</p>
                <p className="text-2xl font-bold">{stats.total}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Activity className="h-4 w-4 text-blue-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Active</p>
                <p className="text-2xl font-bold text-blue-600">{stats.active}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-yellow-100 rounded-lg">
                <Timer className="h-4 w-4 text-yellow-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Created</p>
                <p className="text-2xl font-bold text-yellow-600">{stats.created}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <CheckCircle className="h-4 w-4 text-green-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Completed</p>
                <p className="text-2xl font-bold text-green-600">{stats.completed}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-red-100 rounded-lg">
                <AlertCircle className="h-4 w-4 text-red-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Failed</p>
                <p className="text-2xl font-bold text-red-600">{stats.failed}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-orange-100 rounded-lg">
                <RefreshCw className="h-4 w-4 text-orange-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Retry</p>
                <p className="text-2xl font-bold text-orange-600">{stats.retry}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-gray-100 rounded-lg">
                <X className="h-4 w-4 text-gray-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Cancelled</p>
                <p className="text-2xl font-bold text-gray-600">{stats.cancelled}</p>
              </div>
            </div>
          </Card>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <Tabs.List className="grid w-full grid-cols-6 mb-4">
            <Tabs.Trigger value="all" className="text-xs sm:text-sm">
              All ({jobs.length})
            </Tabs.Trigger>
            <Tabs.Trigger value="active" className="text-xs sm:text-sm">
              Active ({stats.active})
            </Tabs.Trigger>
            <Tabs.Trigger value="created" className="text-xs sm:text-sm">
              Created ({stats.created})
            </Tabs.Trigger>
            <Tabs.Trigger value="completed" className="text-xs sm:text-sm">
              Completed ({stats.completed})
            </Tabs.Trigger>
            <Tabs.Trigger value="failed" className="text-xs sm:text-sm">
              Failed ({stats.failed})
            </Tabs.Trigger>
            <Tabs.Trigger value="retry" className="text-xs sm:text-sm">
              Retry ({stats.retry})
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value={activeTab} className="mt-0">
            {filteredJobs.length === 0 ? (
              <div className="text-center py-12">
                <div className="space-y-4">
                  <Database className="h-12 w-12 mx-auto text-muted-foreground" />
                  <h3 className="text-lg font-semibold">No jobs found</h3>
                  <p className="text-muted-foreground max-w-sm mx-auto">
                    {activeTab === 'all'
                      ? "No jobs in the queue. Create a test job to see how it works."
                      : `No ${activeTab} jobs found. Try changing the tab or create a new job.`}
                  </p>
                  <Button onClick={createJob}>
                    <Plus className="h-4 w-4 mr-2" />
                    Create Test Job
                  </Button>
                </div>
              </div>
            ) : (
              <Card>
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Job ID</Table.Head>
                      <Table.Head>Queue</Table.Head>
                      <Table.Head>Status</Table.Head>
                      <Table.Head>Data</Table.Head>
                      <Table.Head>Created</Table.Head>
                      <Table.Head>Started</Table.Head>
                      <Table.Head>Duration</Table.Head>
                      <Table.Head>Retries</Table.Head>
                      <Table.Head>Actions</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {filteredJobs.map((job) => (
                      <Table.Row key={job.id} className="hover:bg-muted/50">
                        <Table.Cell className="font-mono text-sm">{job.id}</Table.Cell>
                        <Table.Cell>
                          <Badge variant="outline">{job.name}</Badge>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex items-center space-x-2">
                            <div className={`p-1 rounded ${getPGBossStatusColor(job.state)} bg-opacity-20`}>
                              {getStatusIcon(job.state)}
                            </div>
                            <Badge className={`${getPGBossStatusColor(job.state)} text-white text-xs`}>
                              {job.state.toUpperCase()}
                            </Badge>
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="max-w-xs">
                            <details className="cursor-pointer">
                              <summary className="text-sm text-muted-foreground hover:text-foreground">
                                {job.data?.name || 'View data...'}
                              </summary>
                              <pre className="text-xs mt-2 p-2 bg-muted rounded overflow-auto max-h-20">
                                {JSON.stringify(job.data, null, 2)}
                              </pre>
                            </details>
                          </div>
                        </Table.Cell>
                        <Table.Cell className="text-sm text-muted-foreground">
                          {formatTime(job.createdOn)}
                        </Table.Cell>
                        <Table.Cell className="text-sm text-muted-foreground">
                          {job.startedOn ? formatTime(job.startedOn) : '-'}
                        </Table.Cell>
                        <Table.Cell className="text-sm text-muted-foreground">
                          {formatDuration(job.startedOn, job.completedOn)}
                        </Table.Cell>
                        <Table.Cell>
                          <span className="text-sm">
                            {job.retryCount || 0} / {job.retryLimit || 0}
                          </span>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex items-center space-x-2">
                            {job.state === 'active' && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleAction(job.id, 'complete')}
                                  className="text-green-600 hover:bg-green-50"
                                >
                                  <CheckCircle className="h-4 w-4" />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleAction(job.id, 'fail')}
                                  className="text-red-600 hover:bg-red-50"
                                >
                                  <AlertCircle className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setSelectedJob(job);
                                setShowEditModal(true);
                              }}
                              className="text-blue-600 hover:bg-blue-50"
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleAction(job.id, 'delete')}
                              className="text-red-600 hover:bg-red-50"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </Card>
            )}
          </Tabs.Content>
        </Tabs>

        {/* Section Divider */}
        <div className="my-8 border-t pt-8">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-4">
            <div>
              <h2 className="text-xl font-bold tracking-tight">Personal Task Manager</h2>
              <p className="text-muted-foreground mt-1">Manage your personal assistant's tasks and schedule</p>
            </div>
            <Button onClick={() => setShowCreateMockModal(true)} className="w-full lg:w-auto">
              <Plus className="h-4 w-4 mr-2" />
              Add New Job
            </Button>
          </div>

          {/* Mock Stats Overview */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4 mb-4">
            <Card className="p-4">
              <div className="flex items-center space-x-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Target className="h-4 w-4 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Total</p>
                  <p className="text-2xl font-bold">{mockStats.total}</p>
                </div>
              </div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center space-x-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Play className="h-4 w-4 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Running</p>
                  <p className="text-2xl font-bold text-blue-600">{mockStats.running}</p>
                </div>
              </div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center space-x-3">
                <div className="p-2 bg-yellow-100 rounded-lg">
                  <Clock className="h-4 w-4 text-yellow-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Pending</p>
                  <p className="text-2xl font-bold text-yellow-600">{mockStats.pending}</p>
                </div>
              </div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center space-x-3">
                <div className="p-2 bg-green-100 rounded-lg">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Completed</p>
                  <p className="text-2xl font-bold text-green-600">{mockStats.completed}</p>
                </div>
              </div>
            </Card>
            <Card className="p-4 col-span-2 md:col-span-1">
              <div className="flex items-center space-x-3">
                <div className="p-2 bg-purple-100 rounded-lg">
                  <Calendar className="h-4 w-4 text-purple-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Scheduled</p>
                  <p className="text-2xl font-bold text-purple-600">{mockStats.scheduled}</p>
                </div>
              </div>
            </Card>
          </div>

          {/* Mock Controls */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2">
                <Filter className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium text-muted-foreground">Sort by:</span>
                <Select
                  value={mockSortBy}
                  onValueChange={(value: 'priority' | 'time' | 'category') => setMockSortBy(value)}
                >
                  <Select.Trigger className="w-[140px]">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="priority">Priority</Select.Item>
                    <Select.Item value="time">Time</Select.Item>
                    <Select.Item value="category">Category</Select.Item>
                  </Select.Content>
                </Select>
              </div>
            </div>
          </div>

          {/* Mock Tabs */}
          <Tabs value={mockActiveTab} onValueChange={setMockActiveTab} className="w-full">
            <Tabs.List className="grid w-full grid-cols-5 mb-4">
              <Tabs.Trigger value="all" className="text-xs sm:text-sm">
                All ({mockStats.total})
              </Tabs.Trigger>
              <Tabs.Trigger value="running" className="text-xs sm:text-sm">
                Running ({mockStats.running})
              </Tabs.Trigger>
              <Tabs.Trigger value="pending" className="text-xs sm:text-sm">
                Pending ({mockStats.pending})
              </Tabs.Trigger>
              <Tabs.Trigger value="scheduled" className="text-xs sm:text-sm">
                Scheduled ({mockStats.scheduled})
              </Tabs.Trigger>
              <Tabs.Trigger value="completed" className="text-xs sm:text-sm">
                Completed ({mockStats.completed})
              </Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value={mockActiveTab} className="mt-0">
              {sortedMockJobs.length === 0 ? (
                <div className="text-center py-12">
                  <div className="space-y-4">
                    <Zap className="h-12 w-12 mx-auto text-muted-foreground" />
                    <h3 className="text-lg font-semibold">No jobs found</h3>
                    <p className="text-muted-foreground max-w-sm mx-auto">
                      {mockActiveTab === 'all'
                        ? "You're all caught up! Add a new job to get started."
                        : `No ${mockActiveTab} jobs found. Try changing the tab or add a new job.`}
                    </p>
                    <Button onClick={() => setShowCreateMockModal(true)}>
                      <Plus className="h-4 w-4 mr-2" />
                      Add New Job
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {sortedMockJobs.map((job) => (
                    <Card
                      key={job.id}
                      className="relative overflow-hidden hover:shadow-md transition-all duration-200 border-l-4"
                      style={{ borderLeftColor: getStatusColor(job.status).replace('bg-', '') }}
                    >
                      <Card.Header className="pb-3">
                        <div className="flex items-start justify-between">
                          <div className="flex items-start space-x-3 flex-1 min-w-0">
                            <div className={`p-2 rounded-lg ${job.color} bg-opacity-10 flex-shrink-0`}>
                              <job.icon className={`h-5 w-5 ${job.color.replace('bg-', 'text-')}`} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <Card.Title className="text-base font-semibold truncate">{job.title}</Card.Title>
                              <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                                {job.description}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center space-x-2 flex-shrink-0">
                            <Badge
                              variant="secondary"
                              className={`${getPriorityColor(job.priority)} text-white text-xs`}
                            >
                              {getPriorityText(job.priority)}
                            </Badge>
                          </div>
                        </div>
                      </Card.Header>

                      <Card.Content className="space-y-4">
                        {/* Progress bar for running jobs */}
                        {job.status === 'running' && job.progress !== undefined && (
                          <div className="space-y-2">
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Progress</span>
                              <span className="font-medium">{job.progress}%</span>
                            </div>
                            <Progress value={job.progress} className="h-2" />
                          </div>
                        )}

                        {/* Time and category info */}
                        <div className="flex items-center justify-between text-sm">
                          <div className="flex items-center space-x-1">
                            <Timer className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">{job.estimatedDuration} min</span>
                          </div>
                          {job.scheduledFor && (
                            <div className="flex items-center space-x-1">
                              <CalendarDays className="h-4 w-4 text-muted-foreground" />
                              <span className="text-muted-foreground">{formatMockTime(job.scheduledFor)}</span>
                            </div>
                          )}
                        </div>

                        {/* Tags */}
                        {job.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {job.tags.slice(0, 2).map((tag, index) => (
                              <Badge key={index} variant="outline" className="text-xs">
                                {tag}
                              </Badge>
                            ))}
                            {job.tags.length > 2 && (
                              <Badge variant="outline" className="text-xs">
                                +{job.tags.length - 2}
                              </Badge>
                            )}
                          </div>
                        )}

                        {/* Action buttons */}
                        <div className="flex items-center justify-between pt-2">
                          <div className="flex items-center space-x-2">
                            {job.status === 'pending' && (
                              <Button
                                size="sm"
                                onClick={() => handleStartMockJob(job.id)}
                                className="bg-green-600 hover:bg-green-700"
                              >
                                <Play className="h-4 w-4 mr-1" />
                                Start
                              </Button>
                            )}
                            {job.status === 'running' && (
                              <>
                                <Button size="sm" variant="outline" onClick={() => handlePauseMockJob(job.id)}>
                                  <Pause className="h-4 w-4 mr-1" />
                                  Pause
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => handleCompleteMockJob(job.id)}
                                  className="bg-blue-600 hover:bg-blue-700"
                                >
                                  <CheckCircle className="h-4 w-4 mr-1" />
                                  Complete
                                </Button>
                              </>
                            )}
                            {job.status === 'failed' && (
                              <Button
                                size="sm"
                                onClick={() => handleStartMockJob(job.id)}
                                className="bg-orange-600 hover:bg-orange-700"
                              >
                                <RefreshCw className="h-4 w-4 mr-1" />
                                Retry
                              </Button>
                            )}
                          </div>
                          <div className="flex items-center space-x-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setSelectedMockJob(job);
                                setShowEditMockModal(true);
                              }}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => handleDeleteMockJob(job.id)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </Card.Content>
                    </Card>
                  ))}
                </div>
              )}
            </Tabs.Content>
          </Tabs>
        </div>
      </PageContent>

      {/* Job Details Modal */}
      <Dialog open={showEditModal} onOpenChange={setShowEditModal}>
        <Dialog.Content className="sm:max-w-[600px]">
          <Dialog.Header>
            <Dialog.Title>Job Details</Dialog.Title>
            <Dialog.Description>View and manage job information from PGBoss</Dialog.Description>
          </Dialog.Header>

          {selectedJob && (
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Job ID</Label>
                  <Input value={selectedJob.id} readOnly className="font-mono" />
                </div>
                <div className="grid gap-2">
                  <Label>Queue Name</Label>
                  <Input value={selectedJob.name} readOnly />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Status</Label>
                  <div className="flex items-center space-x-2">
                    {getStatusIcon(selectedJob.state)}
                    <Badge className={`${getPGBossStatusColor(selectedJob.state)} text-white`}>
                      {selectedJob.state.toUpperCase()}
                    </Badge>
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label>Priority</Label>
                  <Input value={selectedJob.priority || 0} readOnly />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="grid gap-2">
                  <Label>Created</Label>
                  <Input value={formatTime(selectedJob.createdOn)} readOnly />
                </div>
                <div className="grid gap-2">
                  <Label>Started</Label>
                  <Input value={selectedJob.startedOn ? formatTime(selectedJob.startedOn) : 'Not started'} readOnly />
                </div>
                <div className="grid gap-2">
                  <Label>Duration</Label>
                  <Input value={formatDuration(selectedJob.startedOn, selectedJob.completedOn)} readOnly />
                </div>
              </div>

              <div className="grid gap-2">
                <Label>Job Data</Label>
                <textarea
                  className="min-h-[100px] w-full p-3 border rounded-md bg-muted font-mono text-sm"
                  value={JSON.stringify(selectedJob.data, null, 2)}
                  readOnly
                />
              </div>

              {selectedJob.output && (
                <div className="grid gap-2">
                  <Label>Output</Label>
                  <textarea
                    className="min-h-[100px] w-full p-3 border rounded-md bg-muted font-mono text-sm"
                    value={JSON.stringify(selectedJob.output, null, 2)}
                    readOnly
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Retry Count</Label>
                  <Input value={`${selectedJob.retryCount || 0} / ${selectedJob.retryLimit || 0}`} readOnly />
                </div>
                <div className="grid gap-2">
                  <Label>Actions</Label>
                  <div className="flex space-x-2">
                    {selectedJob.state === 'active' && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => {
                            handleAction(selectedJob.id, 'complete');
                            setShowEditModal(false);
                          }}
                          className="bg-green-600 hover:bg-green-700"
                        >
                          <CheckCircle className="h-4 w-4 mr-1" />
                          Complete
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            handleAction(selectedJob.id, 'fail');
                            setShowEditModal(false);
                          }}
                        >
                          <AlertCircle className="h-4 w-4 mr-1" />
                          Fail
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          <Dialog.Footer>
            <Button variant="outline" onClick={() => setShowEditModal(false)}>
              Close
            </Button>
            {selectedJob && (
              <Button
                variant="destructive"
                onClick={() => {
                  handleAction(selectedJob.id, 'delete');
                  setShowEditModal(false);
                }}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Job
              </Button>
            )}
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>

      {/* Create Mock Job Modal */}
      <Dialog open={showCreateMockModal} onOpenChange={setShowCreateMockModal}>
        <Dialog.Content className="sm:max-w-[500px]">
          <Dialog.Header>
            <Dialog.Title>Add New Job</Dialog.Title>
            <Dialog.Description>Create a new task for your personal assistant to handle.</Dialog.Description>
          </Dialog.Header>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="title">Job Title</Label>
              <Input id="title" placeholder="e.g., Morning Workout" />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="description">Description</Label>
              <Input id="description" placeholder="Brief description of the task" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="priority">Priority</Label>
                <Select>
                  <Select.Trigger>
                    <Select.Value placeholder="Select priority" />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="low">Low</Select.Item>
                    <Select.Item value="medium">Medium</Select.Item>
                    <Select.Item value="high">High</Select.Item>
                    <Select.Item value="urgent">Urgent</Select.Item>
                  </Select.Content>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="category">Category</Label>
                <Select>
                  <Select.Trigger>
                    <Select.Value placeholder="Select category" />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="personal">Personal</Select.Item>
                    <Select.Item value="work">Work</Select.Item>
                    <Select.Item value="health">Health</Select.Item>
                    <Select.Item value="learning">Learning</Select.Item>
                    <Select.Item value="entertainment">Entertainment</Select.Item>
                    <Select.Item value="travel">Travel</Select.Item>
                    <Select.Item value="shopping">Shopping</Select.Item>
                  </Select.Content>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="duration">Duration (minutes)</Label>
                <Input id="duration" type="number" placeholder="30" />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="schedule">Schedule</Label>
                <Input id="schedule" type="datetime-local" />
              </div>
            </div>
          </div>

          <Dialog.Footer>
            <Button variant="outline" onClick={() => setShowCreateMockModal(false)}>
              Cancel
            </Button>
            <Button onClick={() => setShowCreateMockModal(false)}>Create Job</Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>

      {/* Edit Mock Job Modal */}
      <Dialog open={showEditMockModal} onOpenChange={setShowEditMockModal}>
        <Dialog.Content className="sm:max-w-[500px]">
          <Dialog.Header>
            <Dialog.Title>Edit Job</Dialog.Title>
            <Dialog.Description>Update the details of this job.</Dialog.Description>
          </Dialog.Header>

          {selectedMockJob && (
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="edit-title">Job Title</Label>
                <Input id="edit-title" defaultValue={selectedMockJob.title} />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="edit-description">Description</Label>
                <Input id="edit-description" defaultValue={selectedMockJob.description} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="edit-priority">Priority</Label>
                  <Select defaultValue={selectedMockJob.priority}>
                    <Select.Trigger>
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="low">Low</Select.Item>
                      <Select.Item value="medium">Medium</Select.Item>
                      <Select.Item value="high">High</Select.Item>
                      <Select.Item value="urgent">Urgent</Select.Item>
                    </Select.Content>
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="edit-category">Category</Label>
                  <Select defaultValue={selectedMockJob.category}>
                    <Select.Trigger>
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="personal">Personal</Select.Item>
                      <Select.Item value="work">Work</Select.Item>
                      <Select.Item value="health">Health</Select.Item>
                      <Select.Item value="learning">Learning</Select.Item>
                      <Select.Item value="entertainment">Entertainment</Select.Item>
                      <Select.Item value="travel">Travel</Select.Item>
                      <Select.Item value="shopping">Shopping</Select.Item>
                    </Select.Content>
                  </Select>
                </div>
              </div>
            </div>
          )}

          <Dialog.Footer>
            <Button variant="outline" onClick={() => setShowEditMockModal(false)}>
              Cancel
            </Button>
            <Button onClick={() => setShowEditMockModal(false)}>Save Changes</Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  );
}
