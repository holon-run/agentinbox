/**
 * Runtime observability for the control plane.
 *
 * The daemon serves every request from a single event loop, so any
 * synchronous work on that loop delays every other request. These metrics
 * turn "the daemon sometimes stops answering" into a number that the daily
 * audit can track over time (#276).
 */

export interface SlowOperationRecord {
  label: string;
  durationMs: number;
  at: string;
}

export interface RuntimeMetricsSnapshot {
  /** Lag of the most recent event loop sample, in milliseconds. */
  eventLoopLagMs: number;
  /** Largest lag observed since the monitor started. */
  maxEventLoopLagMs: number;
  /** Number of event loop samples taken so far. */
  eventLoopSamples: number;
  /** Consecutive samples whose lag reached the stall threshold. */
  consecutiveStallSamples: number;
  /** ISO timestamp of the most recent stalled sample, if any. */
  lastStallAt: string | null;
  /** Total number of slow operations observed. */
  slowOperationCount: number;
  /** Most recent slow operations, newest first. */
  slowOperations: SlowOperationRecord[];
  /** Milliseconds since the monitor started. */
  uptimeMs: number;
}

export interface RuntimeMetricsOptions {
  /** Sampling period of the event loop lag probe. */
  sampleIntervalMs?: number;
  /** Operations at or above this duration are recorded as slow. */
  slowOperationThresholdMs?: number;
  /** Maximum number of slow operations kept in the snapshot. */
  maxSlowOperations?: number;
  /** Lag at or above this value counts as a stalled sample. */
  stallThresholdMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

const DEFAULT_SAMPLE_INTERVAL_MS = 250;
const DEFAULT_SLOW_OPERATION_THRESHOLD_MS = 100;
const DEFAULT_MAX_SLOW_OPERATIONS = 20;
const DEFAULT_STALL_THRESHOLD_MS = 2_000;

export class RuntimeMetrics {
  private readonly sampleIntervalMs: number;
  private readonly slowOperationThresholdMs: number;
  private readonly maxSlowOperations: number;
  private readonly stallThresholdMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private lastLagMs = 0;
  private maxLagMs = 0;
  private lagSamples = 0;
  private consecutiveStallSamples = 0;
  private lastStallAtMs: number | null = null;
  private slowOperationCount = 0;
  private readonly slowOperations: SlowOperationRecord[] = [];

  constructor(options: RuntimeMetricsOptions = {}) {
    this.sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.slowOperationThresholdMs = options.slowOperationThresholdMs ?? DEFAULT_SLOW_OPERATION_THRESHOLD_MS;
    this.maxSlowOperations = options.maxSlowOperations ?? DEFAULT_MAX_SLOW_OPERATIONS;
    this.stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.startedAt = this.now();
    this.scheduleSample();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Records an observed event loop lag sample. */
  recordEventLoopLag(lagMs: number): void {
    const lag = Number.isFinite(lagMs) ? Math.max(0, lagMs) : 0;
    this.lastLagMs = lag;
    this.maxLagMs = Math.max(this.maxLagMs, lag);
    this.lagSamples += 1;
    if (lag >= this.stallThresholdMs) {
      this.consecutiveStallSamples += 1;
      this.lastStallAtMs = this.now();
    } else {
      this.consecutiveStallSamples = 0;
    }
  }

  /** Records a completed synchronous operation; slow ones are kept. */
  recordOperation(label: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < this.slowOperationThresholdMs) {
      return;
    }
    this.slowOperationCount += 1;
    this.slowOperations.unshift({
      label,
      durationMs: Math.round(durationMs),
      at: new Date(this.now()).toISOString(),
    });
    if (this.slowOperations.length > this.maxSlowOperations) {
      this.slowOperations.length = this.maxSlowOperations;
    }
  }

  snapshot(): RuntimeMetricsSnapshot {
    return {
      eventLoopLagMs: Math.round(this.lastLagMs),
      maxEventLoopLagMs: Math.round(this.maxLagMs),
      eventLoopSamples: this.lagSamples,
      consecutiveStallSamples: this.consecutiveStallSamples,
      lastStallAt: this.lastStallAtMs != null ? new Date(this.lastStallAtMs).toISOString() : null,
      slowOperationCount: this.slowOperationCount,
      slowOperations: this.slowOperations.map((operation) => ({ ...operation })),
      uptimeMs: this.startedAt > 0 ? Math.max(0, this.now() - this.startedAt) : 0,
    };
  }

  private scheduleSample(): void {
    const expectedAt = this.now() + this.sampleIntervalMs;
    this.timer = setTimeout(() => {
      this.recordEventLoopLag(this.now() - expectedAt);
      this.scheduleSample();
    }, this.sampleIntervalMs);
    this.timer.unref?.();
  }
}
