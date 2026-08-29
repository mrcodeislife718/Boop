export type ReconciliationObservation = {
  id: string;
  boundaryAccountId: string;
  provider: string;
  currency: string;
  expectedMinor: bigint;
  observedMinor: bigint;
  observedAt: string;
  settlementReference?: string;
};

export type ReconciliationVariance = {
  observationId: string;
  boundaryAccountId: string;
  provider: string;
  currency: string;
  varianceMinor: bigint;
  absoluteVarianceMinor: bigint;
  status: 'matched' | 'pending-window' | 'quarantined' | 'resolved';
  detectedAt: string;
  resolvedAt?: string;
  resolutionReference?: string;
};

export type ReconciliationPolicy = {
  toleranceMinor: bigint;
  settlementWindowMs: number;
  quarantineThresholdMinor: bigint;
};

export class ContinuousReconciliationEngine {
  private readonly observations = new Map<string, ReconciliationObservation>();
  private readonly variances = new Map<string, ReconciliationVariance>();

  constructor(private readonly policy: ReconciliationPolicy) {
    if (policy.toleranceMinor < 0n || policy.quarantineThresholdMinor < policy.toleranceMinor || policy.settlementWindowMs < 0) {
      throw new Error('Invalid reconciliation policy');
    }
  }

  observe(input: ReconciliationObservation, now = Date.now()): ReconciliationVariance {
    if (this.observations.has(input.id)) return structuredClone(this.variances.get(input.id)!);
    if (!input.boundaryAccountId || !input.provider || !/^[A-Z]{3}$/.test(input.currency)) {
      throw new Error('Boundary account, provider, and currency are required');
    }
    const observedTime = Date.parse(input.observedAt);
    if (!Number.isFinite(observedTime)) throw new Error('observedAt must be a valid timestamp');
    const varianceMinor = input.observedMinor - input.expectedMinor;
    const absoluteVarianceMinor = varianceMinor < 0n ? -varianceMinor : varianceMinor;
    let status: ReconciliationVariance['status'];
    if (absoluteVarianceMinor <= this.policy.toleranceMinor) {
      status = 'matched';
    } else if (absoluteVarianceMinor >= this.policy.quarantineThresholdMinor) {
      status = 'quarantined';
    } else if (now - observedTime <= this.policy.settlementWindowMs) {
      status = 'pending-window';
    } else {
      status = 'quarantined';
    }
    const variance: ReconciliationVariance = {
      observationId: input.id,
      boundaryAccountId: input.boundaryAccountId,
      provider: input.provider,
      currency: input.currency,
      varianceMinor,
      absoluteVarianceMinor,
      status,
      detectedAt: new Date(now).toISOString(),
    };
    this.observations.set(input.id, structuredClone(input));
    this.variances.set(input.id, variance);
    return structuredClone(variance);
  }

  reevaluate(now = Date.now()): ReconciliationVariance[] {
    for (const variance of this.variances.values()) {
      if (variance.status !== 'pending-window') continue;
      const observation = this.observations.get(variance.observationId)!;
      if (now - Date.parse(observation.observedAt) > this.policy.settlementWindowMs) {
        variance.status = variance.absoluteVarianceMinor <= this.policy.toleranceMinor ? 'matched' : 'quarantined';
      }
    }
    return this.list();
  }

  resolve(observationId: string, resolutionReference: string, now = Date.now()): ReconciliationVariance {
    const variance = this.variances.get(observationId);
    if (!variance) throw new Error(`Unknown reconciliation observation: ${observationId}`);
    if (variance.status === 'matched') return structuredClone(variance);
    if (!resolutionReference.trim()) throw new Error('resolutionReference is required');
    variance.status = 'resolved';
    variance.resolvedAt = new Date(now).toISOString();
    variance.resolutionReference = resolutionReference;
    return structuredClone(variance);
  }

  quarantined(provider?: string): ReconciliationVariance[] {
    return [...this.variances.values()]
      .filter((variance) => variance.status === 'quarantined')
      .filter((variance) => !provider || variance.provider === provider)
      .map((variance) => structuredClone(variance));
  }

  assertProviderHealthy(provider: string): void {
    const unresolved = [...this.variances.values()].some((variance) => variance.provider === provider && variance.status === 'quarantined');
    if (unresolved) throw new Error(`Provider ${provider} is quarantined by reconciliation`);
  }

  list(): ReconciliationVariance[] {
    return [...this.variances.values()].map((variance) => structuredClone(variance));
  }
}
