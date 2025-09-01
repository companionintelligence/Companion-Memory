import { Test, TestingModule } from '@nestjs/testing';

import { ClientFactory } from '../clients/ClientFactory';
import { GoogleClient } from '../clients/GoogleClient';
import { MicrosoftClient } from '../clients/MicrosoftClient';
import { HomeAssistantClient } from '../clients/HomeAssistantClient';
import { SipeedClient } from '../clients/SipeedClient';
import { IOSClient } from '../clients/IOSClient';
import { AndroidClient } from '../clients/AndroidClient';
import { WindowsClient } from '../clients/WindowsClient';
import { MacClient } from '../clients/MacClient';
import { XRealClient } from '../clients/XRealClient';
import { QuestClient } from '../clients/QuestClient';
import { OMIClient } from '../clients/OMIClient';

describe('ClientFactory', () => {
  let clientFactory: ClientFactory;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ClientFactory],
    }).compile();

    clientFactory = module.get<ClientFactory>(ClientFactory);
  });

  it('should be defined', () => {
    expect(clientFactory).toBeDefined();
  });

  describe('OAuth Providers', () => {
    it('should return GoogleClient for Google provider ID', () => {
      const client = clientFactory.getClientByProviderId('0198779b-182c-716e-9275-b81d99a47fdb');
      expect(client).toBeInstanceOf(GoogleClient);
    });

    it('should return MicrosoftClient for Microsoft provider ID', () => {
      const client = clientFactory.getClientByProviderId('0198779b-3c33-73da-84e5-82e0df145260');
      expect(client).toBeInstanceOf(MicrosoftClient);
    });
  });

  describe('API Providers', () => {
    it('should return HomeAssistantClient for HomeAssistant provider ID', () => {
      const client = clientFactory.getClientByProviderId('0198779b-c299-7396-9654-490512345678');
      expect(client).toBeInstanceOf(HomeAssistantClient);
    });

    it('should return SipeedClient for Sipeed provider ID', () => {
      const client = clientFactory.getClientByProviderId('0198779b-b188-7285-9543-389401234567');
      expect(client).toBeInstanceOf(SipeedClient);
    });
  });

  describe('Platform Providers', () => {
    it('should return IOSClient for iOS provider ID', () => {
      const client = clientFactory.getClientByProviderId('0198779b-4a11-7b1e-9876-c12d34e56f78');
      expect(client).toBeInstanceOf(IOSClient);
    });

    it('should return AndroidClient for Android provider ID', () => {
      const client = clientFactory.getClientByProviderId('0198779b-5b22-7c2f-9987-d23e45f67890');
      expect(client).toBeInstanceOf(AndroidClient);
    });

    it('should return WindowsClient for Windows provider ID', () => {
      const client = clientFactory.getClientByProviderId('0198779b-6c33-7d30-9098-e34f56789012');
      expect(client).toBeInstanceOf(WindowsClient);
    });

    it('should return MacClient for Mac provider ID', () => {
      const client = clientFactory.getClientByProviderId('0198779b-7d44-7e41-9109-f45067890123');
      expect(client).toBeInstanceOf(MacClient);
    });
  });

  describe('VR/AR/Wearable Providers', () => {
    it('should return XRealClient for XReal provider ID', () => {
      const client = clientFactory.getClientByProviderId('0198779b-8e55-7f52-9210-056178901234');
      expect(client).toBeInstanceOf(XRealClient);
    });

    it('should return QuestClient for Quest provider ID', () => {
      const client = clientFactory.getClientByProviderId('0198779b-9f66-7063-9321-167289012345');
      expect(client).toBeInstanceOf(QuestClient);
    });

    it('should return OMIClient for OMI provider ID', () => {
      const client = clientFactory.getClientByProviderId('0198779b-a077-7174-9432-278390123456');
      expect(client).toBeInstanceOf(OMIClient);
    });
  });

  describe('Error Handling', () => {
    it('should throw error for null provider ID', () => {
      expect(() => clientFactory.getClientByProviderId(null)).toThrow('API client requested for a null Provider');
    });

    it('should throw error for undefined provider ID', () => {
      expect(() => clientFactory.getClientByProviderId(undefined)).toThrow('API client requested for a null Provider');
    });

    it('should throw error for unsupported provider ID', () => {
      expect(() => clientFactory.getClientByProviderId('invalid-provider-id')).toThrow('Unsupported Provider id: invalid-provider-id');
    });
  });
});