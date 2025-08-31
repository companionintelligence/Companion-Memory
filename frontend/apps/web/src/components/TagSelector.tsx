import React, { useState } from 'react';
import { X, Plus } from '@ci/shadcn/icons';

import { Button, Input } from '@ci/shadcn';

import { Tag } from '@/components/Tag';
import { useTagService } from '@/api';

interface TagSelectorProps {
  selectedTags: string[];
  onTagsChange: (tags: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function TagSelector({ selectedTags, onTagsChange, placeholder = 'Select tags...', disabled = false }: TagSelectorProps) {
  const { data: availableTags, create } = useTagService();
  const [inputValue, setInputValue] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);

  const filteredTags = availableTags.filter((tag) => 
    tag.label &&
    tag.label.toLowerCase().includes(inputValue.toLowerCase()) &&
    !selectedTags.includes(tag.label)
  );

  const handleTagSelect = (tagLabel: string) => {
    if (!selectedTags.includes(tagLabel)) {
      onTagsChange([...selectedTags, tagLabel]);
    }
    setInputValue('');
    setShowDropdown(false);
  };

  const handleTagRemove = (tagToRemove: string) => {
    onTagsChange(selectedTags.filter((tag) => tag !== tagToRemove));
  };

  const handleCreateAndSelect = async () => {
    if (!inputValue.trim()) return;

    try {
      const newTag = await create({ label: inputValue.trim() });
      if (newTag.label) {
        handleTagSelect(newTag.label);
      }
    } catch (error) {
      console.error('Failed to create tag:', error);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      
      // If there's an exact match in filtered tags, select it
      const exactMatch = filteredTags.find(tag => 
        tag.label?.toLowerCase() === inputValue.toLowerCase()
      );
      
      if (exactMatch && exactMatch.label) {
        handleTagSelect(exactMatch.label);
      } else if (inputValue.trim()) {
        // Create new tag
        handleCreateAndSelect();
      }
    }
  };

  return (
    <div className="space-y-2">
      {/* Selected tags */}
      {selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedTags.map((tag) => (
            <div key={tag} className="flex items-center gap-1">
              <Tag text={tag} />
              {!disabled && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-gray-500 hover:text-red-600"
                  onClick={() => handleTagRemove(tag)}
                >
                  <X className="w-3 h-3" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Tag input */}
      {!disabled && (
        <div className="relative">
          <div className="flex gap-2">
            <Input
              placeholder={placeholder}
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                setShowDropdown(true);
              }}
              onKeyPress={handleKeyPress}
              onFocus={() => setShowDropdown(true)}
              onBlur={() => {
                // Delay hiding dropdown to allow clicks
                setTimeout(() => setShowDropdown(false), 150);
              }}
            />
            {inputValue.trim() && (
              <Button
                onClick={handleCreateAndSelect}
                size="sm"
                variant="outline"
                className="shrink-0"
              >
                <Plus className="w-4 h-4" />
                Create "{inputValue}"
              </Button>
            )}
          </div>

          {/* Dropdown */}
          {showDropdown && filteredTags.length > 0 && (
            <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-auto">
              {filteredTags.map((tag) => (
                <button
                  key={tag.id}
                  className="w-full px-3 py-2 text-left hover:bg-gray-100 flex items-center gap-2"
                  onClick={() => tag.label && handleTagSelect(tag.label)}
                >
                  {tag.label && <Tag text={tag.label} />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}