import { Button, Form, IconButton, Input, Select, useFieldArray, useFormContext } from '@ci/shadcn';
import { X } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { StepHeader } from './StepHeader';

type Person = {
  first: string;
  last: string;
  relationship: string;
};

const RELATIONSHIP_GROUPS = [
  {
    label: 'Family',
    options: [
      { value: 'partner', label: 'Partner' },
      { value: 'parent', label: 'Parent' },
      { value: 'child', label: 'Child' },
    ],
  },
  {
    label: 'Social',
    options: [
      { value: 'roommate', label: 'Roommate' },
      { value: 'friend', label: 'Friend' },
      { value: 'coworker', label: 'Co-worker' },
    ],
  },
  {
    label: 'Other',
    options: [{ value: 'complicated', label: "It's complicated" }],
  },
];

export function SocialConnections() {
  const { t } = useTranslation();
  const form = useFormContext<{ people: Person[] }>();
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'people',
  });

  const count = form.watch('people')?.length ?? 0;
  const canAdd = count < 6;

  return (
    <div className="w-full min-w-0 max-w-2xl mx-auto space-y-5">
      <StepHeader title="Who are you usually around?" description="Let's start with up to 6 for now." />

      <div className="space-y-3">
        {fields.map((field, index) => (
          <div
            key={field.id}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 device:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_11rem_auto] device:gap-3"
          >
            <Form.Field
              control={form.control}
              name={`people.${index}.first`}
              render={({ field: nameField }) => (
                <Form.Item className="min-w-0">
                  <Form.Control>
                    <Input
                      {...nameField}
                      placeholder="First"
                      className="h-11 w-full min-w-0 text-base device:h-12 device:text-lg"
                    />
                  </Form.Control>
                  <Form.Message />
                </Form.Item>
              )}
            />

            <Form.Field
              control={form.control}
              name={`people.${index}.last`}
              render={({ field: nameField }) => (
                <Form.Item className="min-w-0">
                  <Form.Control>
                    <Input
                      {...nameField}
                      placeholder="Last"
                      className="h-11 w-full min-w-0 text-base device:h-12 device:text-lg"
                    />
                  </Form.Control>
                  <Form.Message />
                </Form.Item>
              )}
            />

            <IconButton
              className="device:col-start-4 device:row-start-1"
              type="button"
              size="lg"
              variant="ghost"
              onClick={() => remove(index)}
              label={t('ONBOARDING_REMOVE_PERSON')}
            >
              <X className="h-5 w-5" />
            </IconButton>

            <Form.Field
              control={form.control}
              name={`people.${index}.relationship`}
              render={({ field: relationField }) => (
                <Form.Item className="col-span-2 min-w-0 device:col-span-1 device:col-start-3 device:row-start-1">
                  <Form.Control>
                    <Select value={relationField.value ?? ''} onValueChange={relationField.onChange}>
                      <Select.Trigger className="h-11 w-full min-w-0 overflow-hidden px-3 text-base data-[size=default]:h-11 device:h-12 device:min-h-12 device:text-lg device:data-[size=default]:h-12 [&_svg:not([class*='size-'])]:size-4">
                        <Select.Value placeholder="Relation" />
                      </Select.Trigger>
                      <Select.Content>
                        {RELATIONSHIP_GROUPS.map((group) => (
                          <Select.Group key={group.label}>
                            <Select.Label className="text-sm">{group.label}</Select.Label>
                            {group.options.map((opt) => (
                              <Select.Item key={opt.value} value={opt.value} className="py-2 text-base">
                                {opt.label}
                              </Select.Item>
                            ))}
                          </Select.Group>
                        ))}
                      </Select.Content>
                    </Select>
                  </Form.Control>
                  <Form.Message />
                </Form.Item>
              )}
            />
          </div>
        ))}
      </div>

      <div className="text-center">
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="text-base"
          onClick={() => append({ first: '', last: '', relationship: '' })}
          disabled={!canAdd}
        >
          Add another person
        </Button>
      </div>
    </div>
  );
}
