import type { Run, ModelMessage } from '../types.ts';
import type { StrategyKnowledge } from '../strategy.ts';
import { candidateRefs, anchorGate, quoteContext, propagationChanges } from '../investigation.ts';
import { documentReviewCoverage, documentDrafts, previewDocument, reviewFingerprint } from '../draft-projection.ts';
import { sourceScope } from '../source-scope.ts';
import { unassignedSourceClauses } from '../source-obligations.ts';

// Full audit persists. Project actual state by document; previews are not evidence.
export function modelContext(run: Run, knowledge: StrategyKnowledge = { proposals: [] }): ModelMessage[] {
  const candidates = candidateRefs(run),
    proposals = knowledge.proposals;
  const missingDeltas = run.deltas.filter((d) => !run.changes.some((c) => c.deltaIds.includes(d.id)));
  const missingSourceClauses = unassignedSourceClauses(run);
  const reviews = documentReviewCoverage(run, proposals);
  const documents = run.manifest.views
    .filter((v) => v.member.id !== run.manifest.sourceMemberId && ['anchor', 'sync'].includes(v.member.role))
    .map((v) => {
      const refs = candidates.filter((r) => r.memberId === v.member.id);
      const gaps = refs.flatMap((r) =>
        propagationChanges(run)
          .filter((c) => !run.findings.some((f) => f.refId === r.id && f.changeId === c.id))
          .map((c) => {
            const target = run.evidence.find((e) => e.refId === r.id),
              context = quoteContext(run, r),
              contextEvidence = context && run.evidence.find((e) => e.refId === context.id);
            return {
              changeId: c.id,
              refId: r.id,
              evidenceId: target?.id,
              readyToJudge: !!target && (!context || !!contextEvidence),
              allowedStatuses:
                r.role === 'anchor'
                  ? ['not_conflicting', 'conflict', 'uncertain']
                  : ['needs_update', 'already_current', 'compatible', 'unrelated', 'uncertain'],
              evidenceIds: [
                ...new Set(
                  [
                    target?.id,
                    ...[...c.before, ...c.after].map((q) => q.evidenceId),
                    contextEvidence?.id,
                  ].filter((id): id is string => !!id),
                ),
              ],
              ...(context ? { contextRefId: context.id, contextEvidenceId: contextEvidence?.id } : {}),
            };
          }),
      );
      const outstanding = run.findings.filter(
        (f) =>
          refs.some((r) => r.id === f.refId) &&
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
        view: v,
        refs,
        gaps,
        outstanding,
        reviewPending: reviews.gaps.some((g) => g.memberId === v.member.id),
        locked: !!run.approvedHeads?.[v.member.id],
      };
    });
  const focus = missingDeltas.length || missingSourceClauses.length
    ? undefined
    : documents.find((d) => !d.locked && (d.gaps.length || d.outstanding.length || d.reviewPending));
  const prioritized = [...run.evidence].sort((a, b) => {
    const score = (id: string) => {
      const r = run.manifest.refs.find((r) => r.id === id)!;
      return run.deltas.some((d) => [d.beforeRefId, d.afterRefId].includes(id))
        ? 0
        : r.memberId === focus?.view.member.id
          ? 1
          : 2;
    };
    return score(a.refId) - score(b.refId);
  });
  let cacheCharacters = 0;
  let preview: unknown;
  if (focus?.view.member.role === 'sync' && focus.refs.every((r) => run.readRefIds.includes(r.id))) {
    try {
      const p = previewDocument(run, proposals, focus.view.member.id);
      preview = {
        note: '实际提案合并后的假设预览，未写入且不是原文证据。锚点必须来自已登记原文。',
        changedBlocks: p.blocks
          .filter((b) => !p.view.version.blocks.some((old) => old.id === b.id && old.text === b.text))
          .map((b) => ({
            originalBlockId: p.view.version.blocks.some((old) => old.id === b.id) ? b.id : undefined,
            kind: b.kind,
            text: b.text,
            level: b.level,
          })),
        removedBlockIds: p.view.version.blocks
          .filter((b) => !p.blocks.some((n) => n.id === b.id))
          .map((b) => b.id),
      };
    } catch (e) {
      preview = {
        error: e instanceof Error ? e.message : '补丁不能合并',
        instruction: '先修正最小替换边界，避免交叠与附带改动，再复核。',
      };
    }
  }
  const projection = {
    note: '真实冻结状态及持久化草案。模型结论可修正，不是客观事实。只按需读取，用户确认才能写文档。',
    changeScope: sourceScope(run),
    ...(run.documentCoverageProtocol === 'scoped-v1' ? {
      sourceContext: {
        title: run.manifest.source.document.title,
        scopeName: run.manifest.source.scope.name,
        instruction: '变化继承当前来源文档与实际检查组的适用范围。不能只因变化中出现另一类产品/用户名称，就自行切换产品范围并套用另一交付的例外。范围真正不清时读取来源用途与邻近上下文，明确提问。',
        readContext: run.evidence.filter(e => {
          const r = run.manifest.refs.find(r => r.id === e.refId)!;
          return r.memberId === run.manifest.sourceMemberId && !r.baseline && r.kind !== 'heading' &&
            run.readRefIds.includes(r.id) && !run.deltas.some(d => d.afterRefId === r.id);
        }).slice(0, 6).map(e => ({ evidenceId: e.id, refId: e.refId, quote: e.quote })),
      },
    } : {}),
    confirmedDocuments: documents.filter((d) => d.locked).map((d) => ({ memberId: d.view.member.id,
      title: d.view.document.title, instruction: '用户已确认，本轮锁定；不要重复读取、判断或生成提案。' })),
    sourceProgress: {
      missingSourceClauses,
      ...(run.documentCoverageProtocol === 'scoped-v1' && missingSourceClauses.length ? {
        instruction: '这些是实际引用尚未登记的来源条款，不等于还没读过。已有evidenceId的项直接describe_change修订相应已登记Change的before/after并保留已有引用；反复read_context不会补引用。不要用摘要替代原句或新建虚假业务。',
        repairTasks: missingSourceClauses.map((item) => ({ ...item,
          action: item.evidenceId ? 'amend_describe_change' : 'read_context',
          possibleChanges: run.changes.filter((c) => c.deltaIds.includes(item.deltaId))
            .map((c) => ({ changeId: c.id, businessObject: c.businessObject, kind: c.kind })),
          fieldToAmend: item.side,
        })),
      } : {}),
      missingDeltas: missingDeltas.map((d) => ({
        id: d.id,
        beforeRefId: d.beforeRefId,
        afterRefId: d.afterRefId,
      })),
      changes: run.changes,
    },
    documents: documents.map((d) => ({
      memberId: d.view.member.id,
      title: d.view.document.title,
      role: d.view.member.role,
      read: d.refs.filter((r) => run.readRefIds.includes(r.id)).length,
      bodies: d.refs.length,
      judged: d.refs.length * propagationChanges(run).length - d.gaps.length,
      unjudged: d.gaps.length,
      outstanding: d.outstanding.length,
      reviewPending: d.reviewPending,
      locked: d.locked,
    })),
    focus: focus && {
      memberId: focus.view.member.id,
      title: focus.view.document.title,
      role: focus.view.member.role,
      ...(run.sourceObligationProtocol === 'clauses-v1' && focus.view.member.role === 'sync' ? {
        clauseReview: {
          protocol: 'clauses-v1',
          ...(run.documentCoverageProtocol ? { coverageProtocol: run.documentCoverageProtocol } : {}),
          instruction: run.documentCoverageProtocol === 'scoped-v1'
            ? '先声明真实purpose；同一实际见证完整承载的条款可合并obligationIds。片段not_applicable不计整文覆盖。明确精选且全文均无关，可exclude_document一次记账。'
            : '每批3–5条检查，用mode=append保存已核验项；后续只补缺项。来源/提案/证据可按真实条款自动绑定，全部覆盖前不能确认。',
          purpose: run.documentReviewDrafts?.find((draft) => draft.memberId === focus.view.member.id &&
            draft.fingerprint === reviewFingerprint(run, proposals, focus.view.member.id))?.purpose,
          validatedChecks: run.documentReviewDrafts?.find((draft) => draft.memberId === focus.view.member.id &&
            draft.fingerprint === reviewFingerprint(run, proposals, focus.view.member.id))?.checks || [],
        },
      } : {}),
      nextActionHint: focus.gaps.length
        ? run.documentCoverageProtocol === 'scoped-v1' && focus.view.member.role === 'sync' &&
          focus.refs.every((r) => run.readRefIds.includes(r.id)) && !documentDrafts(run, proposals, focus.view.member.id).length
          ? '全文已读且无草案：先对照真实用途和全部变化。明确精选且全文均无关，可exclude_document一次记账，避免抄多条相同unrelated；有任何相关规则/缺证则正常逐处判断。不能仅凭标题或数量排除。'
          : '先读取未读块或用readyToJudge的证据记录判断；底本不做文档复核。'
        : focus.outstanding.length
          ? '先为needs_update建立关系和提案；若真正不能定位，用具体原因交代，别把尚未准备草案说成已完成。'
          : '判断齐备，复核真实草案与未修改内容；修订不必要时先改判断。',
      unreadRefIds: focus.refs.filter((r) => !run.readRefIds.includes(r.id)).map((r) => r.id),
      fragments: focus.refs.map((r) => ({
        refId: r.id,
        blockId: r.blockId,
        section: r.section,
        kind: r.kind,
        evidenceId: run.evidence.find((e) => e.refId === r.id)?.id,
        judgments: run.findings
          .filter((f) => f.refId === r.id)
          .map((f) => ({
            changeId: f.changeId,
            status: f.status,
            relationIds: f.relationIds,
            reason: f.reason.slice(0, 100),
          })),
      })),
      drafts: documentDrafts(run, proposals, focus.view.member.id).map((p) => ({
        id: p.id,
        changeId: p.changeId,
        targetRefIds: p.targetRefIds,
        patches: p.patches,
      })),
      outstanding: focus.outstanding.map((f) => ({ changeId: f.changeId, refId: f.refId })),
      preview,
      reviewEvidenceIds: [
        ...new Set([
          ...focus.refs.flatMap((r) => run.evidence.filter((e) => e.refId === r.id).map((e) => e.id)),
          ...run.changes.flatMap((c) => [...c.before, ...c.after].map((q) => q.evidenceId)),
        ]),
      ],
    },
    evidence: prioritized.map((e) => {
      const r = run.manifest.refs.find((r) => r.id === e.refId)!;
      const sourceNeeded =
        run.deltas.some((d) => [d.beforeRefId, d.afterRefId].includes(r.id)) ||
        run.changes.some((c) => [...c.before, ...c.after].some((q) => q.evidenceId === e.id));
      const full =
        (sourceNeeded || r.memberId === focus?.view.member.id) && cacheCharacters + e.quote.length <= 16000;
      if (full) cacheCharacters += e.quote.length;
      return {
        evidenceId: e.id,
        refId: e.refId,
        memberId: r.memberId,
        role: r.role,
        blockId: r.blockId,
        section: r.section,
        ...(r.memberId === run.manifest.sourceMemberId ? { isSource: true, baseline: r.baseline } : {}),
        ...(full ? { text: e.quote } : { excerpt: e.quote.slice(0, 60), fullTextCached: false }),
      };
    }),
    relations: run.relations
      .filter((r) => r.targetRefIds.some((id) => focus?.refs.some((f) => f.id === id)))
      .map((r) => ({
        id: r.id,
        changeIds: r.changeIds,
        targetRefIds: r.targetRefIds,
        coverageMode: r.coverageMode,
      })),
    proposalLedger: proposals.map((p) => ({
      id: p.id,
      memberId: p.targetMemberId,
      changeId: p.changeId,
      state: p.state,
    })),
    nextUnjudgedBatch: run.documentCoverageProtocol === 'scoped-v1' && missingSourceClauses.length ? []
      : (focus?.gaps || documents.flatMap((d) => d.gaps)).slice(0, 12),
    documentReviews: reviews,
    ...(run.documentCoverageProtocol === 'scoped-v1' ? {
      completionAgenda: {
        pendingDocumentReviews: reviews.gaps,
        instruction: reviews.complete ? '针对真实uncertain提出可回答问题，再finish_task；relatedRefIds只关联合法邻近上下文，底本冲突不填跨章节关联。'
          : '先完成这些真实目标的文档复核，再结束。完整资料未写某项新能力不等于无关；底本阻断的真实承载点用unresolved，原文保留。精选已有compatible片段时用普通复核及真实用途排除。',
        unresolvedCandidates: run.findings.filter(f => ['uncertain', 'conflict'].includes(f.status)).map(f => {
          const original = refForCompletion(run, f.refId);
          return { changeId: f.changeId, refId: f.refId, status: f.status, reason: f.reason,
            requiresQuestions: f.status === 'uncertain',
            allowedRelatedRefIds: original.role === 'anchor' ? [] : run.findings.filter(other => {
              const nearby = refForCompletion(run, other.refId);
              return other.changeId === f.changeId && other.refId !== f.refId &&
                ['uncertain', 'compatible', 'unrelated'].includes(other.status) && nearby.role !== 'anchor' &&
                nearby.memberId === original.memberId && nearby.versionId === original.versionId &&
                nearby.section === original.section && Math.abs(nearby.order - original.order) <= 3 && run.readRefIds.includes(nearby.id);
            }).map(other => other.refId),
          };
        }),
      },
    } : {}),
    recoveryHints: run.recoveryHints,
    anchorGates: run.changes.map((c) => ({ changeId: c.id, ...anchorGate(run, c.id) })),
    budgetRemaining: {
      modelCalls: run.budget.modelCalls - run.stats.modelCalls,
      toolCalls: run.budget.toolCalls - run.stats.toolCalls,
      inputTokens: run.budget.inputTokens - run.stats.inputTokens,
      ...(run.documentCoverageProtocol === 'scoped-v1' ? {
        outputTokens: Math.max(0, run.budget.outputTokens - run.stats.outputTokens),
        timeMs: Math.max(0, run.budget.timeMs - (Date.now() - (run.stats.startedAt || Date.now()))),
      } : {}),
    },
  };
  const starts = run.messages.map((m, index) => (m.role === 'assistant' ? index : -1)).filter((i) => i >= 0);
  const recent = starts.length ? run.messages.slice(starts[starts.length - 1]) : run.messages.slice(2);
  return [run.messages[0], run.messages[1], { role: 'user', content: JSON.stringify(projection) }, ...recent];
}
function refForCompletion(run: Run, id: string) { return run.manifest.refs.find(r => r.id === id)!; }
export function compactObservation(name: string, result: any): unknown {
  if (!result || result.error) return result;
  if (name === 'read_context')
    return {
      ...result,
      blocks: result.blocks.map((b: any) => ({
        refId: b.refId,
        evidenceId: b.evidenceId,
        memberId: b.memberId,
        title: b.title,
        blockId: b.blockId,
        section: b.section,
        kind: b.kind,
        role: b.role,
        baseline: b.baseline,
        text: b.text,
        structure: b.structure
          ? {
              columns: b.structure.columns,
              rows: b.structure.rows.map((row: any) => ({ index: row.index, object: row.object })),
            }
          : undefined,
        truncated: b.truncated,
      })),
    };
  if (['list_fragments', 'search_fragments'].includes(name))
    return {
      ...result,
      items: result.items.map((r: any) => ({
        refId: r.refId,
        memberId: r.memberId,
        section: r.section,
        role: r.role,
        kind: r.kind,
        isSource: r.isSource,
        snippet: r.snippet,
        characters: r.characters,
        read: r.read,
      })),
    };
  if (name === 'record_finding')
    return {
      saved: result.saved.map((f: any) => ({
        id: f.id,
        changeId: f.changeId,
        refId: f.refId,
        status: f.status,
        differenceId: f.differenceId,
      })),
      errors: result.errors,
      coverage: {
        expected: result.coverage.expected,
        judged: result.coverage.judged,
        complete: result.coverage.complete,
        missingDeltas: result.coverage.missingDeltas,
        gapCount: result.coverage.gaps.length,
        gaps: result.coverage.gaps.slice(0, 12),
        outstandingCount: result.coverage.outstanding.length,
      },
      anchorGates: result.anchorGates,
    };
  return result;
}
