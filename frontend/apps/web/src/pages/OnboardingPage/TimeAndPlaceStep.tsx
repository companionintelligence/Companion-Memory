import { Form, Input, useFormContext } from '@ci/shadcn';

import { BROWSER_TIMEZONE } from './constants';
import { StepHeader } from './StepHeader';

// iOS sizes `input[type=time]` to a wide intrinsic minimum and ignores the
// grid cell, so two of them overlap and run off the right edge. Dropping the
// native chrome on a phone lets the control actually take the column width.
// Desktop keeps the browser's time field.
const timeInputClassName =
  'h-11 w-full min-w-0 max-w-full appearance-none px-2 text-base device:h-12 device:appearance-auto device:px-3 device:text-lg [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:min-w-0';

export function TimeAndPlaceStep() {
  const form = useFormContext<{
    schedule?: {
      wake_time?: string;
      sleep_time?: string;
      work_start?: string;
      work_end?: string;
    } | null;
  }>();

  return (
    <div className="w-full min-w-0 max-w-xl mx-auto space-y-5 text-left device:space-y-7">
      <StepHeader
        title="Time and place"
        description={
          <>
            Plan your time intentionally. Detected timezone:{' '}
            <span className="text-foreground font-medium">{BROWSER_TIMEZONE}</span>
          </>
        }
      />

      {/* TODO(settings): Schedule subsection under Preferences — wake/sleep/work hours from self-entity properties.schedule */}
      <div className="grid w-full min-w-0 grid-cols-2 gap-3 device:gap-5">
        <Form.Field
          control={form.control}
          name="schedule.wake_time"
          render={({ field }) => (
            <Form.Item className="grid-cols-1 min-w-0 overflow-hidden">
              <Form.Label className="text-sm device:text-base">Usually wake up</Form.Label>
              <Form.Control>
                <Input type="time" className={timeInputClassName} {...field} value={field.value ?? '07:00'} />
              </Form.Control>
            </Form.Item>
          )}
        />
        <Form.Field
          control={form.control}
          name="schedule.sleep_time"
          render={({ field }) => (
            <Form.Item className="grid-cols-1 min-w-0 overflow-hidden">
              <Form.Label className="text-sm device:text-base">Usually go to bed</Form.Label>
              <Form.Control>
                <Input type="time" className={timeInputClassName} {...field} value={field.value ?? '21:00'} />
              </Form.Control>
            </Form.Item>
          )}
        />
      </div>

      <p className="text-sm text-muted-foreground leading-snug device:text-base">
        Your companion uses these hours to understand your rhythm. Change them any time in Settings.
      </p>

      <div className="grid w-full min-w-0 grid-cols-2 gap-3 device:gap-5">
        <Form.Field
          control={form.control}
          name="schedule.work_start"
          render={({ field }) => (
            <Form.Item className="grid-cols-1 min-w-0 overflow-hidden">
              <Form.Label className="text-sm device:text-base">Workday start</Form.Label>
              <Form.Control>
                <Input type="time" className={timeInputClassName} {...field} value={field.value ?? '09:00'} />
              </Form.Control>
            </Form.Item>
          )}
        />
        <Form.Field
          control={form.control}
          name="schedule.work_end"
          render={({ field }) => (
            <Form.Item className="grid-cols-1 min-w-0 overflow-hidden">
              <Form.Label className="text-sm device:text-base">Workday end</Form.Label>
              <Form.Control>
                <Input type="time" className={timeInputClassName} {...field} value={field.value ?? '18:00'} />
              </Form.Control>
            </Form.Item>
          )}
        />
      </div>
    </div>
  );
}
