/**
 * Which DIDs may be a Space `controller` (PWS "Space Controller DID Method Registry").
 *
 * `did:key` with an Ed25519 Multikey is the mandatory floor. Any other method is optional, and a
 * server refuses a controller of a method it does not support with `invalid-request-body` (400),
 * at creation and on update alike. A controller of a supported method must also resolve before it
 * is stored: after that, later updates are authorized by the DID document being resolved, so
 * storing an unresolvable DID would leave a Space no one can act on.
 *
 * `did:keri` is not a method of that registry and nothing in this service resolves it to a
 * conformant KERI document, so it is refused here like any other unsupported method. The refusal
 * is deliberate and tested; the message names what is supported so a client can fix its request.
 */
import { isDid } from './keys';
import type { DidRegistry } from './keys';
import { invalidBody } from './problems';

export async function requireControllerAcceptable(keys: DidRegistry, controller: string): Promise<void> {
  if (!isDid(controller)) {
    throw invalidBody('The "controller" must be a DID.', '/controller');
  }
  if (!keys.supports(controller)) {
    throw invalidBody(
      `The DID method of "${controller.split(':', 3).slice(0, 2).join(':')}" is not supported as a Space controller (supported: ${keys
        .supportedMethods()
        .map((method) => `did:${method}`)
        .join(', ')}).`,
      '/controller',
    );
  }
  if (!(await keys.resolveDocument(controller))) {
    throw invalidBody('The "controller" DID does not resolve.', '/controller');
  }
}
