import { useState, useCallback } from 'react';

import { Dialog, Button, Input, Textarea, cn } from '@ci/shadcn';
import { User, MapPin, Package, Calendar, FileText } from '@ci/shadcn/icons';

import { useAuth } from '@/hooks';

interface Props {
  open?: boolean;
  onClose?: () => void;
  onMemoryAdded?: () => void;
}

type MemoryType = 'person' | 'place' | 'thing' | 'event' | 'content';

export function AddMemoryModal({ open = false, onClose, onMemoryAdded }: Props) {
  const [{ authToken }] = useAuth();

  const [selectedType, setSelectedType] = useState<MemoryType>('event');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [tags, setTags] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    // Reset form
    setSelectedType('event');
    setTitle('');
    setDescription('');
    setLocation('');
    setTags('');
    setError(null);
    // Clear file input
    const input = document.getElementById('file-input') as HTMLInputElement;
    if (input) {
      input.value = '';
    }

    onClose?.();
  }, [onClose]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      if (!title.trim()) {
        setError('Title is required');

        return;
      }

      try {
        let fileData = null;

        // If file is selected, upload it first (for any memory type)
        const input = document.getElementById('file-input') as HTMLInputElement;
        if (input && input.files && input.files.length > 0) {
          setUploading(true);

          const formData = new FormData();
          formData.append('file', input.files[0]);

          const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
            body: formData,
          });

          if (!res.ok) {
            throw new Error('Upload failed');
          }

          fileData = await res.json();
          setUploading(false);
        }

        // TODO: Implement API call to create memory
        console.log('Creating memory:', {
          type: selectedType,
          title: title.trim(),
          description: description.trim(),
          location: location.trim(),
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          fileData: fileData,
        });

        // Notify parent that memory was added
        onMemoryAdded?.();

        // Close the modal
        handleClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create memory');
        setUploading(false);
      }
    },
    [selectedType, title, description, location, tags, handleClose, onMemoryAdded, authToken],
  );

  const getTypeIcon = (type: MemoryType) => {
    switch (type) {
      case 'person':
        return <User className="h-5 w-5" />;
      case 'place':
        return <MapPin className="h-5 w-5" />;
      case 'thing':
        return <Package className="h-5 w-5" />;
      case 'event':
        return <Calendar className="h-5 w-5" />;
      case 'content':
        return <FileText className="h-5 w-5" />;
    }
  };

  const getTypeLabel = (type: MemoryType) => {
    switch (type) {
      case 'person':
        return 'Person';
      case 'place':
        return 'Place';
      case 'thing':
        return 'Thing';
      case 'event':
        return 'Event';
      case 'content':
        return 'Content';
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <Dialog.Content className="w-[90vw] max-w-2xl">
        <Dialog.Header>
          <Dialog.Title>Add Memory</Dialog.Title>
          <Dialog.Description>
            Create a new memory by selecting the type and providing details.
          </Dialog.Description>
        </Dialog.Header>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Memory Type Selection */}
          <div className="space-y-3">
            <label className="text-sm font-medium">Memory Type</label>
            <div className="grid grid-cols-5 gap-2">
              {(['person', 'place', 'thing', 'event', 'content'] as MemoryType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setSelectedType(type)}
                  className={cn(
                    'flex flex-col items-center gap-2 p-3 rounded-lg border transition-colors',
                    selectedType === type
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-input hover:bg-accent',
                  )}
                >
                  {getTypeIcon(type)}
                  <span className="text-xs font-medium">{getTypeLabel(type)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Basic Information */}
          <div className="space-y-4">
            <div>
              <label htmlFor="title" className="text-sm font-medium">
                Title *
              </label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={`Enter ${getTypeLabel(selectedType).toLowerCase()} title`}
                className="mt-1"
              />
            </div>

            <div>
              <label htmlFor="description" className="text-sm font-medium">
                Description
              </label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={`Describe this ${getTypeLabel(selectedType).toLowerCase()}`}
                className="mt-1"
                rows={3}
              />
            </div>

            {selectedType === 'place' && (
              <div>
                <label htmlFor="location" className="text-sm font-medium">
                  Location
                </label>
                <Input
                  id="location"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Enter location details"
                  className="mt-1"
                />
              </div>
            )}

            <div>
              <label htmlFor="tags" className="text-sm font-medium">
                Tags
              </label>
              <Input
                id="tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="Enter tags separated by commas"
                className="mt-1"
              />
            </div>
          </div>

          {/* File Upload Section */}
          <div className="space-y-3">
            <label className="text-sm font-medium pr-4">Attach File </label>
            <input
              id="file-input"
              type="file"
              className="file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:bg-blue-50 file:text-blue-700"
            />
          </div>

          {/* Error Display */}
          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="outline" onClick={handleClose} disabled={uploading}>
              Cancel
            </Button>
            <Button type="submit" disabled={uploading}>
              {uploading ? 'Uploading...' : 'Add Memory'}
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog>
  );
}
