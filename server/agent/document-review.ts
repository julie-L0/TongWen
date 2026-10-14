import { previewDocument, reviewFingerprint } from './draft-projection.ts';
import { fail, hash } from '../domain/rules.ts';
import {
  anchorGate,
  candidateRefs,
  change,
  checkedEvidence,
  evidence,
  ref,
  registeredEvidence,
  propagationChanges,
} from './investigation.ts';
import type { AgentStore, DocumentReview, Run } from './types.ts';

type ReviewCheckInput = Omit<DocumentReview['checks'][number], 'source' | 'proposalIds'> & {
  source?: { evidenceId?: string; quote: string };
  proposalIds?: string[];
  obligationIds?: string[];
};
type ReviewInput = { memberId: string; mode?: 'append' | 'finalize' | 'exclude_document';
  purpose?: DocumentReview['purpose']; exclusionReason?: string; evidenceIds?: string[]; checks: ReviewCheckInput[] };
type ProviderReviewInput = Omit<ReviewInput, 'purpose' | 'checks'> & {
  purpose?: Omit<NonNullable<DocumentReview['purpose']>, 'quote'> & { quote?: string };
  checks: (Omit<ReviewCheckInput, 'targetWitness'> & {
    targetWitness?: { mode: 'present' | 'absent'; quote?: string };
  })[];
};
export function reviewDocument(
  run: Run,
  input: ProviderReviewInput,
  store: AgentStore,
) {
  const purpose = input.purpose ? { ...input.purpose, quote: input.purpose.quote ?? ref(run, input.purpose.refId).text }
    : run.documentReviewDrafts?.find(d => d.memberId === input.memberId &&
      d.fingerprint === reviewFingerprint(run, store.proposals(run.id), input.memberId))?.purpose;
  const actualPreview = run.documentCoverageProtocol === 'scoped-v1'
    ? previewDocument(run, store.proposals(run.id), input.memberId) : undefined;
  const raw: ReviewInput = { ...input, purpose, checks: input.checks.map(check => {
    let quote = check.targetWitness?.quote;
    if (run.documentCoverageProtocol === 'scoped-v1' && check.targetWitness?.mode === 'present' && quote === undefined) {
      if (check.outcome === 'not_applicable' && check.scope === 'document' && purpose && check.targetRefIds.includes(purpose.refId))
        quote = purpose.quote;
      else if (check.targetRefIds.length === 1) {
        const original = ref(run, check.targetRefIds[0]);
        quote = actualPreview?.blocks.find(block => block.id === original.blockId)?.text;
      }
    }
    return { ...check, targetWitness: check.targetWitness && { ...check.targetWitness, quote: quote || '' } };
  }) };
  if (raw.mode === 'exclude_document') return excludeDocument(run, raw, store);
  if (raw.mode === 'append' && run.sourceObligationProtocol !== 'clauses-v1')
    fail('INVALID_ARGUMENT', '分批条款复核只用于来源条款协议；旧协议仍需整份复核。');
  const proposals = store.proposals(run.id),
    { view, drafts, blocks } = previewDocument(run, proposals, raw.memberId);
  const fingerprint = reviewFingerprint(run, proposals, view.member.id);
  const prior = run.sourceObligationProtocol === 'clauses-v1'
    ? run.documentReviewDrafts?.find((draft) => draft.memberId === view.member.id && draft.fingerprint === fingerprint)
    : undefined;
  const resolvedPurpose = raw.purpose || prior?.purpose;
  if (run.documentCoverageProtocol === 'scoped-v1') {
    if (!resolvedPurpose) fail('DOCUMENT_PURPOSE_REQUIRED', '先用本目标的真实用途正文声明acceptance/procedure/overview/selected/other；用途决定条款传播边界。', 400, { committed: false });
    const witness = ref(run, resolvedPurpose!.refId);
    if (witness.memberId !== view.member.id || witness.baseline || witness.kind === 'heading' ||
      resolvedPurpose!.quote.trim().length < 4 || !witness.text.includes(resolvedPurpose!.quote))
      fail('DOCUMENT_PURPOSE_MISMATCH', '用途必须引用本目标实际已读的完整正文，不能用标题、来源或虚构说明；可省quote由refId绑定实际整段。', 400, { refId: witness.id, actualQuote: witness.text, committed: false });
    checkedEvidence(run, registeredEvidence(run, [], [witness.id]), [witness.id]);
    if (prior?.purpose && hash(prior.purpose) !== hash(resolvedPurpose))
      fail('DOCUMENT_PURPOSE_CHANGED', '同一份有效分批复核不能中途换用途来排除遗漏；重新核对该文档。', 400, { committed: false });
  }
  const expanded = raw.checks.flatMap<{ check: ReviewCheckInput; checkIndex: number }>((check, checkIndex) => {
    if (!check.obligationIds) return [{ check, checkIndex }];
    if (run.documentCoverageProtocol !== 'scoped-v1' || check.obligationId || new Set(check.obligationIds).size !== check.obligationIds.length)
      fail('INVALID_ARGUMENT', '合并条款只用于scoped-v1，真实obligationIds不能重复，不能同时给obligationId。', 400, { committed: false });
    const { obligationIds, ...rest } = check;
    return obligationIds.map((obligationId) => ({ check: { ...rest, obligationId }, checkIndex }));
  });
  const checks: DocumentReview['checks'] = expanded.map(({ check, checkIndex }) => {
    const c = change(run, check.changeId),
      allowed = c.kind === 'remove' ? c.before : c.after.length ? c.after : c.before;
    const identified = check.obligationId ? c.obligations?.find((item) => item.id === check.obligationId) : undefined;
    if (check.obligationId && !identified)
      fail('UNKNOWN_SOURCE_OBLIGATION', '来源条款编号不属于这项已登记变化。', 400, {
        changeId: c.id, allowedObligations: c.obligations || [], committed: false,
      });
    const inferredEditorial = run.documentCoverageProtocol === 'scoped-v1' && ['editorial', 'unknown'].includes(c.kind)
      ? allowed[0] : undefined;
    if (!check.source && !identified && !inferredEditorial)
      fail('SOURCE_REFERENCE_REQUIRED', '本项没有source或真实条款编号，不是读取缺证。用途已在purpose中声明，不额外把用途段当规则复核；行为复核使用真实obligationIds。', 400, {
        field: `checks[${checkIndex}]`, changeId: c.id,
        allowedObligations: c.obligations || [], committed: false,
      });
    const sourceQuote = check.source ? check.source.quote : identified?.source.quote || inferredEditorial?.quote;
    const found = sourceQuote === undefined ? undefined : allowed.find((q) => q.quote.includes(sourceQuote));
    const evidenceId = check.source?.evidenceId || found?.evidenceId;
    if (!evidenceId)
      fail('INVALID_EVIDENCE', '需求引用不在此变化的真实规则中。', 400, {
        field: `checks[${checkIndex}].source`,
        changeId: c.id,
        allowedSourceQuotes: allowed,
        committed: false,
      });
    const obligation = identified || c.obligations?.find((item) => item.source.quote === sourceQuote?.trim().replace(/[。；;，,]+$/gu, ''));
    if (obligation && !sourceQuote?.includes(obligation.source.quote))
      fail('INVALID_EVIDENCE', '本项来源引用未包含它绑定的原始条款。', 400, {
        field: `checks[${checkIndex}].source`, obligation, committed: false,
      });
    return {
      ...check,
      ...(obligation ? { obligationId: obligation.id } : {}),
      source: { evidenceId: evidenceId!, quote: sourceQuote! },
      proposalIds:
        check.proposalIds ??
        (check.outcome === 'patched'
          ? drafts
              .filter(
                (p) => p.changeId === c.id && check.targetRefIds.some((id) => p.targetRefIds.includes(id)),
              )
              .map((p) => p.id)
          : []),
    };
  });
  const args = {
    ...raw,
    checks,
    evidenceIds:
      raw.evidenceIds ??
      [...new Set([
        ...registeredEvidence(
          run,
          run.changes.map((c) => c.id),
          candidateRefs(run)
            .filter((r) => r.memberId === view.member.id)
            .map((r) => r.id),
          true,
        ),
        ...checks.filter((check) => check.outcome === 'unresolved').flatMap((check) => {
          const gate = anchorGate(run, check.changeId);
          return gate.missing.length ? [] : gate.blocking.flatMap((finding) => finding.evidenceIds);
        }),
      ])],
  };
  const bodies = candidateRefs(run).filter((r) => r.memberId === view.member.id);
  checkedEvidence(
    run,
    args.evidenceIds,
    bodies.map((r) => r.id),
  );
  const missing = propagationChanges(run).flatMap((c) =>
    bodies
      .filter((r) => !run.findings.some((f) => f.changeId === c.id && f.refId === r.id))
      .map((r) => ({ changeId: c.id, refId: r.id })),
  );
  if (missing.length)
    fail('DOCUMENT_JUDGMENTS_INCOMPLETE', '先补齐该文档的逐片段判断，再复核整体效果。', 400, {
      missing,
      committed: false,
    });
  for (const p of drafts)
    if (
      p.targetRefIds.some(
        (id) =>
          !run.findings.some(
            (f) => f.changeId === p.changeId && f.refId === id && f.status === 'needs_update',
          ),
      )
    )
      fail('DRAFT_FINDING_MISMATCH', '提案与最新判断不一致，请修正或撤回不必要的修订后再复核。', 400, {
        proposalId: p.id,
        committed: false,
      });
  for (const check of args.checks) {
    const c = change(run, check.changeId),
      source = evidence(run, check.source.evidenceId);
    const allowed = c.kind === 'remove' ? c.before : c.after.length ? c.after : c.before;
    if (
      !check.source.quote.trim() ||
      !source.quote.includes(check.source.quote) ||
      !allowed.some((q) => q.evidenceId === source.id && q.quote.includes(check.source.quote))
    )
      fail('INVALID_EVIDENCE', '复核需求必须引用这项变化的真实新规则；删除变化引用被删除的旧规则。', 400, {
        changeId: c.id,
        field: 'checks.source',
        allowedSourceQuotes: allowed,
        committed: false,
      });
    if (!args.evidenceIds.includes(source.id))
      fail('INVALID_EVIDENCE', '复核未绑定来源需求证据，请将此编号加入顶层evidenceIds。', 400, {
        missingEvidenceId: source.id,
        committed: false,
      });
    const targets = check.targetRefIds.map((id) => ref(run, id));
    if (
      !targets.length ||
      targets.some((r) => r.memberId !== view.member.id || r.baseline || r.kind === 'heading')
    )
      fail('INVALID_EVIDENCE', '每项需求需绑定本目标的真实正文／集合见证，不能借其他文档证明。', 400, {
        memberId: view.member.id,
        field: 'checks.targetRefIds',
        allowedTargetRefs: bodies.map((r) => ({
          refId: r.id,
          evidenceId: run.evidence.find((e) => e.refId === r.id)?.id,
          section: r.section,
        })),
        committed: false,
      });
    checkedEvidence(run, args.evidenceIds, check.targetRefIds);
    const selected = check.proposalIds.map((id) => drafts.find((p) => p.id === id && p.changeId === c.id));
    if (selected.some((p) => !p)) fail('INVALID_PROPOSAL', '复核只能引用本运行、本目标和本变化的有效提案。');
    if (run.sourceObligationProtocol === 'clauses-v1' || check.targetWitness) {
      const witness = check.targetWitness;
      const linkedDrafts = drafts.filter((p) => p.changeId === c.id &&
        p.targetRefIds.some((id) => check.targetRefIds.includes(id)));
      const visible = blocks.filter((block) => targets.some((target) => target.blockId === block.id) ||
        !view.version.blocks.some((old) => old.id === block.id) && linkedDrafts.some((p) =>
          p.patches.some((patch) => patch.kind === 'insert_block' && patch.block.kind === block.kind && patch.block.text === block.text)));
      const original = view.version.blocks.filter((block) => targets.some((target) => target.blockId === block.id));
      const supported = witness && witness.quote.trim().length >= 4 && (
        witness.mode === 'present'
          ? visible.some((block) => block.text.includes(witness.quote))
          : c.kind === 'remove' && check.outcome === 'patched' && selected.length > 0 &&
            original.some((block) => block.text.includes(witness.quote)) &&
            !blocks.some((block) => block.text.includes(witness.quote)));
      if (!supported)
        fail('TARGET_WITNESS_MISMATCH', '每项复核须引用对应真实目标/候选补丁文本；删除见证必须原文存在、实际提案移除。不能引用来源或自行补写的结果。', 400, {
          changeId: c.id, obligationId: check.obligationId, outcome: check.outcome,
          actualTargetTexts: visible.map((block) => ({ blockId: block.id, text: block.text })),
          committed: false,
        });
    }
    const findings = targets.map((r) => run.findings.find((f) => f.changeId === c.id && f.refId === r.id)!);
    // A source rule can be blocked by the anchor while the target correctly
    // retains its existing text. Anchor evidence belongs in evidenceIds, never
    // in another document's targetRefIds. The complete gate remains fingerprinted.
    const gate = anchorGate(run, c.id),
      sourceBlocked = !gate.missing.length && gate.blocking.length > 0;
    if (check.outcome === 'unresolved' && sourceBlocked)
      checkedEvidence(run, args.evidenceIds, gate.blocking.map((finding) => finding.refId));
    if (
      check.outcome === 'patched' &&
      (!selected.length || targets.some((r) => !selected.some((p) => p!.targetRefIds.includes(r.id))))
    )
      fail('REVIEW_OUTCOME_MISMATCH', '声称补丁覆盖需求，必须绑定实际提案及对应修改见证。');
    if (check.outcome !== 'patched' && selected.length)
      fail('REVIEW_OUTCOME_MISMATCH', '非补丁结论不能同时绑定待应用提案。');
    if (
      check.outcome === 'current' &&
      findings.some(
        (f) =>
          !['already_current', 'compatible'].includes(f.status) &&
          !(
            f.status === 'needs_update' &&
            drafts.some((p) => p.changeId === c.id && p.targetRefIds.includes(f.refId))
          ),
      )
    )
      fail('REVIEW_OUTCOME_MISMATCH', 'current只用于compatible/already_current或实际补丁已处理的目标；unrelated表示该处不承载规则，应以not_applicable交代，而非声称正文满足。', 400, {
        memberId: view.member.id, changeId: c.id, field: 'checks.outcome', outcome: check.outcome,
        targetFindings: findings.map((f) => ({ refId: f.refId, status: f.status })), committed: false,
      });
    if (
      check.outcome === 'not_applicable' &&
      findings.some((f) => !['unrelated', 'compatible', 'known_retained'].includes(f.status))
    )
      fail('REVIEW_OUTCOME_MISMATCH', '不传播或保留差异的结论必须有相应判断依据。');
    if (run.documentCoverageProtocol === 'scoped-v1' && check.outcome === 'not_applicable' && check.scope === 'document') {
      if (!resolvedPurpose || ['acceptance', 'procedure'].includes(resolvedPurpose.kind) && c.kind !== 'editorial')
        fail('DOCUMENT_SCOPE_MISMATCH', '完整验收/操作文档不能用某片段无关排除整项行为规则；核对实际动作、条件、例外与拒绝路径。', 400, {
          obligationId: check.obligationId, committed: false,
        });
      if (!check.targetRefIds.includes(resolvedPurpose!.refId) || !check.targetWitness?.quote.includes(resolvedPurpose!.quote))
        fail('DOCUMENT_SCOPE_MISMATCH', '整文条款排除须直接绑定声明的真实用途原句；其他片段不用改不代表整文不承载。', 400, {
          field: 'checks.targetRefIds', requiredPurposeRefId: resolvedPurpose!.refId,
          instruction: '整文排除这一组只绑定purpose.refId；其他片段无关用scope=fragment，不能因此覆盖整文条款。', committed: false });
    }
    if (
      check.outcome === 'unresolved' &&
      !sourceBlocked &&
      findings.some((f) => !['uncertain', 'conflict', 'needs_update'].includes(f.status))
    )
      fail('REVIEW_OUTCOME_MISMATCH', '未解决的结论必须对应真实缺证、冲突或尚无提案的修改项。');
    if (
      check.outcome === 'unresolved' &&
      findings.some(
        (f) =>
          f.status === 'needs_update' &&
          drafts.some((p) => p.changeId === c.id && p.targetRefIds.includes(f.refId)),
      )
    )
      fail('REVIEW_OUTCOME_MISMATCH', '已有合法提案的修改项不能以假设的未来失败记为未解决。');
    if (!check.reason.trim()) fail('INVALID_ARGUMENT', '复核须说明目标是否保留了条件、其他内容与文体。');
  }
  const checkKey = (check: DocumentReview['checks'][number]) => hash({ change: check.changeId,
    obligation: check.obligationId, refs: [...check.targetRefIds].sort() });
  const newKeys = new Set(checks.map(checkKey));
  const combined = [...(prior?.checks || []).filter((check) => !newKeys.has(checkKey(check))), ...checks];
  const omitted = run.sourceObligationProtocol === 'clauses-v1' ? run.changes.flatMap((c) => (c.obligations || [])
    .filter((obligation) => !combined.some((check) => check.changeId === c.id && check.obligationId === obligation.id &&
      !(run.documentCoverageProtocol === 'scoped-v1' && check.outcome === 'not_applicable' && check.scope !== 'document')))
    .map((obligation) => ({ changeId: c.id, ...obligation }))) : [];
  const uncheckedChanges = propagationChanges(run)
    .filter((c) => !combined.some((check) => check.changeId === c.id))
    .map((c) => c.id);
  const uncheckedProposals = drafts
    .filter(
      (p) => !combined.some((check) => check.outcome === 'patched' && check.proposalIds.includes(p.id)),
    )
    .map((p) => p.id);
  if (omitted.length || uncheckedChanges.length || uncheckedProposals.length) {
    if (raw.mode === 'append') {
      const draft: DocumentReview = { memberId: view.member.id, fingerprint, purpose: resolvedPurpose, checks: combined, createdAt: new Date().toISOString() };
      run.documentReviewDrafts = [...(run.documentReviewDrafts || []).filter((r) => r.memberId !== draft.memberId), draft];
      return { accepted: true, complete: false, memberId: view.member.id, validatedChecks: combined.length,
        missingObligations: omitted, uncheckedChanges, uncheckedProposals,
        note: '只保存已核验条款；文档尚未完成复核，提案未因此放行。继续补齐剩余项，不重写已保存检查。' };
    }
    if (omitted.length)
      fail('SOURCE_OBLIGATION_GAP', '每个来源条件、定义、例外与边界必须分别交代，整段笼统复核不能替代条款核对。', 400, {
        missingObligations: omitted, committed: false,
      });
    fail('DOCUMENT_REVIEW_GAP', '尚有变化或有效提案未在文档复核中交代。', 400, {
      uncheckedChanges,
      uncheckedProposals,
      committed: false,
    });
  }
  const review: DocumentReview = {
    memberId: view.member.id,
    fingerprint,
    purpose: resolvedPurpose,
    checks: combined,
    createdAt: new Date().toISOString(),
  };
  run.documentReviews = [
    ...(run.documentReviews || []).filter((r) => r.memberId !== review.memberId),
    review,
  ];
  run.documentReviewDrafts = (run.documentReviewDrafts || []).filter((r) => r.memberId !== review.memberId);
  return {
    accepted: true,
    complete: true,
    memberId: view.member.id,
    checks: review.checks.length,
    note: '已记录模型的文档级复核；不是语义正确性的独立评分，也没有写入文档。',
  };
}

