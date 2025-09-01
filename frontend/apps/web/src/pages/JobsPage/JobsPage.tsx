import React, { useState, useEffect } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Card, Badge, Dialog, Input, Label, Select, Progress, Tabs } from '@ci/shadcn';
import {
  Clock,
  Play,
  Pause,
  CheckCircle,
  Calendar,
  Plus,
  Edit,
  Trash2,
  RefreshCw,
  Zap,
  CalendarDays,
  Timer,
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
  Database,
  Activity,
  AlertCircle,
  XCircle,
  Hash,
  Info,
} from '@ci/shadcn/icons';

import { PageContent } from '@/components/layout';
import { JobsService, type PgBossJob } from '@/services/jobsService';

// Map PGboss job types to display information
const getJobIcon = (jobName: string) => {
  if (jobName.includes('file') || jobName.includes('upload')) return FileText;
  if (jobName.includes('chat') || jobName.includes('message')) return Users;
  if (jobName.includes('sync') || jobName.includes('connection')) return RefreshCw;
  if (jobName.includes('infer') || jobName.includes('question')) return BookOpen;
  if (jobName.includes('api')) return Database;
  return Activity;
};

const getJobColor = (jobName: string) => {
  if (jobName.includes('file') || jobName.includes('upload')) return 'bg-blue-500';
  if (jobName.includes('chat') || jobName.includes('message')) return 'bg-green-500';
  if (jobName.includes('sync') || jobName.includes('connection')) return 'bg-purple-500';
  if (jobName.includes('infer') || jobName.includes('question')) return 'bg-orange-500';
  if (jobName.includes('api')) return 'bg-cyan-500';
  return 'bg-gray-500';
};

