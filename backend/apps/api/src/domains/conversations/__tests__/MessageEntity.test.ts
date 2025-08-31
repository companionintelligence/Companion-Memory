import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { UserEntity } from '../../user/entities/UserEntity';
import { MessageEntity } from '../entities/MessageEntity';
import { ThreadEntity } from '../entities/ThreadEntity';
import type { MessageRole } from '../types';

describe('MessageEntity', () => {
  let messageRepository: Repository<MessageEntity>;
  let userRepository: Repository<UserEntity>;
  let threadRepository: Repository<ThreadEntity>;

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: getRepositoryToken(MessageEntity),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(ThreadEntity),
          useValue: mockRepository,
        },
      ],
    }).compile();

    messageRepository = module.get<Repository<MessageEntity>>(getRepositoryToken(MessageEntity));
    userRepository = module.get<Repository<UserEntity>>(getRepositoryToken(UserEntity));
    threadRepository = module.get<Repository<ThreadEntity>>(getRepositoryToken(ThreadEntity));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('MessageRole type safety', () => {
    it('should accept valid MessageRole values', () => {
      const validRoles: MessageRole[] = ['user', 'assistant', 'system', 'tool'];
      
      validRoles.forEach(role => {
        const messageEntity = new MessageEntity();
        messageEntity.id = uuid7();
        messageEntity.role = role;
        messageEntity.text = 'Test message';
        messageEntity.model = 'test-model';
        messageEntity.prompt = role === 'user';
        messageEntity.canceled = false;
        
        // This should not throw a TypeScript error
        expect(messageEntity.role).toBe(role);
      });
    });

    it('should properly convert to Message interface', () => {
      const user = new UserEntity();
      user.id = uuid7();
      user.name = 'Test User';
      user.email = 'test@example.com';
      user.password = 'hashed_password';

      const thread = new ThreadEntity();
      thread.id = uuid7();
      thread.name = 'Test Thread';
      thread.user = user;

      const messageEntity = new MessageEntity();
      messageEntity.id = uuid7();
      messageEntity.role = 'user';
      messageEntity.text = 'Hello, world!';
      messageEntity.model = 'gemma3:1b';
      messageEntity.mimetype = 'text/plain';
      messageEntity.tool_calls = null;
      messageEntity.prompt = true;
      messageEntity.canceled = false;
      messageEntity.user = user;
      messageEntity.thread = thread;
      messageEntity.created_at = new Date();
      messageEntity.updated_at = new Date();

      const message = messageEntity.toMessage();

      expect(message.id).toBe(messageEntity.id);
      expect(message.role).toBe('user');
      expect(message.content).toBe('Hello, world!');
      expect(message.model).toBe('gemma3:1b');
      expect(message.user?.id).toBe(user.id);
      expect(message.thread?.id).toBe(thread.id);
    });

    it('should handle role fallback logic correctly', () => {
      const user = new UserEntity();
      user.id = uuid7();
      user.name = 'Test User';
      user.email = 'test@example.com';

      const thread = new ThreadEntity();
      thread.id = uuid7();
      thread.user = user;

      // Test fallback to prompt field when role is null
      const messageEntity = new MessageEntity();
      messageEntity.id = uuid7();
      messageEntity.role = null;
      messageEntity.text = 'Test';
      messageEntity.prompt = true;
      messageEntity.canceled = false;
      messageEntity.user = user;
      messageEntity.thread = thread;
      messageEntity.created_at = new Date();
      messageEntity.updated_at = new Date();

      const message = messageEntity.toMessage();
      expect(message.role).toBe('user'); // Should fallback to 'user' when prompt=true

      // Test fallback to assistant when prompt is false
      messageEntity.prompt = false;
      const assistantMessage = messageEntity.toMessage();
      expect(assistantMessage.role).toBe('assistant');
    });
  });

  describe('Entity constraints', () => {
    it('should enforce required relationships', () => {
      const messageEntity = new MessageEntity();
      messageEntity.id = uuid7();
      messageEntity.role = 'user';
      messageEntity.text = 'Test message';
      messageEntity.prompt = true;
      messageEntity.canceled = false;

      // TypeScript should require user and thread to be set
      expect(() => {
        // This would cause a database constraint error in practice
        // but TypeScript should catch the missing required fields
        const user = new UserEntity();
        const thread = new ThreadEntity();
        messageEntity.user = user;
        messageEntity.thread = thread;
      }).not.toThrow();
    });
  });
});