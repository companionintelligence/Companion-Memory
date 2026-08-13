import type { BaseSyntheticEvent } from 'react';

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

import { useAuth } from '@/hooks';

const LoginFormSchema = s.object({
  email: s.string().email({
    message: 'Invalid email.',
  }),
  password: s.string(),
});

export type LoginFormData = s.infer<typeof LoginFormSchema>;

interface LoginFormProps {
  onSubmit?: (data: LoginFormData, e?: BaseSyntheticEvent) => void;
}

export function LoginForm({ onSubmit }: LoginFormProps) {
  const [{ loading, error }] = useAuth();

  const form = useForm<LoginFormData>({
    resolver: formDataResolver(LoginFormSchema),
    // Controlled from first render — without explicit defaults the inputs start
    // `undefined` and React warns about switching uncontrolled → controlled.
    defaultValues: { email: '', password: '' },
  });

  const handleSubmit = (data: LoginFormData, e?: BaseSyntheticEvent) => onSubmit?.(data, e);

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="w-full space-y-6">
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
                <PasswordInput {...field} autoComplete="current-password" />
              </Form.Control>
              <Form.Message />
            </Form.Item>
          )}
        />

        {error != null && (
          <Alert variant={'destructive'}>
            <AlertCircleIcon />
            <Alert.Title>{(error as Error).message}</Alert.Title>
          </Alert>
        )}

        <LoadingButton className="w-full" type="submit" loading={loading}>
          Log in
        </LoadingButton>
      </form>
    </Form>
  );
}
