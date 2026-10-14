import { toolSchemas } from './schemas.ts';
import type { Run } from './types.ts';
import { candidateRefs, propagationChanges, quoteContext, anchorGate } from './investigation.ts';
import { unassignedSourceClauses } from './source-obligations.ts';
import { unreadSourceScopeContext } from './source-scope.ts';
import { documentReviewCoverage } from './draft-projection.ts';
import type { Proposal } from './types.ts';

export function readyDocumentReviewRecovery(run: Run, proposals: Proposal[]) {
  if (run.documentCoverageProtocol !== 'scoped-v1' || !propagationChanges(run).length ||
    run.constraintReview?.pending.length || unassignedSourceClauses(run).length ||
    run.deltas.some(d => !run.changes.some(c => c.deltaIds.includes(d.id)))) return undefined;
  const pending = documentReviewCoverage(run, proposals).gaps;
  for (const gap of pending) {
    if (run.approvedHeads?.[gap.memberId]) continue;
    const refs = candidateRefs(run).filter(r => r.memberId === gap.memberId);
    if (!refs.length || refs.some(r => !run.readRefIds.includes(r.id) || !run.evidence.some(e => e.refId === r.id) ||
      propagationChanges(run).some(c => !run.findings.some(f => f.changeId === c.id && f.refId === r.id)))) continue;
    if (run.findings.some(f => f.status === 'needs_update' && refs.some(r => r.id === f.refId) &&
      !anchorGate(run, f.changeId).missing.length && !anchorGate(run, f.changeId).blocking.length &&
      !proposals.some(p => p.changeId === f.changeId && p.targetRefIds.includes(f.refId) &&
        ['pending', 'deferred', 'retained', 'applied'].includes(p.state)))) continue;
    return { memberId: gap.memberId, title: gap.title,
      originals: refs.map(r => ({ refId: r.id, section: r.section, kind: r.kind,
        evidenceId: run.evidence.find(e => e.refId === r.id)!.id, text: r.text })),
      changes: propagationChanges(run).map(c => ({ changeId: c.id, obligations: c.obligations, gate: anchorGate(run, c.id) })),
      findings: run.findings.filter(f => refs.some(r => r.id === f.refId)).map(f => ({ changeId: f.changeId, refId: f.refId, status: f.status })),
    };
  }
}

export function readySourceRecovery(run: Run) {
  if (run.documentCoverageProtocol !== 'scoped-v1') return [];
  const missing = run.deltas.filter(d => !run.changes.some(c => c.deltaIds.includes(d.id)));
  if (!missing.length) return [];
  const items = missing.map(d => ({ deltaId: d.id, kind: d.kind,
    originals: [d.beforeRefId, d.afterRefId].filter((id): id is string => !!id).map(id => {
      const r = run.manifest.refs.find(r => r.id === id);
      const e = run.evidence.find(e => e.refId === id);
      return r?.memberId === run.manifest.sourceMemberId && run.readRefIds.includes(id) && e
        ? { refId: id, evidenceId: e.id, baseline: r.baseline, text: e.quote } : undefined;
    }) }));
  return items.every(item => item.originals.length > 0 && item.originals.every(Boolean)) ? items : [];
}

export function readyJudgmentRecovery(run: Run) {
  if (run.documentCoverageProtocol !== 'scoped-v1' || !run.changes.length) return [];
  if (run.deltas.some(d => !run.changes.some(c => c.deltaIds.includes(d.id))) || unassignedSourceClauses(run).length) return [];
  return candidateRefs(run).filter(r => !run.approvedHeads?.[r.memberId]).flatMap(r =>
    propagationChanges(run).filter(c => !run.findings.some(f => f.changeId === c.id && f.refId === r.id))
      .flatMap(c => {
        const context = quoteContext(run, r);
        if (![r.id, ...(context ? [context.id] : [])].every(id => run.readRefIds.includes(id) && run.evidence.some(e => e.refId === id))) return [];
        return [{ changeId: c.id, refId: r.id, evidenceId: run.evidence.find(e => e.refId === r.id)!.id,
          role: r.role, original: r.text,
          allowedStatuses: r.role === 'anchor' ? ['not_conflicting', 'conflict', 'uncertain']
            : ['needs_update', 'already_current', 'compatible', 'unrelated', 'uncertain'],
          ...(context ? { context: { refId: context.id, evidenceId: run.evidence.find(e => e.refId === context.id)!.id, original: context.text } } : {}) }];
      }));
}

