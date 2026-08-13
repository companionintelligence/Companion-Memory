import { BadRequestException } from '@nestjs/common';

import { CAPTURE_SCOPE, INTENTS_SCOPE, MCP_SCOPE, MEMORY_SCOPE } from '@ci/common/decorators';
import { ValidationPipe } from '@ci/common/pipes';

import { createApiKeySchema, updateApiKeySchema } from '../controllers/ApiKeyController';

/**
 * The create/update schemas constrain `scopes` to the canonical list.
 *
 * This matters because enforcement is deny-by-default on a NON-EMPTY array: a typo like 'mcpp'
 * would previously be accepted, mint a key that authenticates correctly, and then be refused on
 * every route — a dead key with no diagnostic. Rejecting at the door turns that into a 400.
 *
 * The controller's own schemas are exercised, not a copy of them, so relaxing either back to free
 * strings fails these tests. Both are covered: `updateApiKeySchema` accepts `scopes` too, and an
 * unconstrained PATCH would re-open the same hole the POST closes.
 */
describe('api key scope validation', () => {
  describe.each([
    ['create', createApiKeySchema],
    ['update', updateApiKeySchema],
  ])('%s schema', (_label, schema) => {
    const pipe = new ValidationPipe(schema);

    it('accepts each canonical scope', () => {
      for (const scope of [MEMORY_SCOPE, INTENTS_SCOPE, MCP_SCOPE]) {
        expect(pipe.transform({ name: 'k', scopes: [scope] })).toEqual({ name: 'k', scopes: [scope] });
      }
    });

    it('accepts a combination of scopes', () => {
      const input = { name: 'k', scopes: [MEMORY_SCOPE, MCP_SCOPE] };

      expect(pipe.transform(input)).toEqual(input);
    });

    it('accepts the capture scope, so capture agents can be minted a key that is not full-access', () => {
      const input = { name: 'k', scopes: [CAPTURE_SCOPE] };

      expect(pipe.transform(input)).toEqual(input);
    });

    it('accepts an omitted scopes field (full-access key)', () => {
      expect(pipe.transform({ name: 'k' })).toEqual({ name: 'k' });
    });

    it('accepts an explicitly empty array, the grandfathered full-access case', () => {
      expect(pipe.transform({ name: 'k', scopes: [] })).toEqual({ name: 'k', scopes: [] });
    });

    it('rejects a misspelled scope rather than minting a key that can reach nothing', () => {
      expect(() => pipe.transform({ name: 'k', scopes: ['mcpp'] })).toThrow(BadRequestException);
    });

    it('rejects an unknown scope even when combined with a valid one', () => {
      expect(() => pipe.transform({ name: 'k', scopes: [MCP_SCOPE, 'admin'] })).toThrow(BadRequestException);
    });

    it('rejects a non-array scopes value', () => {
      expect(() => pipe.transform({ name: 'k', scopes: MCP_SCOPE })).toThrow(BadRequestException);
    });
  });

  // Importing the real schemas also pins the name rules the two deliberately do NOT share, which
  // the scope cases above never touch.
  describe('name rules, which differ between the two', () => {
    it('rejects a reserved `app:` name on create, keeping that namespace for connect keys', () => {
      const pipe = new ValidationPipe(createApiKeySchema);

      expect(() => pipe.transform({ name: 'app:ci-hermes' })).toThrow(BadRequestException);
    });

    it('allows `app:` on update, so a grandfathered key echoing its own name stays editable', () => {
      const pipe = new ValidationPipe(updateApiKeySchema);

      expect(pipe.transform({ name: 'app:ci-hermes' })).toEqual({ name: 'app:ci-hermes' });
    });
  });
});
