import { performance } from 'node:perf_hooks';

export type OperationSample = {
  id: string;
  operation: string;
  startedAt: string;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  metadata?: Record<string, string | number | boolean>;
};

export type OperationSummary = {
  operation: string;
  samples: number;
  successRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  p100Ms: number;
  throughputPerSecond: number;
  errorCounts: Record<string, number>;
};

const percentile = (sorted: number[], q: number): number => {
  if (!sorted.length) return 0;
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1));
  return sorted[rank];
};

export class FinancialBenchmarkLedger {
  private readonly samples: OperationSample[] = [];

  record(sample: OperationSample): void {
    if (!sample.id || !sample.operation) throw new Error('Benchmark sample identity is required');
    if (!Number.isFinite(sample.durationMs) || sample.durationMs < 0) throw new Error('durationMs must be non-negative');
    if (!Number.isFinite(Date.parse(sample.startedAt))) throw new Error('startedAt must be valid');
    if (this.samples.some((entry) => entry.id === sample.id)) throw new Error(`Duplicate benchmark sample: ${sample.id}`);
    this.samples.push(structuredClone(sample));
  }

  async measure<T>(id: string, operation: string, fn: () => Promise<T>, metadata?: OperationSample['metadata']): Promise<T> {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    try {
      const result = await fn();
      this.record({ id, operation, startedAt, durationMs: performance.now() - start, success: true, metadata });
      return result;
    } catch (error) {
      const code = error instanceof Error ? error.name || 'Error' : 'UnknownError';
      this.record({ id, operation, startedAt, durationMs: performance.now() - start, success: false, errorCode: code, metadata });
      throw error;
    }
  }

  summarize(operation: string): OperationSummary {
    const samples = this.samples.filter((sample) => sample.operation === operation);
    if (!samples.length) throw new Error(`No benchmark samples for ${operation}`);
    const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
    const totalDurationMs = samples.reduce((sum, sample) => sum + sample.durationMs, 0);
    const errorCounts: Record<string, number> = {};
    for (const sample of samples) if (!sample.success) errorCounts[sample.errorCode ?? 'UnknownError'] = (errorCounts[sample.errorCode ?? 'UnknownError'] ?? 0) + 1;
    return {
      operation,
      samples: samples.length,
      successRate: samples.filter((sample) => sample.success).length / samples.length,
      p50Ms: percentile(durations, 0.50),
      p95Ms: percentile(durations, 0.95),
      p99Ms: percentile(durations, 0.99),
      p100Ms: durations.at(-1) ?? 0,
      throughputPerSecond: totalDurationMs === 0 ? Number.POSITIVE_INFINITY : samples.length / (totalDurationMs / 1000),
      errorCounts,
    };
  }
}
