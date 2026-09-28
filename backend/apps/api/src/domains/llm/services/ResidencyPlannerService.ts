import { Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import { Ollama } from 'ollama';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { isFirstResponseTimeout } from '../firstResponseDeadline';
import { CalibrationStore, type CalibrationRecord } from '../residency/calibrationStore';
import {
  canonicalModelId,
  estimateFootprintBytes,
  formatGiB,
  type GpuMemory,
  type ModelGeometry,
  parseModelGeometry,
  planUtilityResidency,
  type ResidentModel,
  sameModel,
  UTILITY_CONTEXT_LADDER,
  type UtilityCandidate,
  type UtilityModelChoice,
  type UtilityPlan,
  planChatContext,
  type ChatContextPlan,
} from '../residency/footprint';
import { probeGpuMemory } from '../residency/gpuMemory';

import { LlmEndpointService } from './LlmEndpointService';

/**
 * How long one observation of the backend (`/api/ps`, the GPU counters) is
 * reused. The planning crons fan out one job per user at the same instant, so
 * without this a burst of ten utility calls would be ten probes; with it they
 * share one and reach the same answer, which is also what you want — ten
 * concurrent "fits" decisions against the same headroom are one load, not ten.
 */
const SNAPSHOT_TTL_MS = 3_000;

/** `/api/show` and `/api/tags` describe files on disk; they change only on a pull. */
const CATALOG_TTL_MS = 5 * 60_000;

/**
 * How long after a runner first shows up in `/api/ps` its card-level sighting
 * is still taken as its baseline. Long enough to see the vision encoder's
 * buffers, which are allocated on the first image rather than at load; short
 * enough that a runner which grows per request (measured 2026-09-22: ~1.9 MiB
 * per chat request on ROCm, no plateau) contributes minutes of growth, not
 * hours. After the window the sighting is frozen for that runner's lifetime;
 * a reload starts a new baseline. Sightings of a runner whose load this
 * process did not witness are never taken: it may have been growing for hours.
 */
const CARD_BASELINE_WINDOW_MS = 10 * 60_000;

/**
 * How long a planned (non-resident) chat window is answered again without
 * re-planning. A load takes several seconds, `/api/ps` does not list a model
 * until it finishes, and the snapshot is refreshed every few seconds — so
 * without this every call during a load re-derived the window from scratch and
 * two callers could disagree, each reloading the model at its own answer
 * (2026-09-22: 29 loads in 3.5 min, alternating 32k and 4k). The memo lasts as
 * long as the load watchdog: if the model has not shown up by then, the plan
 * is due a rethink anyway. A resident model always wins over the memo.
 */
const PLANNED_WINDOW_STICKY_MS = 120_000;

/** The boot report must never hold the boot open. Same bound as the chat-model preflight. */
const PREFLIGHT_TIMEOUT_MS = 5_000;

/**
 * Bytes to hold back for the embedding model when it is not resident and its
 * catalog entry cannot be read. `nomic-embed-text` is 274 MB of weights and a
 * few tens of MB of KV at its 2048-token window.
 */
const EMBED_RESERVE_FALLBACK_BYTES = 512 * 1024 * 1024;

interface CatalogEntry {
  weightBytes: number;
  geometry: ModelGeometry | null;
  fetchedAt: number;
}

/** A utility-model load this planner asked for and has not yet seen succeed. */
interface PendingLoad {
  model: string;
  numCtx: number | undefined;
  armedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** One runner behind a `/api/ps` row, as this process has watched it. */
interface RunnerInstance {
  contextLength: number | null;
  sizeVramBytes: number;
  firstSeenAt: number;
  /** True when this process saw the runner arrive; false for one already there at its first look. */
  witnessed: boolean;
  /** The largest card figure taken for THIS runner inside its baseline window. */
  cardBytes: number | null;
}

/** What the caller saw happen to a utility call. */
export type UtilityCallOutcome = { ok: true } | { ok: false; error: unknown };

interface Snapshot {
  takenAt: number;
  residents: ResidentModel[];
  gpu: GpuMemory | null;
  /** GGUF file size per served model, keyed by canonical id. Doubles as the served list. */
  weightsByModel: Map<string, number>;
}

/** A plan plus how it was reached, for the boot report and the deep-health route. */
export interface ResidencyReport {
  plan: UtilityPlan;
  chatModel: string;
  utilityModel: string;
  embedModel: string;
  residents: ResidentModel[];
  gpu: GpuMemory | null;
  embedReserveBytes: number;
  /** Set while the watchdog has paused co-residency. */
  coResidencyBlocked: { untilMs: number; reason: string } | null;
  summary: string;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        handle = setTimeout(() => reject(new Error(message)), ms);
        handle.unref?.();
      }),
    ]);
  } finally {
    if (handle) {
      clearTimeout(handle);
    }
  }
}

