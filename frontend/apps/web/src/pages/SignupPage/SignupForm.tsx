import type { BaseSyntheticEvent } from 'react';

import {
  Alert,
  Form,
  Input,
  LoadingButton,
  useForm,
  formDataResolver,
  formDataSchema as s,
} from '@ci/shadcn';
import { AlertCircleIcon } from '@ci/shadcn/icons';

import { useFeatures } from '@/common/feature';

import { useAuth } from '../../hooks';

const SignupFormSchema = s.object({
  name: s.string(),
  email: s.string().email({
    message: 'Invalid email.',
  }),
  password: s.string(),
  signup_code: s.string().optional(),
});

export type SignupFormData = s.infer<typeof SignupFormSchema>;

interface SignupFormProps {
  onSubmit?: (data: SignupFormData, e?: BaseSyntheticEvent) => void;
}

export function SignupForm({ onSubmit }: SignupFormProps) {
  const [{ loading, error }] = useAuth();

  const { isFeatureEnabled } = useFeatures();

  const form = useForm<SignupFormData>({
    resolver: formDataResolver(SignupFormSchema),
  });

  const handleSubmit = (data: SignupFormData, e?: BaseSyntheticEvent) => onSubmit?.(data, e);

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
                <Input {...field} />
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
                <Input {...field} type="password" />
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

        {error != null && (
          <Alert variant={'destructive'}>
            <AlertCircleIcon />
            <Alert.Title>{(error as Error).message}</Alert.Title>
          </Alert>
        )}

        <LoadingButton className="w-full" type="submit" loading={loading}>
          Sign up
        </LoadingButton>
      </form>
    </Form>
  );
}
