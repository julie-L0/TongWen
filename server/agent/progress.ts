import { hash } from '../domain/rules.ts';
import type { Proposal, Run } from './types.ts';

const sorted = (values: string[]) => [...new Set(values)].sort();
const unique = (values: unknown[]) => sorted(values.map((v) => hash(v)));

// New wording, sequence IDs and timestamps are not new investigation results.
// Original evidence, changed classifications, patches and review checks are.
export function investigationProgress(run: Run, proposals: Proposal[]) {
  const relation = (id: string) => {
    const r = run.relations.find((r) => r.id === id);
    return r && { changes: sorted(r.changeIds), refs: sorted(r.targetRefIds), type: r.type,
      coverage: r.coverageMode, evidence: sorted(r.evidenceIds) };
  };
  return hash({
    reads: sorted(run.readRefIds),
    constraintReview: run.constraintReview && { changeFingerprint: run.constraintReview.changeFingerprint, stage: run.constraintReview.stage,
      pending: sorted(run.constraintReview.pending) },
    changes: unique(run.changes.map((c) => ({ id: c.id, fingerprint: c.fingerprint }))),
    relations: unique(run.relations.map((r) => relation(r.id))),
    findings: unique(run.findings.map((f) => ({ change: f.changeId, ref: f.refId, status: f.status,
      evidence: sorted(f.evidenceIds), relations: unique(f.relationIds.map(relation)) }))),
    reviews: unique((run.documentReviews || []).map((r) => ({ member: r.memberId,
      purpose: r.purpose, scopeExclusion: r.scopeExclusion && { changes: sorted(r.scopeExclusion.changeIds) },
      checks: unique(r.checks.map((c) => ({ change: c.changeId, source: c.source,
        refs: sorted(c.targetRefIds), proposals: sorted(c.proposalIds), outcome: c.outcome,
        obligationId: c.obligationId, targetWitness: c.targetWitness, scope: c.scope }))) }))),
    partialReviews: unique((run.documentReviewDrafts || []).map((r) => ({ member: r.memberId,
      purpose: r.purpose,
      checks: unique(r.checks.map((c) => ({ change: c.changeId, source: c.source, obligationId: c.obligationId,
        refs: sorted(c.targetRefIds), proposals: sorted(c.proposalIds), outcome: c.outcome, targetWitness: c.targetWitness, scope: c.scope }))) }))),
    proposals: unique(proposals.map((p) => ({ id: p.id, patches: p.patches, state: p.state, refs: sorted(p.targetRefIds) }))),
  });
}
