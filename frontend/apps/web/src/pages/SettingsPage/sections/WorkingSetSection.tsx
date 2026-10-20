import { useEffect, useState } from 'react';

import { isNativePlatform } from '@ci/common';
import { Button, Card } from '@ci/shadcn';
import { usePowerSync } from '@powersync/react';

import { clearPowerSyncWorkingSet, measurePowerSyncSizeBytes } from '@/api/powersync/session';
import {
  POWER_SYNC_CACHE_BUDGET_BYTES,
  formatCacheBudget,
  getLookbackDays,
} from '@/api/powersync/workingSet';

export function WorkingSetSection() {
  const database = usePowerSync();
  const [usedBytes, setUsedBytes] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const lookbackDays = getLookbackDays();

  useEffect(() => {
    let cancelled = false;

    void measurePowerSyncSizeBytes(database).then((size) => {
      if (!cancelled) {
        setUsedBytes(size);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [database, clearing]);

  const handleClear = async () => {
    setClearing(true);

    try {
      await clearPowerSyncWorkingSet();
      setUsedBytes(0);
    } finally {
      setClearing(false);
    }
  };

  const usedLabel = usedBytes == null ? 'Measuring…' : formatCacheBudget(usedBytes);
  const budgetLabel = formatCacheBudget(POWER_SYNC_CACHE_BUDGET_BYTES);

  return (
    <Card>
      <Card.Content className="space-y-4 pt-6">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">On-device working set</h3>
          <p className="text-sm text-muted-foreground">
            This phone keeps a rolling window of notes, messages, threads and recent events
            {isNativePlatform() ? ' in encrypted SQLite' : ''} — currently the last {lookbackDays} days,
            capped at {budgetLabel} — plus a searchable index of everything (names, subjects and snippets), so
            search keeps working when your Memory Server is unreachable. It is not a copy of the whole server:
            media, the graph and embeddings stay online.
          </p>
          <p className="text-sm text-muted-foreground">
            Used: {usedLabel} / {budgetLabel}
          </p>
        </div>
        <Button variant="outline" onClick={() => void handleClear()} disabled={clearing}>
          {clearing ? 'Clearing…' : 'Clear cache'}
        </Button>
      </Card.Content>
    </Card>
  );
}