/**
 * Decides, per utility call, whether the utility model can run beside the
 * chat model and at what context window — see `residency/footprint.ts` for
 * the rules and the measurements behind them.
 *
 * ── What it is NOT allowed to do ───────────────────────────────────────────
 *
 *  - Change the chat model's context. CI-Hub owns `CI_LLM_NUM_CTX`; this
 *    service only decides the UTILITY model's window, and only ever sends a
 *    resident model the window it is already loaded with.
 *  - Un-wedge Ollama. Prevention only: if the utility model cannot be proven
 *    to fit, the call runs on the resident chat model instead.
 *  - Model HBPE. Live used memory already includes it (sysfs / nvidia-smi
 *    rungs); on the config rung the safety margin is the only cover.
 *
 * ── The watchdog ───────────────────────────────────────────────────────────
 *
 * Prevention can still be wrong — an estimate is an estimate. So when the
 * planner answers `'load'`, it also arms a timer. If the model has not shown
 * up in `/api/ps` by `loadWatchdogMs`, or the call that carried the load fails
 * on the first-response deadline (the wedge's exact signature: the request is
 * accepted and nothing ever answers), co-residency is PAUSED for `cooldownMs`
 * and every utility call runs on the chat model. The pause is logged at ERROR
 * with the operator's next step, because a stuck load is not something this
 * process can undo — see `docs/operations/gpu-model-residency.md`.
 *
 * ── Failure handling ───────────────────────────────────────────────────────
 *
 * {@link resolveUtilityModel} never throws and never blocks on a probe for
 * longer than one backend round trip. Anything it cannot read makes it MORE
 * conservative (route to the chat model), never less.
 */
@Injectable()
export class ResidencyPlannerService implements OnModuleInit {
  private snapshot: Snapshot | null = null;

  private snapshotInFlight: Promise<Snapshot> | null = null;

  private readonly catalog = new Map<string, CatalogEntry>();

  /**
   * Latest `/api/ps` sighting per model, keyed by canonical id. Loaded from
   * and written back to {@link CalibrationStore}, so a restart does not forget
   * what a hybrid-architecture model really costs.
   */
  private readonly observations: Map<string, CalibrationRecord>;

  private readonly calibration: CalibrationStore;

  private readonly pendingLoads = new Map<string, PendingLoad>();

  /**
   * The runner instance behind each resident, keyed by canonical id: when it
   * first appeared and whether this process saw it appear (as opposed to
   * finding it already there at boot). A change of window or size is a new
   * instance. Drives {@link CARD_BASELINE_WINDOW_MS}.
   */
  private readonly runnerInstances = new Map<string, RunnerInstance>();

  /** The chat window last planned for a non-resident model, per {@link PLANNED_WINDOW_STICKY_MS}. */
  private readonly plannedWindows = new Map<string, { numCtx: number; plannedAt: number }>();

  private coResidencyBlocked: { untilMs: number; reason: string } | null = null;

  private lastReport: ResidencyReport | null = null;

  private lastLoggedSummary: string | null = null;

