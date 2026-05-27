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
  Input,
  Label,
  Popover,
} from '@ci/shadcn';
import { ChevronLeft, ChevronRight, Info } from '@ci/shadcn/icons';
import { useNavigate, useParams } from 'react-router-dom';

import logo from '@/assets/logo.png';
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
      openidKeyLink
      theme {
        backgroundColor
        borderColor
      }
      ...ProviderEndpointsFragment
    }
  }
`);

export const ConnectFormSchema = s.object({
  endpoints: s.array(s.string()).nullable().default(null),
});

export type ConnectFormData = s.input<typeof ConnectFormSchema>;

export function ProviderPage() {
  usePageTitle('Connect - Companion Intelligence');

  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const { data, loading: queryLoading } = useQuery(GET_PROVIDER, {
    variables: {
      id: GlobalUID.encode('provider', id!),
    },
    skip: !id,
  });

  const provider = data?.provider;

  const [{ authorizationUrl, loading: connectLoading, error, setEndpoints, apiKey, setApiKey }, { connect }] =
    useConnectService();

  const isOpenId = provider?.authType === 'openid';
  const isConnectDisabled = isOpenId && (apiKey == null || apiKey.length === 0);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const handleConnect = useCallback(() => {
    if (!provider) {
      return;
    }

    const id = GlobalUID.parse('provider', provider.id);

    connect(id);
  }, [connect, provider]);

  const handleGoBack = useCallback(() => {
    navigate('/connect');
  }, [navigate]);

  useEffect(() => {
    if (!authorizationUrl) {
      return;
    }

    // We have to do `window.location` since this is an external URL.
    window.location.href = authorizationUrl;
  }, [authorizationUrl]);

  useEffect(() => {
    if (!error) {
      return;
    }

    toast.error('Error connecting to API');

    // handleGoBack();
  }, [error]);

  const form = useForm<ConnectFormData>({
    resolver: formDataResolver(ConnectFormSchema),
    shouldUnregister: false,
  });

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

  if (queryLoading || !provider) {
    return <LoadingPage />;
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
                    <Endpoints provider={provider} setEndpoints={setEndpoints} />

                    {isOpenId && (
                      <div className="mt-6 space-y-2">
                        <div className="flex items-center gap-1.5">
                          <Label htmlFor="openid-api-key">Enter your {provider.name} OpenID API key</Label>
                          {provider.openidKeyLink && (
                            <Popover>
                              <Popover.Trigger asChild>
                                <button
                                  type="button"
                                  className="cursor-pointer text-muted-foreground hover:text-foreground"
                                >
                                  <Info className="h-4 w-4" />
                                </button>
                              </Popover.Trigger>
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

          <div className="flex justify-center items-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <Button
              variant="ghost"
              size="icon"
              className="cursor-pointer"
              onClick={handleGoBack}
              aria-label="Go back to connect page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="cursor-pointer"
              onClick={handleGoBack}
              aria-label="Go back to connect page"
            >
              <div className={cn('h-2 w-2 m-2 rounded-full transition-all duration-200', 'bg-slate-300')} />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="cursor-pointer"
              aria-label="Select provider endpoints"
            >
              <div
                className={cn(
                  'h-2 w-2 m-2 rounded-full transition-all duration-200',
                  'bg-slate-800 scale-115',
                )}
              />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="cursor-pointer"
              onClick={handleConnect}
              aria-label="Next slide"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </form>
      </Form>
    </>
  );
}

function isHexColor(color: string): boolean {
  return /^#([0-9A-F]{3}){1,2}$/i.test(color);
}
