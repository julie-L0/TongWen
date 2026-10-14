import type { Run, ModelMessage } from '../types.ts';
import type { StrategyKnowledge } from '../strategy.ts';
import { modelContext, compactObservation } from './context.ts';
import { independentAnchorPhase, constraintReviewPhase } from '../model-tools.ts';
import { sourceScopeContextRefs, unreadSourceScopeContext } from '../source-scope.ts';

// Keep the complete durable ledger; project only the current working document.
// Missing originals remain available through tools, never replaced by invented evidence.
export function leanModelContext(run: Run, knowledge: StrategyKnowledge = { proposals: [] }): ModelMessage[] {
  const messages = modelContext(run, knowledge);
  const state = JSON.parse(messages[2].content!);
  const recent = messages.slice(3);
  const recentReads = new Set<string>();
  for (const message of recent.filter((m) => m.role === 'tool')) {
    try {
      for (const block of JSON.parse(message.content || '{}').blocks || []) recentReads.add(block.refId);
    } catch { /* Original malformed feedback is kept below, not reinterpreted. */ }
  }
  const sourceNeeded = new Set(run.deltas.flatMap((d) => [d.beforeRefId, d.afterRefId]).filter(Boolean));
  const locked = new Set(Object.keys(run.approvedHeads || {}));
  let characters = 0;
  state.evidence = state.evidence.filter((e: any) => !locked.has(e.memberId) && (
    e.memberId === state.focus?.memberId || recentReads.has(e.refId) ||
    ((state.sourceProgress.missingDeltas.length || state.sourceProgress.missingSourceClauses?.length) && sourceNeeded.has(e.refId))),
  ).map((e: any) => {
    const original = run.evidence.find((p) => p.id === e.evidenceId)!;
    const full = characters + original.quote.length <= 12000;
    if (full) characters += original.quote.length;
    return { evidenceId: e.evidenceId, refId: e.refId, section: e.section, kind: run.manifest.refs.find((r) => r.id === e.refId)?.kind,
      ...(e.isSource ? { isSource: true, baseline: e.baseline } : {}),
      ...(full ? { text: original.quote } : { excerpt: original.quote.slice(0, 80), fullTextCached: false }) };
  });
  state.nextUnjudgedBatch = state.nextUnjudgedBatch.map((g: any) => ({
    changeId: g.changeId, refId: g.refId, evidenceId: g.evidenceId, readyToJudge: g.readyToJudge,
    ...(g.contextRefId ? { contextRefId: g.contextRefId, contextEvidenceId: g.contextEvidenceId } : {}),
  }));
  if (state.focus) {
    state.focus.fragments = state.focus.fragments.map((f: any) => ({ refId: f.refId, section: f.section, kind: f.kind,
      evidenceId: f.evidenceId, judgments: f.judgments.map((j: any) => ({ changeId: j.changeId, status: j.status })) }));
    // Actual patches suffice for the self-check. Full virtual documents are not evidence.
    if (run.sourceObligationProtocol !== 'clauses-v1') delete state.focus.preview;
    delete state.focus.reviewEvidenceIds;
    if (run.documentCoverageProtocol === 'scoped-v1' && state.focus.clauseReview) {
      const groups = new Map<string, any>();
      for (const check of state.focus.clauseReview.validatedChecks) {
        const key = JSON.stringify({ changeId: check.changeId, targetRefIds: check.targetRefIds,
          proposalIds: check.proposalIds, outcome: check.outcome, targetWitness: check.targetWitness, scope: check.scope });
        const group = groups.get(key) || { changeId: check.changeId, obligationIds: [], targetRefIds: check.targetRefIds,
          outcome: check.outcome, targetWitness: check.targetWitness, ...(check.scope ? { scope: check.scope } : {}) };
        if (check.obligationId) group.obligationIds.push(check.obligationId);
        groups.set(key, group);
      }
      state.focus.clauseReview.validatedChecks = [...groups.values()];
    }
  }
  state.proposalLedger = state.proposalLedger.filter((p: any) => p.memberId === state.focus?.memberId);
  // The immutable request is still persisted for audit. Scope and document
  // progress are carried by the current projection instead of being sent twice.
  const request = JSON.parse(messages[1].content!);
  delete request.changeScope;
  delete request.documents;
  delete request.budget;
  if (!state.sourceProgress.missingDeltas.length && !state.sourceProgress.missingSourceClauses?.length) delete request.deltas;
  state.note = '只展示当前工作资料和最近读取的真实原文；完整账本保留在后端。未展示全文仍可用read_context读取。证据/关系/提案可省编号绑定，不能猜ID。';
  if (independentAnchorPhase(run) || constraintReviewPhase(run)) {
    const sourceContextRefIds = sourceScopeContextRefs(run).map(r => r.id);
    const sourceQuotes = run.changes.flatMap(c => [...c.before, ...c.after]);
    const sourceIds = new Set(sourceQuotes.map(q => q.evidenceId));
    state.evidence.push(...run.evidence.filter(e => sourceIds.has(e.id) && !state.evidence.some((p: any) => p.evidenceId === e.id))
      .map(e => ({ evidenceId: e.id, refId: e.refId, text: e.quote })));
    const scopeContext = run.evidence.filter(e => sourceContextRefIds.includes(e.refId));
    state.evidence.push(...scopeContext.filter(e => !state.evidence.some((x: any) => x.evidenceId === e.id))
      .map(e => ({ evidenceId: e.id, refId: e.refId, text: e.quote })));
    state.anchorReview = { sourceContextRefIds, requiredUnreadSourceRefIds: unreadSourceScopeContext(run).map(r => r.id),
      fixedScope: { scopeId: run.manifest.source.scope.id, scopeName: run.manifest.source.scope.name,
        sourceMemberId: run.manifest.sourceMemberId, sourceTitle: run.manifest.source.document.title },
      instruction: '先读取requiredUnreadSourceRefIds，门禁拒绝未读范围的判断。默认scopeBasis=current_source，逐条保留当前来源主体，底本的其他范围例外不把来源变成那个范围。若源文明确声明某例外适用于本变化，可scopeBasis=source_exception并给来源自身scopeWitness；底本引用不会被程序接受为来源范围证明。范围缺证用needs_definition和uncertain。证据绑定不是机器语义判分，reason仍须准确比较每一实际行为及必要前提。' };
    if (constraintReviewPhase(run)) {
      state.anchorReview.reasonAudit = {
        instruction: '这是理由复核，不是接受上一轮结论。逐条检查reason的每项断言是否由这一对实际行为与当前来源范围支持：不能从一般用途/客户协议声明推导功能不存在；不能把一个行为的必要权限扩散到其他未定义动作。删掉不成立的断言，必要条件不明用uncertain并具体缺证。用record_finding改正或保留每一待办，并给auditVerdict=checked；这只记录模型自查，不是独立评分。',
        items: run.findings.filter(f => run.constraintReview!.pending.includes(`${f.changeId}:${f.refId}`)).slice(0, 1)
          .map(f => ({ changeId: f.changeId, refId: f.refId, proposedStatus: f.status, proposedReason: f.reason,
            original: run.readRefIds.includes(f.refId) ? run.manifest.refs.find(r => r.id === f.refId)!.text : undefined })),
      };
    }
    // Baseline judgments use a fresh context. Do not carry an actor's earlier
    // plan or justification for proposed edits into the constraint assessment.
    const configuredPolicy = run.messages[0]?.role === 'system' ? run.messages[0].content || '' : '';
    return [{ role: 'system', content:
      '你负责独立核对本次来源变化与固定底本是否相容。只审当前来源文档与实际资料组，不自行换产品或用户范围。先读取必要来源用途或未读底本，再用真实引用登记判断。明确相抵触用conflict，真实缺证用uncertain并说明具体缺项，有依据地相容用not_conflicting。不能编造权限、功能步骤、按钮、期限或假设其他交付协议。仅使用实际业务原文，不继承先前助手的修改计划或判断理由。以下为本次配置的可信系统规则，独立底本核对同样遵守。\n\n' + configuredPolicy +
      '\n\n独立比较协议：每条reason先简述来源的行为与必要参与者，再简述本条底本实际限制的行为，最后说明二者能否在当前资料组内同时成立。行为的必要前提也是比较对象；概念名称不同、底本未直接写功能名，都不能证明相容。来源行为必须依赖被底本否定的参与者、对象或权限时，明确矛盾用conflict；必要要素或适用范围缺证、存在不同合理解读时用uncertain并指出可回答的缺项。not_conflicting必须有同范围内两项事实可同时成立的依据，不能靠假设未记载的外部产品、线下软件、共用账号或例外协议。仅说明产品用途、客户范围、另按协议或遵守其他条款，未限定具体行为的段落，不是独立功能禁令；逐条评估，其他条款的冲突不扩散至这些段落。明确禁止公开或匿名访问，只判断与该种访问相抵触的来源行为。未定义操作的步骤、参与者、对象、期限不能同步编造；登记缺证并交具体questions，合法结束needs_input。' },
      { role: 'user', content: JSON.stringify({ source: request.source, changeScope: state.changeScope }) },
      { role: 'user', content: JSON.stringify(constraintReviewPhase(run) ? {
        sourceProgress: state.sourceProgress, changeScope: state.changeScope, anchorReview: state.anchorReview,
        executorRecovery: run.recoveryHints || [],
        evidence: state.evidence.filter((e: any) => {
          const ref = run.manifest.refs.find(r => r.id === e.refId);
          return ref?.memberId === run.manifest.sourceMemberId || ref?.role === 'anchor';
        }),
        note: '本阶段仅审reasonAudit.items这一项底本理由。请返回一个简短record_finding，scopeBasis保持真实来源、auditVerdict=checked；不读取目标、不输出其余判断或整文复核。其他待办仍由后端保存，后续逐项提供。',
      } : state) }];
  }
  return [messages[0], { ...messages[1], content: JSON.stringify(request) }, { role: 'user', content: JSON.stringify(state) }, ...recent];
}