export function JobsPage() {
  usePageTitle('Jobs Queue - Companion Intelligence');

  const [jobs, setJobs] = useState<PgBossJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<PgBossJob | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [activeTab, setActiveTab] = useState('all');
  const [sortBy, setSortBy] = useState<'priority' | 'created' | 'name'>('created');

  const fetchJobs = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await JobsService.getJobs();
      setJobs(response.jobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch jobs');
      setJobs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    
    // Refresh jobs every 30 seconds
    const interval = setInterval(fetchJobs, 30000);
    return () => clearInterval(interval);
  }, []);

  const getStatusColor = (state: PgBossJob['state']) => {
    switch (state) {
      case 'active':
        return 'bg-blue-500';
      case 'completed':
        return 'bg-green-500';
      case 'failed':
        return 'bg-red-500';
      case 'cancelled':
        return 'bg-gray-500';
      default:
        return 'bg-yellow-500';
    }
  };

  const getPriorityColor = (priority: number) => {
    if (priority >= 10) return 'bg-red-500';
    if (priority >= 5) return 'bg-orange-500';
    if (priority >= 0) return 'bg-yellow-500';
    return 'bg-gray-500';
  };

  const getPriorityText = (priority: number) => {
    if (priority >= 10) return 'High';
    if (priority >= 5) return 'Medium';
    if (priority >= 0) return 'Low';
    return 'Normal';
  };

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getFilteredJobs = (tab: string) => {
    if (tab === 'all') {
      return jobs;
    }

    return jobs.filter((job) => job.state === tab);
  };

  const sortedJobs = [...getFilteredJobs(activeTab)].sort((a, b) => {
    switch (sortBy) {
      case 'priority':
        return b.priority - a.priority;
      case 'created':
        return new Date(b.createdOn).getTime() - new Date(a.createdOn).getTime();
      case 'name':
        return a.name.localeCompare(b.name);
      default:
        return 0;
    }
  });

  const stats = {
    total: jobs.length,
    active: jobs.filter((j) => j.state === 'active').length,
    created: jobs.filter((j) => j.state === 'created').length,
    completed: jobs.filter((j) => j.state === 'completed').length,
    failed: jobs.filter((j) => j.state === 'failed').length,
    cancelled: jobs.filter((j) => j.state === 'cancelled').length,
  };

  const handleCreateJob = async () => {
    try {
      await JobsService.createJob();
      await fetchJobs();
      setShowCreateModal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create job');
    }
  };

  const handleCancelJob = async (jobId: string) => {
    try {
      await JobsService.cancelJob(jobId);
      await fetchJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel job');
    }
  };

  const handleResumeJob = async (jobId: string) => {
    try {
      await JobsService.resumeJob(jobId);
      await fetchJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resume job');
    }
  };

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
              <Breadcrumb.Page>PGboss Job Queue</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        {/* Header Section */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">PGboss Job Queue</h1>
            <p className="text-muted-foreground mt-1">Monitor and manage background jobs in the CI system</p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={fetchJobs} variant="outline" size="sm" disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button onClick={() => setShowCreateModal(true)} className="w-full lg:w-auto">
              <Plus className="h-4 w-4 mr-2" />
              Create Test Job
            </Button>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <Card className="mb-4 border-red-200 bg-red-50">
            <Card.Header className="pb-3">
              <div className="flex items-center space-x-2 text-red-600">
                <AlertCircle className="h-4 w-4" />
                <span className="font-medium">Error</span>
              </div>
              <p className="text-sm text-red-600 mt-1">{error}</p>
            </Card.Header>
          </Card>
        )}

        {/* Stats Overview */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-4">
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Target className="h-4 w-4 text-blue-600" />
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
                <Play className="h-4 w-4 text-blue-600" />
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
                <Clock className="h-4 w-4 text-yellow-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Queued</p>
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
                <XCircle className="h-4 w-4 text-red-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Failed</p>
                <p className="text-2xl font-bold text-red-600">{stats.failed}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-gray-100 rounded-lg">
                <Pause className="h-4 w-4 text-gray-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Cancelled</p>
                <p className="text-2xl font-bold text-gray-600">{stats.cancelled}</p>
              </div>
            </div>
          </Card>
        </div>

        {/* Controls */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium text-muted-foreground">Sort by:</span>
              <Select
                value={sortBy}
                onValueChange={(value: 'priority' | 'created' | 'name') => setSortBy(value)}
              >
                <Select.Trigger className="w-[140px]">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="created">Created Time</Select.Item>
                  <Select.Item value="priority">Priority</Select.Item>
                  <Select.Item value="name">Job Name</Select.Item>
                </Select.Content>
              </Select>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <Tabs.List className="grid w-full grid-cols-6 mb-4">
            <Tabs.Trigger value="all" className="text-xs sm:text-sm">
              All ({stats.total})
            </Tabs.Trigger>
            <Tabs.Trigger value="created" className="text-xs sm:text-sm">
              Queued ({stats.created})
            </Tabs.Trigger>
            <Tabs.Trigger value="active" className="text-xs sm:text-sm">
              Active ({stats.active})
            </Tabs.Trigger>
            <Tabs.Trigger value="completed" className="text-xs sm:text-sm">
              Completed ({stats.completed})
            </Tabs.Trigger>
            <Tabs.Trigger value="failed" className="text-xs sm:text-sm">
              Failed ({stats.failed})
            </Tabs.Trigger>
            <Tabs.Trigger value="cancelled" className="text-xs sm:text-sm">
              Cancelled ({stats.cancelled})
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value={activeTab} className="mt-0">
            {sortedJobs.length === 0 ? (
              <div className="text-center py-12">
                <div className="space-y-4">
                  <Database className="h-12 w-12 mx-auto text-muted-foreground" />
                  <h3 className="text-lg font-semibold">No jobs found</h3>
                  <p className="text-muted-foreground max-w-sm mx-auto">
                    {activeTab === 'all'
                      ? "No jobs in the queue. Create a test job to get started."
                      : `No ${activeTab} jobs found. Try changing the tab or create a new job.`}
                  </p>
                  <Button onClick={() => setShowCreateModal(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Create Test Job
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {sortedJobs.map((job) => {
                  const JobIcon = getJobIcon(job.name);
                  const jobColor = getJobColor(job.name);
                  
                  return (
                    <Card
                      key={job.id}
                      className="relative overflow-hidden hover:shadow-md transition-all duration-200 border-l-4"
                      style={{ borderLeftColor: getStatusColor(job.state).replace('bg-', '') }}
                    >
                      <Card.Header className="pb-3">
                        <div className="flex items-start justify-between">
                          <div className="flex items-start space-x-3 flex-1 min-w-0">
                            <div className={`p-2 rounded-lg ${jobColor} bg-opacity-10 flex-shrink-0`}>
                              <JobIcon className={`h-5 w-5 ${jobColor.replace('bg-', 'text-')}`} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <Card.Title className="text-base font-semibold truncate">{job.name}</Card.Title>
                              <div className="flex items-center space-x-2 mt-1">
                                <div className="flex items-center space-x-1">
                                  <Hash className="h-3 w-3 text-muted-foreground" />
                                  <span className="text-xs text-muted-foreground font-mono">{job.id.slice(0, 8)}</span>
                                </div>
                                {job.retryCount > 0 && (
                                  <Badge variant="outline" className="text-xs">
                                    Retry {job.retryCount}
                                  </Badge>
                                )}
                              </div>
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
                        {/* Job timing info */}
                        <div className="flex items-center justify-between text-sm">
                          <div className="flex items-center space-x-1">
                            <Calendar className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Created {formatDate(job.createdOn)}</span>
                          </div>
                          {job.startedOn && (
                            <div className="flex items-center space-x-1">
                              <Play className="h-4 w-4 text-muted-foreground" />
                              <span className="text-muted-foreground">Started {formatTime(job.startedOn)}</span>
                            </div>
                          )}
                        </div>

                        {/* Job status and completion info */}
                        {job.completedOn && (
                          <div className="text-sm text-green-600">
                            <div className="flex items-center space-x-1">
                              <CheckCircle className="h-4 w-4" />
                              <span>Completed {formatDate(job.completedOn)}</span>
                            </div>
                          </div>
                        )}

                        {job.failedReason && (
                          <div className="text-sm text-red-600">
                            <div className="flex items-center space-x-1">
                              <XCircle className="h-4 w-4" />
                              <span className="truncate">{job.failedReason}</span>
                            </div>
                          </div>
                        )}

                        {/* Action buttons */}
                        <div className="flex items-center justify-between pt-2">
                          <div className="flex items-center space-x-2">
                            {job.state === 'failed' && (
                              <Button
                                size="sm"
                                onClick={() => handleResumeJob(job.id)}
                                className="bg-orange-600 hover:bg-orange-700"
                              >
                                <RefreshCw className="h-4 w-4 mr-1" />
                                Retry
                              </Button>
                            )}
                            {(job.state === 'created' || job.state === 'active') && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleCancelJob(job.id)}
                                className="border-red-200 text-red-600 hover:bg-red-50"
                              >
                                <XCircle className="h-4 w-4 mr-1" />
                                Cancel
                              </Button>
                            )}
                          </div>
                          <div className="flex items-center space-x-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setSelectedJob(job);
                                setShowDetailModal(true);
                              }}
                            >
                              <Info className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </Card.Content>
                    </Card>
                  );
                })}
              </div>
            )}
          </Tabs.Content>
        </Tabs>
      </PageContent>

      {/* Create Job Modal */}
      <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
        <Dialog.Content className="sm:max-w-[400px]">
          <Dialog.Header>
            <Dialog.Title>Create Test Job</Dialog.Title>
            <Dialog.Description>
              Create a test job to demonstrate the PGboss queue system.
            </Dialog.Description>
          </Dialog.Header>

          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              This will create a test job using the API_ENQUEUE event type with sample data.
            </p>
          </div>

          <Dialog.Footer>
            <Button variant="outline" onClick={() => setShowCreateModal(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateJob}>Create Job</Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>

      {/* Job Detail Modal */}
      <Dialog open={showDetailModal} onOpenChange={setShowDetailModal}>
        <Dialog.Content className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto">
          <Dialog.Header>
            <Dialog.Title>Job Details</Dialog.Title>
            <Dialog.Description>
              Detailed information about this job
            </Dialog.Description>
          </Dialog.Header>

          {selectedJob && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs font-medium text-muted-foreground">Job ID</Label>
                  <p className="text-sm font-mono">{selectedJob.id}</p>
                </div>
                <div>
                  <Label className="text-xs font-medium text-muted-foreground">Name</Label>
                  <p className="text-sm">{selectedJob.name}</p>
                </div>
                <div>
                  <Label className="text-xs font-medium text-muted-foreground">State</Label>
                  <Badge className={`${getStatusColor(selectedJob.state)} text-white`}>
                    {selectedJob.state}
                  </Badge>
                </div>
                <div>
                  <Label className="text-xs font-medium text-muted-foreground">Priority</Label>
                  <p className="text-sm">{selectedJob.priority}</p>
                </div>
                <div>
                  <Label className="text-xs font-medium text-muted-foreground">Created</Label>
                  <p className="text-sm">{formatDate(selectedJob.createdOn)}</p>
                </div>
                {selectedJob.startedOn && (
                  <div>
                    <Label className="text-xs font-medium text-muted-foreground">Started</Label>
                    <p className="text-sm">{formatDate(selectedJob.startedOn)}</p>
                  </div>
                )}
                {selectedJob.completedOn && (
                  <div>
                    <Label className="text-xs font-medium text-muted-foreground">Completed</Label>
                    <p className="text-sm">{formatDate(selectedJob.completedOn)}</p>
                  </div>
                )}
                <div>
                  <Label className="text-xs font-medium text-muted-foreground">Retry Count</Label>
                  <p className="text-sm">{selectedJob.retryCount}</p>
                </div>
              </div>

              {selectedJob.failedReason && (
                <div>
                  <Label className="text-xs font-medium text-muted-foreground">Failure Reason</Label>
                  <Card className="p-3 bg-red-50 border-red-200 mt-1">
                    <p className="text-sm text-red-600">{selectedJob.failedReason}</p>
                  </Card>
                </div>
              )}

              <div>
                <Label className="text-xs font-medium text-muted-foreground">Job Data</Label>
                <Card className="p-3 bg-gray-50 mt-1">
                  <pre className="text-xs overflow-x-auto">
                    {JSON.stringify(selectedJob.data, null, 2)}
                  </pre>
                </Card>
              </div>
            </div>
          )}

          <Dialog.Footer>
            <Button onClick={() => setShowDetailModal(false)}>Close</Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  );
}
