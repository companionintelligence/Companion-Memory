import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useQuery } from '@apollo/client';
import { usePageTitle, LoadingPage, GlobalUID } from '@ci/common';
import {
  Button,
  Form,
  formDataResolver,
  cn,
  useForm,
  useToast,
  formDataSchema as s,
  IconButton,
  Input,
  Label,
  Popover,
  Tooltip,
} from '@ci/shadcn';
import { ChevronLeft, Info } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';

import logo from '@/assets/logo.png';
import { ErrorState } from '@/components/ErrorState';
import { InlineModal } from '@/components/InlineModal';
import { ThemeToggle } from '@/components/ThemePicker';
import { gql } from '@/graphql';

import { Endpoints } from './Endpoints';
import { useConnectService } from './useConnectService';

const GET_PROVIDER = gql(`
  query GetProvider($id: ID!) {
    provider(id: $id) {
      id
      name
      description
      logoUrl
      authType
      localOnly
      appSetupUrl
      openidKeyLink
      theme {
        backgroundColor
        borderColor
      }
      ...ProviderEndpointsFragment
    }
  }
`);

export { GET_PROVIDER };

export const ConnectFormSchema = s.object({
  endpoints: s.array(s.string()).nullable().default(null),
});

export type ConnectFormData = s.input<typeof ConnectFormSchema>;

