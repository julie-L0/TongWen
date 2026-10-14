import { fail, hash } from '../domain/rules.ts';
import type { AgentStore, Run, Ref, Evidence, Change } from './types.ts';
import { unassignedSourceClauses } from './source-obligations.ts';

// Read-only investigation queries shared by guards and strategy projections.
export function candidateRefs(run: Run) {
  return run.manifest.refs.filter(
    (r) =>
      !r.baseline &&
      r.kind !== 'heading' &&
      r.memberId !== run.manifest.sourceMemberId &&
      (r.role === 'anchor' || r.role === 'sync'),
  );
}
export function propagationChanges(run: Run) {
  return run.documentCoverageProtocol === 'scoped-v1' ? run.changes.filter((c) => c.kind !== 'editorial') : run.changes;
}
export function quoteContext(run: Run, r: Ref) {
  if (r.kind !== 'blockquote') return undefined;
  return run.manifest.refs
    .filter(
      (n) =>
        n.memberId === r.memberId &&
        n.versionId === r.versionId &&
        n.section === r.section &&
        n.kind !== 'heading' &&
        n.id !== r.id,
    )
    .sort((a, b) => Math.abs(a.order - r.order) - Math.abs(b.order - r.order))[0];
}
export function registeredEvidence(
  run: Run,
  changeIds: string[],
  refIds: string[],
  includeQuoteContext = false,
) {
  const targets = refIds.map((id) => ref(run, id));
  const required = [
    ...new Set([
      ...refIds,
      ...(includeQuoteContext
        ? targets.flatMap((r) => {
            const context = quoteContext(run, r);
            return context ? [context.id] : [];
          })
        : []),
    ]),
  ];
  const ids = required.map((id) => {
    const e = run.evidence.find((e) => e.refId === id && run.readRefIds.includes(id));
    if (!e)
      fail('INVALID_EVIDENCE', '原文尚未真实读取，无法自动绑定证据。', 400, { refId: id, committed: false });
    evidence(run, e!.id);
    return e!.id;
  });
  for (const id of changeIds)
    for (const q of [...change(run, id).before, ...change(run, id).after]) {
      evidence(run, q.evidenceId);
      ids.push(q.evidenceId);
    }
  return [...new Set(ids)];
}
export function ref(run: Run, id: string): Ref {
  const r = run.manifest.refs.find((r) => r.id === id);
  if (!r) fail('OUT_OF_SCOPE', '引用不属于本任务冻结范围，请使用真实返回的R编号。', 400, {
    requestedRefId: id,
    sourceRefs: run.deltas.map((d) => ({ deltaId: d.id, beforeRefId: d.beforeRefId, afterRefId: d.afterRefId })),
    committed: false,
  });
  return r!;
}
export function evidence(run: Run, id: string): Evidence {
  const e = run.evidence.find((e) => e.id === id);
  if (!e) fail('INVALID_EVIDENCE', '证据没有通过真实读取登记。');
  if (hash(e!.quote) !== e!.hash || ref(run, e!.refId).text !== e!.quote)
    fail('INVALID_EVIDENCE', '证据原文或指纹不匹配。');
  return e!;
}
export function change(run: Run, id: string): Change {
  const c = run.changes.find((c) => c.id === id);
  if (!c)
    fail(
      'UNKNOWN_CHANGE',
      '变化单元不存在。创建变化请省略 changeId；只有工具成功返回的编号才能修订。失败调用没有创建 C 编号。',
      400,
      { knownChangeIds: run.changes.map((c) => c.id), committed: false },
    );
  return c!;
}
export function checkedEvidence(run: Run, ids: string[], refIds: string[]) {
  const items = ids.map((id) => evidence(run, id));
  for (const id of refIds)
    if (!items.some((e) => e.refId === id) || !run.readRefIds.includes(id))
      fail('INVALID_EVIDENCE', `缺少 ${id} 的完整原文证据。`, 400, {
        refId: id, alreadyRead: run.readRefIds.includes(id),
        registeredEvidenceId: run.evidence.find((e) => e.refId === id)?.id,
        repair: run.readRefIds.includes(id)
          ? '已真实读取，缺少本次参数绑定；使用登记证据。工具支持自动绑定时可省略evidenceIds，重复读取不能补齐手填参数。'
          : '先read_context完整读取，再使用实际返回证据。', committed: false,
      });
  return items;
}
export function anchorGate(run: Run, changeId: string) {
  if (run.documentCoverageProtocol === 'scoped-v1' && change(run, changeId).kind === 'editorial')
    return { missing: [], blocking: [] };
  const anchors = candidateRefs(run).filter((r) => r.role === 'anchor');
  const missing = anchors.filter(
    (r) => !run.findings.some((f) => f.changeId === changeId && f.refId === r.id),
  );
  for (const r of anchors)
    if (run.constraintReview?.pending.includes(`${changeId}:${r.id}`) && !missing.some(x => x.id === r.id)) missing.push(r);
  const blocking = run.findings.filter(
    (f) =>
      f.changeId === changeId &&
      ref(run, f.refId).role === 'anchor' &&
      ['conflict', 'uncertain'].includes(f.status),
  );
  return {
    missing: missing.map((r) => r.id),
    blocking: blocking.map((f) => ({
      refId: f.refId,
      status: f.status,
      reason: f.reason,
      evidenceIds: f.evidenceIds,
    })),
  };
}
export function coverage(run: Run, store: AgentStore) {
  const missingSourceClauses = unassignedSourceClauses(run);
  const missingDeltas = run.deltas
    .filter((d) => !run.changes.some((c) => c.deltaIds.includes(d.id)))
    .map((d) => d.id);
  const refs = candidateRefs(run);
  const gaps: { changeId: string; refId: string; reason: string }[] = [];
  for (const c of propagationChanges(run))
    for (const r of refs)
      if (!run.findings.some((f) => f.changeId === c.id && f.refId === r.id))
        gaps.push({
          changeId: c.id,
          refId: r.id,
          reason: run.readRefIds.includes(r.id) ? '已读取、尚未判定' : '尚未完整读取',
        });
  const proposals = store.proposals(run.id);
  const outstanding = run.findings.filter(
    (f) =>
      f.status === 'needs_update' &&
      !anchorGate(run, f.changeId).blocking.length &&
      !proposals.some(
        (p) =>
          p.changeId === f.changeId &&
          p.targetRefIds.includes(f.refId) &&
          ['pending', 'deferred', 'retained', 'applied'].includes(p.state),
      ),
  );
  return {
    missingDeltas,
    missingSourceClauses,
    gaps,
    outstanding,
    expected: propagationChanges(run).length * refs.length,
    judged: run.findings.length,
    complete: !missingDeltas.length && !missingSourceClauses.length && !gaps.length,
  };
}
