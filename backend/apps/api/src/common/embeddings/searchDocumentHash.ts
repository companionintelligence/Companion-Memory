import { createHash } from 'node:crypto';

import config from '@ci/configuration';

import { canonicalEmbedModel } from './embedModelIdentity';

/**
 * The identity of a stored vector's input: sha256 over the canonical name of
 * the configured embed model and the search document, hex. Stored beside the
 * vector (`ci_search.embeddings.source_hash`) so a row whose document has not
 * changed is not sent to the model again — and so a change of model, which
 * makes a different vector of the same text, reads as a change too. The
 * canonical name, not the served one: the same weights under another engine's
 * spelling make the same vectors (see `embedModelIdentity`).
 */
export function searchDocumentHash(text: string, model: string = config.embedding.model): string {
  return createHash('sha256').update(canonicalEmbedModel(model)).update('\n').update(text).digest('hex');
}
