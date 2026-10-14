import { applyPatches, fail, hash } from '../domain/rules.ts';
import { ref, anchorGate, propagationChanges } from './investigation.ts';
import type { Proposal, Run } from './types.ts';

// Derive previews and review identities without writing documents or task state.
export function documentDrafts(run: Run, proposals: Proposal[], memberId: string) {
  return proposals.filter(
    (p) =>
      p.targetMemberId === memberId && p.latestRunId === run.id && ['pending', 'deferred'].includes(p.state),
  );
}
export function reviewFingerprint(run: Run, proposals: Proposal[], memberId: string) {
  return hash({
    version: run.manifest.views.find((v) => v.member.id === memberId)?.version.id,
    changes: run.changes,
    anchorGates: run.changes.map((c) => ({ changeId: c.id, ...anchorGate(run, c.id) })),
    findings: run.findings.filter((f) => ref(run, f.refId).memberId === memberId),
    // Human retain/defer/apply changes disposition, not the reviewed text. Withdrawn
    // model drafts and revised findings/patches do change the review identity.
    drafts: proposals
      .filter((p) => p.targetMemberId === memberId && p.latestRunId === run.id && p.state !== 'withdrawn')
      .map((p) => ({ id: p.id, changeId: p.changeId, refs: p.targetRefIds, patches: p.patches })),
  });
}
export function documentReviewCoverage(run: Run, proposals: Proposal[]) {
  const required = run.reviewProtocol === 'documents-v1' && propagationChanges(run).length > 0;
  const gaps = required
    ? run.manifest.views
        .filter((v) => v.member.role === 'sync' && v.member.id !== run.manifest.sourceMemberId)
        .filter(
          (v) =>
            !run.documentReviews?.some(
              (r) =>
                r.memberId === v.member.id &&
                r.fingerprint === reviewFingerprint(run, proposals, v.member.id),
            ),
        )
        .map((v) => ({ memberId: v.member.id, title: v.document.title }))
    : [];
  return { required, complete: !gaps.length, gaps };
}
export function previewDocument(run: Run, proposals: Proposal[], memberId: string) {
  const view = run.manifest.views.find((v) => v.member.id === memberId);
  if (!view || view.member.role !== 'sync' || view.member.id === run.manifest.sourceMemberId)
    fail(
      'ROLE_FORBIDDEN',
      '文档复核只针对本轮目标同步文档；使用memberId而不是refId，底本不提交review_document。',
      400,
      {
        allowedMembers: run.manifest.views
          .filter((v) => v.member.role === 'sync' && v.member.id !== run.manifest.sourceMemberId)
          .map((v) => ({ memberId: v.member.id, title: v.document.title })),
        committed: false,
      },
    );
  const drafts = documentDrafts(run, proposals, memberId);
  return {
    view: view!,
    drafts,
    blocks: drafts.length
      ? applyPatches(
          view!.version.blocks,
          drafts.flatMap((p) => p.patches),
        )
      : structuredClone(view!.version.blocks),
  };
}
