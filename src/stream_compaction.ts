/** Preview is deliberately bounded; counts and bytes describe only the scanned prefix. */
export interface PreviewStreamCompactionInput {
  streamId: string;
  retentionMs: number;
  scanLimit?: number;
}

/** Each invocation recomputes eligibility; a preview is never an apply token. */
export interface ApplyStreamCompactionInput {
  streamId: string;
  retentionMs: number;
  batchSize?: number;
  maxEvents?: number;
  maxPayloadBytes?: number;
}

export interface StreamCompactionResult {
  streamId: string;
  dryRun: false;
  cutoff: string;
  prunedEvents: number;
  prunedPayloadBytes: StreamPayloadBytes;
  batches: number;
  safeBeforeOffset: number | null;
  blockingConsumers: Array<{ consumerId: string; nextOffset: number }>;
  blockingConsumersHasMore: boolean;
  prunedThroughOffset: number | null;
  retainedFromOffset: number;
  nextOffset: number;
  hasMore: boolean;
  stopReason: "no_consumers" | "consumer_boundary" | "retention_boundary"
    | "event_limit" | "oversized" | "exhausted";
  oversizedOffset?: number;
}

export interface StreamHistoryBounds {
  prunedThroughOffset: number | null;
  retainedFromOffset: number;
  highWatermarkOffset: number | null;
}

export class HistoryUnavailableError extends Error {
  readonly code = "history_unavailable";
  readonly statusCode = 409;
  constructor(
    readonly streamId: string,
    readonly requested: { offset?: number; time?: string; startPolicy?: string },
    readonly retainedFromOffset: number,
    readonly highWatermarkOffset: number | null,
  ) {
    super(`history unavailable for stream ${streamId}; retained history starts at offset ${retainedFromOffset}`);
    this.name = "HistoryUnavailableError";
  }
}

export interface StreamPayloadBytes {
  metadata: number;
  rawPayload: number;
  providerRawPayload: number;
  deliveryHandle: number;
  total: number;
}

export interface StreamCompactionPreview {
  streamId: string;
  dryRun: true;
  cutoff: string;
  scanLimit: number;
  countsScope: "scanned_prefix";
  scannedEvents: number;
  candidateEvents: number;
  protectedEvents: number;
  scannedPayloadBytes: StreamPayloadBytes;
  candidatePayloadBytes: StreamPayloadBytes;
  safeBeforeOffset: number | null;
  blockingConsumers: Array<{ consumerId: string; nextOffset: number }>;
  blockingConsumersHasMore: boolean;
  candidateThroughOffset: number | null;
  projectedRetainedFromOffset: number;
  hasMore: boolean;
  estimated: boolean;
  stopReason: "no_consumers" | "consumer_boundary" | "retention_boundary" | "scan_limit" | "exhausted";
}

export function compactionPreviewOptions(input: PreviewStreamCompactionInput, now = Date.now()) {
  const scanLimit = input.scanLimit ?? 1000;
  if (!Number.isSafeInteger(input.retentionMs) || input.retentionMs <= 0
    || !Number.isFinite(new Date(now - input.retentionMs).getTime())) {
    throw Object.assign(new Error("invalid retentionMs: expected a positive duration in milliseconds"), { statusCode: 400 });
  }
  if (!Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > 1000) {
    throw Object.assign(new Error("invalid scanLimit: expected an integer from 1 to 1000"), { statusCode: 400 });
  }
  return { scanLimit, cutoff: new Date(now - input.retentionMs).toISOString() };
}

export function compactionApplyOptions(input: ApplyStreamCompactionInput, now = Date.now()) {
  const { cutoff } = compactionPreviewOptions(input, now);
  const batchSize = input.batchSize ?? 100;
  const maxEvents = input.maxEvents ?? 1000;
  const maxPayloadBytes = input.maxPayloadBytes ?? 8 * 1024 * 1024;
  for (const [name, value, maximum] of [
    ["batchSize", batchSize, 100],
    ["maxEvents", maxEvents, 1000],
    ["maxPayloadBytes", maxPayloadBytes, 8 * 1024 * 1024],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw Object.assign(new Error(`invalid ${name}: expected an integer from 1 to ${maximum}`), { statusCode: 400 });
    }
  }
  return { cutoff, batchSize, maxEvents, maxPayloadBytes };
}

export function emptyPayloadBytes(): StreamPayloadBytes {
  return { metadata: 0, rawPayload: 0, providerRawPayload: 0, deliveryHandle: 0, total: 0 };
}
