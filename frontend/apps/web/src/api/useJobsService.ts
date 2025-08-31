import { useEffect, useState, useCallback } from 'react';

export interface JobInfo {
  id: string;
  name: string;
  state: 'created' | 'retry' | 'active' | 'completed' | 'expired' | 'cancelled' | 'failed';
  priority?: number;
  data: any;
  createdOn: Date;
  startedOn?: Date;
  completedOn?: Date;
  retryCount?: number;
  retryLimit?: number;
  output?: any;
}

export interface QueueStats {
  total: number;
  active: number;
  completed: number;
  failed: number;
  retry: number;
  cancelled: number;
  created: number;
}

export interface JobsResponse {
  jobs: JobInfo[];
  stats: QueueStats;
}

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

export function useJobsService() {
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [stats, setStats] = useState<QueueStats>({
    total: 0,
    active: 0,
    completed: 0,
    failed: 0,
    retry: 0,
    cancelled: 0,
    created: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const getAuthHeaders = () => {
    const token = localStorage.getItem('authToken');
    return {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    };
  };

  const fetchJobs = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await fetch(`${API_BASE_URL}/jobs`, {
        headers: getAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch jobs: ${response.statusText}`);
      }

      const data: JobsResponse = await response.json();
      
      // Convert date strings to Date objects
      const jobsWithDates = data.jobs.map(job => ({
        ...job,
        createdOn: new Date(job.createdOn),
        startedOn: job.startedOn ? new Date(job.startedOn) : undefined,
        completedOn: job.completedOn ? new Date(job.completedOn) : undefined,
      }));

      setJobs(jobsWithDates);
      setStats(data.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch jobs');
      console.error('Error fetching jobs:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const updateJobStatus = async (jobId: string, status: 'completed' | 'failed') => {
    try {
      const response = await fetch(`${API_BASE_URL}/jobs/${jobId}/${status}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to update job: ${response.statusText}`);
      }

      // Refresh jobs after update
      await fetchJobs();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update job');
      console.error('Error updating job:', err);
      return false;
    }
  };

  const deleteJob = async (jobId: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/jobs/${jobId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to delete job: ${response.statusText}`);
      }

      // Refresh jobs after deletion
      await fetchJobs();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete job');
      console.error('Error deleting job:', err);
      return false;
    }
  };

  const createJob = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/jobs`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to create job: ${response.statusText}`);
      }

      const result = await response.json();
      
      // Refresh jobs after creation
      await fetchJobs();
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create job');
      console.error('Error creating job:', err);
      return null;
    }
  };

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  return {
    jobs,
    stats,
    loading,
    error,
    fetchJobs,
    updateJobStatus,
    deleteJob,
    createJob,
  };
}