export function independentAnchorPhase(run: Run) {
  return run.documentCoverageProtocol === 'scoped-v1' && run.changes.length > 0 &&
    !run.deltas.some(d => !run.changes.some(c => c.deltaIds.includes(d.id))) && !unassignedSourceClauses(run).length &&
    candidateRefs(run).some(r => r.role === 'anchor' && propagationChanges(run).some(c =>
      !run.findings.some(f => f.changeId === c.id && f.refId === r.id)));
}

export function constraintReviewPhase(run: Run) {
  return run.constraintReview?.stage === 'reason_review' && run.constraintReview.pending.length > 0;
}

// A smaller provider menu, not an authorization layer. Core tool validation,
// evidence binding and role/version gates apply to every executed call.
export function modelToolSchemas(run: Run, options: { recoverJudgments?: boolean; recoverSource?: boolean; recoverDocumentMemberId?: string; documentReviewsComplete?: boolean } = {}) {
  const sourceTools = new Set(['list_fragments', 'search_fragments', 'read_context', 'describe_change', 'finish_task']);
  const locked = Object.keys(run.approvedHeads || {}).length > 0;
  const recovery = options.recoverJudgments && readyJudgmentRecovery(run).length > 0;
  const sourceRecovery = options.recoverSource && readySourceRecovery(run).length > 0;
  const anchorPhase = independentAnchorPhase(run);
  const auditPhase = constraintReviewPhase(run);
  const scopeReadPending = (anchorPhase || auditPhase) && unreadSourceScopeContext(run).length > 0;
  const patchableChanges = propagationChanges(run).filter(c => c.kind !== 'unknown' &&
    !anchorGate(run, c.id).missing.length && !anchorGate(run, c.id).blocking.length).map(c => c.id);
  const schemas = structuredClone(toolSchemas.filter((t) =>
    (!run.changes.length ? sourceTools.has(t.function.name) : true) &&
    (!recovery || ['record_finding', 'describe_change'].includes(t.function.name)) &&
    (!sourceRecovery || t.function.name === 'describe_change') &&
    (!options.recoverDocumentMemberId || t.function.name === 'review_document') &&
    (!anchorPhase || ['read_context', 'record_finding', 'describe_change'].includes(t.function.name)) &&
    (!auditPhase || ['read_context', 'record_finding', 'describe_change'].includes(t.function.name)) &&
    (!scopeReadPending || t.function.name === 'read_context') &&
    (t.function.name !== 'propose_patch' || patchableChanges.length > 0) &&
    !(run.documentCoverageProtocol === 'scoped-v1' && options.documentReviewsComplete === false &&
      propagationChanges(run).length > 0 && t.function.name === 'finish_task') &&
    !(locked && t.function.name === 'describe_change')));
  const patch = schemas.find(t => t.function.name === 'propose_patch')?.function;
  if (patch) patch.parameters.properties!.changeId.enum = patchableChanges;
  const findingProperties = schemas.find(t => t.function.name === 'record_finding')?.function.parameters.properties?.findings.items?.properties;
  if (findingProperties && !auditPhase) delete findingProperties.auditVerdict;
  if ((anchorPhase || auditPhase) && !scopeReadPending) {
    const judgment = schemas.find(t => t.function.name === 'record_finding')!.function;
    judgment.parameters.properties!.findings.maxItems = 2;
    judgment.parameters.properties!.findings.items!.required!.push('scopeBasis');
    const item = judgment.parameters.properties!.findings.items!;
    item.properties!.status.enum = ['not_conflicting', 'conflict', 'uncertain'];
    delete item.properties!.evidenceIds; delete item.properties!.relation; delete item.properties!.relationIds;
    if (auditPhase) {
      judgment.parameters.properties!.findings.maxItems = 1;
      item.required!.push('auditVerdict');
      const current = run.findings.find(f => run.constraintReview!.pending.includes(`${f.changeId}:${f.refId}`));
      if (current) { item.properties!.changeId.enum = [current.changeId]; item.properties!.refId.enum = [current.refId]; }
      delete item.properties!.relation; delete item.properties!.relationIds;
    }
    judgment.description = '独立底本核对，每次最多2项。每条reason写简短证据比较：来源行为及必要参与者；本条底本实际限制；当前范围内能否同时成立，或缺哪项定义。必要前提相抵触也需报告，名称不同不证明相容。缺参与者/对象/适用范围时用uncertain；一般范围说明不推导独立能力禁令。结论仍由真实原文决定，读过才登记。';
    if (auditPhase) judgment.description = '只复核reasonAudit.items当前这一项，返回一个finding。给scopeBasis、auditVerdict=checked及一句简短理由，不复述整个来源或输出其他判断。status仍须这对实际事实支持，缺证uncertain；不要输出目标复核或整库计划。';
  }
  if (anchorPhase || auditPhase) {
    const read = schemas.find(t => t.function.name === 'read_context')?.function;
    if (read) read.parameters.properties!.refIds.items!.enum = run.manifest.refs.filter(r =>
      r.memberId === run.manifest.sourceMemberId || r.role === 'anchor').map(r => r.id);
  }
  if (run.documentCoverageProtocol !== 'scoped-v1') {
    const properties = schemas.find((t) => t.function.name === 'review_document')?.function.parameters.properties;
    if (properties) {
      if (options.recoverDocumentMemberId) properties.memberId.enum = [options.recoverDocumentMemberId];
      properties.mode.enum = ['append', 'finalize'];
      delete properties.purpose; delete properties.exclusionReason;
      const check = properties.checks.items?.properties;
      if (check) { delete check.obligationIds; delete check.scope; }
    }
  } else {
    const review = schemas.find((t) => t.function.name === 'review_document')?.function;
    const properties = review?.parameters.properties;
    if (properties) {
      if (options.recoverDocumentMemberId) properties.memberId.enum = [options.recoverDocumentMemberId];
      delete properties.evidenceIds;
      if (properties.purpose?.required) properties.purpose.required = properties.purpose.required.filter(key => key !== 'quote');
      if (properties.purpose?.properties) delete properties.purpose.properties.quote;
      properties.checks.maxItems = 4;
      const check = properties.checks.items!;
      delete check.properties!.source; delete check.properties!.proposalIds; delete check.properties!.obligationId;
      check.required = [...check.required!, 'targetWitness', 'obligationIds', 'scope'];
      if (check.properties!.targetWitness.required)
        check.properties!.targetWitness.required = check.properties!.targetWitness.required.filter(key => key !== 'quote');
      if (check.properties!.targetWitness.properties) delete check.properties!.targetWitness.properties.quote;
      review!.description = 'scoped-v1复核：每次最多4组checks，优先mode=append分批积累，完整后自动复核。每组必给scope。not_applicable+fragment仅排除该片段，不完成整文条款；如果真实全文及用途均不承载该条款，显式not_applicable+document且targetRefIds仅purpose.refId，否则核实际承载点为current/patched/unresolved。后续只补剩余组，不重发全文账本。purpose给kind/refId，targetWitness给mode，不手抄quote；可合并完整支持的obligationIds。已有compatible不反复exclude_document。程序绑定真实见证，不判语义、不代你声明整文无关。';
    }
  }
  return schemas;
}
