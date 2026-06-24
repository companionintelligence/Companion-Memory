import { type KeyboardEvent, useState, useCallback, useMemo } from 'react';

import { Form, Input, useForm, formDataResolver, formDataSchema as s, cn } from '@ci/shadcn';
import { X, Tag as TagIcon } from '@ci/shadcn/icons';

import { Tag } from '../Tag';

const FormSchema = s.object({
  label: s.string(),
});

export type FormData = s.infer<typeof FormSchema>;

const EMPTY: FormData = {
  label: '',
};

const MAX_SUGGESTIONS = 50;

interface Props {
  tags?: string[];
  readOnly?: boolean;
  className?: string;
  inputPlaceholder?: string;
  singleLine?: boolean;
  /**
   * Existing tag labels to autocomplete from. When provided, a dropdown of
   * matching tags surfaces as you type — this is what unifies the explorer's tag
   * filter with the tag vocabulary the Tags page browses. Free-text entry still
   * works (you can add a tag that isn't in the list).
   */
  suggestions?: string[];
  onTagAdded?: (tag: string) => boolean | Promise<boolean>;
  /**
   * Called when a tag is removed. The removal is applied optimistically; resolve
   * (or return) `false` to signal the removal failed so the tag is restored.
   */
  onTagRemoved?: (tag: string) => void | boolean | Promise<void | boolean>;
}

export function TagInput({
  tags: initialTags,
  readOnly = false,
  className,
  inputPlaceholder,
  singleLine = false,
  suggestions,
  onTagAdded,
  onTagRemoved,
}: Props) {
  const [tags, setTags] = useState<string[]>(initialTags ?? []);
  const [lowercaseTags, setLowercaseTags] = useState<Set<string>>(
    new Set(initialTags?.map((t) => t.toLowerCase()) ?? []),
  );
  const [focused, setFocused] = useState(false);

  const form = useForm<FormData>({
    resolver: formDataResolver(FormSchema),
    defaultValues: EMPTY,
  });

  const draft = form.watch('label');

  // The browsable tag list shown beneath the input while focused: all existing
  // tags (minus already-applied ones) when empty — so focusing the field lets
  // you browse every tag, the way the old Tags page did — narrowing as you type.
  const matches = useMemo(() => {
    if (!suggestions?.length || !focused) {
      return [];
    }

    const query = draft.trim().toLowerCase();

    return suggestions
      .filter(
        (label) =>
          !lowercaseTags.has(label.toLowerCase()) && (query === '' || label.toLowerCase().includes(query)),
      )
      .slice(0, MAX_SUGGESTIONS);
  }, [suggestions, focused, draft, lowercaseTags]);

  const addTag = useCallback(
    async (label: string) => {
      const trimmed = label.trim();

      if (trimmed === '' || lowercaseTags.has(trimmed.toLowerCase())) {
        form.reset(EMPTY);

        return;
      }

      const success = await onTagAdded?.(trimmed);

      if (success === true) {
        setTags((prev) => [...prev, trimmed]);
        setLowercaseTags((prev) => new Set(prev).add(trimmed.toLowerCase()));
        form.reset(EMPTY);
      }
    },
    [form, lowercaseTags, onTagAdded],
  );

  const handleSubmit = useCallback((data: FormData) => addTag(data.label), [addTag]);

  const restoreTag = useCallback((value: string, index: number) => {
    setTags((prev) => {
      if (prev.includes(value)) {
        return prev;
      }

      const next = [...prev];

      next.splice(Math.min(index, next.length), 0, value);

      return next;
    });
    setLowercaseTags((prev) => new Set(prev).add(value.toLowerCase()));
  }, []);

  const handleRemove = useCallback(
    (value: string) => {
      const index = tags.indexOf(value);

      if (index === -1) {
        return;
      }

      // Remove optimistically, then roll the tag back if the handler reports failure.
      setTags((prev) => prev.filter((s) => s !== value));

      setLowercaseTags((prev) => {
        const next = new Set(prev);

        next.delete(value.toLowerCase());

        return next;
      });

      void Promise.resolve()
        .then(() => onTagRemoved?.(value))
        .then((result) => {
          if (result === false) {
            restoreTag(value, index);
          }
        })
        .catch(() => {
          restoreTag(value, index);
        });
    },
    [onTagRemoved, restoreTag, tags],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (e.currentTarget.value === '' && tags.length > 0) {
          handleRemove(tags[tags.length - 1]);
        }
      }

      if (e.key === 'Escape') {
        if (e.currentTarget.value === '') {
          e.currentTarget.blur();
        } else {
          form.reset(EMPTY);
        }
      }
    },
    [form, handleRemove, tags],
  );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="relative">
        <div
          className={cn(
            'w-full flex flex-col p-2',
            'placeholder:text-muted-foreground/60',
            'outline-none border shadow-xs rounded-md bg-background text-base',
            'aria-[invalid=true]:ring-destructive/20 dark:aria-[invalid=true]:ring-destructive/40 aria-[invalid=true]:border-destructive',
            'transition-[color,box-shadow]',
            'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
            className,
          )}
        >
          <div
            className={cn(
              'flex items-center gap-1',
              singleLine ? 'flex-nowrap overflow-hidden' : 'flex-wrap',
            )}
          >
            <TagIcon className="h-4 w-4 mr-0.5 my-0.5" strokeWidth={1.75} />

            {tags.map((tag, i) => {
              return (
                <Tag key={`${tag}-${i}`} text={tag} className={singleLine ? 'shrink-0' : undefined}>
                  {!readOnly && (
                    <button
                      type="button"
                      className="flex items-center justify-center cursor-pointer -ml-0.5 -my-0.5 -mr-1.5 p-1"
                      onClick={() => handleRemove(tag)}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      <X size={12} />
                    </button>
                  )}
                </Tag>
              );
            })}

            {!readOnly && (
              <Form.Field
                control={form.control}
                name="label"
                render={({ field }) => (
                  <Input
                    {...field}
                    onKeyDown={handleKeyDown}
                    onFocus={() => setFocused(true)}
                    // Delay so a suggestion click registers before the list unmounts.
                    onBlur={() => setTimeout(() => setFocused(false), 120)}
                    placeholder={
                      tags.length === 0
                        ? (inputPlaceholder ?? (suggestions ? 'Add tags…' : undefined))
                        : undefined
                    }
                    className={cn(
                      'min-w-35 !flex-1 !bg-transparent !border-0 !outline-none !ring-0 !shadow-none !rounded-none',
                      '!p-0 h-5',
                      'focus:!border-transparent focus:!ring-0 focus-visible:!ring-0 focus-visible:!border-transparent',
                      'disabled:!bg-transparent',
                      'resize-none text-sm leading-none',
                      singleLine && '!min-w-0',
                    )}
                  />
                )}
              />
            )}
          </div>
        </div>

        {matches.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-auto rounded-md border bg-popover p-1 shadow-md">
            {matches.map((label) => (
              <button
                key={label}
                type="button"
                // Keep focus on the input so the list stays open between picks.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addTag(label)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <TagIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </div>
        )}
      </form>
    </Form>
  );
}
