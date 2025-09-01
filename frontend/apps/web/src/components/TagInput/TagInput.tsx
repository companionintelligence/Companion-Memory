import { useState, useRef } from 'react';
import { Input, Badge, Button } from '@ci/shadcn';
import { X, Plus } from '@ci/shadcn/icons';

interface TagInputProps {
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  placeholder?: string;
  className?: string;
}

export function TagInput({ tags, onTagsChange, placeholder = "Add tags...", className }: TagInputProps) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = (tag: string) => {
    const trimmedTag = tag.trim().toLowerCase();
    if (trimmedTag && !tags.includes(trimmedTag)) {
      onTagsChange([...tags, trimmedTag]);
    }
    setInputValue('');
  };

  const removeTag = (tagToRemove: string) => {
    onTagsChange(tags.filter(tag => tag !== tagToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (inputValue.trim()) {
        addTag(inputValue);
      }
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      // Remove last tag on backspace when input is empty
      const lastTag = tags[tags.length - 1];
      removeTag(lastTag);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Handle comma-separated values
    if (value.includes(',')) {
      const newTags = value.split(',').map(tag => tag.trim()).filter(Boolean);
      newTags.forEach(tag => addTag(tag));
      return;
    }
    setInputValue(value);
  };

  const handleAddClick = () => {
    if (inputValue.trim()) {
      addTag(inputValue);
    }
    inputRef.current?.focus();
  };

  return (
    <div className={`space-y-2 ${className || ''}`}>
      {/* Display existing tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <Badge 
              key={tag} 
              variant="secondary" 
              className="gap-1 pr-1 text-xs"
            >
              {tag}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto p-0 w-4 h-4 hover:bg-transparent"
                onClick={() => removeTag(tag)}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          ))}
        </div>
      )}
      
      {/* Input for new tags */}
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          className="flex-1 text-sm"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleAddClick}
          disabled={!inputValue.trim()}
          className="px-3"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      
      {/* Help text */}
      <p className="text-xs text-muted-foreground">
        Press Enter or comma to add tags. Click × to remove.
      </p>
    </div>
  );
}