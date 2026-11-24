/**
 * Trust Tasks — a Trust Over IP framework for self-contained, transport-agnostic, JSON-based task
 * documents (https://trusttasks.org) — carried alongside this box's KERI-shaped peer identities.
 * See `docs/trust-tasks.md` for what is implemented, what is not, and why.
 */
export { TrustTasksModule } from './TrustTasksModule';
export { ASK_COLLECT_TYPE_URI, ASK_REQUEST_TYPE_URI } from './askSpecs';
export type { TrustTaskDocument } from './document';
