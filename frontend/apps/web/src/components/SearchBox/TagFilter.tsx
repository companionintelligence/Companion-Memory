import { useMemo, useState } from 'react';

import { useQuery } from '@apollo/client';
import { Button, DropdownMenu, Label } from '@ci/shadcn';
import { ChevronDown } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { gql } from '@/graphql';

const GET_FILTER_TAGS = gql(`
  query GetFilterTags {
    tags {
      edges {
        node {
          id
          label
        }
      }
    }
  }
`);

/**
 * Tag filter for the search dropdown. Reads/writes the `tags` URL param (a CSV
 * of tag labels) the explorer consumes. Populated from the user's tag library.
 */
export function TagFilter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [isOpen, setIsOpen] = useState(false);
  const { data } = useQuery(GET_FILTER_TAGS);

  const selected = useMemo(
    () => new Set(searchParams.get('tags')?.split(',').filter(Boolean) ?? []),
    [searchParams],
  );

  const tags = useMemo(
    () =>
      [...(data?.tags.edges ?? [])]
        .map((edge) => edge.node.label)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    [data],
  );

  const writeTags = (next: Set<string>) => {
    const params = new URLSearchParams(searchParams);

    if (next.size > 0) {
      params.set('tags', [...next].join(','));
    } else {
      params.delete('tags');
    }

    setSearchParams(params);
  };

  const toggle = (label: string) => {
    const next = new Set(selected);

    if (next.has(label)) {
      next.delete(label);
    } else {
      next.add(label);
    }

    writeTags(next);
  };

  const label =
    selected.size === 0 ? 'Any tags' : selected.size === 1 ? [...selected][0] : `${selected.size} tags`;

  const { CheckboxItem, Content, Label: MenuLabel, Separator, Trigger } = DropdownMenu;

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="font-medium">Tags</Label>
      <DropdownMenu modal={false} onOpenChange={() => setIsOpen(!isOpen)}>
        <Trigger>
          <Button type="button" variant="outline" className="w-56 justify-between">
            <span className="truncate">{label}</span>
            <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </Button>
        </Trigger>

        <Content
          id="tag-filters"
          className="fixed bg-background border border-border rounded-md shadow-lg z-[9999] max-h-80 overflow-y-auto w-56"
        >
          <div className="flex items-center justify-between">
            <MenuLabel className="p-2 font-medium">Tags</MenuLabel>
            {selected.size > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs mr-1"
                onClick={() => writeTags(new Set())}
              >
                Clear
              </Button>
            )}
          </div>
          <Separator />
          {tags.length === 0 && <div className="p-2 text-sm text-muted-foreground">No tags yet</div>}
          {tags.map((tag) => (
            <CheckboxItem
              key={tag}
              checked={selected.has(tag)}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                toggle(tag);
              }}
            >
              {tag}
            </CheckboxItem>
          ))}
        </Content>
      </DropdownMenu>
    </div>
  );
}
