import { processRole } from '@ci/common/roles';

/**
 * The concurrency arithmetic, in one place.
 *
 * Two things need it and they must never disagree: the worker, which sizes the
 * semaphores, and the settings API, which tells an operator what the numbers
 * they are about to type will actually do. A settings page that computes
 * "effective" differently from the code that enforces it is worse than one that
 * shows nothing — it is a page that confidently reports the wrong ceiling.
 */

/**
 * How many processes on this appliance run queue workers.
 *
 * The global semaphore is a per-PROCESS in-memory counter, not a distributed
 * lease, so it bounds one process and nothing else. Under `CI_ROLE=all` — the
 * single-process topology every test and every default deployment runs — that
 * distinction does not exist. Under the web/worker split (see the Procfile)
 * there are two of them, and the appliance-wide ceiling is twice whatever figure
 * either process was given.
 *
 * Both the worker (which divides by this) and the settings API (which reports
 * what the worker divided by) read it here, because a page describing a
 * different topology than the one enforcing the setting is worse than a page
 * with no numbers on it.
 *
 * Per-QUEUE ceilings need no such division: every queue declares one `role` and
 * is consumed only by the process serving it, so a queue's semaphore exists in
 * exactly one process however the appliance is split.
 */
export function queueWorkerProcesses(): number {
  return processRole() === 'all' ? 1 : 2;
}

/**
 * The per-process share of an appliance-wide in-flight ceiling.
 *
 * The global semaphore is a per-process counter, so on the web/worker split
 * there are two of them and the appliance-wide ceiling is twice either one. A
 * control labelled "at most N jobs at once on this box" therefore has to be
 * divided before it is applied, or it means N on a single-process appliance and
 * 2N on a split one.
 *
 * `floor`, so the division only ever undershoots the operator's figure. `max(1,
 * …)` because a process with zero slots has stopped, and "cap concurrency at 1"
 * must not silently mean "switch the appliance off" — which is the one case this
 * rounds up, and it is that or a dead queue.
 *
 * The `min` against the shipped appliance figure is the safety property, and it
 * is the reason this control exists: the page was added because an unattended
 * appliance drives a machine to 100% CPU, so a number typed into it may make the
 * box quieter and must never make it hotter. An operator who genuinely wants
 * more throughput than the build ships with raises `CI_QUEUE_CONCURRENCY`, which
 * is a deliberate act with a restart attached rather than a text box on a page
 * whose stated job is cooling the machine down.
 *
 * @param setting  the operator's appliance-wide cap, or null for none
 * @param shipped  `config.queues.concurrency` — the shipped PER-PROCESS ceiling
 * @param processes how many processes run queue workers in this topology
 */
export function perProcessGlobalConcurrency(
  setting: number | null,
  shipped: number,
  processes: number,
): number {
  // The default is expressed as shipped × processes precisely so that dividing
  // it again lands back on `shipped`. An unconfigured appliance therefore runs
  // exactly as it did before this control existed, on either topology — and it
  // doubles as the ceiling, so leaving the box empty and typing the number that
  // was already in it are the same appliance.
  const shippedAppliance = shipped * processes;
  const appliance = Math.min(setting ?? shippedAppliance, shippedAppliance);

  return Math.max(1, Math.floor(appliance / Math.max(1, processes)));
}

/**
 * The global per-queue default in force: the operator's, bounded by the shipped
 * one.
 *
 * The same one-way property as {@link perProcessGlobalConcurrency}, and it has
 * to live here rather than at the two call sites, because both of them
 * previously spelled it `setting ?? shipped` — which reads as a default and
 * silently behaves as an override the moment a row exists. Every per-queue
 * ceiling is derived from this number, so a value above `shipped` raises the
 * ceiling on every queue at once.
 *
 * @param setting the operator's per-queue default, or null for none
 * @param shipped `config.queues.perQueueConcurrency`
 */
export function perQueueDefaultConcurrency(setting: number | null, shipped: number): number {
  return Math.max(1, Math.min(setting ?? shipped, shipped));
}

/**
 * The highest per-queue ceiling an operator may usefully request for one queue.
 *
 * Two things bound it, and they bound it for different reasons. The global
 * per-queue default is a policy the operator themselves set (or inherited from
 * config) and can raise. A queue's own `localConcurrency` is a claim by the code
 * that more than N of these at once breaks something — `llm` declares 1 because
 * two chat generations thrash the model — and no number typed into a settings
 * page gets to overrule it.
 *
 * Surfaced to the UI as the row's maximum so the constraint is visible rather
 * than silently applied to whatever was typed.
 */
export function maxQueueConcurrency(perQueueDefault: number, declared: number | null): number {
  return Math.max(1, declared == null ? perQueueDefault : Math.min(perQueueDefault, declared));
}

/**
 * What a queue's semaphore is actually sized to: the tightest of the global
 * per-queue default, this queue's own setting, and its declared ceiling.
 *
 * A minimum rather than a lookup-with-fallbacks, so that a setting can only ever
 * make a queue quieter than shipped. That is the whole safety property of this
 * feature: nothing an operator can save from the Jobs page makes the box hotter
 * than the build already allowed.
 *
 * The minimum here only bounds a queue against `perQueueDefault`; what bounds
 * `perQueueDefault` itself is {@link perQueueDefaultConcurrency}, and the two
 * are load-bearing together. This function alone read as if it enforced the
 * property, which is how the global fields came to accept 64 against a shipped 6
 * — every queue clamped faithfully to a default the operator had just raised.
 */
export function effectiveQueueConcurrency(options: {
  readonly perQueueDefault: number;
  readonly requested: number | null;
  readonly declared: number | null;
}): number {
  const { perQueueDefault, requested, declared } = options;
  const ceiling = maxQueueConcurrency(perQueueDefault, declared);

  return Math.max(1, requested == null ? ceiling : Math.min(ceiling, requested));
}
