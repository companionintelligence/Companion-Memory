import { useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Badge, Card } from '@ci/shadcn';
import { ArrowLeft, FileText, User, Calendar, MapPin, Tag } from '@ci/shadcn/icons';

import { PageContent } from '@/components/layout';
import { useAuth } from '@/hooks';

interface EntityData {
  id: string;
  type: string;
  title: string;
  content?: string;
  metadata?: Record<string, any>;
  path?: string;
  created_at?: string;
  updated_at?: string;
  tags?: string[];
}

export function EntityPage() {
  const { type, id } = useParams<{ type: string; id: string }>();
  const navigate = useNavigate();
  const [{ authToken }] = useAuth();
  
  const [entity, setEntity] = useState<EntityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  usePageTitle(entity ? `${entity.title} - Entity` : 'Entity - Companion Intelligence');

  useEffect(() => {
    const fetchEntity = async () => {
      if (!type || !id || !authToken) return;

      setLoading(true);
      setError(null);

      try {
        // This would be replaced with actual API call
        // For now, create a mock entity based on the type and id
        const mockEntity: EntityData = {
          id,
          type,
          title: `${type.charAt(0).toUpperCase() + type.slice(1)} Entity`,
          content: `This is a detailed view of a ${type} entity with ID ${id}. In a real implementation, this would fetch detailed information about the specific entity from the backend.`,
          metadata: {
            source: 'search_result',
            relevance: 0.95,
          },
          path: `/entities/${type}/${id}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          tags: ['entity', type, 'search-result'],
        };

        setEntity(mockEntity);
      } catch (err) {
        setError('Failed to load entity details');
        console.error('Error fetching entity:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchEntity();
  }, [type, id, authToken]);

  const getEntityIcon = (entityType: string) => {
    switch (entityType.toLowerCase()) {
      case 'file':
      case 'document':
        return <FileText className="h-5 w-5" />;
      case 'person':
      case 'user':
        return <User className="h-5 w-5" />;
      case 'event':
        return <Calendar className="h-5 w-5" />;
      case 'location':
      case 'place':
        return <MapPin className="h-5 w-5" />;
      default:
        return <FileText className="h-5 w-5" />;
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <PageContent>
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading entity details...</p>
          </div>
        </div>
      </PageContent>
    );
  }

  if (error || !entity) {
    return (
      <PageContent>
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <p className="text-destructive mb-4">{error || 'Entity not found'}</p>
            <Button onClick={() => navigate('/search')} variant="outline">
              Back to Search
            </Button>
          </div>
        </div>
      </PageContent>
    );
  }

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item>
              <Breadcrumb.Link href="/">Home</Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator />
            <Breadcrumb.Item>
              <Breadcrumb.Link href="/search">Search</Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator />
            <Breadcrumb.Item>
              <Breadcrumb.Page>
                {entity.type.charAt(0).toUpperCase() + entity.type.slice(1)}
              </Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(-1)}
            className="gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          
          <div className="flex items-center gap-2">
            {getEntityIcon(entity.type)}
            <h1 className="text-2xl font-bold">{entity.title}</h1>
            <Badge variant="secondary">{entity.type}</Badge>
          </div>
        </div>

        {/* Entity Details */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2">
            <Card className="p-6">
              <h2 className="text-lg font-semibold mb-4">Content</h2>
              <div className="prose dark:prose-invert max-w-none">
                <p>{entity.content}</p>
              </div>
            </Card>
          </div>

          {/* Sidebar - Metadata */}
          <div className="space-y-4">
            {/* Tags */}
            {entity.tags && entity.tags.length > 0 && (
              <Card className="p-4">
                <h3 className="font-medium mb-3 flex items-center gap-2">
                  <Tag className="h-4 w-4" />
                  Tags
                </h3>
                <div className="flex flex-wrap gap-1">
                  {entity.tags.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </Card>
            )}

            {/* Metadata */}
            <Card className="p-4">
              <h3 className="font-medium mb-3">Details</h3>
              <div className="space-y-2 text-sm">
                <div>
                  <span className="text-muted-foreground">ID:</span>
                  <span className="ml-2 font-mono text-xs">{entity.id}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Type:</span>
                  <span className="ml-2">{entity.type}</span>
                </div>
                {entity.path && (
                  <div>
                    <span className="text-muted-foreground">Path:</span>
                    <span className="ml-2 font-mono text-xs">{entity.path}</span>
                  </div>
                )}
                {entity.created_at && (
                  <div>
                    <span className="text-muted-foreground">Created:</span>
                    <span className="ml-2">{formatDate(entity.created_at)}</span>
                  </div>
                )}
                {entity.updated_at && (
                  <div>
                    <span className="text-muted-foreground">Updated:</span>
                    <span className="ml-2">{formatDate(entity.updated_at)}</span>
                  </div>
                )}
              </div>
            </Card>

            {/* Metadata object */}
            {entity.metadata && Object.keys(entity.metadata).length > 0 && (
              <Card className="p-4">
                <h3 className="font-medium mb-3">Metadata</h3>
                <div className="space-y-2 text-sm">
                  {Object.entries(entity.metadata).map(([key, value]) => (
                    <div key={key}>
                      <span className="text-muted-foreground">{key}:</span>
                      <span className="ml-2">{String(value)}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="mt-8 flex gap-2">
          <Button variant="outline">
            Edit Entity
          </Button>
          <Button variant="outline">
            Share
          </Button>
          <Button variant="outline">
            Export
          </Button>
        </div>
      </PageContent>
    </>
  );
}