export function leanObservation(name: string, result: any): unknown {
  const compact: any = compactObservation(name, result);
  if (compact?.error || !compact) return compact;
  if (name === 'list_fragments') {
    const documents = new Map<string, any[]>();
    for (const item of compact.items) {
      const entries = documents.get(item.memberId) || [];
      entries.push({ refId: item.refId, section: item.section, kind: item.kind, read: item.read });
      documents.set(item.memberId, entries);
    }
    const { items, ...page } = compact;
    return { ...page, documents: [...documents].map(([memberId, items]) => ({ memberId, items })),
      note: '冻结目录；不算原文证据。已列出的refId可直接读取，不必再次列目录。' };
  }
  if (name === 'propose_patch') {
    const { patches, ...receipt } = compact;
    return { ...receipt, patchCount: patches?.length || 0,
      note: '提案已登记，未写入；实际补丁在下一轮focus.drafts中，不必重新创建。' };
  }
  if (name === 'describe_change')
    return { ...compact, changes: compact.changes.map((c: any) => ({ id: c.id, deltaIds: c.deltaIds,
      kind: c.kind, businessObject: c.businessObject })),
      note: '变化与真实引用已登记；下一轮sourceProgress.changes提供完整内容，不必重新解释。' };
  if (name !== 'read_context' || !compact?.blocks || compact.error) return compact;
  return { ...compact, note: '真实原文已登记，下一轮工作证据缓存提供全文；缓存截断时再按真实refId读取。',
    blocks: compact.blocks.map((b: any) => ({ refId: b.refId, evidenceId: b.evidenceId, memberId: b.memberId,
      section: b.section, kind: b.kind, baseline: b.baseline, characters: b.text.length })) };
}
