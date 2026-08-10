export interface ForecastBucket {
  bucket_index: number;
  start_time: string;
  /** Independent 0–1 energy potentials per L0 class (need not sum to 1). */
  l0_probs: Record<string, number>;
  /** Highest-potential L0 class for this bucket. */
  occupant_l0?: string;
  /** Historical q50 potential per class for this time range. */
  l0_predictability?: Record<string, number>;
  l1_probs: Record<string, number>;
  l2_probs: Record<string, number> | null;
  q10: number;
  q50: number;
  q90: number;
}

export interface ForecastResponse {
  horizon: string;
  generated_at: string;
  system_status: string;
  buckets: ForecastBucket[];
}

export interface WeekForecastCluster {
  cluster_id: string;
  name: string;
  l0_class: string;
  p_occur: number;
  daypart_probs: Record<string, number>;
  /** True when a confirmed/tentative calendar event pins this cell (Layer 2). */
  scheduled?: boolean;
}

export interface WeekForecastDay {
  date: string;
  dow: string;
  clusters: WeekForecastCluster[];
}

export interface WeekForecastResponse {
  horizon: string;
  generated_at: string;
  days: WeekForecastDay[];
}

export interface DueItem {
  cluster_id: string;
  name: string;
  l0_class: string;
  last_seen: string;
  days_since_last: number;
  median_interval_days: number;
  due_in_days: number;
  window: [number, number];
  overdue: boolean;
  /** ISO date of the next matching booked event, or null (Layer 1 reconciliation). */
  scheduled_date: string | null;
  confidence: number;
}

export interface DueResponse {
  generated_at: string;
  due: DueItem[];
}
