/** Preview is deliberately bounded; counts and bytes describe only the scanned prefix. */
export interface PreviewStreamCompactionInput {
  streamId: string;
  retentionMs: number;
  scanLimit?: number;
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

export function emptyPayloadBytes(): StreamPayloadBytes {
  return { metadata: 0, rawPayload: 0, providerRawPayload: 0, deliveryHandle: 0, total: 0 };
}
