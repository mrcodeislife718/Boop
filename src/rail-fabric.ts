export type RailType = 'internal' | 'ach' | 'card' | 'rtp' | 'fednow' | 'bank-transfer' | 'other';

export type RailCapability = {
  id: string;
  provider: string;
  railType: RailType;
  currencies: string[];
  jurisdictions: string[];
  maxAmountMinor?: bigint;
  minAmountMinor?: bigint;
  supportsInstantFinality: boolean;
  supportsRefunds: boolean;
  supportsIdempotency: boolean;
  estimatedCostBps: number;
  fixedFeeMinor: bigint;
  expectedLatencyMs: number;
  reliability: number;
  enabled: boolean;
};

export type RailRequest = {
  amountMinor: bigint;
  currency: string;
  jurisdiction: string;
  requireInstant?: boolean;
  requireRefunds?: boolean;
  preferredRailTypes?: RailType[];
  maxEstimatedCostMinor?: bigint;
};

export type RailDecision = {
  capabilityId: string;
  provider: string;
  railType: RailType;
  estimatedCostMinor: bigint;
  expectedLatencyMs: number;
  reliability: number;
  score: number;
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export class RailFabric {
  private readonly capabilities = new Map<string, RailCapability>();

  register(capability: RailCapability): RailCapability {
    if (!capability.id.trim() || !capability.provider.trim()) throw new Error('Rail capability id and provider are required');
    if (!capability.currencies.length || !capability.jurisdictions.length) throw new Error('Rail capability must declare currencies and jurisdictions');
    if (capability.estimatedCostBps < 0 || capability.fixedFeeMinor < 0n || capability.expectedLatencyMs < 0) throw new Error('Rail costs and latency must be non-negative');
    if (!Number.isFinite(capability.reliability) || capability.reliability < 0 || capability.reliability > 1) throw new Error('Rail reliability must be between 0 and 1');
    const copy = structuredClone(capability);
    this.capabilities.set(copy.id, copy);
    return structuredClone(copy);
  }

  get(id: string): RailCapability | undefined {
    const capability = this.capabilities.get(id);
    return capability ? structuredClone(capability) : undefined;
  }

  setEnabled(id: string, enabled: boolean): void {
    const capability = this.capabilities.get(id);
    if (!capability) throw new Error(`Unknown rail capability: ${id}`);
    capability.enabled = enabled;
  }

  route(request: RailRequest): RailDecision[] {
    if (request.amountMinor <= 0n) throw new Error('amountMinor must be positive');
    if (!/^[A-Z]{3}$/.test(request.currency)) throw new Error('currency must be an uppercase ISO-style code');
    const preferences = request.preferredRailTypes ?? [];
    const decisions: RailDecision[] = [];
    for (const capability of this.capabilities.values()) {
      if (!capability.enabled) continue;
      if (!capability.currencies.includes(request.currency)) continue;
      if (!capability.jurisdictions.includes(request.jurisdiction) && !capability.jurisdictions.includes('*')) continue;
      if (capability.minAmountMinor !== undefined && request.amountMinor < capability.minAmountMinor) continue;
      if (capability.maxAmountMinor !== undefined && request.amountMinor > capability.maxAmountMinor) continue;
      if (request.requireInstant && !capability.supportsInstantFinality) continue;
      if (request.requireRefunds && !capability.supportsRefunds) continue;
      const variableFee = (request.amountMinor * BigInt(Math.round(capability.estimatedCostBps))) / 10_000n;
      const estimatedCostMinor = variableFee + capability.fixedFeeMinor;
      if (request.maxEstimatedCostMinor !== undefined && estimatedCostMinor > request.maxEstimatedCostMinor) continue;
      const preferenceIndex = preferences.indexOf(capability.railType);
      const preferenceBoost = preferenceIndex >= 0 ? (preferences.length - preferenceIndex) / Math.max(1, preferences.length) : 0;
      const latencyScore = 1 / (1 + Math.log1p(capability.expectedLatencyMs));
      const costNumber = Number(estimatedCostMinor > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : estimatedCostMinor);
      const costScore = 1 / (1 + Math.log1p(costNumber));
      const score = clamp01(capability.reliability * 0.55 + latencyScore * 0.2 + costScore * 0.2 + preferenceBoost * 0.05);
      decisions.push({ capabilityId: capability.id, provider: capability.provider, railType: capability.railType, estimatedCostMinor, expectedLatencyMs: capability.expectedLatencyMs, reliability: capability.reliability, score });
    }
    return decisions.sort((a, b) => b.score - a.score || a.expectedLatencyMs - b.expectedLatencyMs || a.capabilityId.localeCompare(b.capabilityId));
  }

  choose(request: RailRequest): RailDecision {
    const [best] = this.route(request);
    if (!best) throw new Error('No rail satisfies payment requirements');
    return best;
  }

  decisionFor(id: string, amountMinor: bigint): RailDecision {
    const capability = this.capabilities.get(id);
    if (!capability) throw new Error(`Unknown rail capability: ${id}`);
    const variableFee = (amountMinor * BigInt(Math.round(capability.estimatedCostBps))) / 10_000n;
    return { capabilityId: capability.id, provider: capability.provider, railType: capability.railType, estimatedCostMinor: variableFee + capability.fixedFeeMinor, expectedLatencyMs: capability.expectedLatencyMs, reliability: capability.reliability, score: 1 };
  }
}
