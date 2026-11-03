/**
 * JSON with object keys in sorted order, so payloads that differ only by key
 * order compare equal. Arrays retain their original order.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};

      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }

      return sorted;
    }

    return v;
  });
}
