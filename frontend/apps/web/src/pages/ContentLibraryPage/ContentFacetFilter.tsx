import { useState } from 'react';

import { Button, DropdownMenu } from '@ci/shadcn';
import { ChevronDown, type LucideIcon } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

interface Props {
  /** The dimension word, shown as "{label}: all" / "{label}: image". */
  label: string;
  /** The CSV URL param the selection lives in (`types`, `mimetypes`). */
  param: string;
  /** Every value the user's rows carry, from `contentFacets`. */
  options: readonly string[];
  icon: LucideIcon;
  modal?: boolean;
}

/** The comma-separated values of `param`, in URL order. */
export function readFacetParam(params: URLSearchParams, param: string): string[] {
  return params.get(param)?.split(',').filter(Boolean) ?? [];
}

/**
 * A multi-select over one column's distinct values, kept in the URL so a
 * filtered library has a shareable address. Same shape as the explorer's How
 * picker (ConnectorFilter): a labelled trigger, a Clear, one checkbox per
 * value, and "No <label>s yet" while the account has nothing to offer.
 */
export function ContentFacetFilter({ label, param, options, icon: Icon, modal = false }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = readFacetParam(searchParams, param);

  const { CheckboxItem, Content, Label, Separator, Trigger } = DropdownMenu;

  const value =
    selected.length === 0 ? 'all' : selected.length === 1 ? selected[0] : `${selected.length} selected`;

  const setSelected = (next: string[]) => {
    setSearchParams((params) => {
      if (next.length === 0) {
        params.delete(param);
      } else {
        params.set(param, next.join(','));
      }

      return params;
    });
  };

  const toggle = (option: string) => {
    setSelected(
      selected.includes(option) ? selected.filter((item) => item !== option) : [...selected, option],
    );
  };

  return (
    <DropdownMenu modal={modal} open={isOpen} onOpenChange={setIsOpen}>
      <Trigger asChild>
        <Button type="button" variant="outline">
          <Icon className="mr-2 h-4 w-4 text-muted-foreground" />
          {label}: {value}
          <ChevronDown
            className={`ml-2 h-4 w-4 opacity-50 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </Button>
      </Trigger>

      <Content
        align="start"
        sideOffset={4}
        className="z-[9999] max-h-80 w-64 overflow-y-auto rounded-md border border-border bg-background p-1 shadow-lg"
      >
        <div className="flex items-center justify-between gap-3 px-2 py-1.5">
          <Label className="text-sm font-medium">{label}</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setSelected([])}
            className="h-7 px-2 text-xs text-muted-foreground"
          >
            Clear
          </Button>
        </div>
        <Separator />
        {options.length === 0 ? (
          <div className="p-2 text-xs text-muted-foreground">No {label.toLowerCase()}s yet</div>
        ) : (
          options.map((option) => (
            <CheckboxItem
              key={option}
              checked={selected.includes(option)}
              onClick={(event) => {
                event.stopPropagation();
                event.preventDefault();
                toggle(option);
              }}
            >
              {option}
            </CheckboxItem>
          ))
        )}
      </Content>
    </DropdownMenu>
  );
}
