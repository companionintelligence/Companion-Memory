import { type KeyboardEvent, useState, useCallback } from 'react';

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

interface Props {
  tags?: string[];
  onTagAdded?: (tag: string) => boolean | Promise<boolean>;
  onTagRemoved?: (tag: string) => void;
}

export function TagInput({ tags: initialTags, onTagAdded, onTagRemoved }: Props) {
  const [tags, setTags] = useState<string[]>(initialTags ?? []);
  const [lowercaseTags, setLowercaseTags] = useState<Set<string>>(
    new Set(initialTags?.map((t) => t.toLowerCase()) ?? []),
  );

  const form = useForm<FormData>({
    resolver: formDataResolver(FormSchema),
    defaultValues: EMPTY,
  });

  const handleSubmit = useCallback(
    async (data: FormData) => {
      if (lowercaseTags.has(data.label.toLowerCase())) {
        return;
      }

      const success = await onTagAdded?.(data.label);

      if (success === true) {
        setTags((prev) => [...prev, data.label]);
        setLowercaseTags((prev) => new Set(prev).add(data.label.toLowerCase()));
        form.reset();
      }
    },
    [form, onTagAdded, tags],
  );

  const handleRemove = useCallback(
    (value: string) => {
      setTags((prev) => prev.filter((s) => s !== value));

      setLowercaseTags((prev) => {
        const next = new Set(prev);

        next.delete(value.toLowerCase());

        return next;
      });

      onTagRemoved?.(value);
    },
    [onTagRemoved],
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
          form.reset();
        }
      }
    },
    [form, handleRemove, tags],
  );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)}>
        <div
          className={cn(
            'w-full flex flex-col p-2',
            'placeholder:text-muted-foreground/60 field-sizing-content',
            'outline-none border shadow-xs rounded-md bg-background text-base',
            'aria-[invalid=true]:ring-destructive/20 dark:aria-[invalid=true]:ring-destructive/40 aria-[invalid=true]:border-destructive',
            'transition-[color,box-shadow]',
          )}
        >
          <div className="flex items-center gap-1 flex-wrap">
            <TagIcon className="h-4 w-4 mr-0.5" strokeWidth={1.75} />

            {tags.map((tag, i) => {
              return (
                <Tag key={`${tag}-${i}`} text={tag}>
                  <button
                    type="button"
                    className="flex items-center justify-center cursor-pointer -ml-0.5 -my-0.5 -mr-1.5 p-1"
                    onClick={() => handleRemove(tag)}
                  >
                    <X size={12} />
                  </button>
                </Tag>
              );
            })}

            <Form.Field
              control={form.control}
              name="label"
              render={({ field }) => (
                <Input
                  {...field}
                  onKeyDown={handleKeyDown}
                  className={cn(
                    'min-w-35 !flex-1 !bg-transparent !border-0 !outline-none !ring-0 !shadow-none !rounded-none',
                    '!p-0 !h-[calc(theme(spacing.9)-2px)] -my-1.5',
                    'focus:!border-transparent focus:!ring-0 focus-visible:!ring-0 focus-visible:!border-transparent',
                    'disabled:!bg-transparent',
                    'resize-none text-base leading-none',
                  )}
                />
              )}
            />
          </div>
        </div>
      </form>
    </Form>
  );
}
