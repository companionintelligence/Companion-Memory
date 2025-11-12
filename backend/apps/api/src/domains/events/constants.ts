export const DEFAULT_QUEUE = 'default';

// Queue dedicated to long-horizon memory summary jobs consumed by external workers.
export const SUMMARY_QUEUE = 'memory-summaries';

// Queues that the API publishes to but for which it does not register local workers.
export const WRITER_ONLY_QUEUES = Object.freeze([SUMMARY_QUEUE]);
