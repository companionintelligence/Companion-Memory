import { Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import { ContrastiveDecisionService } from '../services/ContrastiveDecisionService';
import { GenerativeDecisionEvaluatorAdapter } from '../services/GenerativeDecisionEvaluatorAdapter';
import {
  DECISION_GENERATIVE_HANDOFF_ENV,
  GenerativeDecisionHandoffService,
  isGenerativeHandoffEnabled,
} from '../services/GenerativeDecisionHandoffService';

/** Stands in for the llm domain's chat service. Discovery finds it by class name, as it does in production. */
class OllamaService {
  chat = jest.fn(async () => ({ done_reason: 'stop', message: { content: '{"probability":0.7}' } }));
}

/** Also has `chat`, but a different name, so it must not be mistaken for the chat service. */
class UnrelatedService {
  chat = jest.fn();
}

function discoveryWith(ollama: OllamaService | undefined) {
  const providers = [
    { metatype: UnrelatedService, instance: new UnrelatedService() },
    ...(ollama ? [{ metatype: OllamaService, instance: ollama }] : []),
  ];

  return { getProviders: jest.fn(() => providers) };
}

function decisionsSpy() {
  return { setGenerativeEvaluator: jest.fn() };
}

function setFlag(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[DECISION_GENERATIVE_HANDOFF_ENV];
  } else {
    process.env[DECISION_GENERATIVE_HANDOFF_ENV] = value;
  }
}

describe('GenerativeDecisionHandoffService', () => {
  const originalFlag = process.env[DECISION_GENERATIVE_HANDOFF_ENV];

  afterEach(() => {
    setFlag(originalFlag);
  });

  describe('isGenerativeHandoffEnabled', () => {
    it.each([
      ['true', true],
      [' TRUE ', true],
      ['false', false],
      ['1', false],
      ['yes', false],
      ['', false],
      [undefined, false],
    ])('reads %p as %p', (value, expected) => {
      expect(
        isGenerativeHandoffEnabled({ [DECISION_GENERATIVE_HANDOFF_ENV]: value } as NodeJS.ProcessEnv),
      ).toBe(expected);
    });
  });

  describe('onModuleInit', () => {
    it('registers an adapter that reaches the chat service when the flag is true', async () => {
      setFlag('true');
      const ollama = new OllamaService();
      const decisions = decisionsSpy();
      const service = new GenerativeDecisionHandoffService(
        decisions as unknown as ContrastiveDecisionService,
        discoveryWith(ollama) as unknown as DiscoveryService,
      );

      service.onModuleInit();

      expect(decisions.setGenerativeEvaluator).toHaveBeenCalledTimes(1);
      const registered = decisions.setGenerativeEvaluator.mock.calls[0][0];
      expect(registered).toBeInstanceOf(GenerativeDecisionEvaluatorAdapter);

      await expect(
        (registered as GenerativeDecisionEvaluatorAdapter).evaluateNoul('state', 'action', 'negated'),
      ).resolves.toBe(0.7);
      expect(ollama.chat).toHaveBeenCalledTimes(1);
    });

    it.each([[undefined], ['false']])(
      'registers nothing and does not search for the chat service when the flag is %p',
      (value) => {
        setFlag(value);
        const discovery = discoveryWith(new OllamaService());
        const decisions = decisionsSpy();
        const service = new GenerativeDecisionHandoffService(
          decisions as unknown as ContrastiveDecisionService,
          discovery as unknown as DiscoveryService,
        );

        service.onModuleInit();

        expect(decisions.setGenerativeEvaluator).not.toHaveBeenCalled();
        expect(discovery.getProviders).not.toHaveBeenCalled();
      },
    );

    it('keeps the lexical fallback and logs, without throwing, when the provider lookup throws', () => {
      setFlag('true');
      const decisions = decisionsSpy();
      const discovery = {
        getProviders: jest.fn(() => {
          throw new Error('discovery not ready');
        }),
      };
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const service = new GenerativeDecisionHandoffService(
        decisions as unknown as ContrastiveDecisionService,
        discovery as unknown as DiscoveryService,
      );

      try {
        expect(() => service.onModuleInit()).not.toThrow();
        expect(decisions.setGenerativeEvaluator).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('discovery not ready'));
      } finally {
        warn.mockRestore();
      }
    });

    it('stays unregistered, without throwing, when no chat service is registered', () => {
      setFlag('true');
      const decisions = decisionsSpy();
      const service = new GenerativeDecisionHandoffService(
        decisions as unknown as ContrastiveDecisionService,
        discoveryWith(undefined) as unknown as DiscoveryService,
      );

      expect(() => service.onModuleInit()).not.toThrow();
      expect(decisions.setGenerativeEvaluator).not.toHaveBeenCalled();
    });
  });

  describe('under the Nest container', () => {
    it('registers the evaluator at module init when the flag is true', async () => {
      setFlag('true');
      const decisions = decisionsSpy();
      const moduleRef = await Test.createTestingModule({
        providers: [
          GenerativeDecisionHandoffService,
          { provide: ContrastiveDecisionService, useValue: decisions },
          { provide: DiscoveryService, useValue: discoveryWith(new OllamaService()) },
        ],
      }).compile();

      await moduleRef.init();

      expect(decisions.setGenerativeEvaluator).toHaveBeenCalledTimes(1);
      await moduleRef.close();
    });

    it('initialises the module, keeping the lexical fallback, when the provider lookup throws', async () => {
      setFlag('true');
      const decisions = decisionsSpy();
      const moduleRef = await Test.createTestingModule({
        providers: [
          GenerativeDecisionHandoffService,
          { provide: ContrastiveDecisionService, useValue: decisions },
          {
            provide: DiscoveryService,
            useValue: {
              getProviders: () => {
                throw new Error('discovery not ready');
              },
            },
          },
        ],
      }).compile();

      await moduleRef.init();

      expect(decisions.setGenerativeEvaluator).not.toHaveBeenCalled();
      await moduleRef.close();
    });

    it('registers nothing at module init when the flag is off', async () => {
      setFlag(undefined);
      const decisions = decisionsSpy();
      const moduleRef = await Test.createTestingModule({
        providers: [
          GenerativeDecisionHandoffService,
          { provide: ContrastiveDecisionService, useValue: decisions },
          { provide: DiscoveryService, useValue: discoveryWith(new OllamaService()) },
        ],
      }).compile();

      await moduleRef.init();

      expect(decisions.setGenerativeEvaluator).not.toHaveBeenCalled();
      await moduleRef.close();
    });
  });
});
