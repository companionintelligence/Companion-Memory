import { ServiceUnavailableException } from '@nestjs/common';

import type { LlmEndpointConnectionFailure } from '../../services/LlmEndpointService';
import { OllamaController } from '../OllamaController';

/**
 * `GET /llm/models` when the model server gives no HTTP answer. It used to be a bare 500, so Chat could
 * only say "Chat can't reach a model" and the composer "Couldn't load models", with nothing about why.
 */
describe('OllamaController listModels', () => {
  const fetchFailed = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
  });

  function buildController(failure: LlmEndpointConnectionFailure | null, error: unknown = fetchFailed) {
    const desktopAppService = {
      rethrow: jest.fn(async (thrown: unknown) => {
        throw thrown;
      }),
    };
    const llmEndpointService = { describeConnectionFailure: jest.fn(() => failure) };
    const controller = new OllamaController(
      {} as never,
      { getAvailableModels: jest.fn(async () => Promise.reject(error)) } as never,
      {} as never,
      {} as never,
      {} as never,
      desktopAppService as never,
      llmEndpointService as never,
      { setContext: jest.fn() } as never,
    );

    return { controller, desktopAppService, llmEndpointService };
  }

  it('answers with a 503 that says what failed, for Chat to show', async () => {
    const { controller, desktopAppService, llmEndpointService } = buildController({
      reason: 'refused',
      code: 'ECONNREFUSED',
      message: 'host.docker.internal:11434 refused the connection.',
    });

    const thrown = await controller.listModels({} as never).catch((error: unknown) => error);

    expect(llmEndpointService.describeConnectionFailure).toHaveBeenCalledWith(fetchFailed);
    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect((thrown as ServiceUnavailableException).getResponse()).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'host.docker.internal:11434 refused the connection.',
      reason: 'refused',
    });
    expect((thrown as ServiceUnavailableException).cause).toBe(fetchFailed);
    // Still through the Desktop check, which answers "Memory Desktop is closed" when that is the reason.
    expect(desktopAppService.rethrow).toHaveBeenCalledWith(thrown);
  });

  it('points at Test connection for the firewall rule rather than carrying the command', async () => {
    const { controller } = buildController({
      reason: 'timeout',
      code: 'UND_ERR_CONNECT_TIMEOUT',
      message: 'host.docker.internal:11434 did not answer in time.',
      fixCommand: 'sudo ufw allow from 172.16.0.0/12 to any port 11434 proto tcp',
    });

    const thrown = (await controller
      .listModels({} as never)
      .catch((error: unknown) => error)) as ServiceUnavailableException;

    expect(thrown.getResponse()).toMatchObject({
      message:
        'host.docker.internal:11434 did not answer in time. Test connection in Settings > Model shows a firewall rule for it.',
      reason: 'timeout',
    });
    expect(JSON.stringify(thrown.getResponse())).not.toMatch(/ufw/);
  });

  it('passes any other failure on unchanged', async () => {
    const other = new Error('model list was not JSON');
    const { controller } = buildController(null, other);

    await expect(controller.listModels({} as never)).rejects.toBe(other);
  });
});
