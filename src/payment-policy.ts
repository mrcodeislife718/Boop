export type VerificationLevel = 'unverified' | 'basic' | 'verified' | 'enhanced';

export type PaymentPolicyContext = {
  payerAccountId: string;
  payeeAccountId: string;
  amountMinor: bigint;
  currency: string;
  jurisdiction: string;
  payerVerification: VerificationLevel;
  payeeVerification: VerificationLevel;
  velocityCount24h: number;
  velocityAmount24hMinor: bigint;
  accountAgeMs: number;
  riskScore: number;
  sanctionsClear: boolean;
  deviceTrusted: boolean;
};

export type PaymentPolicy = {
  maxSingleAmountMinor: bigint;
  maxVelocityCount24h: number;
  maxVelocityAmount24hMinor: bigint;
  minimumPayerVerification: VerificationLevel;
  minimumPayeeVerification: VerificationLevel;
  maxRiskScore: number;
  requireTrustedDeviceAboveMinor?: bigint;
};

export type PolicyDecision = {
  allowed: boolean;
  reasons: string[];
  requiresReview: boolean;
};

const level = { unverified: 0, basic: 1, verified: 2, enhanced: 3 } as const;

export class PaymentPolicyEngine {
  constructor(private readonly policy: PaymentPolicy) {
    if (policy.maxSingleAmountMinor <= 0n || policy.maxVelocityAmount24hMinor <= 0n || policy.maxVelocityCount24h < 1) throw new Error('Payment policy limits must be positive');
    if (!Number.isFinite(policy.maxRiskScore) || policy.maxRiskScore < 0 || policy.maxRiskScore > 1) throw new Error('maxRiskScore must be between 0 and 1');
  }

  evaluate(context: PaymentPolicyContext): PolicyDecision {
    if (context.amountMinor <= 0n) throw new Error('Payment amount must be positive');
    if (!/^[A-Z]{3}$/.test(context.currency)) throw new Error('Invalid payment currency');
    if (!Number.isFinite(context.riskScore) || context.riskScore < 0 || context.riskScore > 1) throw new Error('riskScore must be between 0 and 1');
    const reasons: string[] = [];
    if (!context.sanctionsClear) reasons.push('sanctions-not-clear');
    if (context.amountMinor > this.policy.maxSingleAmountMinor) reasons.push('single-amount-limit');
    if (context.velocityCount24h + 1 > this.policy.maxVelocityCount24h) reasons.push('velocity-count-limit');
    if (context.velocityAmount24hMinor + context.amountMinor > this.policy.maxVelocityAmount24hMinor) reasons.push('velocity-amount-limit');
    if (level[context.payerVerification] < level[this.policy.minimumPayerVerification]) reasons.push('payer-verification-insufficient');
    if (level[context.payeeVerification] < level[this.policy.minimumPayeeVerification]) reasons.push('payee-verification-insufficient');
    if (context.riskScore > this.policy.maxRiskScore) reasons.push('risk-threshold');
    if (this.policy.requireTrustedDeviceAboveMinor !== undefined && context.amountMinor >= this.policy.requireTrustedDeviceAboveMinor && !context.deviceTrusted) reasons.push('trusted-device-required');
    const hardDenials = reasons.filter((reason) => reason !== 'risk-threshold');
    return {
      allowed: reasons.length === 0,
      reasons,
      requiresReview: hardDenials.length === 0 && reasons.includes('risk-threshold'),
    };
  }
}
