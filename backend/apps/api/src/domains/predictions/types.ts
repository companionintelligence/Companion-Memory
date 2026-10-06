export interface ForecastBucket {
  bucket_index: number;
  start_time: string;
  /**
   * The class to render for this bucket.
   *
   * Deliberately not `argmax(l0_probs)`. Most of a day carries no recorded
   * activity, so the posterior — which stays calibrated — answers UNKNOWN
   * nearly everywhere even when it is exactly right. HBPE applies a
   * prior correction to pick the label, with a floor so it can only promote a
   * class the model still gives real probability to. Optional because an HBPE
   * older than that change does not send it.
   */
  predicted_l0?: string | null;
  l0_probs: Record<string, number>;
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
  model_version?: string;
  still_learning?: boolean;
  pipeline_eta_seconds?: number | null;
  pipeline_detail?: string | null;
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

export interface ForageMass {
  label: string;
  mass: number;
}

export interface ForageBranch {
  id: string;
  mass: number;
  ready: boolean;
  past: boolean;
  pinned: boolean;
  top_texture: string;
}

export interface ForageItem {
  gaze: number;
  id: string;
  label: string;
  read: boolean;
  G: number;
  epistemic: number;
  risk: number;
  ambiguity: number;
  source?: string;
}

export interface ForageRead {
  item_id: string;
  cue: string;
  G: number;
  epistemic: number;
  branch_delta: Record<string, number>;
}

export interface ForageTrialResponse {
  user_id: string;
  question: string;
  horizon: string;
  kind?: string;
  pin: string | null;
  resolved: boolean;
  ready: boolean;
  pick: string | null;
  texture: string | null;
  texture_mass: number | null;
  permutation_branch: string;
  branches: ForageBranch[];
  permutations: ForageMass[];
  interests: Record<string, string[]>;
  attention: ForageItem[];
  reads: ForageRead[];
}
