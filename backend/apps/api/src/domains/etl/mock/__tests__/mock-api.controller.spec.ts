import { Test, TestingModule } from '@nestjs/testing';
import { MockApiController } from '../mock-api.controller';
import { MockApiService } from '../mock-api.service';

describe('MockApiController', () => {
  let controller: MockApiController;
  let service: MockApiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MockApiController],
      providers: [MockApiService],
    }).compile();

    controller = module.get<MockApiController>(MockApiController);
    service = module.get<MockApiService>(MockApiService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
    expect(service).toBeDefined();
  });

  describe('Discord endpoints', () => {
    it('should generate Discord messages', () => {
      const result = controller.getDiscordMessages('channel123', { limit: 10 });
      expect(result).toHaveProperty('messages');
      expect(Array.isArray(result.messages)).toBe(true);
      expect(result.messages.length).toBeLessThanOrEqual(10);
      expect(result.messages[0]).toHaveProperty('id');
      expect(result.messages[0]).toHaveProperty('content');
      expect(result.messages[0]).toHaveProperty('author');
    });

    it('should generate Discord DM channels', () => {
      const result = controller.getDiscordDMChannels();
      expect(result).toHaveProperty('channels');
      expect(Array.isArray(result.channels)).toBe(true);
      expect(result.channels[0]).toHaveProperty('id');
      expect(result.channels[0]).toHaveProperty('type');
      expect(result.channels[0].type).toBe(1);
    });

    it('should generate Discord guilds', () => {
      const result = controller.getDiscordGuilds({ limit: 20 });
      expect(result).toHaveProperty('guilds');
      expect(Array.isArray(result.guilds)).toBe(true);
      expect(result.guilds.length).toBeLessThanOrEqual(20);
    });
  });

  describe('GitHub endpoints', () => {
    it('should generate GitHub repositories', () => {
      const result = controller.getGitHubRepos({ per_page: 30 });
      expect(result).toHaveProperty('repositories');
      expect(result.repositories.length).toBeLessThanOrEqual(30);
      expect(result.repositories[0]).toHaveProperty('name');
      expect(result.repositories[0]).toHaveProperty('full_name');
    });

    it('should generate GitHub issues', () => {
      const result = controller.getGitHubIssues({ per_page: 20 });
      expect(result).toHaveProperty('issues');
      expect(result.issues[0]).toHaveProperty('title');
      expect(result.issues[0]).toHaveProperty('state');
    });
  });

  describe('Stripe endpoints', () => {
    it('should generate Stripe charges', () => {
      const result = controller.getStripeCharges({});
      expect(result).toHaveProperty('object', 'list');
      expect(result).toHaveProperty('data');
      expect(result.data[0]).toHaveProperty('id');
      expect(result.data[0].id).toMatch(/^ch_/);
      expect(result.data[0]).toHaveProperty('amount');
      expect(result.data[0]).toHaveProperty('currency');
    });
  });

  describe('Pagination', () => {
    it('should handle cursor-based pagination', () => {
      const result = controller.getDiscordMessages('channel123', { limit: 100 });
      expect(result.messages.length).toBeGreaterThan(0);
    });

    it('should handle offset-based pagination', () => {
      const result = controller.getGitHubRepos({ per_page: 50, page: 2 });
      expect(result.repositories).toBeDefined();
    });
  });
});