function excludeDocument(run: Run, raw: ReviewInput, store: AgentStore): { accepted: boolean; complete: boolean; memberId: string;
  scopeDecision: string; compiledJudgments: number; note: string } {
  if (run.documentCoverageProtocol !== 'scoped-v1' || raw.purpose?.kind !== 'selected' || raw.checks.length || !raw.exclusionReason?.trim())
    fail('DOCUMENT_SCOPE_MISMATCH', '整文排除仅用于scoped-v1中明确精选、与本轮全部变化无关的材料；须给真实purpose、exclusionReason和checks=[]。', 400, { committed: false });
  const { view, drafts } = previewDocument(run, store.proposals(run.id), raw.memberId);
  const bodies = candidateRefs(run).filter((r) => r.memberId === view.member.id);
  const unread = bodies.filter((r) => !run.readRefIds.includes(r.id));
  if (unread.length) fail('DOCUMENT_NOT_FULLY_READ', '先读完整正文再声明整文无影响；精选标题或零命中不足以排除。', 400, {
    unreadRefIds: unread.map((r) => r.id), committed: false,
  });
  if (drafts.length || store.proposals(run.id).some((p) => p.targetMemberId === view.member.id && p.state !== 'withdrawn') ||
    run.findings.some((f) => bodies.some((r) => r.id === f.refId) && f.status !== 'unrelated' &&
      !(f.status === 'compatible' && f.refId === raw.purpose!.refId)))
    fail('DOCUMENT_SCOPE_CONTRADICTION', '整文排除不能覆盖已有相关规则、修改、缺证或保留决定；保留正确判断，改用普通review_document，不重复exclude_document。', 400, {
      conflictingFindings: run.findings.filter(f => bodies.some(r => r.id === f.refId) && f.status !== 'unrelated' &&
        !(f.status === 'compatible' && f.refId === raw.purpose!.refId)).map(f => ({ changeId: f.changeId, refId: f.refId, status: f.status })),
      instruction: '用途确实排除的来源条款可用普通checks: not_applicable, scope=document, targetRefIds=[purpose.refId]；实际相关片段分别复核。purpose.quote可省略绑定原文。不得把缺证或实际规则改成unrelated来绕过。',
      committed: false });
  // Compile one explicit semantic scope decision into the full audit matrix.
  // Stage it first: a forged purpose or failed review must leave no findings.
  const staged = structuredClone(run);
  const changes = propagationChanges(staged);
  if (!changes.length) fail('NO_SEMANTIC_CHANGE', '本轮只有文字/结构变化，无目标传播义务；使用finish_task结束，不补造整文调查。');
  let sequence = Math.max(staged.entitySequence?.F || 0, ...staged.findings.map((f) => Number(f.id.slice(1)) || 0));
  for (const c of changes) for (const body of bodies) {
    const evidenceIds = registeredEvidence(staged, [c.id], [body.id, raw.purpose!.refId], true);
    const old = staged.findings.find((f) => f.changeId === c.id && f.refId === body.id);
    if (!old) staged.findings.push({ id: 'F' + ++sequence, changeId: c.id, refId: body.id, status: 'unrelated',
      evidenceIds, relationIds: [], reason: raw.exclusionReason! });
  }
  staged.entitySequence = { ...staged.entitySequence, F: sequence };
  const checks: ReviewCheckInput[] = changes.flatMap((c) => {
    const sources = c.obligations?.length ? c.obligations.map((o) => ({ obligationId: o.id, source: o.source }))
      : [{ source: (c.kind === 'remove' ? c.before : c.after.length ? c.after : c.before)[0] }];
    return sources.map((source) => ({ changeId: c.id, ...source, targetRefIds: [raw.purpose!.refId],
      scope: 'document' as const, outcome: 'not_applicable' as const,
      targetWitness: { mode: 'present' as const, quote: raw.purpose!.quote }, reason: raw.exclusionReason! }));
  });
  const result = reviewDocument(staged, { memberId: raw.memberId, purpose: raw.purpose, checks }, store);
  const review = staged.documentReviews!.find((r) => r.memberId === raw.memberId)!;
  review.scopeExclusion = { changeIds: changes.map((c) => c.id), reason: raw.exclusionReason! };
  run.findings = staged.findings; run.entitySequence = staged.entitySequence;
  run.documentReviews = staged.documentReviews; run.documentReviewDrafts = staged.documentReviewDrafts;
  return { ...result, scopeDecision: 'document_excluded', compiledJudgments: bodies.length * changes.length,
    note: '完整正文已读取，记录模型的精选范围排除并展开审计；不是独立语义评分，原文未写入。' };
}
