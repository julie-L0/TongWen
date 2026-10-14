import { candidateRefs, propagationChanges } from './investigation.ts';
import { documentReviewCoverage } from './draft-projection.ts';
import type { Proposal, Run } from './types.ts';
import { unassignedSourceClauses } from './source-obligations.ts';

// A running task, resource stop, or explicitly recorded investigation stall
// preserves committed document checkpoints. Other failures remain blocked.
export function reviewReadiness(run: Run, proposals: Proposal[], memberIds: string[], completeCoverage: boolean) {
  const stalled = run.status === 'failed' && run.stopCode === 'NO_PROGRESS';
  if (!stalled && !['running', 'awaiting_review', 'needs_input', 'budget_exhausted'].includes(run.status))
    return { allowed: false, reason: '检查尚未结束或已经失效，不能确认。' };
  const review = documentReviewCoverage(run, proposals);
  if (!stalled && !['running', 'budget_exhausted'].includes(run.status))
    return { allowed: completeCoverage && review.complete, reason: '文档级复核或来源覆盖未完成，请重新检查。' };
  if (run.reviewProtocol !== 'documents-v1' || !run.changes.length || unassignedSourceClauses(run).length ||
    run.deltas.some((d) => !run.changes.some((c) => c.deltaIds.includes(d.id))))
    return { allowed: false, reason: '来源变化尚未全部解释，不能使用局部完成点确认。' };
  if (review.gaps.some((g) => memberIds.includes(g.memberId)))
    return { allowed: false, reason: '选中文档尚未完成整体复核，草案不能确认。' };
  const refs = candidateRefs(run).filter((r) => memberIds.includes(r.memberId));
  const allowed = refs.length > 0 && memberIds.every((id) => refs.some((r) => r.memberId === id)) &&
    refs.every((r) => run.readRefIds.includes(r.id) && propagationChanges(run).every((c) =>
      run.findings.some((f) => f.refId === r.id && f.changeId === c.id)));
  return { allowed, reason: '选中文档的原文或逐项判断尚未完整，不可确认。' };
}
