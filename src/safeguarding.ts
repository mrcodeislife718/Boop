export type SafeguardedAssetPosition = {
  id: string;
  provider: string;
  currency: string;
  amountMinor: bigint;
  observedAt: string;
  accountReference: string;
  status: 'available' | 'restricted' | 'unavailable';
};

export type LiabilityPosition = {
  currency: string;
  customerLiabilityMinor: bigint;
  pendingWithdrawalMinor: bigint;
};

export type SafeguardingStatus = {
  currency: string;
  availableAssetsMinor: bigint;
  customerLiabilityMinor: bigint;
  pendingWithdrawalMinor: bigint;
  requiredMinor: bigint;
  surplusMinor: bigint;
  coverageRatio: number;
  healthy: boolean;
};

export class SafeguardingEngine {
  private readonly assets = new Map<string, SafeguardedAssetPosition>();

  recordAsset(position: SafeguardedAssetPosition): void {
    if (!position.id || !position.provider || !position.accountReference) throw new Error('Safeguarded asset identity is required');
    if (!/^[A-Z]{3}$/.test(position.currency)) throw new Error('Invalid currency');
    if (position.amountMinor < 0n) throw new Error('Safeguarded assets cannot be negative');
    if (!Number.isFinite(Date.parse(position.observedAt))) throw new Error('Invalid asset observation timestamp');
    this.assets.set(position.id, structuredClone(position));
  }

  evaluate(liability: LiabilityPosition): SafeguardingStatus {
    if (liability.customerLiabilityMinor < 0n || liability.pendingWithdrawalMinor < 0n) throw new Error('Liabilities cannot be negative');
    const availableAssetsMinor = [...this.assets.values()]
      .filter((asset) => asset.currency === liability.currency && asset.status === 'available')
      .reduce((total, asset) => total + asset.amountMinor, 0n);
    const requiredMinor = liability.customerLiabilityMinor + liability.pendingWithdrawalMinor;
    const surplusMinor = availableAssetsMinor - requiredMinor;
    const coverageRatio = requiredMinor === 0n ? Number.POSITIVE_INFINITY : Number(availableAssetsMinor) / Number(requiredMinor);
    return {
      currency: liability.currency,
      availableAssetsMinor,
      customerLiabilityMinor: liability.customerLiabilityMinor,
      pendingWithdrawalMinor: liability.pendingWithdrawalMinor,
      requiredMinor,
      surplusMinor,
      coverageRatio,
      healthy: surplusMinor >= 0n,
    };
  }

  assertCanIncreaseLiability(liability: LiabilityPosition, increaseMinor: bigint): SafeguardingStatus {
    if (increaseMinor < 0n) throw new Error('increaseMinor must be non-negative');
    const projected = this.evaluate({ ...liability, customerLiabilityMinor: liability.customerLiabilityMinor + increaseMinor });
    if (!projected.healthy) throw new Error(`Safeguarding deficit for ${liability.currency}`);
    return projected;
  }

  concentration(currency: string): Array<{ provider: string; amountMinor: bigint; share: number }> {
    const byProvider = new Map<string, bigint>();
    for (const asset of this.assets.values()) {
      if (asset.currency !== currency || asset.status !== 'available') continue;
      byProvider.set(asset.provider, (byProvider.get(asset.provider) ?? 0n) + asset.amountMinor);
    }
    const total = [...byProvider.values()].reduce((sum, value) => sum + value, 0n);
    return [...byProvider.entries()]
      .map(([provider, amountMinor]) => ({ provider, amountMinor, share: total === 0n ? 0 : Number(amountMinor) / Number(total) }))
      .sort((a, b) => b.share - a.share || a.provider.localeCompare(b.provider));
  }
}
