import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Input, Table, Badge, Sheet } from '@ci/shadcn';
import { AlertCircle, Search, Loader2, Star, BookmarkPlus, Menu, Sparkles } from '@ci/shadcn/icons';

import { PageContent } from '@/components/layout';
import { TagInput } from '@/components/TagInput';
import { SmartSearchBuilder, type SearchFilter } from '@/components/SmartSearchBuilder';
import { useAuth, useSavedSearches } from '@/hooks';

interface SearchResult {
  text: string;
  type: string;
  id: string;
  path: string;
}

export function SearchPage() {
  usePageTitle('Search - Companion Intelligence');
  const [{ authToken }] = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { savedSearches, createSavedSearch } = useSavedSearches();

  // Get initial query from URL params
  const initialQuery = searchParams.get('q') || '';
  
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(!!initialQuery);
  const [showSavedSearches, setShowSavedSearches] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveTags, setSaveTags] = useState<string[]>([]);
  const [showSmartSearch, setShowSmartSearch] = useState(false);
  const [smartFilters, setSmartFilters] = useState<SearchFilter[]>([]);

  // Perform search when component mounts if there's an initial query
  useEffect(() => {
    if (initialQuery) {
      performSearch(initialQuery);
    }
  }, [initialQuery, authToken]);

  // Update URL params when search query changes
  const updateSearchParams = (query: string) => {
    const params = new URLSearchParams(searchParams);
    if (query) {
      params.set('q', query);
    } else {
      params.delete('q');
    }
    setSearchParams(params);
  };

  const performSearch = async (query?: string) => {
    const searchTerm = query || searchQuery;
    if (!searchTerm.trim()) {
      setError('Please enter a search query');
      return;
    }

    try {
      console.log('SearchPage: Starting search with query:', searchTerm);
      setLoading(true);
      setError(null);
      setHasSearched(true);
      
      // Update URL with search query
      updateSearchParams(searchTerm);

      console.log('SearchPage: Making API request to search service');
      const response = await fetch(`/api/embeddings/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: searchTerm,
        }),
      });

      if (!response.ok) {
        console.error(
          `SearchPage: API request failed with status ${response.status}: ${response.statusText}`,
        );
        if (response.status === 401) {
          throw new Error('Unauthorized: You do not have permission to access this resource');
        } else if (response.status === 403) {
          throw new Error('Forbidden: Access denied');
        } else if (response.status === 404) {
          throw new Error('API endpoint not found');
        } else if (response.status >= 500) {
          throw new Error('Server error: Please try again later');
        } else {
          throw new Error(`Error performing search: ${response.statusText}`);
        }
      }

      console.log('SearchPage: API request successful, parsing response');

      const data = await response.json();

      // Handle both array response and paginated response
      let resultsData: SearchResult[] = [];

      if (Array.isArray(data)) {
        resultsData = data;
      } else if (data.data && Array.isArray(data.data)) {
        resultsData = data.data;
      } else {
        console.error('SearchPage: Invalid response format', data);

        throw new Error('Invalid response format: Expected an array of search results');
      }

      console.log(`SearchPage: Successfully found ${resultsData.length} results`, resultsData);

      setSearchResults(resultsData);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';

      console.error('SearchPage: Error in performSearch():', errorMessage, err);

      setError(errorMessage);
    } finally {
      console.log('SearchPage: Search operation completed');
      setLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      performSearch();
    }
  };

  const handleSearchQueryChange = (value: string) => {
    setSearchQuery(value);
  };

  const handleSavedSearchSelect = (savedSearch: any) => {
    setSearchQuery(savedSearch.query);
    updateSearchParams(savedSearch.query);
    performSearch(savedSearch.query);
    setShowSavedSearches(false);
  };

  const handleSaveSearch = async () => {
    if (!saveName.trim() || !searchQuery.trim()) return;

    try {
      await createSavedSearch({
        name: saveName,
        query: searchQuery,
        tags: saveTags,
        is_smart_search: smartFilters.length > 0,
        filters: smartFilters.length > 0 ? { conditions: smartFilters } : undefined,
      });
      setSaveName('');
      setSaveTags([]);
      setShowSaveDialog(false);
    } catch (error) {
      console.error('Failed to save search:', error);
    }
  };

  const handleSmartSearchApply = (filters: SearchFilter[]) => {
    // Convert smart search filters to a query string
    const query = filters.map(f => `${f.field}:${f.operator}:${f.value}`).join(' AND ');
    setSearchQuery(query);
    updateSearchParams(query);
    performSearch(query);
  };

  const handleResultClick = (result: SearchResult) => {
    // Navigate to the entity page
    navigate(`/entity/${result.type}/${result.id}`);
  };

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
              <Breadcrumb.Page>Search</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        {/* Search Input */}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setShowSavedSearches(true)}
            className="shrink-0"
          >
            <Menu className="h-4 w-4" />
          </Button>
          <Input
            type="text"
            placeholder="Enter your search query..."
            value={searchQuery}
            onChange={(e) => handleSearchQueryChange(e.target.value)}
            onKeyPress={handleKeyPress}
            className="flex-1"
            disabled={loading}
            autoFocus
          />
          <Button
            variant="outline"
            size="icon"
            onClick={() => setShowSmartSearch(!showSmartSearch)}
            className={`shrink-0 ${showSmartSearch ? 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300' : ''}`}
          >
            <Sparkles className="h-4 w-4" />
          </Button>
          <Button onClick={() => performSearch()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            <span className="ml-2">Search</span>
          </Button>
          {hasSearched && searchResults.length > 0 && (
            <Button
              variant="outline"
              onClick={() => setShowSaveDialog(true)}
              disabled={loading}
            >
              <BookmarkPlus className="h-4 w-4 mr-2" />
              Save
            </Button>
          )}
        </div>

        {/* Smart Search Builder */}
        {showSmartSearch && (
          <div className="border border-purple-200 dark:border-purple-800 rounded-lg p-4 bg-purple-50/50 dark:bg-purple-900/20">
            <SmartSearchBuilder
              filters={smartFilters}
              onFiltersChange={setSmartFilters}
              onApply={handleSmartSearchApply}
            />
          </div>
        )}

        {/* Quick Save Dialog */}
        {showSaveDialog && (
          <div className="bg-muted/50 border border-border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Save Search</h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowSaveDialog(false)}
              >
                ×
              </Button>
            </div>
            <div className="space-y-3">
              <Input
                placeholder="Enter a name for this search..."
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && saveTags.length === 0 && handleSaveSearch()}
              />
              <TagInput
                tags={saveTags}
                onTagsChange={setSaveTags}
                placeholder="Add tags to organize your search..."
              />
              <div className="flex justify-end gap-2">
                <Button 
                  variant="outline" 
                  onClick={() => setShowSaveDialog(false)}
                >
                  Cancel
                </Button>
                <Button onClick={handleSaveSearch} disabled={!saveName.trim()}>
                  Save Search
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md p-4 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="font-medium">Error performing search</h3>
              <p className="text-sm">{error}</p>
            </div>
          </div>
        )}

        {/* Results Display */}
        {hasSearched && !error && (
          <>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">
                {searchResults.length > 0 ? `Found ${searchResults.length} results` : 'No results found'}
              </h3>
              {searchResults.length > 0 && (
                <span className="text-sm text-muted-foreground">
                  Sorted by relevance (lower distance = more relevant)
                </span>
              )}
            </div>

            {searchResults.length > 0 ? (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Type</Table.Head>
                    <Table.Head>ID</Table.Head>
                    <Table.Head>Data Path</Table.Head>
                    <Table.Head>Content</Table.Head>
                    <Table.Head className="w-20">Actions</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {searchResults.map((result) => (
                    <Table.Row 
                      key={result.id}
                      className="cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => handleResultClick(result)}
                    >
                      <Table.Cell>
                        <Badge variant="outline">{result.type}</Badge>
                      </Table.Cell>
                      <Table.Cell className="font-mono text-xs">
                        {result.id}
                      </Table.Cell>
                      <Table.Cell className="max-w-md truncate">
                        <span className="text-muted-foreground">{result.path}</span>
                      </Table.Cell>
                      <Table.Cell className="max-w-lg">
                        <p className="truncate text-sm">{result.text}</p>
                      </Table.Cell>
                      <Table.Cell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleResultClick(result);
                          }}
                        >
                          View
                        </Button>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            ) : (
              hasSearched && (
                <div className="text-center py-8 text-muted-foreground">
                  <p>No results found for your search query.</p>
                  <p className="text-sm mt-2">Try using different keywords or a more general search term.</p>
                </div>
              )
            )}
          </>
        )}

        {/* Initial State */}
        {!hasSearched && !error && (
          <div className="text-center py-12 text-muted-foreground">
            <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-lg">Enter a search query to find relevant content</p>
            <p className="text-sm mt-2">The search uses semantic similarity to find related information</p>
          </div>
        )}
      </PageContent>

      {/* Saved Searches Sheet */}
      <Sheet open={showSavedSearches} onOpenChange={setShowSavedSearches}>
        <Sheet.Content side="left" className="w-80">
          <Sheet.Header>
            <Sheet.Title>Saved Searches</Sheet.Title>
            <Sheet.Description>
              Your saved search queries and smart searches
            </Sheet.Description>
          </Sheet.Header>
          
          <div className="mt-6 space-y-4">
            {savedSearches.map((savedSearch) => (
              <div
                key={savedSearch.id}
                className="p-3 border border-border rounded-lg cursor-pointer hover:bg-muted/50 transition-colors"
                onClick={() => handleSavedSearchSelect(savedSearch)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h4 className="text-sm font-medium">{savedSearch.name}</h4>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {savedSearch.query}
                    </p>
                    {savedSearch.description && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {savedSearch.description}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-1 mt-2">
                      {savedSearch.is_smart_search && (
                        <Badge variant="secondary" className="text-xs">
                          <Star className="h-3 w-3 mr-1" />
                          Smart
                        </Badge>
                      )}
                      {savedSearch.tags.map((tag) => (
                        <Badge key={tag.id} variant="outline" className="text-xs">
                          {tag.label}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}

            {savedSearches.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <Search className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No saved searches yet</p>
                <p className="text-xs mt-1">Save searches to quickly access them later</p>
              </div>
            )}
          </div>
        </Sheet.Content>
      </Sheet>
    </>
  );
}