export function ProviderPage() {
  usePageTitle('Connect - Companion Intelligence');

  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useTranslation();

  const { data, loading: queryLoading, error: queryError, refetch } = useQuery(GET_PROVIDER, {
    variables: {
      id: GlobalUID.encode('provider', id!),
    },
    skip: !id,
  });

  const provider = data?.provider;

  const [{ authorizationUrl, loading: connectLoading, error, apiKey, setApiKey }, { connect }] =
    useConnectService();

  const isOpenId = provider?.authType === 'openid';
  const isApiKey = provider?.authType === 'api_key';
  const requiresApiKey = isOpenId || isApiKey;
  const isConnectDisabled = requiresApiKey && (apiKey == null || apiKey.length === 0);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const form = useForm<ConnectFormData>({
    resolver: formDataResolver(ConnectFormSchema),
    shouldUnregister: false,
  });

  const handleConnect = useCallback(() => {
    if (!provider) {
      return;
    }

    const id = GlobalUID.parse('provider', provider.id);

    connect(id, form.getValues('endpoints') || []);
  }, [connect, provider, form]);

  const handleGoBack = useCallback(() => {
    navigate('/sources/connect');
  }, [navigate]);

  useEffect(() => {
    if (authorizationUrl === null) {
      return;
    }

    if (authorizationUrl === '') {
      toast.success(`Connected to ${provider?.name ?? 'provider'}`);
      navigate('/sources/connect');

      return;
    }

    // We have to do `window.location` since this is an external URL.
    window.location.href = authorizationUrl;
  }, [authorizationUrl, navigate, provider?.name, toast]);

  useEffect(() => {
    if (!error) {
      return;
    }

    // Names the provider and the real cause, where there is one, rather than
    // a generic sentence that could describe any request on the page — the
    // connect call, the API key field, or the endpoint form all funnel their
    // failures into this one `error` state.
    const message = error instanceof Error && error.message ? error.message : 'Please try again.';

    toast.error(`Could not connect to ${provider?.name ?? 'this service'}. ${message}`);
  }, [error, provider?.name]);

  const backgroundStyle = useMemo(() => {
    if (provider?.theme?.backgroundColor && isHexColor(provider.theme.backgroundColor)) {
      return {
        backgroundColor: provider.theme.backgroundColor,
      };
    }

    return {};
  }, [provider?.theme?.backgroundColor]);

  const borderStyle = useMemo(() => {
    if (provider?.theme?.borderColor && isHexColor(provider.theme.borderColor)) {
      return {
        borderColor: provider.theme.borderColor,
      };
    }

    return {};
  }, [provider?.theme?.borderColor]);

  if (queryLoading) {
    return <LoadingPage />;
  }

  // Not-loading-and-no-provider used to share the branch above and spin
  // forever: a failed query or an id naming no provider left `queryLoading`
  // false and `provider` undefined, and this page is registered OUTSIDE
  // MainLayout (App.tsx), so there was no rail and no in-app control on screen
  // — browser Back was the only way out of a full-screen spinner.
  if (!provider) {
    return (
      <ErrorState
        className="min-h-dvh"
        title={queryError ? 'Could not load this service' : 'No such service'}
        description={
          queryError
            ? 'This device could not reach it just now.'
            : 'That link does not point at a service this Companion knows about.'
        }
        onRetry={queryError ? () => void refetch() : undefined}
      >
        <Button variant="outline" size="sm" onClick={() => navigate('/sources/connect')}>
          Back to Sources
        </Button>
      </ErrorState>
    );
  }

  return (
    <>
      <InlineModal open={connectLoading || !!authorizationUrl}>
        <LoadingPage />
      </InlineModal>

      <Form {...form}>
        <form className="relative h-lvh flex flex-col gap-2">
          <div className="absolute top-0 left-0 h-[max(0.5rem,env(safe-area-inset-top))] w-full">
            <div className="absolute top-full right-2 z-10 text-white md:text-foreground">
              <ThemeToggle />
            </div>
          </div>

          <div className="flex flex-col items-center flex-1/4 gap-4 h-full">
            <div className="flex w-full items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))]">
              <div className="flex-1">
                <img src={logo} className="w-8 h-8" />
              </div>

              <div className="text-center text-lg font-semibold">
                Connect your Companion to {provider.name}
              </div>

              <div className="flex-1" />
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 md:max-w-xl mx-4 md:mx-8">
              <div className="flex flex-col justify-center min-h-full">
                <div className="rounded-lg bg-white dark:bg-card shadow-lg m-2">
                  <div
                    className={cn('flex items-center justify-center p-4 rounded-t-lg')}
                    style={backgroundStyle}
                  >
                    <div
                      className={cn(
                        'flex items-center justify-center p-6 rounded-full bg-white aspect-square border-6',
                      )}
                      style={borderStyle}
                    >
                      {provider.logoUrl && <img src={provider.logoUrl} className="w-12 h-12" />}
                    </div>
                  </div>

                  <div className="p-6">
                    <Endpoints provider={provider} />

                    {(isOpenId || isApiKey) && (
                      <div className="mt-6 space-y-2">
                        <div className="flex items-center gap-1.5">
                          <Label htmlFor="openid-api-key">
                            {isApiKey
                              ? `Enter your ${provider.name} REST API key`
                              : `Enter your ${provider.name} OpenID API key`}
                          </Label>
                          {provider.openidKeyLink && (
                            <Popover>
                              <Tooltip delayDuration={600}>
                                <Tooltip.Content>{t('PROVIDER_API_KEY_HELP')}</Tooltip.Content>
                                <Popover.Trigger asChild>
                                  <Tooltip.Trigger asChild>
                                    <button
                                      type="button"
                                      className="cursor-pointer text-muted-foreground hover:text-foreground"
                                      aria-label={t('PROVIDER_API_KEY_HELP')}
                                    >
                                      <Info className="h-4 w-4" />
                                    </button>
                                  </Tooltip.Trigger>
                                </Popover.Trigger>
                              </Tooltip>
                              <Popover.Content className="text-sm w-fit">
                                To get your API key, go to{' '}
                                <a
                                  href={provider.openidKeyLink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="underline text-blue-500"
                                >
                                  {provider.openidKeyLink}
                                </a>
                              </Popover.Content>
                            </Popover>
                          )}
                        </div>
                        <Input
                          id="openid-api-key"
                          type="password"
                          autoComplete="off"
                          placeholder="API key"
                          value={apiKey ?? ''}
                          onChange={(e) => setApiKey(e.target.value)}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <Button type="button" className="px-24" onClick={handleConnect} disabled={isConnectDisabled}>
              Connect
            </Button>
          </div>

          {/* This used to be a three-dot carousel row under the real Back
              icon button above — a leftover from a multi-step wizard this
              form no longer is. The middle dot had no onClick at all (a
              focusable, clickable dead control), and the right chevron was
              labelled "Next slide" but actually called handleConnect,
              starting the real OAuth redirect — the exact same action the
              honest "Connect" button above already offers. Both real actions
              on this page (Back, Connect) already have a correctly-labelled
              control; this row only duplicated one of them and disguised the
              other. */}
          <div className="flex justify-center items-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <IconButton
              variant="ghost"
              className="cursor-pointer"
              onClick={handleGoBack}
              label={t('PROVIDER_BACK_TO_CONNECTIONS')}
            >
              <ChevronLeft className="h-4 w-4" />
            </IconButton>
          </div>
        </form>
      </Form>
    </>
  );
}

function isHexColor(color: string): boolean {
  return /^#([0-9A-F]{3}){1,2}$/i.test(color);
}
