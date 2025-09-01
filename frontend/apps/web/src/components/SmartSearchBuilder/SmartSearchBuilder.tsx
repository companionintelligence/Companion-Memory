import { useState } from 'react';
import { Button, Input, Select, Badge } from '@ci/shadcn';
import { Plus, X, Sparkles } from '@ci/shadcn/icons';

interface SearchFilter {
  id: string;
  field: string;
  operator: string;
  value: string;
}

export type { SearchFilter };

interface SmartSearchBuilderProps {
  filters: SearchFilter[];
  onFiltersChange: (filters: SearchFilter[]) => void;
  onApply: (filters: SearchFilter[]) => void;
  className?: string;
}

const FILTER_FIELDS = [
  { value: 'type', label: 'Content Type' },
  { value: 'date', label: 'Date' },
  { value: 'path', label: 'File Path' },
  { value: 'text', label: 'Contains Text' },
  { value: 'size', label: 'File Size' },
];

const OPERATORS = [
  { value: 'contains', label: 'contains', fields: ['text', 'path'] },
  { value: 'equals', label: 'equals', fields: ['type'] },
  { value: 'after', label: 'after', fields: ['date'] },
  { value: 'before', label: 'before', fields: ['date'] },
  { value: 'greater', label: 'greater than', fields: ['size'] },
  { value: 'less', label: 'less than', fields: ['size'] },
];

export function SmartSearchBuilder({ filters, onFiltersChange, onApply, className }: SmartSearchBuilderProps) {
  const addFilter = () => {
    const newFilter: SearchFilter = {
      id: Date.now().toString(),
      field: 'text',
      operator: 'contains',
      value: '',
    };
    onFiltersChange([...filters, newFilter]);
  };

  const removeFilter = (id: string) => {
    onFiltersChange(filters.filter(f => f.id !== id));
  };

  const updateFilter = (id: string, key: keyof SearchFilter, value: string) => {
    onFiltersChange(filters.map(f => 
      f.id === id ? { ...f, [key]: value } : f
    ));
  };

  const getAvailableOperators = (field: string) => {
    return OPERATORS.filter(op => op.fields.includes(field));
  };

  return (
    <div className={`space-y-4 ${className || ''}`}>
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-purple-500" />
        <h3 className="text-sm font-medium">Smart Search Builder</h3>
        <Badge variant="secondary" className="text-xs">Advanced</Badge>
      </div>

      {/* Filter Rules */}
      <div className="space-y-2">
        {filters.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            No filters added yet. Click "Add Filter" to create smart search conditions.
          </p>
        ) : (
          filters.map((filter, index) => (
            <div key={filter.id} className="flex items-center gap-2 p-2 border border-border rounded-lg">
              {index > 0 && (
                <span className="text-xs text-muted-foreground px-2">AND</span>
              )}
              
              <Select 
                value={filter.field} 
                onValueChange={(value) => updateFilter(filter.id, 'field', value)}
              >
                <Select.Trigger className="w-32">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {FILTER_FIELDS.map(field => (
                    <Select.Item key={field.value} value={field.value}>
                      {field.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>

              <Select 
                value={filter.operator} 
                onValueChange={(value) => updateFilter(filter.id, 'operator', value)}
              >
                <Select.Trigger className="w-28">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {getAvailableOperators(filter.field).map(op => (
                    <Select.Item key={op.value} value={op.value}>
                      {op.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>

              <Input
                placeholder="Enter value..."
                value={filter.value}
                onChange={(e) => updateFilter(filter.id, 'value', e.target.value)}
                className="flex-1"
              />

              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeFilter(filter.id)}
                className="p-1 h-8 w-8"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={addFilter}
          className="gap-1"
        >
          <Plus className="h-4 w-4" />
          Add Filter
        </Button>

        {filters.length > 0 && (
          <Button
            onClick={() => onApply(filters)}
            size="sm"
            className="gap-1 bg-purple-600 hover:bg-purple-700"
          >
            <Sparkles className="h-4 w-4" />
            Apply Smart Search
          </Button>
        )}
      </div>

      {/* Info */}
      <p className="text-xs text-muted-foreground">
        Smart searches use conditions to find specific content. They're similar to macOS Finder's smart folders.
      </p>
    </div>
  );
}