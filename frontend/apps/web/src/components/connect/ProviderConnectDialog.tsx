import { useCallback, useEffect } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID, LoadingPage } from '@ci/common';
import {
  Dialog,
  Form,
  formDataResolver,
  Input,
  Label,
  Popover,
  Tooltip,
  useForm,
  useToast,
  formDataSchema as s,
} from '@ci/shadcn';
import { Info } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { BrandPrimaryButton } from '@/components/BrandPrimaryButton/BrandPrimaryButton';
import { ONBOARDING_OAUTH_RESUME_KEY } from '@/pages/OnboardingPage/constants';
import { Endpoints } from '@/pages/ProviderPage/Endpoints';
import { GET_PROVIDER } from '@/pages/ProviderPage/ProviderPage';
import { useConnectService } from '@/pages/ProviderPage/useConnectService';

const ConnectFormSchema = s.object({
  endpoints: s.array(s.string()).nullable().default(null),
});

type ConnectFormData = s.input<typeof ConnectFormSchema>;

interface ProviderConnectDialogProps {
  rawProviderId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void;
  resumeOnboarding?: boolean;
}

export function ProviderConnectDialog({
  rawProviderId,
  open,
  onOpenChange,
  onConnected,
  resumeOnboarding = false,
}: ProviderConnectDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const form = useForm<ConnectFormData>({
    resolver: formDataResolver(ConnectFormSchema),
    shouldUnregister: false,
  });

  const { data, loading } = useQuery(GET_PROVIDER, {
    variables: { id: GlobalUID.encode('provider', rawProviderId ?? '') },
    skip: !rawProviderId || !open,
  });

  const provider = data?.provider;
  const [
    { authorizationUrl, loading: connectLoading, error, apiKey, setApiKey, account, setAccount },
    { connect },
  ] = useConnectService();

  const isOpenId = provider?.authType === 'openid';
  const isApiKey = provider?.authType === 'api_key';
  const requiresApiKey = isOpenId || isApiKey;
  // An api_key provider (Signal) serves several accounts, so the number to connect is named too.
  const isConnectDisabled =
    (requiresApiKey && (apiKey == null || apiKey.length === 0)) ||
    (isApiKey && (account == null || account.trim().length === 0));

  const handleConnect = useCallback(() => {
    if (!provider || !rawProviderId) {
      return;
    }

    if (resumeOnboarding) {
      localStorage.setItem(ONBOARDING_OAUTH_RESUME_KEY, '1');
    }

    connect(rawProviderId, form.getValues('endpoints') || []);
  }, [connect, provider, rawProviderId, form, resumeOnboarding]);

  useEffect(() => {
    if (authorizationUrl === null) {
      return;
    }

    if (authorizationUrl === '') {
      toast.success(`Connected to ${provider?.name ?? 'provider'}`);
      onConnected?.();
      onOpenChange(false);

      return;
    }

    window.location.href = authorizationUrl;
  }, [authorizationUrl, onConnected, onOpenChange, provider?.name, toast]);

  useEffect(() => {
    if (!error) {
      return;
    }

    // The server's own reason, as ProviderPage shows it: "Only an administrator can connect
    // Signal", "The Signal service does not hold that number" and the like are the answer.
    const message = error instanceof Error && error.message ? error.message : 'Please try again.';

    toast.error(`Could not connect to ${provider?.name ?? 'this service'}. ${message}`);
    if (resumeOnboarding) {
      localStorage.removeItem(ONBOARDING_OAUTH_RESUME_KEY);
    }
  }, [error, provider?.name, resumeOnboarding, toast]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <Dialog.Header>
          <Dialog.Title>{provider ? `Connect ${provider.name}` : 'Connect'}</Dialog.Title>
          <Dialog.Description>Select what to sync, then connect your account.</Dialog.Description>
        </Dialog.Header>

        {loading || !provider ? (
          <LoadingPage />
        ) : (
          <Form {...form}>
            <form className="space-y-4 py-2">
              <Endpoints provider={provider} />

              {(isOpenId || isApiKey) && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="provider-api-key">API key</Label>
                    {provider.openidKeyLink && (
                      <Popover>
                        <Tooltip delayDuration={600}>
                          <Tooltip.Content>{t('PROVIDER_API_KEY_HELP')}</Tooltip.Content>
                          <Popover.Trigger asChild>
                            <Tooltip.Trigger asChild>
                              <button
                                type="button"
                                aria-label={t('PROVIDER_API_KEY_HELP')}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <Info className="h-4 w-4" />
                              </button>
                            </Tooltip.Trigger>
                          </Popover.Trigger>
                        </Tooltip>
                        <Popover.Content className="text-sm w-fit">
                          <a
                            href={provider.openidKeyLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline"
                          >
                            Get your API key
                          </a>
                        </Popover.Content>
                      </Popover>
                    )}
                  </div>
                  <Input
                    id="provider-api-key"
                    type="password"
                    autoComplete="off"
                    placeholder="API key"
                    value={apiKey ?? ''}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </div>
              )}

              {isApiKey && (
                <div className="space-y-2">
                  <Label htmlFor="provider-account">{`Your ${provider.name} number`}</Label>
                  <Input
                    id="provider-account"
                    type="tel"
                    autoComplete="off"
                    placeholder="+15551234567"
                    value={account ?? ''}
                    onChange={(e) => setAccount(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    The number registered with the service. Only an administrator can connect it, and each
                    number can belong to one account.
                  </p>
                </div>
              )}

              <BrandPrimaryButton
                type="button"
                className="w-full"
                disabled={isConnectDisabled || connectLoading}
                onClick={handleConnect}
              >
                {connectLoading ? 'Connecting…' : 'Connect'}
              </BrandPrimaryButton>
            </form>
          </Form>
        )}
      </Dialog.Content>
    </Dialog>
  );
}
