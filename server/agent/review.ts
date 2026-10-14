import { applyPatches, assertEditable, assertRequestId, fail, hash, uid } from '../domain/rules.ts';
import type { AgentService } from './service.ts';
import { anchorGate, coverage } from './tools.ts';
import type { Proposal, Run, ReviewBatch } from './types.ts';
import { documentReviewCoverage } from './draft-projection.ts';
import { sourceGoalFingerprint, assertScopedChange } from './source-scope.ts';
import { reviewReadiness } from './review-readiness.ts';
import { rememberMergedRelations, invalidateRelation } from './confirmed-relations.ts';

// Human review is a separate command layer. The model never receives a writing tool.
// Manifest/evidence remain immutable; only receipts of our own approved writes extend freshness.
export class AgentReview {
  private service: AgentService;
  constructor(service: AgentService) {
    this.service = service;
  }
  apply(runId: string, input: { proposalIds: string[]; requestId: string }) {
    assertRequestId(input?.requestId);
    const s = this.service,
      w = s.workspaceStore,
      a = s.store;
    return a.transaction(() => {
      const prior = w.priorRequest(input.requestId, 'agent-apply', { runId, ...input });
      if (prior)
        return {
          batch: a.reviewBatches(runId).find((b) => b.id === prior.batchId),
          report: s.report(runId),
          workspace: s.workspace.snapshot(),
        };
      if (
        !Array.isArray(input.proposalIds) ||
        !input.proposalIds.length ||
        input.proposalIds.length > 50 ||
        new Set(input.proposalIds).size !== input.proposalIds.length
      )
        fail('INVALID_SELECTION', '请选择 1–50 个不同提案。');
      const run = a.run(runId);
      s.assertCurrentPolicy(run);
      s.assertFresh(run);
      const proposals = input.proposalIds.map((id) => a.proposal(id));
      const readiness = reviewReadiness(run, a.proposals(runId), [...new Set(proposals.map((p) => p.targetMemberId))], coverage(run, a).complete);
      if (!readiness.allowed) fail('RUN_NOT_REVIEWABLE', readiness.reason, 409);
      for (const p of proposals) {
        const sourceChange = run.changes.find((c) => c.id === p.changeId);
        if (!sourceChange) fail('SOURCE_CHANGE_OUT_OF_SCOPE', '提案没有本次检查的来源变化。', 409);
        assertScopedChange(run, sourceChange!);
        if (p.targetRefIds.some((id) => !run.findings.some((f) => f.refId === id && f.changeId === p.changeId && f.status === 'needs_update')))
          fail('PROPOSAL_NOT_APPLICABLE', '提案与当前判断不一致，不能直接应用。', 409);
        if (p.latestRunId !== runId || !['pending', 'deferred'].includes(p.state))
          fail('PROPOSAL_NOT_APPLICABLE', '提案已应用、保留、失效或属于其他调查，请刷新后选择。', 409);
        const gate = anchorGate(run, p.changeId);
        if (gate.missing.length || gate.blocking.length)
          fail('ANCHOR_CONFLICT', '底本未核对完成或存在相关冲突，不能应用。', 409);
        const difference = a.differences().find((d) => d.id === p.differenceId)!;
        if (difference.status === 'retained') fail('KNOWN_DIFFERENCE', '该差异已经明确保留，不能应用。', 409);
        const view = s.workspace.view(p.targetMemberId);
        assertEditable(view);
        if (p.targetMemberId === run.manifest.sourceMemberId || p.targetVersionId !== view.version.id)
          fail('INPUT_STALE', '目标或提案版本已经变化，需重新核对。', 409);
      }
      const groups = new Map<string, Proposal[]>();
      for (const p of proposals) groups.set(p.targetMemberId, [...(groups.get(p.targetMemberId) || []), p]);
      // Validate combined patches before the first write. One document becomes one operation.
      for (const [memberId, items] of groups) {
        const patches = items.flatMap((p) => p.patches);
        const inserts = patches.filter((p) => p.kind === 'insert_block').map((p) => p.afterBlockId);
        if (new Set(inserts).size !== inserts.length)
          fail('PATCH_OVERLAP', '多项提案使用同一插入位置，请分批确认并重新核对顺序。', 409);
        applyPatches(s.workspace.view(memberId).version.blocks, patches);
      }
      const batch: ReviewBatch = {
        id: uid(),
        runId,
        proposalIds: input.proposalIds,
        requestId: input.requestId,
        createdAt: new Date().toISOString(),
        undoneAt: null,
        operations: [],
      };
      for (const [memberId, items] of groups) {
        const before = s.workspace.view(memberId),
          result = s.workspace.patch(memberId, {
            expectedRevision: before.document.revision,
            patches: items.flatMap((p) => p.patches),
            requestId: uid(),
          });
        const reread = s.workspace.view(memberId);
        if (reread.version.id !== result.view.version.id || reread.version.hash !== result.view.version.hash)
          fail('VERIFY_FAILED', '提案保存后回读不一致，整批未提交。', 500);
        batch.operations.push({
          operationId: result.operationId,
          memberId,
          beforeVersionId: before.version.id,
          afterVersionId: reread.version.id,
        });
        (run.approvedHeads ||= {})[memberId] = {
          versionId: reread.version.id,
          revision: reread.document.revision,
        };
      }
      for (const p of proposals) {
        p.state = 'applied';
        a.saveProposal(p);
        const d = a.differences().find((d) => d.id === p.differenceId)!;
        d.status = 'applied';
        a.saveDifference(d);
      }
      this.refreshRemaining(run, new Set(groups.keys()));
      if (run.status === 'running')
        a.event(runId, 'document_locked', '已确认文档在本轮锁定；其余文档继续检查。', { memberIds: [...groups.keys()] });
      this.shareReceipts(
        run,
        batch,
        batch.operations.map((o) => ({ memberId: o.memberId, beforeVersionId: o.beforeVersionId })),
      );
      a.saveReviewBatch(batch);
      rememberMergedRelations(s, run, proposals, batch);
      a.saveRun(run);
      a.event(runId, 'applied', '用户选中提案已保存并回读；未选提案保留。', {
        batchId: batch.id,
        proposalIds: batch.proposalIds,
        operations: batch.operations,
      });
      w.saveRequest(input.requestId, 'agent-apply', { runId, ...input }, { batchId: batch.id });
      return { batch, report: s.report(runId), workspace: s.workspace.snapshot() };
    });
  }
  undo(batchId: string, requestId: string) {
    assertRequestId(requestId);
    const s = this.service,
      a = s.store,
      w = s.workspaceStore;
    return a.transaction(() => {
      const prior = w.priorRequest(requestId, 'agent-undo', { batchId });
      if (prior)
        return {
          batch: a.reviewBatches().find((b) => b.id === batchId),
          report: s.report(prior.runId),
          workspace: s.workspace.snapshot(),
        };
      const batch = a.reviewBatches().find((b) => b.id === batchId);
      if (!batch || batch.undoneAt) fail('UNDO_CONFLICT', '这个修订批次不存在或已撤销。', 409);
      const run = a.run(batch!.runId);
      s.assertFresh(run);
      const expected = [...batch!.operations].reverse(),
        latest = w
          .operations()
          .filter((o) => !o.undoneAt)
          .slice(0, expected.length);
      if (expected.some((o, i) => latest[i]?.id !== o.operationId))
        fail('UNDO_CONFLICT', '只能撤销最近尚未撤销的整批操作；后续补丁或恢复必须先处理。', 409);
      for (const op of expected) {
        const current = s.workspace.view(op.memberId);
        assertEditable(current);
        if (current.version.hash !== w.version(op.afterVersionId).hash)
          fail('UNDO_CONFLICT', '文档后来已被修改，撤销不会覆盖后续内容。', 409);
      }
      const previousHeads = expected.map((o) => ({
        memberId: o.memberId,
        beforeVersionId: s.workspace.view(o.memberId).version.id,
      }));
      for (const op of expected) {
        const before = w.version(op.beforeVersionId),
          current = s.workspace.view(op.memberId),
          version = w.insertVersion(current.document.id, before.blocks, '撤销 Agent 修订批次');
        w.setHead(current.document.id, version.id);
        w.markUndone(op.operationId);
        const reread = s.workspace.view(op.memberId);
        if (reread.version.hash !== before.hash) fail('VERIFY_FAILED', '撤销后回读失败，整批未提交。', 500);
        (run.approvedHeads ||= {})[op.memberId] = {
          versionId: version.id,
          revision: reread.document.revision,
        };
      }
      for (const id of batch!.proposalIds) {
        const p = a.proposal(id);
        p.state = 'needs_revalidation';
        a.saveProposal(p);
        const d = a.differences().find((d) => d.id === p.differenceId)!;
        d.status = 'pending';
        a.saveDifference(d);
      }
      this.refreshRemaining(run, new Set(expected.map((o) => o.memberId)));
      this.shareReceipts(run, batch!, previousHeads);
      batch!.undoneAt = new Date().toISOString();
      for (const relation of a.confirmedRelations())
        if (batch!.operations.some(op => op.memberId === relation.targetMemberId))
          invalidateRelation(s, relation, '已确认修订被撤销，关系检查点失效');
      if (run.status === 'running') {
        run.status = 'interrupted';
        run.stopReason = '用户撤销了运行中的确认批次；已停止本轮检查，请基于当前资料重新检查。';
      }
      a.saveReviewBatch(batch!);
      a.saveRun(run);
      a.event(run.id, 'undo', '整批修订已恢复为新版本；来源修改保留，已撤销提案需重新核对。', { batchId });
      w.saveRequest(requestId, 'agent-undo', { batchId }, { runId: run.id });
      return { batch, report: s.report(run.id), workspace: s.workspace.snapshot() };
    });
  }
  private refreshRemaining(run: Run, members: Set<string>) {
    const s = this.service;
    for (const p of s.store.proposals(run.id)) {
      if (
        p.latestRunId !== run.id ||
        !members.has(p.targetMemberId) ||
        !['pending', 'deferred'].includes(p.state)
      )
        continue;
      const current = s.workspace.view(p.targetMemberId);
      // Include support and insertion-boundary evidence, not just the replaced fragment.
      const refs = p.evidenceIds
        .map((id) => run.evidence.find((e) => e.id === id))
        .filter((e) => e)
        .map((e) => run.manifest.refs.find((r) => r.id === e!.refId)!)
        .filter((r) => r.memberId === p.targetMemberId && !r.baseline);
      if (refs.some((r) => current.version.blocks.find((b) => b.id === r.blockId)?.text !== r.text))
        p.state = 'needs_revalidation';
      else
        try {
          p.after = applyPatches(current.version.blocks, p.patches);
          p.targetVersionId = current.version.id;
        } catch {
          p.state = 'needs_revalidation';
        }
      s.store.saveProposal(p);
    }
  }
  private shareReceipts(
    run: Run,
    batch: ReviewBatch,
    previous: { memberId: string; beforeVersionId: string }[],
  ) {
    const s = this.service;
    for (const other of s.store.runs()) {
      if (
        other.id === run.id ||
        ['queued', 'running'].includes(other.status) ||
        other.manifest.sourceMemberId !== run.manifest.sourceMemberId ||
        other.manifest.source.version.id !== run.manifest.source.version.id ||
        other.manifest.source.baseline.id !== run.manifest.source.baseline.id ||
        sourceGoalFingerprint(other) !== sourceGoalFingerprint(run) ||
        other.reviewProtocol !== run.reviewProtocol ||
        hash(other.executionIdentity || null) !== hash(run.executionIdentity || null) ||
        other.manifest.policyHash !== run.manifest.policyHash
      )
        continue;
      if (
        hash(other.manifest.views.map((v) => v.member.id).sort()) !==
        hash(run.manifest.views.map((v) => v.member.id).sort())
      )
        continue;
      // Extend only an exact, recorded before→after chain of the same frozen goal.
      // An external edit or a changed source can never be explained by this receipt.
      const members = new Set<string>();
      for (const op of previous) {
        const frozen = other.manifest.views.find((v) => v.member.id === op.memberId)!;
        if ((other.approvedHeads?.[op.memberId]?.versionId || frozen.version.id) !== op.beforeVersionId)
          continue;
        const current = s.workspace.view(op.memberId);
        (other.approvedHeads ||= {})[op.memberId] = {
          versionId: current.version.id,
          revision: current.document.revision,
        };
        members.add(op.memberId);
      }
      if (!members.size) continue;
      this.refreshRemaining(other, members);
      other.updatedAt = new Date().toISOString();
      s.store.saveRun(other);
      s.store.event(
        other.id,
        'review_receipt',
        '同一冻结目标的后续审阅操作已记录；共享证据变化的旧建议需重新核对。',
        { originRunId: run.id, batchId: batch.id, memberIds: [...members] },
      );
    }
  }
}
