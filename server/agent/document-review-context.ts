import type { ModelMessage, Proposal, Run } from './types.ts';
import { candidateRefs, propagationChanges } from './investigation.ts';
import { readyDocumentReviewRecovery } from './model-tools.ts';
import { sourceScopeContextRefs } from './source-scope.ts';

// A ready review gets only its real inputs. Preserve the durable ledger and
// configured system rules; no previous actor plan becomes new evidence.
export function documentReviewMessages(run: Run, proposals: Proposal[], document: NonNullable<ReturnType<typeof readyDocumentReviewRecovery>>): ModelMessage[] {
  const changes = propagationChanges(run);
  const sourceIds = new Set([
    ...sourceScopeContextRefs(run).map(r => r.id),
    ...changes.flatMap(c => [...c.before, ...c.after].map(q => run.evidence.find(e => e.id === q.evidenceId)?.refId)),
  ]);
  const anchors = candidateRefs(run).filter(r => r.role === 'anchor');
  const relevantIds = new Set([...sourceIds, ...anchors.map(r => r.id)]);
  const originals = run.manifest.refs.filter(r => relevantIds.has(r.id) && run.readRefIds.includes(r.id)).flatMap(r => {
    const evidence = run.evidence.find(e => e.refId === r.id);
    return evidence ? [{ refId: r.id, evidenceId: evidence.id, role: r.role, baseline: r.baseline,
      section: r.section, text: r.text }] : [];
  });
  const policy = run.messages[0]?.role === 'system' ? run.messages[0].content || '' : '';
  return [{ role: 'system', content: policy + '\n\n当前仅完成这份已真实读取且逐段判断齐备的文档复核。仅用review_document，不重新列目录或读取。按实际来源条款、用途和草案逐组核对，可mode=append分批积累；scope必须显式。片段排除不等于整文排除。草案不是原文证据；底本阻断时保持原文并据实unresolved。用途、见证与结论由你从真实正文判断，程序不代填语义答案。' },
    { role: 'user', content: JSON.stringify({ kind: 'ready_document_review',
      source: { memberId: run.manifest.sourceMemberId, title: run.manifest.source.document.title },
      document, sourceAndAnchorOriginals: originals,
      changes: changes.map(c => ({ id: c.id, kind: c.kind, summary: c.summary, before: c.before, after: c.after, obligations: c.obligations })),
      anchorFindings: run.findings.filter(f => anchors.some(r => r.id === f.refId)),
      targetFindings: run.findings.filter(f => document.originals.some(r => r.refId === f.refId)),
      drafts: proposals.filter(p => p.targetMemberId === document.memberId).map(p => ({ id: p.id, changeId: p.changeId,
        state: p.state, targetRefIds: p.targetRefIds, patches: p.patches, after: p.after, reason: p.reason })),
      accumulatedReview: run.documentReviewDrafts?.filter(d => d.memberId === document.memberId) || [],
      executorRecovery: (run.recoveryHints || []).filter(h => h.tool === 'review_document'),
    }) }];
}
