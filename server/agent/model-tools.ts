import { toolSchemas } from './schemas.ts';
import type { Run } from './types.ts';
import { candidateRefs, propagationChanges, quoteContext } from './investigation.ts';
import { unassignedSourceClauses } from './source-obligations.ts';

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

// A smaller provider menu, not an authorization layer. Core tool validation,
// evidence binding and role/version gates apply to every executed call.
export function modelToolSchemas(run: Run, options: { recoverJudgments?: boolean; recoverSource?: boolean; documentReviewsComplete?: boolean } = {}) {
  const sourceTools = new Set(['list_fragments', 'search_fragments', 'read_context', 'describe_change', 'finish_task']);
  const locked = Object.keys(run.approvedHeads || {}).length > 0;
  const recovery = options.recoverJudgments && readyJudgmentRecovery(run).length > 0;
  const sourceRecovery = options.recoverSource && readySourceRecovery(run).length > 0;
  const anchorPhase = independentAnchorPhase(run);
  const schemas = structuredClone(toolSchemas.filter((t) =>
    (!run.changes.length ? sourceTools.has(t.function.name) : true) &&
    (!recovery || ['record_finding', 'describe_change'].includes(t.function.name)) &&
    (!sourceRecovery || t.function.name === 'describe_change') &&
    (!anchorPhase || ['read_context', 'record_finding', 'describe_change'].includes(t.function.name)) &&
    !(run.documentCoverageProtocol === 'scoped-v1' && options.documentReviewsComplete === false &&
      propagationChanges(run).length > 0 && t.function.name === 'finish_task') &&
    !(locked && t.function.name === 'describe_change')));
  if (anchorPhase) {
    const judgment = schemas.find(t => t.function.name === 'record_finding')!.function;
    judgment.parameters.properties!.findings.maxItems = 2;
    judgment.description = '独立底本核对，每次最多2项。每条reason写简短证据比较：来源行为及必要参与者；本条底本实际限制；当前范围内能否同时成立，或缺哪项定义。必要前提相抵触也需报告，名称不同不证明相容。缺参与者/对象/适用范围时用uncertain；一般范围说明不推导独立能力禁令。结论仍由真实原文决定，读过才登记。';
  }
  if (run.documentCoverageProtocol !== 'scoped-v1') {
    const properties = schemas.find((t) => t.function.name === 'review_document')?.function.parameters.properties;
    if (properties) {
      properties.mode.enum = ['append', 'finalize'];
      delete properties.purpose; delete properties.exclusionReason;
      const check = properties.checks.items?.properties;
      if (check) { delete check.obligationIds; delete check.scope; }
    }
  } else {
    const review = schemas.find((t) => t.function.name === 'review_document')?.function;
    const properties = review?.parameters.properties;
    if (properties) {
      delete properties.evidenceIds;
      if (properties.purpose?.required) properties.purpose.required = properties.purpose.required.filter(key => key !== 'quote');
      if (properties.purpose?.properties) delete properties.purpose.properties.quote;
      properties.checks.maxItems = 4;
      const check = properties.checks.items!;
      delete check.properties!.source; delete check.properties!.proposalIds; delete check.properties!.obligationId;
      check.required = [...check.required!, 'targetWitness', 'obligationIds'];
      if (check.properties!.targetWitness.required)
        check.properties!.targetWitness.required = check.properties!.targetWitness.required.filter(key => key !== 'quote');
      if (check.properties!.targetWitness.properties) delete check.properties!.targetWitness.properties.quote;
      review!.description = 'scoped-v1复核：每次最多4组checks，优先mode=append分批积累，完整后自动复核；后续只补真实剩余组，不重发全文账本。每组reason只写一句必要依据。purpose只给kind/refId，targetWitness只给mode，不手抄quote。每组优先一个真实targetRefId，可合并多个完整支持的obligationIds；程序绑定实际合并预览整块，不生成答案。语义outcome仍须真实判断/补丁支持。scope=document的not_applicable只绑定purpose.refId；其他无关片段用fragment但不能替代整文覆盖。已有compatible片段不反复exclude_document，正常复核。';
    }
  }
  return schemas;
}
