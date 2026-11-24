import { Test } from '@nestjs/testing';

import { LoggingModule } from '@ci/common/logging';
import { LlmEndpointModule } from '@ci/domains/llm/llm-endpoint.module';
import { LlmEndpointService } from '@ci/domains/llm/services/LlmEndpointService';

import { EmbeddingModule, EmbeddingGenerationService } from '..';

/*
 * `EmbeddingModule` reaches the resolved LLM endpoint through `LlmEndpointModule`,
 * not `LlmCoreModule`, whose `ToolsModule` subtree imports the search modules
 * that import this one. The wiring is only checked at boot, so it is checked
 * here: the module compiles on its own, and the endpoint it embeds against is
 * the same instance any other importer of `LlmEndpointModule` gets.
 */
describe('EmbeddingModule wiring', () => {
  it('compiles without LlmCoreModule and shares one LlmEndpointService', async () => {
    const module = await Test.createTestingModule({
      imports: [LoggingModule, EmbeddingModule, LlmEndpointModule],
    }).compile();

    const service = module.get(EmbeddingGenerationService);
    const endpoint = module.get(LlmEndpointService);

    expect(service).toBeInstanceOf(EmbeddingGenerationService);
    expect((service as unknown as { endpoint: LlmEndpointService }).endpoint).toBe(endpoint);

    await module.close();
  });
});
