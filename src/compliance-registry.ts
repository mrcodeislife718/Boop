import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { VerificationLevel } from './payment-policy.js';

export type SubjectType = 'consumer' | 'merchant' | 'worker' | 'platform' | 'enterprise';
export type SanctionsStatus = 'unknown' | 'clear' | 'review' | 'blocked';
export type IdentityProfile = {
  subjectId: string;
  subjectType: SubjectType;
  verificationLevel: VerificationLevel;
  sanctionsStatus: SanctionsStatus;
  verificationProvider?: string;
  verificationReference?: string;
  reviewedAt?: string;
  expiresAt?: string;
  metadata: Record<string,unknown>;
  updatedAt: string;
};
export type RiskDecision = {
  id: string;
  subjectId: string;
  paymentIntentId?: string;
  riskScore: number;
  decision: 'allow' | 'review' | 'deny';
  reasonCodes: string[];
  modelOrRulesetVersion: string;
  createdAt: string;
};

export class ComplianceRegistry {
  constructor(readonly pool: Pool) {}

  async upsertProfile(input: Omit<IdentityProfile,'updatedAt'>): Promise<IdentityProfile> {
    if (!input.subjectId.trim()) throw new Error('subjectId is required');
    if (input.verificationReference && !input.verificationProvider) throw new Error('verificationProvider is required when a verificationReference is present');
    if (input.reviewedAt && !Number.isFinite(Date.parse(input.reviewedAt))) throw new Error('reviewedAt is invalid');
    if (input.expiresAt && !Number.isFinite(Date.parse(input.expiresAt))) throw new Error('expiresAt is invalid');
    const result = await this.pool.query(
      `INSERT INTO boop_identity_profiles
       (subject_id,subject_type,verification_level,sanctions_status,verification_provider,verification_reference,reviewed_at,expires_at,metadata,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,now())
       ON CONFLICT (subject_id) DO UPDATE SET
         subject_type=EXCLUDED.subject_type,verification_level=EXCLUDED.verification_level,sanctions_status=EXCLUDED.sanctions_status,
         verification_provider=EXCLUDED.verification_provider,verification_reference=EXCLUDED.verification_reference,
         reviewed_at=EXCLUDED.reviewed_at,expires_at=EXCLUDED.expires_at,metadata=EXCLUDED.metadata,updated_at=now()
       RETURNING *`,
      [input.subjectId,input.subjectType,input.verificationLevel,input.sanctionsStatus,input.verificationProvider ?? null,input.verificationReference ?? null,input.reviewedAt ? new Date(input.reviewedAt).toISOString() : null,input.expiresAt ? new Date(input.expiresAt).toISOString() : null,JSON.stringify(input.metadata)],
    );
    return this.rowToProfile(result.rows[0]);
  }

  async requireCurrentProfile(subjectId: string, at = new Date()): Promise<IdentityProfile> {
    const result = await this.pool.query('SELECT * FROM boop_identity_profiles WHERE subject_id=$1', [subjectId]);
    if (!result.rowCount) throw new Error(`Verification profile missing: ${subjectId}`);
    const profile = this.rowToProfile(result.rows[0]);
    if (profile.expiresAt && Date.parse(profile.expiresAt) <= at.getTime()) throw new Error(`Verification profile expired: ${subjectId}`);
    return profile;
  }

  async recordRiskDecision(input: Omit<RiskDecision,'id'|'createdAt'>): Promise<RiskDecision> {
    if (!input.subjectId.trim() || !input.modelOrRulesetVersion.trim()) throw new Error('Risk subject and version are required');
    if (!Number.isFinite(input.riskScore) || input.riskScore < 0 || input.riskScore > 1) throw new Error('riskScore must be between 0 and 1');
    if (!input.reasonCodes.every((reason) => reason.trim())) throw new Error('Risk reason codes must be non-empty');
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO boop_risk_decisions
       (id,subject_id,payment_intent_id,risk_score,decision,reason_codes,model_or_ruleset_version)
       VALUES ($1,$2,$3,$4,$5,$6::text[],$7) RETURNING *`,
      [id,input.subjectId,input.paymentIntentId ?? null,input.riskScore,input.decision,input.reasonCodes,input.modelOrRulesetVersion],
    );
    return this.rowToRisk(result.rows[0]);
  }

  async latestRiskDecision(subjectId: string): Promise<RiskDecision | undefined> {
    const result = await this.pool.query('SELECT * FROM boop_risk_decisions WHERE subject_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [subjectId]);
    return result.rowCount ? this.rowToRisk(result.rows[0]) : undefined;
  }

  private rowToProfile(row: any): IdentityProfile {
    return {
      subjectId: row.subject_id, subjectType: row.subject_type, verificationLevel: row.verification_level,
      sanctionsStatus: row.sanctions_status, verificationProvider: row.verification_provider ?? undefined,
      verificationReference: row.verification_reference ?? undefined, reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : undefined, metadata: row.metadata ?? {}, updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private rowToRisk(row: any): RiskDecision {
    return {
      id: row.id, subjectId: row.subject_id, paymentIntentId: row.payment_intent_id ?? undefined,
      riskScore: row.risk_score, decision: row.decision, reasonCodes: row.reason_codes,
      modelOrRulesetVersion: row.model_or_ruleset_version, createdAt: new Date(row.created_at).toISOString(),
    };
  }
}
