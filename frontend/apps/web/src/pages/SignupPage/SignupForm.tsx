import { useLayoutEffect, useMemo, useState, type BaseSyntheticEvent } from 'react';

import { FetchJsonError } from '@ci/common';
import {
  Alert,
  Form,
  Input,
  LoadingButton,
  PasswordInput,
  useForm,
  formDataResolver,
  formDataSchema as s,
} from '@ci/shadcn';
import { AlertCircleIcon } from '@ci/shadcn/icons';

import { useFeatures } from '@/common/feature';

import { useAuth } from '../../hooks';

// Validation rules (password length etc.) live in the backend signup schema —
// the single source of truth. Server-reported issues are mapped onto the
// matching fields below instead of being duplicated here.
const SignupFormSchema = s.object({
  name: s.string(),
  email: s.string().email({
    message: 'Invalid email.',
  }),
  password: s.string(),
  signup_code: s.string().optional(),
});

export type SignupFormData = s.infer<typeof SignupFormSchema>;

const signupFieldNames = Object.keys(SignupFormSchema.shape);

interface SignupFormProps {
  onSubmit?: (data: SignupFormData, e?: BaseSyntheticEvent) => void;
}

export function SignupForm({ onSubmit }: SignupFormProps) {
  const [{ loading, error }] = useAuth();

  const { isFeatureEnabled } = useFeatures();
  const codesRequired = isFeatureEnabled('require.signup.codes');

  const form = useForm<SignupFormData>({
    resolver: formDataResolver(SignupFormSchema),
  });

  // Server issues are mapped only for submissions made by this mounted form:
  // useAuth's error slot is app-wide and survives navigation, and a stale
  // error must not paint field errors onto a pristine remounted form.
  //
  // Own state rather than formState.submitCount: that value sits behind
  // react-hook-form's formState proxy, which does not re-render this
  // component when submitting is the only thing that changed (an error
  // already in context at submit time would then never be mapped).
  //
  // The submitted values are kept, not just a flag: the server's verdict
  // applies to those exact values, so a field the user has since edited must
  // stop showing it.
  const [submittedValues, setSubmittedValues] = useState<SignupFormData | null>(null);
  const hasSubmitted = submittedValues != null;
  const currentValues = form.watch();

  const { fieldIssues, unmappedMessages, issueMessages } = useMemo(() => {
    const fieldIssues: Array<{ field: keyof SignupFormData; message: string }> = [];
    const unmappedMessages: string[] = [];

    // Every issue message the server sent, ungated: the alert prefers these
    // over the envelope's generic "Validation failed", which tells the user
    // nothing about what to change.
    const issueMessages =
      error instanceof FetchJsonError
        ? error.issues.map((issue) => issue.message).filter((message): message is string => !!message)
        : [];

    if (hasSubmitted && error instanceof FetchJsonError) {
      // Only fields with a mounted input can display an inline message; the
      // signup_code input exists solely when the feature flag is on.
      const rendered = new Set(signupFieldNames.filter((field) => field !== 'signup_code' || codesRequired));

      for (const issue of error.issues) {
        if (typeof issue.message !== 'string' || !issue.message) {
          continue;
        }

        const field = issue.path?.[0];

        if (typeof field === 'string' && rendered.has(field)) {
          fieldIssues.push({ field: field as keyof SignupFormData, message: issue.message });
        } else {
          unmappedMessages.push(issue.message);
        }
      }
    }

    return { fieldIssues, unmappedMessages, issueMessages };
  }, [error, hasSubmitted, codesRequired]);

  // Layout effect so the field errors are committed before the frame in which
  // the alert is suppressed gets painted — no flash of missing feedback.
  //
  // Runs after every render, re-asserting the message if react-hook-form has
  // cleared it: its own post-submit state update lands after this effect when
  // the error was already in context at submit time, and would otherwise wipe
  // the message for good. Skipped once the field's value diverges from what
  // was submitted — the server judged the old value, so from that point the
  // resolver owns the field and the alert carries the message instead.
  useLayoutEffect(() => {
    for (const { field, message } of fieldIssues) {
      if (currentValues[field] === submittedValues?.[field] && !form.getFieldState(field).error) {
        form.setError(field, { type: 'server', message });
      }
    }
  });

  // Alert visibility tracks the form's LIVE errors, not a snapshot: when the
  // resolver clears a server-mapped field error (first keystroke after a
  // failed submit), the alert takes back over instead of leaving the failure
  // invisible. Unmapped issues always surface here.
  const visibleFieldErrorCount = Object.keys(form.formState.errors).length;
  const showAlert = error != null && (visibleFieldErrorCount === 0 || unmappedMessages.length > 0);

  // Computed only when the alert is actually shown: `error` is null on a
  // normal page load, and an unguarded read here crashes the whole form.
  // Ordering is most-specific-first — the envelope message ("Validation
  // failed") is a last resort, never shown when the server said what is wrong.
  const alertMessage = !showAlert
    ? null
    : unmappedMessages.length > 0
      ? unmappedMessages.join('; ')
      : issueMessages.length > 0
        ? issueMessages.join('; ')
        : error instanceof Error && error.message
          ? error.message
          : 'Something went wrong. Please try again.';

  const handleSubmit = (data: SignupFormData, e?: BaseSyntheticEvent) => {
    setSubmittedValues(data);

    return onSubmit?.(data, e);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="w-full space-y-6">
        <Form.Field
          control={form.control}
          name="name"
          render={({ field }) => (
            <Form.Item>
              <Form.Label>Name</Form.Label>
              <Form.Control>
                <Input {...field} />
              </Form.Control>
              <Form.Message />
            </Form.Item>
          )}
        />

        <Form.Field
          control={form.control}
          name="email"
          render={({ field }) => (
            <Form.Item>
              <Form.Label>Email</Form.Label>
              <Form.Control>
                <Input {...field} autoComplete="username" />
              </Form.Control>
              <Form.Message />
            </Form.Item>
          )}
        />

        <Form.Field
          control={form.control}
          name="password"
          render={({ field }) => (
            <Form.Item>
              <Form.Label>Password</Form.Label>
              <Form.Control>
                <PasswordInput {...field} autoComplete="new-password" />
              </Form.Control>
              <Form.Message />
            </Form.Item>
          )}
        />

        {isFeatureEnabled('require.signup.codes') && (
          <Form.Field
            control={form.control}
            name="signup_code"
            render={({ field }) => (
              <Form.Item>
                <Form.Label>Signup Code</Form.Label>
                <Form.Control>
                  <Input {...field} />
                </Form.Control>
                <Form.Message />
              </Form.Item>
            )}
          />
        )}

        {showAlert && (
          <Alert variant={'destructive'}>
            <AlertCircleIcon />
            <Alert.Title>{alertMessage}</Alert.Title>
          </Alert>
        )}

        <LoadingButton className="w-full" type="submit" loading={loading}>
          Sign up
        </LoadingButton>
      </form>
    </Form>
  );
}
