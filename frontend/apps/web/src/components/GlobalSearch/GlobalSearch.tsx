import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { 
  Command
} from '@ci/shadcn';
import { Search, FileText, User, Calendar, Folder, Clock } from '@ci/shadcn/icons';

import { useAuth } from '@/hooks';

interface SearchResult {
  text: string;
  type: string;
  id: string;
  path: string;
}

interface GlobalSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GlobalSearch({ open, onOpenChange }: GlobalSearchProps) {
  const [{ authToken }] = useAuth();
  const navigate = useNavigate();
  
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Load recent searches from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem('recentSearches');
    if (stored) {
      setRecentSearches(JSON.parse(stored));
    }
  }, []);

  // Debounced search
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    if (!query.trim()) {
      setResults([]);
      return;
    }

    searchTimeoutRef.current = setTimeout(() => {
      performSearch(query);
    }, 300);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [query]);

  const performSearch = async (searchQuery: string) => {
    if (!searchQuery.trim() || !authToken) return;

    try {
      setLoading(true);
      
      const response = await fetch('/api/embeddings/search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: searchQuery,
        }),
      });

      if (!response.ok) {
        throw new Error('Search failed');
      }

      const data = await response.json();
      const resultsData = Array.isArray(data) ? data : data.data || [];
      
      setResults(resultsData.slice(0, 10)); // Limit to 10 results for the command palette
    } catch (error) {
      console.error('Search error:', error);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (result: SearchResult) => {
    // Add to recent searches
    const newRecentSearches = [query, ...recentSearches.filter(s => s !== query)].slice(0, 5);
    setRecentSearches(newRecentSearches);
    localStorage.setItem('recentSearches', JSON.stringify(newRecentSearches));

    // Navigate based on entity type
    let path = '/search';
    if (result.type === 'user') {
      path = `/users/${result.id}`;
    } else if (result.type === 'file') {
      path = `/files/${result.id}`;
    } else if (result.type === 'conversation') {
      path = `/conversations/${result.id}`;
    } else {
      // For now, navigate to search page with the query
      path = `/search?q=${encodeURIComponent(query)}`;
    }

    navigate(path);
    onOpenChange(false);
    setQuery('');
  };

  const handleRecentSearchSelect = (recentQuery: string) => {
    setQuery(recentQuery);
  };

  const getResultIcon = (type: string) => {
    switch (type.toLowerCase()) {
      case 'file':
      case 'document':
        return FileText;
      case 'user':
      case 'person':
        return User;
      case 'conversation':
      case 'chat':
        return Calendar;
      case 'folder':
      case 'directory':
        return Folder;
      default:
        return FileText;
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    onOpenChange(newOpen);
    if (!newOpen) {
      setQuery('');
      setResults([]);
    }
  };

  return (
    <Command.Dialog 
      open={open} 
      onOpenChange={handleOpenChange}
      title="Global Search"
      description="Search across all your content"
      className="max-w-2xl"
    >
      <Command.Input 
        placeholder="Search anything..." 
        value={query}
        onValueChange={setQuery}
      />
      
      <Command.List>
        <Command.Empty>
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Search className="h-4 w-4 animate-spin mr-2" />
              Searching...
            </div>
          ) : (
            <div className="py-6">
              <Search className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No results found</p>
              <p className="text-xs text-muted-foreground mt-1">
                Try different keywords or check your spelling
              </p>
            </div>
          )}
        </Command.Empty>

        {!query && recentSearches.length > 0 && (
          <Command.Group heading="Recent Searches">
            {recentSearches.map((recentQuery, index) => (
              <Command.Item
                key={index}
                value={recentQuery}
                onSelect={() => handleRecentSearchSelect(recentQuery)}
              >
                <Clock className="h-4 w-4" />
                <span>{recentQuery}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {results.length > 0 && (
          <Command.Group heading="Search Results">
            {results.map((result) => {
              const IconComponent = getResultIcon(result.type);
              return (
                <Command.Item
                  key={result.id}
                  value={`${result.text} ${result.type}`}
                  onSelect={() => handleSelect(result)}
                >
                  <IconComponent className="h-4 w-4" />
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="truncate">{result.text}</span>
                    <span className="text-xs text-muted-foreground capitalize">
                      {result.type} • {result.path}
                    </span>
                  </div>
                </Command.Item>
              );
            })}
          </Command.Group>
        )}

        {!query && (
          <Command.Group heading="Quick Actions">
            <Command.Item onSelect={() => navigate('/search')}>
              <Search className="h-4 w-4" />
              <span>Advanced Search</span>
              <Command.Shortcut>/</Command.Shortcut>
            </Command.Item>
            <Command.Item onSelect={() => navigate('/files')}>
              <Folder className="h-4 w-4" />
              <span>Browse Files</span>
            </Command.Item>
            <Command.Item onSelect={() => navigate('/chat')}>
              <Calendar className="h-4 w-4" />
              <span>Start New Conversation</span>
            </Command.Item>
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}