  constructor(
    private readonly llmEndpointService: LlmEndpointService,
    private readonly logger: LoggerService,
    // Not a Nest provider: tests hand in an in-memory store, the app gets the
    // on-disk default. `@Optional()` is what stops Nest treating the parameter
    // as a dependency it must resolve — without it boot fails with
    // "Nest can't resolve dependencies of the ResidencyPlannerService".
    @Optional() calibration?: CalibrationStore,
  ) {
    this.logger.setContext(ResidencyPlannerService.name);
    this.calibration = calibration ?? new CalibrationStore(CalibrationStore.defaultPaths(), this.logger);
    this.observations = this.calibration.load();

    if (this.observations.size > 0) {
      this.logger.log(`Loaded ${this.observations.size} persisted GPU residency observation(s)`, {
        models: [...this.observations.keys()],
      });
    }
  }

  async onModuleInit(): Promise<void> {
    await this.preflight();
  }

  /** The most recent report, or `null` before the first plan. */
  get residencyReport(): ResidencyReport | null {
    return this.lastReport;
  }

  /** `LLM_RESIDENCY_MODE=off`, or an OpenAI-compatible backend (no `/api/ps`, no eviction to avoid). */
  get enabled(): boolean {
    return config.llm.residency.mode !== 'off' && !this.llmEndpointService.usesOpenAiDriver();
  }

  /**
   * The model and context the next utility call should use. The only method a
   * caller needs; `OllamaService.chat` calls it for `tier: 'utility'`.
   */
  async resolveUtilityModel(): Promise<UtilityModelChoice> {
    if (!this.enabled) {
      return { model: config.llm.utilityModel };
    }

    try {
      const report = await this.report();
      const { plan } = report;

      if (plan.kind === 'load') {
        this.armWatchdog(plan.model, plan.numCtx);
      }

      return { model: plan.model, ...(plan.numCtx != null && { numCtx: plan.numCtx }), kind: plan.kind };
    } catch (err: unknown) {
      // The backend is down or the probe failed. The call itself will report
      // that far better than this can; hand back the plain configured id and
      // let it.
      this.logger.warn('Residency planning failed; using the configured utility model unplanned', {
        error: err instanceof Error ? err.message : String(err),
      });

      return { model: config.llm.utilityModel };
    }
  }

  /** Compute (or reuse, within {@link SNAPSHOT_TTL_MS}) the full plan with its inputs. */
  /**
   * The chat model's context window as this machine can actually carry it —
   * the loaded window when the model is resident, else the largest rung of
   * {@link CHAT_CONTEXT_LADDER} whose estimated footprint fits the card. Used
   * by the chat path only when `CI_LLM_NUM_CTX` is absent, so a configured or
   * Hub-supplied window always wins. `null` means "nothing can be proven";
   * the caller keeps its static fallback. Never throws.
   */
  async resolveChatContextTokens(model: string = config.llm.chatModel): Promise<number | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      const embedModel = config.embedding.model;
      const snapshot = await this.takeSnapshot();
      // A resident chat model answers from `/api/ps` alone; `/api/show` and the
      // embed reserve are only needed to size a load that has not happened yet.
      const resident = snapshot.residents.some((entry) => sameModel(entry.name, model));
      const id = canonicalModelId(model);

      if (resident) {
        this.plannedWindows.delete(id);
      } else {
        const sticky = this.plannedWindows.get(id);

        if (sticky != null && Date.now() - sticky.plannedAt < PLANNED_WINDOW_STICKY_MS) {
          return sticky.numCtx;
        }
      }

      const candidate = resident ? null : await this.describeCandidate(model, snapshot);
      const embedReserveBytes =
        resident || snapshot.residents.some((entry) => sameModel(entry.name, embedModel))
          ? 0
          : await this.embedReserve(embedModel, snapshot);
      const plan = planChatContext({
        chatModel: model,
        residents: snapshot.residents,
        gpu: snapshot.gpu,
        candidate,
        embedReserveBytes,
        safetyMarginBytes: config.llm.residency.safetyMarginBytes,
        parallelSlots: this.parallelSlots(),
      });
      this.logChatContextChange(model, plan);

      if (plan.kind === 'planned') {
        this.plannedWindows.set(id, { numCtx: plan.numCtx, plannedAt: Date.now() });
      }

