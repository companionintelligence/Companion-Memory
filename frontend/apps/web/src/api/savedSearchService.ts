export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  description?: string;
  filters?: Record<string, any>;
  is_smart_search: boolean;
  tags: Tag[];
  created_at: string;
  updated_at: string;
}

export interface Tag {
  id: string;
  label: string;
}

export interface CreateSavedSearchRequest {
  name: string;
  query: string;
  description?: string;
  filters?: Record<string, any>;
  is_smart_search?: boolean;
  tags?: string[];
}

export interface UpdateSavedSearchRequest {
  name?: string;
  query?: string;
  description?: string;
  filters?: Record<string, any>;
  is_smart_search?: boolean;
  tags?: string[];
}

export class SavedSearchService {
  constructor(private authToken: string) {}

  async findAll(): Promise<SavedSearch[]> {
    const response = await fetch('/api/saved-searches', {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch saved searches');
    }
    
    return response.json();
  }

  async findById(id: string): Promise<SavedSearch> {
    const response = await fetch(`/api/saved-searches/${id}`, {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch saved search');
    }
    
    return response.json();
  }

  async create(request: CreateSavedSearchRequest): Promise<SavedSearch> {
    const response = await fetch('/api/saved-searches', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    
    if (!response.ok) {
      throw new Error('Failed to create saved search');
    }
    
    return response.json();
  }

  async update(id: string, request: UpdateSavedSearchRequest): Promise<SavedSearch> {
    const response = await fetch(`/api/saved-searches/${id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    
    if (!response.ok) {
      throw new Error('Failed to update saved search');
    }
    
    return response.json();
  }

  async delete(id: string): Promise<void> {
    const response = await fetch(`/api/saved-searches/${id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });
    
    if (!response.ok) {
      throw new Error('Failed to delete saved search');
    }
  }

  async getTagSuggestions(): Promise<string[]> {
    const response = await fetch('/api/saved-searches/tags/suggestions', {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch tag suggestions');
    }
    
    return response.json();
  }
}