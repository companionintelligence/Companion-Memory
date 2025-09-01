// Service for interacting with the jobs API
const API_BASE_URL = '/api/jobs';

export interface PgBossJob {
  id: string;
  name: string;
  data: Record<string, any>;
  state: 'created' | 'active' | 'completed' | 'failed' | 'cancelled';
  priority: number;
  createdOn: string;
  startedOn?: string;
  completedOn?: string;
  failedReason?: string;
  retryCount: number;
  expireIn?: string;
  queue?: string;
}

export interface JobsResponse {
  jobs: PgBossJob[];
  total: number;
}

export class JobsService {
  static async getJobs(queue?: string, limit = 100): Promise<JobsResponse> {
    const params = new URLSearchParams();
    if (queue) params.append('queue', queue);
    params.append('limit', limit.toString());
    
    const url = `${API_BASE_URL}?${params.toString()}`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch jobs');
    }

    return response.json();
  }

  static async getJob(id: string): Promise<{ job: PgBossJob }> {
    const response = await fetch(`${API_BASE_URL}/${id}`, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch job');
    }

    return response.json();
  }

  static async createJob(): Promise<{ id: string }> {
    const response = await fetch(API_BASE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error('Failed to create job');
    }

    return response.json();
  }

  static async cancelJob(id: string): Promise<{ success: boolean }> {
    const response = await fetch(`${API_BASE_URL}/${id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error('Failed to cancel job');
    }

    return response.json();
  }

  static async resumeJob(id: string): Promise<{ success: boolean }> {
    const response = await fetch(`${API_BASE_URL}/${id}/resume`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error('Failed to resume job');
    }

    return response.json();
  }
}