      return plan.kind === 'unknown' ? null : plan.numCtx;
    } catch (err: unknown) {
      this.logger.warn('Chat context planning failed; the chat path keeps its configured fallback', {
        model,
        error: err instanceof Error ? err.message : String(err),
      });

      return null;
    }
  }

  /**
   * Ollama slots per loaded model (`llm.residency.parallelSlots`, from `LLM_OLLAMA_NUM_PARALLEL`).
   * Read through a guard: zod defaults it to 1 in production, but a hand-built config (tests,
   * an older Hub env) may omit it, and `undefined × contextLength` would poison a calibration.
   */
  private parallelSlots(): number {
    const configured = config.llm.residency.parallelSlots;

    return typeof configured === 'number' && Number.isFinite(configured) && configured >= 1
      ? Math.floor(configured)
      : 1;
  }

  /** Per-model memory of the last answer, so a steady state costs no log lines. */
  private readonly lastChatContext = new Map<string, string>();

  private logChatContextChange(model: string, plan: ChatContextPlan): void {
    const key = plan.kind === 'unknown' ? `unknown:${plan.reason}` : `${plan.kind}:${plan.numCtx}`;
    if (this.lastChatContext.get(model) === key) {
      return;
    }

    this.lastChatContext.set(model, key);
    if (plan.kind === 'unknown') {
      this.logger.log(
        `Chat context for "${model}" cannot be planned (${plan.reason}); using the configured fallback`,
      );
    } else if (plan.kind === 'resident') {
      this.logger.log(`Chat context for "${model}": ${plan.numCtx} tokens (already resident at that window)`);
    } else {
      this.logger.log(
        `Chat context for "${model}": ${plan.numCtx} tokens (estimated ${formatGiB(plan.footprintBytes)} of ${formatGiB(plan.headroomBytes)} headroom)`,
      );
    }
  }

  async report(): Promise<ResidencyReport> {
    const utilityModel = config.llm.utilityModel;
    const chatModel = config.llm.chatModel;
    const embedModel = config.embedding.model;
    const snapshot = await this.takeSnapshot();

    const candidate = await this.describeCandidate(utilityModel, snapshot);
    const embedReserveBytes = snapshot.residents.some((resident) => sameModel(resident.name, embedModel))
      ? 0
      : await this.embedReserve(embedModel, snapshot);

    const plan = planUtilityResidency({
      utilityModel,
      chatModel,
      residents: snapshot.residents,
      gpu: snapshot.gpu,
      candidate,
      embedReserveBytes,
      safetyMarginBytes: config.llm.residency.safetyMarginBytes,
      ladder: UTILITY_CONTEXT_LADDER.filter((ctx) => ctx <= config.llm.residency.maxUtilityContextTokens),
      coResidencyBlocked: this.activeBlock(),
      parallelSlots: this.parallelSlots(),
    });

    const report: ResidencyReport = {
      plan,
      chatModel,
      utilityModel,
      embedModel,
      residents: snapshot.residents,
      gpu: snapshot.gpu,
      embedReserveBytes,
      coResidencyBlocked: this.activeBlock(),
      summary: ResidencyPlannerService.summarize(
        plan,
        chatModel,
        utilityModel,
        embedModel,
        snapshot,
        embedReserveBytes,
      ),
    };

    this.lastReport = report;

    // One line per CHANGE of decision, not per call: the crons make dozens of
    // utility calls an hour and the interesting event is the flip.
    if (report.summary !== this.lastLoggedSummary) {
      this.lastLoggedSummary = report.summary;
      this.logger.log(`GPU residency plan changed: ${report.summary}`);
    }

    return report;
  }

  /**
   * Boot report. Never throws; an unreachable backend is a warn (it is
   * routinely still starting), everything else is one informational line an
   * operator can read to learn where background inference will run.
   */
  async preflight(): Promise<ResidencyReport | null> {
    if (!this.enabled) {
      this.logger.log(
        config.llm.residency.mode === 'off'
          ? 'GPU residency planning is off (LLM_RESIDENCY_MODE=off); utility calls use the configured model unplanned'
          : 'GPU residency planning does not apply to an OpenAI-compatible backend; utility calls use the configured model',
      );

      return null;
    }

    try {
      const report = await withTimeout(
        this.report(),
        PREFLIGHT_TIMEOUT_MS,
        `the LLM backend did not answer the residency probe within ${PREFLIGHT_TIMEOUT_MS}ms`,
      );

      // report() already logged the summary as a change; make sure boot says it
      // exactly once even when the summary is unchanged from a previous run.
      if (this.lastLoggedSummary !== report.summary) {
        this.logger.log(`GPU residency plan: ${report.summary}`);
      }

      if (report.gpu == null) {
        this.logger.warn(
          'GPU memory could not be read (no AMD sysfs counters, no nvidia-smi, LLM_RESIDENCY_VRAM_TOTAL_BYTES unset). ' +
            'Utility calls will run on the chat model unless the utility model is already resident. ' +
            'Set LLM_RESIDENCY_VRAM_TOTAL_BYTES to the card size, or LLM_RESIDENCY_MODE=off to restore unplanned loads.',
        );
      }

      return report;
    } catch (err: unknown) {
      this.logger.warn(
        'Could not compute the GPU residency plan at boot — the inference backend did not answer',
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );

      return null;
    }
  }

  /**
   * Feedback from the call that used a choice from {@link resolveUtilityModel}.
   *
   * Only a `'load'` choice is interesting. Success clears the watchdog and
   * invalidates the snapshot so the next call records the model's real
   * footprint. A first-response timeout is the wedge's signature — Ollama
   * accepted the request and never started answering — and pauses
   * co-residency at once rather than waiting for the timer. Any other error
   * (a 400, a bad schema) says nothing about residency and is ignored.
   */
  noteUtilityOutcome(choice: UtilityModelChoice, outcome: UtilityCallOutcome): void {
    if (choice.kind !== 'load') {
      return;
    }

    const id = canonicalModelId(choice.model);

    if (outcome.ok) {
      this.clearPending(id);
      this.snapshot = null;

      return;
    }

    if (isFirstResponseTimeout(outcome.error)) {
      this.pauseCoResidency(
        `the planned load of "${choice.model}"${choice.numCtx != null ? ` @${choice.numCtx}` : ''} was accepted by Ollama but never started answering`,
      );
    }
  }

  /** The current pause, or null once it has expired. */
  private activeBlock(): { untilMs: number; reason: string } | null {
    if (this.coResidencyBlocked && Date.now() >= this.coResidencyBlocked.untilMs) {
      this.logger.log('GPU co-residency pause has ended; utility loads may be planned again');
      this.coResidencyBlocked = null;
    }

    return this.coResidencyBlocked;
  }

  private armWatchdog(model: string, numCtx: number | undefined): void {
    const watchdogMs = config.llm.residency.loadWatchdogMs;
    const id = canonicalModelId(model);

    if (watchdogMs <= 0 || this.pendingLoads.has(id)) {
      return;
    }

    const timer = setTimeout(() => {
      void this.checkPendingLoad(id);
    }, watchdogMs);

    timer.unref?.();
    this.pendingLoads.set(id, { model, numCtx, armedAt: Date.now(), timer });
  }

  private clearPending(id: string): void {
    const pending = this.pendingLoads.get(id);

    if (pending?.timer) {
      clearTimeout(pending.timer);
    }

    this.pendingLoads.delete(id);
  }

  /** The timer's half of the watchdog: is the model we asked for actually resident yet? */
  private async checkPendingLoad(id: string): Promise<void> {
    const pending = this.pendingLoads.get(id);

    if (!pending) {
      return;
    }

    let residents: ResidentModel[];

    try {
      this.snapshot = null;
      ({ residents } = await this.takeSnapshot());
    } catch (err: unknown) {
      // The backend is not answering at all. That is its own outage, not a
      // co-residency verdict; leave the pending load and let the chat call's
      // own error reporting speak.
      this.logger.warn('Residency watchdog could not reach the backend to verify a load', {
        model: pending.model,
        error: err instanceof Error ? err.message : String(err),
      });
      this.pendingLoads.delete(id);

      return;
    }

    if (residents.some((resident) => sameModel(resident.name, pending.model))) {
      this.logger.debug('Planned utility load became resident', {
        model: pending.model,
        numCtx: pending.numCtx,
      });
      this.clearPending(id);

      return;
    }

    const waitedS = Math.round((Date.now() - pending.armedAt) / 1000);

    this.pauseCoResidency(
      `"${pending.model}"${pending.numCtx != null ? ` @${pending.numCtx}` : ''} was still not resident ${waitedS}s after its load was requested`,
    );
  }

  private pauseCoResidency(reason: string): void {
    const cooldownMs = config.llm.residency.cooldownMs;
    const untilMs = Date.now() + cooldownMs;

    for (const id of [...this.pendingLoads.keys()]) {
      this.clearPending(id);
    }

    this.coResidencyBlocked = { untilMs, reason };
    // Force the next call to re-plan against the pause rather than a cached plan.
    this.snapshot = null;
    this.lastLoggedSummary = null;

    this.logger.error(
      `GPU co-residency paused for ${Math.round(cooldownMs / 60_000)} min: ${reason}. ` +
        'This is the signature of an Ollama load stuck behind an eviction it cannot make. Utility calls run on the chat model ' +
        'meanwhile. If embeds or chat also hang, restart Ollama; see docs/operations/gpu-model-residency.md.',
    );
  }

  private get ollama(): Ollama {
    return new Ollama({ host: this.llmEndpointService.getOllamaHost() });
  }

  private async takeSnapshot(): Promise<Snapshot> {
    const now = Date.now();

    if (this.snapshot && now - this.snapshot.takenAt < SNAPSHOT_TTL_MS) {
      return this.snapshot;
    }

    if (this.snapshotInFlight) {
      return this.snapshotInFlight;
    }

    this.snapshotInFlight = this.buildSnapshot()
      .then((snapshot) => (this.snapshot = snapshot))
      .finally(() => (this.snapshotInFlight = null));

    return this.snapshotInFlight;
  }

  private async buildSnapshot(): Promise<Snapshot> {
    const client = this.ollama;
    const [ps, tags] = await Promise.all([client.ps(), client.list()]);

    const residents: ResidentModel[] = ps.models.map((model) => {
      const raw = model as { name: string; size_vram?: number; context_length?: number };

      return {
        name: raw.name,
        sizeVramBytes: raw.size_vram ?? 0,
        contextLength: raw.context_length != null && raw.context_length > 0 ? raw.context_length : null,
      };
    });

    const weightsByModel = new Map(tags.models.map((model) => [canonicalModelId(model.name), model.size]));

    // Every sighting of a loaded model is a calibration point: what it REALLY
    // costs above its weights at the context it is running at. Persisted when
    // the numbers move, not on every poll.
    let changed = false;

    const residentBytes = residents.reduce((total, resident) => total + resident.sizeVramBytes, 0);
    const gpu = await probeGpuMemory({
      configuredTotalBytes: config.llm.residency.vramTotalBytes,
      residentBytes,
    });

    // The card's unaccounted bytes — what sysfs says is used beyond every resident's own
    // `size_vram` — belong to the largest resident: its vision encoder, llama.cpp scratch and
    // prompt cache. Only a real counter can say this (the `config` source is just residentBytes
    // echoed back), and only when the counter exceeds Ollama's own accounting.
    const largest = residents.reduce<ResidentModel | null>(
      (best, resident) => (best == null || resident.sizeVramBytes > best.sizeVramBytes ? resident : best),
      null,
    );
    const cardBytesForLargest =
      gpu != null && gpu.source !== 'config' && largest != null && gpu.usedBytes > residentBytes
        ? gpu.usedBytes - (residentBytes - largest.sizeVramBytes)
        : null;
    const now = Date.now();
    this.trackRunnerInstances(residents, now);
    for (const resident of residents) {
      const id = canonicalModelId(resident.name);
      const weightBytes = weightsByModel.get(id);
      if (weightBytes == null || resident.contextLength == null || resident.sizeVramBytes <= 0) {
        continue;
      }

      const isLargest = largest != null && sameModel(resident.name, largest.name);
      const instance = this.runnerInstances.get(id);
      // The card figure is this runner's BASELINE, taken only while the runner is young and
      // only when this process saw it arrive — see CARD_BASELINE_WINDOW_MS. It replaces
      // whatever an earlier runner left behind (no ratchet across reloads) and, within the
      // window, only grows: buffers appear as features are exercised (the first image
      // allocates the vision encoder), and a sighting before that must not win.
      const inBaselineWindow =
        instance != null && instance.witnessed && now - instance.firstSeenAt <= CARD_BASELINE_WINDOW_MS;
      const cardBytes =
        isLargest && cardBytesForLargest != null && inBaselineWindow
          ? Math.max(cardBytesForLargest, instance.cardBytes ?? 0)
          : undefined;
      if (cardBytes != null && instance != null) {
        instance.cardBytes = cardBytes;
      }

      const totalTokens = cardBytes != null ? resident.contextLength * this.parallelSlots() : undefined;
      const previous = this.observations.get(id);
      if (
        previous &&
        previous.numCtx === resident.contextLength &&
        previous.sizeVramBytes === resident.sizeVramBytes &&
        previous.weightBytes === weightBytes &&
        (cardBytes == null || previous.cardBytes === cardBytes)
      ) {
        continue;
      }

      const keepPrevious =
        cardBytes == null &&
        previous?.cardBytes != null &&
        previous.totalTokens != null &&
        previous.numCtx === resident.contextLength;
      this.observations.set(id, {
        numCtx: resident.contextLength,
        sizeVramBytes: resident.sizeVramBytes,
        weightBytes,
        seenAt: new Date().toISOString(),
        ...(cardBytes != null && totalTokens != null
          ? { cardBytes, totalTokens }
          : keepPrevious
            ? { cardBytes: previous.cardBytes, totalTokens: previous.totalTokens }
            : {}),
      });
      changed = true;
      // A model we asked to load is now here: the watchdog can stand down.
      this.clearPending(id);
    }

    if (changed) {
      this.calibration.save(this.observations);
    }

    return { takenAt: Date.now(), residents, gpu, weightsByModel };
  }

  /**
   * Reconcile {@link runnerInstances} with this `/api/ps` page. A resident seen for the
   * first time is a new instance, witnessed only if this process had taken a snapshot
   * before (a runner already there at boot has an unknown age). A resident whose window
   * or size changed is a fresh runner too. Residents that left are forgotten, so their
   * next appearance counts as a witnessed load.
   */
  private trackRunnerInstances(residents: readonly ResidentModel[], now: number): void {
    const witnessedArrivals = this.snapshot != null;
    const present = new Set<string>();
    for (const resident of residents) {
      const id = canonicalModelId(resident.name);
      present.add(id);
      const known = this.runnerInstances.get(id);
      // A reload to the same window and size looks identical in `/api/ps`. But when this
      // process planned a load for the model (the chat memo) or asked for one (the utility
      // watchdog) and it now shows up, that arrival IS the runner it planned for — a fresh
      // baseline, whatever the previous instance looked like.
      const arrivedAsPlanned = this.plannedWindows.has(id) || this.pendingLoads.has(id);
      const sameInstance =
        known != null &&
        !arrivedAsPlanned &&
        known.contextLength === resident.contextLength &&
        known.sizeVramBytes === resident.sizeVramBytes;
      if (!sameInstance) {
        this.runnerInstances.set(id, {
          contextLength: resident.contextLength,
          sizeVramBytes: resident.sizeVramBytes,
          firstSeenAt: now,
          witnessed: witnessedArrivals,
          cardBytes: null,
        });
      }
    }

    for (const id of [...this.runnerInstances.keys()]) {
      if (!present.has(id)) {
        this.runnerInstances.delete(id);
      }
    }
  }

  private async catalogEntry(model: string, snapshot: Snapshot): Promise<CatalogEntry | null> {
    const id = canonicalModelId(model);
    const weightBytes = snapshot.weightsByModel.get(id);

    if (weightBytes == null) {
      return null;
    }

    const cached = this.catalog.get(id);

    if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
      return cached;
    }

    // Weights ride along with `/api/tags` (already in the snapshot); only the
    // attention geometry needs `/api/show`.
    const show = await this.ollama.show({ model });
    const entry: CatalogEntry = {
      weightBytes,
      geometry: parseModelGeometry(
        show.model_info as Map<string, unknown> | Record<string, unknown> | undefined,
      ),
      fetchedAt: Date.now(),
    };

    this.catalog.set(id, entry);

    return entry;
  }

  private async describeCandidate(model: string, snapshot: Snapshot): Promise<UtilityCandidate | null> {
    const entry = await this.catalogEntry(model, snapshot);

    if (entry == null) {
      return null;
    }

    return {
      weightBytes: entry.weightBytes > 0 ? entry.weightBytes : null,
      geometry: entry.geometry,
      observation: this.observations.get(canonicalModelId(model)) ?? null,
    };
  }

  /**
   * The embedding model's slot when it is not resident: its weights plus KV at
   * its training window (Ollama clamps `num_ctx` to that anyway — the journal's
   * `requested context size too large for model` warning is that clamp).
   */
  private async embedReserve(embedModel: string, snapshot: Snapshot): Promise<number> {
    try {
      const entry = await this.catalogEntry(embedModel, snapshot);

      if (entry == null || entry.weightBytes <= 0 || entry.geometry == null) {
        return EMBED_RESERVE_FALLBACK_BYTES;
      }

      return estimateFootprintBytes({
        weightBytes: entry.weightBytes,
        geometry: entry.geometry,
        numCtx: entry.geometry.trainingContextLength ?? 2_048,
      });
    } catch {
      return EMBED_RESERVE_FALLBACK_BYTES;
    }
  }

  private static summarize(
    plan: UtilityPlan,
    chatModel: string,
    utilityModel: string,
    embedModel: string,
    snapshot: Snapshot,
    embedReserveBytes: number,
  ): string {
    const describeResident = (model: string): string => {
      const resident = snapshot.residents.find((entry) => sameModel(entry.name, model));

      return resident
        ? `resident @${resident.contextLength ?? '?'} (${formatGiB(resident.sizeVramBytes)})`
        : 'not resident';
    };

    const utility =
      plan.kind === 'resident'
        ? `"${utilityModel}" ${describeResident(utilityModel)} — used as is`
        : plan.kind === 'load'
          ? `"${utilityModel}" fits @${plan.numCtx} (needs ${formatGiB(plan.footprintBytes)} of ${formatGiB(plan.headroomBytes)} headroom)`
          : `"${utilityModel}" routed to chat model${plan.numCtx != null ? ` @${plan.numCtx}` : ''} — ${plan.reason}` +
            (plan.headroomBytes != null
              ? ` (smallest footprint ${formatGiB(plan.smallestFootprintBytes)}, headroom ${formatGiB(plan.headroomBytes)})`
              : '');

    const gpu = snapshot.gpu
      ? `GPU ${formatGiB(snapshot.gpu.totalBytes)} total, ${formatGiB(snapshot.gpu.usedBytes)} used (${snapshot.gpu.source}${snapshot.gpu.device ? ` ${snapshot.gpu.device}` : ''})`
      : 'GPU memory unknown';

    const embed =
      embedReserveBytes > 0
        ? `embed "${embedModel}" not resident, ${formatGiB(embedReserveBytes)} reserved`
        : `embed "${embedModel}" ${describeResident(embedModel)}`;

    return `chat "${chatModel}" ${describeResident(chatModel)}; utility ${utility}; ${embed}; ${gpu}`;
  }
}
