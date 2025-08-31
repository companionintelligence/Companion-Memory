import React, { useState } from 'react';
import { Trash2, Plus, Edit2, Check, X } from '@ci/shadcn/icons';

import { Button, Card, Input, Separator } from '@ci/shadcn';

import { Tag } from '@/components/Tag';
import { useTagService } from '@/api';

export function TagManager() {
  const { data: tags, loading, create, update, delete: deleteTag } = useTagService();
  const [newTagLabel, setNewTagLabel] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');

  const handleCreateTag = async () => {
    if (!newTagLabel.trim()) return;

    try {
      setIsCreating(true);
      await create({ label: newTagLabel.trim() });
      setNewTagLabel('');
    } catch (error) {
      console.error('Failed to create tag:', error);
    } finally {
      setIsCreating(false);
    }
  };

  const handleEditTag = (id: string, currentLabel: string) => {
    setEditingId(id);
    setEditingLabel(currentLabel);
  };

  const handleSaveEdit = async () => {
    if (!editingLabel.trim() || !editingId) return;

    try {
      await update(editingId, { label: editingLabel.trim() });
      setEditingId(null);
      setEditingLabel('');
    } catch (error) {
      console.error('Failed to update tag:', error);
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingLabel('');
  };

  const handleDeleteTag = async (id: string) => {
    if (!confirm('Are you sure you want to delete this tag?')) return;

    try {
      await deleteTag(id);
    } catch (error) {
      console.error('Failed to delete tag:', error);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === 'Enter') {
      action();
    }
  };

  if (loading) {
    return (
      <Card>
        <Card.Header>
          <Card.Title>Tags</Card.Title>
        </Card.Header>
        <Card.Content>
          <div className="text-center py-4 text-gray-500">Loading tags...</div>
        </Card.Content>
      </Card>
    );
  }

  return (
    <Card>
      <Card.Header>
        <Card.Title>Tags</Card.Title>
      </Card.Header>
      <Card.Content className="space-y-4">
        {/* Create new tag */}
        <div className="flex gap-2">
          <Input
            placeholder="Enter tag name..."
            value={newTagLabel}
            onChange={(e) => setNewTagLabel(e.target.value)}
            onKeyPress={(e) => handleKeyPress(e, handleCreateTag)}
            disabled={isCreating}
          />
          <Button
            onClick={handleCreateTag}
            disabled={!newTagLabel.trim() || isCreating}
            size="sm"
          >
            <Plus className="w-4 h-4" />
            {isCreating ? 'Creating...' : 'Add'}
          </Button>
        </div>

        <Separator />

        {/* Tags list */}
        <div className="space-y-2">
          {tags.length === 0 ? (
            <div className="text-center py-4 text-gray-500">
              No tags yet. Create your first tag above.
            </div>
          ) : (
            tags.map((tag) => (
              <div key={tag.id} className="flex items-center gap-2 p-2 border rounded-lg">
                {editingId === tag.id ? (
                  // Edit mode
                  <div className="flex items-center gap-2 flex-1">
                    <Input
                      value={editingLabel}
                      onChange={(e) => setEditingLabel(e.target.value)}
                      onKeyPress={(e) => handleKeyPress(e, handleSaveEdit)}
                      className="flex-1"
                      autoFocus
                    />
                    <Button
                      onClick={handleSaveEdit}
                      disabled={!editingLabel.trim()}
                      size="sm"
                      variant="default"
                    >
                      <Check className="w-4 h-4" />
                    </Button>
                    <Button
                      onClick={handleCancelEdit}
                      size="sm"
                      variant="outline"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ) : (
                  // View mode
                  <>
                    <div className="flex-1">
                      {tag.label && <Tag text={tag.label} />}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        onClick={() => handleEditTag(tag.id, tag.label || '')}
                        size="sm"
                        variant="ghost"
                      >
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button
                        onClick={() => handleDeleteTag(tag.id)}
                        size="sm"
                        variant="ghost"
                        className="text-red-600 hover:text-red-700"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </Card.Content>
    </Card>
  );
}