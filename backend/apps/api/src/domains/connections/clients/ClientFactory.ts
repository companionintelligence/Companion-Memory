import { Injectable } from '@nestjs/common';

import config from '@ci/configuration';

import { AndroidClient } from './AndroidClient';
import { BaseClient as Client } from './BaseClient';
import { GoogleClient } from './GoogleClient';
import { HomeAssistantClient } from './HomeAssistantClient';
import { IOSClient } from './IOSClient';
import { MacClient } from './MacClient';
import { MicrosoftClient } from './MicrosoftClient';
import { OMIClient } from './OMIClient';
import { QuestClient } from './QuestClient';
import { SipeedClient } from './SipeedClient';
import { WindowsClient } from './WindowsClient';
import { XRealClient } from './XRealClient';

@Injectable()
export class ClientFactory {
  private readonly providers = new Map<string, Client>();

  constructor() {
    // OAuth-based API providers
    this.providers.set(config.auth.providers.google.id, new GoogleClient());
    this.providers.set(config.auth.providers.microsoft.id, new MicrosoftClient());

    // API-based integrations
    this.providers.set(config.auth.providers.homeassistant.id, new HomeAssistantClient());
    this.providers.set(config.auth.providers.sipeed.id, new SipeedClient());

    // Platform integrations (app-based)
    this.providers.set(config.auth.providers.ios.id, new IOSClient());
    this.providers.set(config.auth.providers.android.id, new AndroidClient());
    this.providers.set(config.auth.providers.windows.id, new WindowsClient());
    this.providers.set(config.auth.providers.mac.id, new MacClient());

    // VR/AR/Wearable device integrations
    this.providers.set(config.auth.providers.xreal.id, new XRealClient());
    this.providers.set(config.auth.providers.quest.id, new QuestClient());
    this.providers.set(config.auth.providers.omi.id, new OMIClient());
  }

  getClientByProviderId(providerId: string | null | undefined): Client {
    if (providerId == null) {
      throw new Error('API client requested for a null Provider');
    }

    const provider = this.providers.get(providerId);

    if (provider == null) {
      throw new Error(`Unsupported Provider id: ${providerId}`);
    }

    return provider;
  }
}
