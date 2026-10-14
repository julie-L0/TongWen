import { assertEditable, assertRequestId, contentDiff, fail, hash, uid } from '../domain/rules.ts';
import type { Workspace } from '../application/workspace.ts';
import type { WorkspaceStore } from '../application/ports.ts';
import type { View } from '../domain/types.ts';
import { candidateRefs, coverage, anchorGate } from './tools.ts';
import { defaultBudget, type AgentStore, type Budget, type Ref, type Run } from './types.ts';
import type { AgentStrategy } from './strategy.ts';
import { defaultStrategy } from './tuning/default.ts';
import type { AgentReport, ProposalEvidence, CreateRunRequest } from '../../shared/contracts/agent.ts';
import { AgentReview } from './review.ts';
import { changedTableRows } from '../domain/markdown-structure.ts';
import { documentReviewCoverage } from './draft-projection.ts';
import { executionIdentity } from './identity.ts';
import type { ExecutionIdentity } from '../../shared/contracts/agent.ts';
import { sourceScope, assertScopedChange } from './source-scope.ts';
import { reviewReadiness } from './review-readiness.ts';

export class AgentService {
  readonly store: AgentStore;
  readonly workspace: Workspace;
  readonly workspaceStore: WorkspaceStore;
  readonly strategy: AgentStrategy;
  readonly executionIdentity: ExecutionIdentity;
  readonly reviewProtocol: 'fragments-v1' | 'documents-v1';
  constructor(
    store: AgentStore,
    workspace: Workspace,
    workspaceStore: WorkspaceStore,
    strategy: AgentStrategy = defaultStrategy,
    options: { reviewProtocol?: 'fragments-v1' | 'documents-v1' } = {},
  ) {
    this.store = store;
    this.workspace = workspace;
    this.workspaceStore = workspaceStore;
    if (!strategy.version.trim() || !strategy.systemPrompt.trim())
      fail('INVALID_STRATEGY', 'Agent 策略必须提供版本和系统提示。');
    this.strategy = Object.freeze({
      version: strategy.version,
      identity: strategy.identity ? structuredClone(strategy.identity) : undefined,
      systemPrompt: strategy.systemPrompt,
      buildMessages: strategy.buildMessages.bind(strategy),
      formatObservation: strategy.formatObservation.bind(strategy),
    });
    this.executionIdentity = executionIdentity(strategy);
    this.reviewProtocol = options.reviewProtocol || 'documents-v1';
  }
  create(input: CreateRunRequest) {
    const promptVersion = this.strategy.version;
    assertRequestId(input?.requestId);
    const receipt = this.workspaceStore.priorRequest(input.requestId, 'agent-run', input);
    if (receipt) return this.store.run(receipt.runId);
    const prior = this.store.request(input.requestId);
    if (prior) {
      if (prior.inputHash !== hash(input)) fail('REQUEST_REUSED', '任务请求 ID 已用于不同输入。', 409);
      return prior;
    }
    const source = this.workspace.view(input.sourceMemberId);
    assertEditable(source);
    if (input.baselineVersionId) {
      const baseline = this.workspaceStore.version(input.baselineVersionId);
      if (baseline.documentId !== source.document.id) fail('VERSION_OWNERSHIP', '来源比较基线属于其他文档。');
      source.baseline = baseline;
    }
    if (input.sourceBlockIds !== undefined && !Array.isArray(input.sourceBlockIds))
      fail('INVALID_SOURCE_SELECTION', '请提供当前文档的来源位置列表。');
    const sourceBlockIds = input.sourceBlockIds ? [...input.sourceBlockIds].sort() : undefined;
    if (
      input.sourceBlockIds !== undefined &&
      (!Array.isArray(input.sourceBlockIds) ||
        !sourceBlockIds?.length ||
        new Set(sourceBlockIds).size !== sourceBlockIds.length ||
        sourceBlockIds.some(
          (id) =>
            typeof id !== 'string' ||
            ![...source.baseline.blocks, ...source.version.blocks].some((b) => b.id === id),
        ))
    )
      fail('INVALID_SOURCE_SELECTION', '来源位置不属于当前文档的比较版本。');
    const scopeViews = this.workspace
      .snapshot()
      .views.filter((v) => v.member.scopeId === source.member.scopeId);
    if (
      input.memberIds &&
      (!Array.isArray(input.memberIds) ||
        input.memberIds.some((id) => !scopeViews.some((v) => v.member.id === id)))
    )
      fail('OUT_OF_SCOPE', '所选目标不属于来源资料组。');
    const views = scopeViews
      .filter(
        (v) =>
          !input.memberIds ||
          input.memberIds.includes(v.member.id) ||
          v.member.role === 'anchor' ||
          v.member.id === source.member.id,
      )
      .map((v) => (v.member.id === source.member.id ? source : v));
    if (views.some((v) => v.member.role === 'unconfigured'))
      fail('SCOPE_NOT_CONFIGURED', '请先配置范围内所有资料的角色。');
    const active = this.store
      .runs()
      .find(
        (r) => r.manifest.source.scope.id === source.scope.id && ['queued', 'running'].includes(r.status),
      );
    const budget = { ...defaultBudget };
    for (const key of Object.keys(input.budget || {}) as (keyof Budget)[]) {
      if (!Object.hasOwn(defaultBudget, key)) fail('INVALID_BUDGET', '不支持的预算字段。');
      const value = input.budget![key];
      if (!Number.isSafeInteger(value) || value! <= 0 || value! > defaultBudget[key])
        fail('INVALID_BUDGET', '预算只能设置为正整数且不超过服务上限。');
      budget[key] = value!;
    }
    if (active) {
      let fresh = true;
      try {
        this.assertFresh(active);
      } catch {
        fresh = false;
      }
      if (!fresh) {
        active.status = 'stale';
        active.stopReason = '新的检查发现原运行输入已变化。';
        this.store.transaction(() => {
          this.store.saveRun(active);
          this.store.event(active.id, 'stale', active.stopReason);
        });
      } else {
        const same =
          active.manifest.sourceMemberId === source.member.id &&
          active.manifest.source.baseline.id === source.baseline.id &&
          hash(active.sourceBlockIds || null) === hash(sourceBlockIds || null) &&
          hash(active.manifest.views.map((v) => v.member.id).sort()) ===
            hash(views.map((v) => v.member.id).sort()) &&
          hash(active.budget) === hash(budget) &&
          active.strategyVersion === promptVersion &&
          hash(active.executionIdentity) === hash(this.executionIdentity) &&
          active.reviewProtocol === this.reviewProtocol;
        if (!same) fail('ACTIVE_RUN_EXISTS', '当前范围已有不同目标的运行，请取消或等待结束。', 409);
        this.store.transaction(() =>
          this.workspaceStore.saveRequest(input.requestId, 'agent-run', input, { runId: active.id }),
        );
        return active;
      }
    }
    const refs: Ref[] = [];
    const addRefs = (view: View, baseline = false) => {
      let section = '';
      const version = baseline ? view.baseline : view.version;
      version.blocks.forEach((b, order) => {
        if (b.kind === 'heading') section = b.text;
        refs.push({
          id: `R${refs.length + 1}`,
          memberId: view.member.id,
          versionId: version.id,
          blockId: b.id,
          title: view.document.title,
          section,
          role: view.member.role,
          kind: b.kind,
          text: b.text,
          order,
          baseline,
        });
      });
    };
    views.forEach((v) => addRefs(v));
    addRefs(source, true);
    const deltas = contentDiff(source.baseline.blocks, source.version.blocks)
      .filter(
        (d) =>
          !sourceBlockIds ||
          sourceBlockIds.includes(d.before?.id || '') ||
          sourceBlockIds.includes(d.after?.id || ''),
      )
      .map((d, index) => ({
        ...d,
        id: `D${index + 1}`,
        beforeRefId: d.before
          ? refs.find((r) => r.memberId === source.member.id && r.baseline && r.blockId === d.before!.id)!.id
          : null,
        afterRefId: d.after
          ? refs.find((r) => r.memberId === source.member.id && !r.baseline && r.blockId === d.after!.id)!.id
          : null,
      }));
    if (
      deltas.length &&
      views.some(
        (v) =>
          v.member.id !== source.member.id &&
          ['anchor', 'sync'].includes(v.member.role) &&
          !v.version.blocks.some((b) => b.kind !== 'heading'),
      )
    )
      fail(
        'EMPTY_CHECK_DOCUMENT',
        '范围中有仅标题、缺少正文的底本或同步文档，请补齐正文或调整范围；不能当作已排除影响。',
      );
    const history = views
      .filter((v) => v.member.role === 'history')
      .map((v) => {
        const comparison = views.find(
          (x) => x.document.id === (v.member.compareDocumentId || v.document.id) && x.member.role === 'sync',
        );
        if (!comparison) fail('HISTORY_COMPARE_SCOPE', '历史比较对象没有在本次范围内固定。');
        return {
          memberId: v.member.id,
          beforeVersionId: v.version.id,
          afterVersionId: comparison!.version.id,
          deltas: contentDiff(v.version.blocks, comparison!.version.blocks),
        };
      });
    const createdAt = new Date().toISOString();
    const run: Run = {
      sourceBlockIds,
      id: uid(),
      strategyVersion: promptVersion,
      executionIdentity: structuredClone(this.executionIdentity),
      rounds: [],
      reviewProtocol: this.reviewProtocol,
      ...(['lean-source-clauses-v1', 'lean-source-clauses-v2'].includes(this.strategy.identity?.projection || '')
        ? { sourceObligationProtocol: 'clauses-v1' as const } : {}),
      ...(this.strategy.identity?.projection === 'lean-source-clauses-v2'
        ? { documentCoverageProtocol: 'scoped-v1' as const } : {}),
      requestId: input.requestId,
      inputHash: hash(input),
      status: deltas.length ? 'queued' : 'no_changes',
      createdAt,
      updatedAt: createdAt,
      manifest: {
        sourceMemberId: source.member.id,
        source,
        views,
        policyRevision: source.scope.revision,
        policyHash: hash(
          views.map((v) => ({
            memberId: v.member.id,
            role: v.member.role,
            pin: v.member.pinVersionId,
            format: v.document.format,
          })),
        ),
        refs,
        history,
      },
      deltas,
      changes: [],
      evidence: [],
      relations: [],
      findings: [],
      proposalIds: [],
      readRefIds: [],
      unresolved: [],
      messages: [],
      budget,
      stats: {
        modelCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedUsage: false,
        startedAt: null,
      },
      summary: deltas.length ? '' : '来源与比较基线没有文字或结构变化。',
      stopReason: deltas.length ? '' : 'no_source_delta',
    };
    run.messages = [
      { role: 'system', content: this.strategy.systemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          goal: '围绕用户刚修改的来源位置，检查所选资料受影响的表达，准备可逐条勾选确认的局部修订提案，并单列冲突与待解决项。',
          changeScope: sourceScope(run),
          sourceSelection: sourceBlockIds
            ? {
                blockIds: sourceBlockIds,
                rule: '只处理以下delta对应的来源变化，其他来源内容只用于理解上下文，不另行传播其变化。',
              }
            : '当前文档全部待比较变化',
          promptVersion,
          source: {
            memberId: source.member.id,
            title: source.document.title,
            versionId: source.version.id,
            baselineVersionId: source.baseline.id,
          },
          documents: views.map((v) => ({
            memberId: v.member.id,
            title: v.document.title,
            role: v.member.role,
            versionId: v.version.id,
            bodyCount: v.version.blocks.filter((b) => b.kind !== 'heading').length,
            editable: v.editable,
          })),
          deltas: deltas.map((d) => ({
            id: d.id,
            kind: d.kind,
            beforeRefId: d.beforeRefId,
            afterRefId: d.afterRefId,
            beforeExcerpt: d.before?.text.slice(0, 160),
            afterExcerpt: d.after?.text.slice(0, 160),
            changedRows:
              d.before?.kind === 'table' || d.after?.kind === 'table'
                ? changedTableRows(
                    d.before?.kind === 'table' ? d.before.text : undefined,
                    d.after?.kind === 'table' ? d.after.text : undefined,
                  )
                : undefined,
          })),
          history: '历史差异已独立计算，不是本次来源变化。',
          budget,
        }),
      },
    ];
    this.store.transaction(() => {
      this.store.createRun(run);
      this.workspaceStore.saveRequest(input.requestId, 'agent-run', input, { runId: run.id });
      this.store.event(run.id, 'created', '已固定来源、基线、角色和允许范围。', {
        promptVersion,
        reviewProtocol: run.reviewProtocol,
        documentCount: views.length,
        bodyCandidates: candidateRefs(run).length,
        deltas: deltas.length,
      });
    });
    return run;
  }
  assertFresh(run: Run) {
    if (this.workspaceStore.scope(run.manifest.source.scope.id).revision !== run.manifest.policyRevision)
      fail('INPUT_STALE', '资料角色或范围变化，当前运行停止。', 409);
    for (const frozen of run.manifest.views) {
      const current = this.workspace.view(frozen.member.id);
      if (
        current.version.id !== (run.approvedHeads?.[frozen.member.id]?.versionId || frozen.version.id) ||
        (run.approvedHeads?.[frozen.member.id] &&
          current.document.revision !== run.approvedHeads[frozen.member.id].revision) ||
        current.member.role !== frozen.member.role ||
        current.member.scopeId !== frozen.member.scopeId
      )
        fail('INPUT_STALE', '来源或目标版本变化，旧证据和提案不可继续使用。', 409);
    }
  }
  report(id: string): AgentReport {
    const run = this.store.run(id),
      state = coverage(run, this.store),
      proposals = this.store.proposals(id);
    const readyMembers = new Set([...new Set(proposals.map((p) => p.targetMemberId))].filter((memberId) =>
      reviewReadiness(run, proposals, [memberId], state.complete).allowed));
    const scopedChanges = new Set(run.changes.filter((c) => {
      try { assertScopedChange(run, c); return true; } catch { return false; }
    }).map((c) => c.id));
    const differences = this.store
      .differences()
      .filter(
        (d) =>
          proposals.some((p) => p.differenceId === d.id) || run.findings.some((f) => f.differenceId === d.id),
      );
    let inputValid = true;
    try {
      this.assertFresh(run);
    } catch {
      inputValid = false;
    }
    return {
      id: run.id,
      strategyVersion: run.strategyVersion,
      sourceBlockIds: run.sourceBlockIds,
      sourceEdits: run.deltas.map((d) => ({
        blockId: d.after?.id || d.before!.id,
        kind: d.kind,
        before: d.before?.text || '',
        after: d.after?.text || '',
      })),
      executionIdentity: run.executionIdentity,
      rounds: run.rounds || [],
      documentReview: documentReviewCoverage(run, proposals),
      status: run.status,
      inputValid,
      documents: run.manifest.views.map((v) => ({
        memberId: v.member.id,
        title: v.document.title,
        displayName:
          this.workspaceStore.presentations().find((p) => p.documentId === v.document.id)?.displayName ||
          v.document.title,
        role: v.member.role,
        versionId: v.version.id,
        isSource: v.member.id === run.manifest.sourceMemberId,
      })),
      source: {
        memberId: run.manifest.sourceMemberId,
        title: run.manifest.source.document.title,
        versionId: run.manifest.source.version.id,
        baselineVersionId: run.manifest.source.baseline.id,
      },
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      summary: run.summary,
      stopReason: run.stopReason,
      stopCode: run.stopCode,
      stats: run.stats,
      budget: run.budget,
      reviewBatches: this.store.reviewBatches(id),
      decisions: this.workspaceStore
        .decisions()
        .filter((v) =>
          differences.some(
            (d) =>
              v.issueKey === d.issueKey &&
              v.sourceHash === d.sourceHash &&
              v.targetHash === d.targetHash &&
              v.policyHash === d.policyHash,
          ),
        ),
      coverage: {
        expected: state.expected,
        judged: state.judged,
        complete: state.complete,
        missingDeltas: state.missingDeltas,
        unchecked: run.changes.length ? state.gaps.length : run.deltas.length ? candidateRefs(run).length : 0,
        candidateBodies: candidateRefs(run).length,
        changesDescribed: run.changes.length,
        gaps: state.gaps.slice(0, 50),
      },
      changes: run.changes,
      findings: run.findings,
      anchorGates: run.changes.map((c) => ({ changeId: c.id, ...anchorGate(run, c.id) })),
      conflicts: run.changes.flatMap((c) =>
        anchorGate(run, c.id).blocking.map((f) => {
          const r = run.manifest.refs.find((r) => r.id === f.refId)!;
          return {
            memberId: r.memberId,
            title: r.title,
            section: r.section,
            original: r.text,
            sourceAfter: c.after.map((q) => q.quote).join('\n'),
            reason: f.reason,
          };
        }),
      ),
      proposals: proposals.map((p) => ({
        id: p.id,
        differenceId: p.differenceId,
        changeId: p.changeId,
        targetMemberId: p.targetMemberId,
        title: run.manifest.views.find((v) => v.member.id === p.targetMemberId)?.document.title,
        state: p.state,
        reason: p.reason,
        patches: p.patches,
        targetVersionId: p.targetVersionId,
        applicable:
          scopedChanges.has(p.changeId) &&
          inputValid &&
          p.latestRunId === id &&
          ['pending', 'deferred'].includes(p.state) &&
          readyMembers.has(p.targetMemberId) &&
          p.targetRefIds.every((id) =>
            run.findings.some(
              (f) => f.refId === id && f.changeId === p.changeId && f.status === 'needs_update',
            ),
          ) &&
          !anchorGate(run, p.changeId).missing.length &&
          !anchorGate(run, p.changeId).blocking.length,
      })),
      history: run.manifest.history,
      unresolved: [
        ...run.findings.filter((f) => f.status === 'uncertain' || f.status === 'conflict').map((f) => {
          const request = run.unresolved.find((u) => u.changeId === f.changeId &&
            [u.refId, ...(u.relatedRefIds || [])].includes(f.refId) && u.questions?.length);
          return request ? { ...f, questions: request.questions, relatedRefIds: request.relatedRefIds,
            reason: request.reason + ' ' + request.questions!.join('；') } : f;
        }),
        ...run.unresolved.filter(
          (u) =>
            !run.findings.some(
              (f) =>
                f.changeId === u.changeId &&
                f.refId === u.refId &&
                ['uncertain', 'conflict'].includes(f.status),
            ),
        ),
      ],
      toolResultNote: '完整证据仅在详情接口提供；没有模型内部推理。',
    };
  }
  proposalEvidence(id: string): ProposalEvidence {
    const p = this.store.proposal(id),
      run = this.store.run(p.latestRunId);
    const c = run.changes.find((c) => c.id === p.changeId);
    const ids = [
      ...new Set([...p.evidenceIds, ...(c ? [...c.before, ...c.after].map((q) => q.evidenceId) : [])]),
    ];
    return {
      proposalId: id,
      runId: run.id,
      target: run.manifest.views.find((v) => v.member.id === p.targetMemberId),
      source: run.manifest.source,
      change: run.changes.find((c) => c.id === p.changeId),
      evidence: ids.map((id) => {
        const e = run.evidence.find((e) => e.id === id)!;
        return { ...e, ref: run.manifest.refs.find((r) => r.id === e.refId) };
      }),
      patches: p.patches,
      reason: p.reason,
    };
  }
  apply(id: string, input: { proposalIds: string[]; requestId: string }) {
    return new AgentReview(this).apply(id, input);
  }
  undoBatch(id: string, requestId: string) {
    return new AgentReview(this).undo(id, requestId);
  }
  decision(
    id: string,
    input: {
      action: 'retain' | 'defer';
      reason: string;
      sourceHash?: string;
      targetHash?: string;
      policyHash?: string;
    },
  ) {
    const d = this.store.differences().find((d) => d.id === id);
    if (!d) fail('NOT_FOUND', '差异不存在。', 404);
    const p = this.store.proposals().find((p) => p.differenceId === id);
    if (!p) fail('PROPOSAL_REQUIRED', '只有已调查的修订差异可记录审阅决定。');
    if (!['pending', 'deferred', 'retained'].includes(p!.state))
      fail('PROPOSAL_NOT_APPLICABLE', '已应用或需要重新核对的提案不能记录为保留；请检查当前版本。', 409);
    this.assertFresh(this.store.run(p!.latestRunId));
    for (const k of ['sourceHash', 'targetHash', 'policyHash'] as const)
      if (input[k] && input[k] !== d![k]) fail('INPUT_STALE', '差异指纹已变化。', 409);
    return this.store.transaction(() => {
      const decision = this.workspace.recordDecision({ ...d!, action: input.action, reason: input.reason });
      d!.status = input.action === 'retain' ? 'retained' : 'deferred';
      this.store.saveDifference(d!);
      for (const proposal of this.store
        .proposals()
        .filter((p) => p.differenceId === id && p.state !== 'applied')) {
        proposal.state = d!.status as 'retained' | 'deferred';
        this.store.saveProposal(proposal);
        this.store.event(
          proposal.latestRunId,
          'decision',
          input.action === 'retain' ? '用户保留差异。' : '用户稍后处理。',
          { differenceId: id, decisionId: decision.id },
        );
      }
      return decision;
    });
  }
  revokeDecision(id: string) {
    return this.store.transaction(() => {
      const result = this.workspace.revokeDecision(id);
      for (const d of this.store.differences())
        if (
          !this.workspaceStore
            .decisions()
            .some(
              (v) =>
                !v.revokedAt &&
                v.issueKey === d.issueKey &&
                v.sourceHash === d.sourceHash &&
                v.targetHash === d.targetHash &&
                v.policyHash === d.policyHash,
            )
        ) {
          if (['retained', 'deferred'].includes(d.status)) {
            d.status = 'pending';
            this.store.saveDifference(d);
            for (const p of this.store
              .proposals()
              .filter((p) => p.differenceId === d.id && ['retained', 'deferred'].includes(p.state))) {
              p.state = 'needs_revalidation';
              this.store.saveProposal(p);
            }
          }
        }
      return result;
    });
  }
}
