import {
  candidateRefs,
  ref,
  evidence,
  change,
  checkedEvidence,
  anchorGate,
  coverage,
  quoteContext,
  registeredEvidence,
} from './investigation.ts';
export { candidateRefs, anchorGate, coverage } from './investigation.ts';
import { AppError, applyPatches, fail, hash, matchesDecision, uid } from '../domain/rules.ts';
import type { WorkspaceStore } from '../application/ports.ts';
import type { Patch } from '../domain/types.ts';
import type { AgentStore, Run, Ref, Evidence, Change, Finding, Proposal, Relation } from './types.ts';
import { validateTool } from './schemas.ts';
import { tableStructure, changedTableRows } from '../domain/markdown-structure.ts';
import { canonicalDifference } from './difference-identity.ts';
import { reviewDocument } from './document-review.ts';
import { documentReviewCoverage } from './draft-projection.ts';
import { resolvePatchRequest } from './patch-request.ts';
import { assertSourceChangeWitness, assertScopedChange } from './source-scope.ts';
import { sourceObligations } from './source-obligations.ts';

function nextId(run: Run, prefix: string) {
  run.entitySequence ??= {};
  if (run.entitySequence[prefix] === undefined) {
    const values =
      prefix === 'E'
        ? run.evidence
        : prefix === 'C'
          ? run.changes
          : prefix === 'L'
            ? run.relations
            : run.findings;
    run.entitySequence[prefix] = Math.max(0, ...values.map((v) => Number(v.id.slice(1)) || 0));
  }
  return prefix + ++run.entitySequence[prefix];
}
export class AgentTools {
  private store: AgentStore;
  private workspace: WorkspaceStore;
  constructor(store: AgentStore, workspace: WorkspaceStore) {
    this.store = store;
    this.workspace = workspace;
  }
  execute(run: Run, name: string, args: any): unknown {
    validateTool(name, args, { scopedQuoteBinding: run.documentCoverageProtocol === 'scoped-v1' });
    // Human-confirmed targets retain their frozen audit; later model actions
    // cannot reinterpret them or change the shared source/anchor judgments.
    const locked = Object.keys(run.approvedHeads || {});
    if (run.status === 'running' && locked.length) {
      const refs = name === 'record_finding' ? args.findings.map((f: any) => f.refId)
        : ['record_relation', 'propose_patch'].includes(name) ? args.targetRefIds
        : name === 'read_context' ? args.refIds : [];
      const targets = refs.map((id: string) => ref(run, id));
      if (name === 'describe_change' ||
        (name === 'review_document' && locked.includes(args.memberId)) ||
        targets.some((r: Ref) => locked.includes(r.memberId) ||
          (name === 'record_finding' && r.role === 'anchor')))
        fail('DOCUMENT_LOCKED', '用户已确认的文档及其来源/底本判断已锁定；继续检查其余目标，不要重复调查。', 409,
          { lockedMemberIds: locked, committed: false });
    }
    switch (name) {
      case 'list_fragments':
        return this.list(run, args);
      case 'search_fragments':
        return this.list(run, args, true);
      case 'read_context':
        return this.read(run, args);
      case 'describe_change':
        return this.describe(run, args);
      case 'record_relation':
        return this.relation(run, args);
      case 'record_finding':
        return this.findings(run, args);
      case 'propose_patch':
        return this.propose(run, args);
      case 'finish_task':
        return this.finish(run, args);
      case 'review_document':
        return reviewDocument(run, args, this.store);
      default:
        fail('UNKNOWN_TOOL', '工具不存在。');
    }
  }
  private list(run: Run, args: any, search = false) {
    if (args.memberId && !run.manifest.views.some((v) => v.member.id === args.memberId))
      fail('OUT_OF_SCOPE', '文档不在允许范围内。');
    let items = run.manifest.refs.filter(
      (r) =>
        !r.baseline &&
        !(run.status === 'running' && run.approvedHeads?.[r.memberId]) &&
        (!args.memberId || r.memberId === args.memberId) &&
        (!args.role || r.role === args.role),
    );
    if (search) {
      const terms = args.query.trim().split(/\s+/).filter(Boolean);
      if (!terms.length) fail('INVALID_ARGUMENT', '搜索词不能为空。');
      items = items.filter((r) =>
        terms.some((term: string) =>
          (r.text + ' ' + r.section).toLocaleLowerCase().includes(term.toLocaleLowerCase()),
        ),
      );
    }
    const cursor = args.cursor || 0,
      limit = args.limit || 30,
      page = items.slice(cursor, cursor + limit);
    return {
      total: items.length,
      cursor,
      nextCursor: cursor + page.length < items.length ? cursor + page.length : null,
      items: page.map((r) => ({
        refId: r.id,
        memberId: r.memberId,
        versionId: r.versionId,
        blockId: r.blockId,
        title: r.title,
        section: r.section,
        role: r.role,
        kind: r.kind,
        isSource: r.memberId === run.manifest.sourceMemberId,
        snippet: search ? r.text.slice(0, 200) : undefined,
        characters: r.text.length,
        read: run.readRefIds.includes(r.id),
      })),
      note: '目录／搜索摘录不算完整原文证据。',
    };
  }
  private read(run: Run, args: any) {
    const depth = args.neighborDepth ?? 1;
    const wanted = args.refIds.map((id: string) => ref(run, id));
    const selected = new Map<string, Ref>();
    for (const r of wanted)
      for (const n of run.manifest.refs.filter(
        (n) =>
          n.memberId === r.memberId && n.versionId === r.versionId && Math.abs(n.order - r.order) <= depth,
      ))
        selected.set(n.id, n);
    if ([...selected.values()].reduce((size, r) => size + r.text.length, 0) > 40000)
      fail('CONTEXT_TOO_LARGE', '单次正文超过 40000 字符，请缩小批次或邻居深度。');
    const blocks = [...selected.values()].map((r) => {
      let e = run.evidence.find((e) => e.refId === r.id);
      if (!e) {
        e = { id: nextId(run, 'E'), refId: r.id, quote: r.text, hash: hash(r.text) };
        run.evidence.push(e);
      }
      if (!run.readRefIds.includes(r.id)) run.readRefIds.push(r.id);
      const view = run.manifest.views.find((v) => v.member.id === r.memberId)!;
      const original = (r.baseline ? view.baseline : view.version).blocks.find((b) => b.id === r.blockId);
      return {
        refId: r.id,
        evidenceId: e.id,
        memberId: r.memberId,
        versionId: r.versionId,
        blockId: r.blockId,
        title: r.title,
        section: r.section,
        kind: r.kind,
        role: r.role,
        baseline: r.baseline,
        text: r.text,
        structure: r.kind === 'table' ? tableStructure(r.text) : undefined,
        locator: original?.locator || null,
        truncated: false,
      };
    });
    return { blocks, readCount: run.readRefIds.length };
  }
  private describe(run: Run, args: any) {
    if (run.documentCoverageProtocol === 'scoped-v1')
      for (const [index, input] of args.changes.entries()) {
        const deltas = input.deltaIds.map((id: string) => run.deltas.find((d) => d.id === id));
        if (['add', 'remove', 'rule'].includes(input.kind) && deltas.length && deltas.every((d: any) => d &&
          (!d.before || d.before.kind === 'heading') && (!d.after || d.after.kind === 'heading')))
          fail('STRUCTURAL_CHANGE_NOT_BUSINESS', '仅新增/删除章节标题不构成独立功能或规则。若只是结构用editorial；若属于正文业务，合并相应正文delta并引用实际规则。不能将标题单独传播成能力。', 400, {
            field: `changes[${index}].kind`, deltaIds: input.deltaIds, committed: false,
          });
      }
    const results = [];
    for (const [changeIndex, input] of args.changes.entries()) {
      const deltas = input.deltaIds.map((id: string) => {
        const d = run.deltas.find((d) => d.id === id);
        if (!d) fail('UNKNOWN_DELTA', '来源变化引用不存在。');
        return d!;
      });
      if (!input.before.length && !input.after.length)
        fail('INVALID_EVIDENCE', '变化必须有至少一个真实来源原文。');
      for (const [side, quotes] of [
        ['before', input.before],
        ['after', input.after],
      ] as const)
        for (const [quoteIndex, q] of quotes.entries()) {
          const e = evidence(run, q.evidenceId),
            r = ref(run, e.refId);
          const allowedRefIds = deltas
            .map((d: any) => (side === 'before' ? d.beforeRefId : d.afterRefId))
            .filter(Boolean);
          const details = {
            field: `changes[${changeIndex}].${side}[${quoteIndex}]`,
            evidenceId: e.id,
            actualRefId: r.id,
            actualBaseline: r.baseline,
            allowedRefIds,
            knownChangeIds: run.changes.map((c) => c.id),
            committed: false,
          };
          if (
            r.memberId !== run.manifest.sourceMemberId ||
            r.baseline !== (side === 'before') ||
            !allowedRefIds.includes(r.id)
          )
            fail(
              'INVALID_EVIDENCE',
              `${e.id} 不属于所选 delta 的 ${side} 原文。before 仅用变化的基线证据，after 仅用当前证据；新增可将 before 留空。失败调用没有创建变化编号。`,
              400,
              details,
            );
          if (!q.quote || !e.quote.includes(q.quote))
            fail(
              'INVALID_EVIDENCE',
              `${e.id} 的 quote 未精确匹配，请从工具真实原文取连续子串，保留标点与空格。`,
              400,
              { ...details, originalText: e.quote },
            );
          if (r.kind === 'table') {
            const delta = deltas.find(
              (d: any) => (side === 'before' ? d.beforeRefId : d.afterRefId) === r.id,
            )!;
            const rows = changedTableRows(
              delta.before?.kind === 'table' ? delta.before.text : undefined,
              delta.after?.kind === 'table' ? delta.after.text : undefined,
            );
            if (
              (rows.before.length || rows.after.length) &&
              !rows[side].some((line) => line.includes(q.quote))
            )
              fail(
                'SOURCE_QUOTE_TOO_BROAD',
                '表格变化请逐条引用实际变化行中的连续原文；不要引用整表，把未变化能力传播出去。新增行可以不引用旧行。',
                400,
                { ...details, changedRows: rows, committed: false },
              );
          }
        }
      for (const d of deltas)
        if (
          ![...input.before, ...input.after].some((q) =>
            [d.beforeRefId, d.afterRefId].includes(evidence(run, q.evidenceId).refId),
          )
        )
          fail('DELTA_UNEXPLAINED', `${d.id} 没有真实对应原文。`);
      if ((input.kind === 'add' && !input.after.length) || (input.kind === 'remove' && !input.before.length))
        fail('INVALID_EVIDENCE', '新增／删除必须提供对应一侧的原文。');
      assertSourceChangeWitness(run, deltas, input);
      if (run.documentCoverageProtocol === 'scoped-v1' && input.kind === 'terminology' &&
        !input.after.some((q: any) => /更名为|改称为|改名为|统一命名|命名约定|统一(?:使用|称为)|(?:入口|按钮|界面|功能)(?:的)?名称.{0,12}(?:改为|调整为|称为)|renamed?\s+to|is\s+now\s+called/iu.test(q.quote)))
        fail('NAMING_REQUIREMENT_NOT_WITNESSED', '术语统一必须有真实来源的命名约定/更名要求，不能把模型摘要里的“统一”当依据。核对对象、职责、权限及数值边界；同一事实的自然代称用editorial，事实变化用rule，意图缺证用unknown。', 400, {
          field: `changes[${changeIndex}].kind`, actualAfterQuotes: input.after, committed: false,
        });
      const signature = hash({
        deltaIds: [...input.deltaIds].sort(),
        kind: input.kind,
        before: input.before.map((q: any) => q.quote),
        after: input.after.map((q: any) => q.quote),
      });
      const existing = run.changes.find((c) => c.fingerprint === signature);
      const requested = input.changeId ? change(run, input.changeId) : null;
      if (existing && (!requested || requested.id === existing.id) && !input.supersedes?.length) {
        results.push(existing);
        continue;
      }
      const revision = requested || existing || null;
      const replaced = (input.supersedes || []).map((id: string) => change(run, id));
      if (replaced.some((old: Change) => old.deltaIds.some((id) => !input.deltaIds.includes(id))))
        fail('DELTA_UNEXPLAINED', '合并变化必须覆盖被合并变化的全部 delta，不能丢弃未处理的业务变化。');
      const { supersedes, ...description } = input;
      const c: Change = { ...description, id: revision?.id || nextId(run, 'C'), fingerprint: signature };
      if (run.sourceObligationProtocol === 'clauses-v1') c.obligations = sourceObligations(c);
      if (revision || replaced.length) {
        const retired = new Set([...(revision ? [revision.id] : []), ...replaced.map((c: Change) => c.id)]);
        if (this.store.proposals(run.id).some((p) => retired.has(p.changeId) && p.state === 'applied'))
          fail('REVIEW_LOCKED', '已有确认修改的变化不能在旧任务中合并，请基于当前版本重新调查。');
        // Advance sequences before pruning: published evidence/knowledge IDs never get reused.
        for (const [prefix, values] of [
          ['F', run.findings],
          ['L', run.relations],
        ] as const) {
          run.entitySequence ??= {};
          run.entitySequence[prefix] = Math.max(
            run.entitySequence[prefix] || 0,
            ...values.map((v) => Number(v.id.slice(1)) || 0),
          );
        }
        this.store.event(run.id, 'change_revised', '变化解释已修订，相关判断与提案须重新核对。', {
          before: [...run.changes.filter((c) => retired.has(c.id))],
          after: c,
        });
        run.changes = run.changes.filter((old) => !retired.has(old.id));
        run.changes.push(c);
        run.findings = run.findings.filter((f) => !retired.has(f.changeId));
        run.relations = run.relations.filter((r) => !r.changeIds.some((id) => retired.has(id)));
        run.unresolved = run.unresolved.filter((u) => !retired.has(u.changeId));
        for (const p of this.store
          .proposals(run.id)
          .filter((p) => retired.has(p.changeId) && p.state !== 'applied')) {
          p.state = 'withdrawn';
          this.store.saveProposal(p);
        }
        run.proposalIds = run.proposalIds.filter((id) => this.store.proposal(id).state !== 'withdrawn');
      } else run.changes.push(c);
      results.push(c);
    }
    return {
      changes: results,
      unexplainedDeltas: run.deltas
        .filter((d) => !run.changes.some((c) => c.deltaIds.includes(d.id)))
        .map((d) => d.id),
      next: '读取所有底本正文并记录每个变化的约束判断；再调查同步目标。',
    };
  }
  private relation(run: Run, args: any) {
    args = {
      ...args,
      evidenceIds: args.evidenceIds ?? registeredEvidence(run, args.changeIds, args.targetRefIds),
    };
    args.changeIds.forEach((id: string) => change(run, id));
    const refs = args.targetRefIds.map((id: string) => ref(run, id));
    if (refs.some((r: Ref) => r.baseline || r.role !== 'sync' || r.memberId === run.manifest.sourceMemberId))
      fail('ROLE_FORBIDDEN', '语义同步关系目标只能是其他同步文档。');
    checkedEvidence(run, args.evidenceIds, args.targetRefIds);
    const fingerprint = hash(args);
    // Relation IDs are generated by the executor; model labels never become permission.
    const same = run.relations.find(
      (r) =>
        hash({
          changeIds: r.changeIds,
          targetRefIds: r.targetRefIds,
          type: r.type,
          coverageMode: r.coverageMode,
          evidenceIds: r.evidenceIds,
          reason: r.reason,
        }) === fingerprint,
    );
    if (same) return same;
    const relation: Relation = { ...args, id: nextId(run, 'L') };
    run.relations.push(relation);
    return relation;
  }
  private findings(run: Run, args: any) {
    const saved: Finding[] = [],
      errors: unknown[] = [];
    for (const [index, raw] of args.findings.entries()) {
      try {
        const c = change(run, raw.changeId);
        if (run.documentCoverageProtocol === 'scoped-v1' && c.kind === 'editorial')
          fail('NO_SEMANTIC_CHANGE', 'editorial仅交代来源文字/结构变化，不产生目标传播判断；继续实际业务变化，勿复制额外矩阵。');
        const input = {
          ...raw,
          evidenceIds: raw.evidenceIds ?? registeredEvidence(run, [raw.changeId], [raw.refId], true),
          relationIds: [...(raw.relationIds || [])],
        };
        const r = ref(run, input.refId);
        if (r.kind === 'blockquote') {
          const neighbors = run.manifest.refs
            .filter(
              (n) =>
                n.memberId === r.memberId &&
                n.versionId === r.versionId &&
                n.section === r.section &&
                n.kind !== 'heading' &&
                n.id !== r.id,
            )
            .sort((a, b) => Math.abs(a.order - r.order) - Math.abs(b.order - r.order));
          const context = neighbors[0];
          if (context && !input.evidenceIds.some((id: string) => evidence(run, id).refId === context.id))
            fail(
              'QUOTE_CONTEXT_REQUIRED',
              '引用摘录需要同时绑定邻近的出处／用途正文，不能只凭引用句套用规则。请读取并引用上下文后重新判断。',
              400,
              {
                contextRefId: context.id,
                contextEvidenceId: run.evidence.find((e) => e.refId === context.id)?.id,
                committed: false,
              },
            );
        }
        if (!candidateRefs(run).some((v) => v.id === r.id))
          fail('ROLE_FORBIDDEN', '标题、来源自身或历史不是同步／约束判断的候选正文。');
        checkedEvidence(run, input.evidenceIds, [r.id]);
        const sourceRefs = [...c.before, ...c.after].map((q) => evidence(run, q.evidenceId).refId);
        if (!input.evidenceIds.some((id: string) => sourceRefs.includes(evidence(run, id).refId)))
          fail('INVALID_EVIDENCE', '判断需同时引用来源变化证据。');
        const legal =
          r.role === 'anchor'
            ? ['not_conflicting', 'conflict', 'uncertain']
            : ['needs_update', 'already_current', 'compatible', 'unrelated', 'uncertain'];
        if (!legal.includes(input.status)) fail('ROLE_FORBIDDEN', '此角色不允许该判断。');
        for (const id of input.relationIds)
          if (
            !run.relations.some(
              (v) => v.id === id && v.changeIds.includes(c.id) && v.targetRefIds.includes(r.id),
            )
          )
            fail('INVALID_RELATION', '关系未绑定此变化与目标。');
        if (raw.relation) {
          if (input.status !== 'needs_update')
            fail('INVALID_RELATION', '内联关系只用于需要修改的判断，不代替其他状态的证据。');
          const relation = this.relation(run, {
            ...raw.relation,
            changeIds: [c.id],
            targetRefIds: [...new Set([r.id, ...(raw.relation.targetRefIds || [])])],
          });
          input.relationIds.push(relation.id);
          delete input.relation;
        }
        if (input.status === 'needs_update' && !input.relationIds.length)
          fail('RELATION_REQUIRED', '同步建议须有真实语义关系。');
        if (!input.reason.trim()) fail('INVALID_ARGUMENT', '判断必须说明依据。');
        const old = run.findings.find((f) => f.changeId === c.id && f.refId === r.id);
        const f: Finding = { ...input, id: old?.id || nextId(run, 'F') };
        if (f.status === 'needs_update') {
          const d = this.makeDifference(run, c, [r], input.reason);
          f.differenceId = d.id;
          const decision = this.workspace.decisions().find((v) => matchesDecision(v, d));
          if (decision?.action === 'retain') {
            f.status = 'known_retained';
            d.status = 'retained';
            this.store.saveDifference(d);
          }
        }
        if (old) Object.assign(old, f);
        else run.findings.push(f);
        if (old && f.status !== 'needs_update')
          for (const p of this.store
            .proposals(run.id)
            .filter(
              (p) =>
                p.changeId === c.id &&
                p.targetRefIds.includes(r.id) &&
                ['pending', 'deferred'].includes(p.state),
            )) {
            p.state = ['compatible', 'unrelated', 'already_current'].includes(f.status)
              ? 'withdrawn'
              : 'needs_revalidation';
            this.store.saveProposal(p);
          }
        saved.push(f);
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        errors.push({
          index,
          code: e.code,
          message: e.message,
          ...(e.details ? { details: e.details } : {}),
        });
      }
    }
    return {
      saved,
      errors,
      coverage: coverage(run, this.store),
      anchorGates: run.changes.map((c) => ({ changeId: c.id, ...anchorGate(run, c.id) })),
    };
  }
  private makeDifference(run: Run, c: Change, refs: Ref[], reason: string) {
    const canonical = canonicalDifference(run, c, refs);
    // Reuse existing decisions and proposal IDs without rewriting old audit fingerprints.
    // Old runs are read locally; neither their private conversation nor prior answers go to the model.
    for (const p of this.store.proposals()) {
      if (p.targetMemberId !== refs[0].memberId || p.targetRefIds.length !== refs.length) continue;
      const oldRun = this.store.run(p.latestRunId),
        oldChange = oldRun.changes.find((c) => c.id === p.changeId);
      if (!oldChange) continue;
      const oldRefs = oldRun.manifest.refs.filter((r) => p.targetRefIds.includes(r.id));
      if (canonicalDifference(oldRun, oldChange, oldRefs) === canonical) {
        const d = this.store.differences().find((d) => d.id === p.differenceId);
        if (d) return d;
      }
    }
    const identity = {
      scopeId: run.manifest.source.scope.id,
      sourceDocumentId: run.manifest.source.document.id,
      sourceBlocks: [
        ...new Set(
          c.deltaIds.flatMap((id) => {
            const d = run.deltas.find((d) => d.id === id)!;
            return [d.before?.id, d.after?.id].filter(Boolean);
          }),
        ),
      ].sort(),
      beforeQuotes: c.before.map((q) => q.quote),
      targetMemberId: refs[0].memberId,
      targetBlocks: refs.map((r) => r.blockId).sort(),
    };
    return this.store.difference({
      issueKey: hash(identity),
      sourceHash: hash({
        before: c.before.map((q) => q.quote),
        after: c.after.map((q) => q.quote),
      }),
      targetHash: hash(refs.map((r) => ({ blockId: r.blockId, text: r.text }))),
      policyHash: run.manifest.policyHash,
      targetMemberId: refs[0].memberId,
      reason,
    });
  }
  private propose(run: Run, args: any) {
    const c = change(run, args.changeId),
      refs: Ref[] = args.targetRefIds.map((id: string) => ref(run, id));
    assertScopedChange(run, c);
    if (c.kind === 'editorial' || c.kind === 'unknown')
      fail('CHANGE_NOT_ACTIONABLE', '纯润色或含义未查明的变化不能创建同步提案；请核对变化解释。');
    if (
      !refs.length ||
      refs.some(
        (r) =>
          r.role !== 'sync' ||
          r.baseline ||
          r.memberId === run.manifest.sourceMemberId ||
          r.memberId !== refs[0].memberId,
      )
    )
      fail('ROLE_FORBIDDEN', '提案只能修改同一目标同步文档。');
    const view = run.manifest.views.find((v) => v.member.id === refs[0].memberId)!;
    args = { ...args, patches: args.patches.map((p: any) => resolvePatchRequest(run, view, p)) };
    if (args.evidenceIds === undefined) {
      const boundaries = args.patches
        .filter((p: any) => p.kind === 'insert_block')
        .flatMap((p: any) =>
          run.manifest.refs
            .filter(
              (r) =>
                r.memberId === view.member.id &&
                !r.baseline &&
                r.blockId === (p.afterBlockId || view.version.blocks[0]?.id),
            )
            .map((r) => r.id),
        );
      args = { ...args, evidenceIds: registeredEvidence(run, [c.id], [...args.targetRefIds, ...boundaries]) };
    }
    if (!view.editable) fail('ANNOTATION_REQUIRED', '只读 PDF 需注释提案，当前语义内核尚未接 PDF 注释。');
    const gate = anchorGate(run, c.id);
    if (gate.missing.length)
      fail('ANCHOR_COVERAGE_INCOMPLETE', `先完成底本正文判断：${gate.missing.join(',')}`);
    if (gate.blocking.length) fail('ANCHOR_CONFLICT', '此变化存在底本冲突或约束不明，不能产生可确认补丁。');
    checkedEvidence(run, args.evidenceIds, args.targetRefIds);
    const targetFindings = refs.map((r) => run.findings.find((f) => f.changeId === c.id && f.refId === r.id));
    if (targetFindings.some((f) => f?.status === 'known_retained'))
      fail('KNOWN_DIFFERENCE', '用户已明确保留这项差异，不能再生成提案。');
    if (targetFindings.some((f) => f?.status !== 'needs_update'))
      fail('FINDING_REQUIRED', '每个修改依据块必须先登记 needs_update。');
    const patches: Patch[] = args.patches.map((p: any) =>
      p.kind === 'insert_block' ? { kind: p.kind, afterBlockId: p.afterBlockId || null, block: p.block } : p,
    );
    for (const p of args.patches) {
      const required =
        p.kind === 'replace_text'
          ? ['blockId', 'before', 'after']
          : p.kind === 'insert_block'
            ? ['afterBlockId', 'block']
            : ['blockId', 'expectedText'];
      if (required.some((key) => p[key] === undefined))
        fail('INVALID_PATCH', `${p.kind} 缺少必要字段：${required.join(', ')}。`);
    }
    const allowedIds = new Set(refs.map((r) => r.blockId));
    for (const p of patches) {
      const id = p.kind === 'insert_block' ? p.afterBlockId : p.blockId;
      if (p.kind === 'insert_block') {
        const boundary = run.manifest.refs.find(
          (r) =>
            r.memberId === view.member.id &&
            !r.baseline &&
            r.blockId === (p.afterBlockId || view.version.blocks[0]?.id),
        );
        if (!boundary) fail('ANCHOR_NOT_FOUND', '插入边界不存在。');
        checkedEvidence(run, args.evidenceIds, [boundary!.id]);
        if (
          candidateRefs(run)
            .filter((r) => r.memberId === view.member.id)
            .some((r) => !run.readRefIds.includes(r.id))
        )
          fail('MISSING_WITNESS', '新增内容需要完整读取该目标，以核对是否确实缺失。');
      } else if (id && !allowedIds.has(id))
        fail('INVALID_EVIDENCE', '改写／删除的块必须是已判定需要修改的依据点。');
    }
    const after = applyPatches(view.version.blocks, patches);
    if (hash(after) === view.version.hash) fail('NO_EFFECT', '补丁没有实际改变，不能形成待应用提案。');
    const d = this.makeDifference(run, c, refs, args.reason),
      decision = this.workspace.decisions().find((v) => matchesDecision(v, d));
    if (decision?.action === 'retain') fail('KNOWN_DIFFERENCE', '用户已保留同一内容差异。');
    const existing = this.store
      .proposals()
      .find(
        (p) => p.differenceId === d.id && ['pending', 'deferred', 'needs_revalidation'].includes(p.state),
      );
    const p: Proposal = {
      id: existing?.id || uid(),
      differenceId: d.id,
      createdRunId: existing?.createdRunId || run.id,
      latestRunId: run.id,
      changeId: c.id,
      targetMemberId: view.member.id,
      targetVersionId: view.version.id,
      targetRefIds: args.targetRefIds,
      patches,
      after,
      evidenceIds: args.evidenceIds,
      state: decision?.action === 'defer' ? 'deferred' : 'pending',
      reason: args.reason,
      createdAt: existing?.createdAt || new Date().toISOString(),
    };
    this.store.saveProposal(p);
    this.store.linkProposal(run.id, p.id);
    if (!run.proposalIds.includes(p.id)) run.proposalIds.push(p.id);
    for (const f of targetFindings) if (f) f.differenceId = d.id;
    return {
      proposalId: p.id,
      differenceId: d.id,
      state: p.state,
      reused: !!existing,
      targetTitle: view.document.title,
      patches: p.patches,
      note: '只创建提案，原文未写入。',
    };
  }
  private finish(run: Run, args: any) {
    const state = coverage(run, this.store);
    if (!state.complete)
      return {
        accepted: false,
        code: 'COVERAGE_GAP',
        missingDeltas: state.missingDeltas,
        missingSourceClauses: state.missingSourceClauses,
        missingCount: state.gaps.length,
        gaps: state.gaps.slice(0, 30),
        expected: state.expected,
        judged: state.judged,
      };
    const unresolved = args.unresolved || [];
    if (run.documentCoverageProtocol === 'scoped-v1') {
      for (const u of unresolved) {
        const main = ref(run, u.refId);
        if (u.questions?.some((question: string) => !question.trim()))
          fail('INVALID_ARGUMENT', '澄清问题不能为空。');
        for (const id of u.relatedRefIds || []) {
          const related = ref(run, id);
          if (related.memberId !== main.memberId || related.versionId !== main.versionId || related.baseline ||
            related.section !== main.section || Math.abs(related.order - main.order) > 3 || !run.readRefIds.includes(id) ||
            !run.findings.some((f) => f.changeId === u.changeId && f.refId === id && ['uncertain', 'compatible', 'unrelated'].includes(f.status)))
            fail('INVALID_ARGUMENT', '澄清上下文须是同变化、同文档同章节的已读邻近正文；删除不合格relatedRefIds后重发已有问题，不重新调查全库。', 400, {
              refId: id, primaryRefId: main.id,
              allowedRelatedRefIds: main.role === 'anchor' ? [] : run.findings.filter(candidate => {
                const context = ref(run, candidate.refId);
                return candidate.changeId === u.changeId && candidate.refId !== main.id &&
                  ['uncertain', 'compatible', 'unrelated'].includes(candidate.status) && context.role !== 'anchor' &&
                  !context.baseline && context.memberId === main.memberId && context.versionId === main.versionId &&
                  context.section === main.section && Math.abs(context.order - main.order) <= 3 && run.readRefIds.includes(context.id);
              }).map(candidate => candidate.refId),
              unresolvedActualStates: unresolved.map((item: any) => ({ changeId: item.changeId, refId: item.refId,
                status: run.findings.find(f => f.changeId === item.changeId && f.refId === item.refId)?.status,
                note: 'unresolved主项须实际conflict/uncertain或真实未完成修改，不能把unrelated写为待澄清；若有新证据先修判断。' })),
              pendingDocumentReviews: documentReviewCoverage(run, this.store.proposals(run.id)).gaps,
              committed: false });
        }
      }
      const missingQuestions = run.findings.filter((f) => f.status === 'uncertain' &&
        !unresolved.some((u: any) => u.changeId === f.changeId && [u.refId, ...(u.relatedRefIds || [])].includes(f.refId) && u.questions?.length));
      if (missingQuestions.length)
        return { accepted: false, code: 'CLARIFICATION_REQUEST_GAP',
          missing: missingQuestions.map((f) => ({ changeId: f.changeId, refId: f.refId, original: ref(run, f.refId).text, reason: f.reason })),
          instruction: '针对真实缺项提交unresolved.questions，问题须具体可回答；同一摘录可用relatedRefIds合并。确定提案保留，不重新调查全库。' };
    }
    for (const u of unresolved)
      if (!run.findings.some((f) => f.changeId === u.changeId && f.refId === u.refId) || !u.reason.trim())
        fail('INVALID_ARGUMENT', '未解决项需对应真实判断并说明定位问题。');
    for (const u of unresolved) {
      const f = run.findings.find((f) => f.changeId === u.changeId && f.refId === u.refId)!;
      if (
        !['uncertain', 'conflict'].includes(f.status) &&
        !state.outstanding.some((f) => f.changeId === u.changeId && f.refId === u.refId)
      )
        fail(
          'UNRESOLVED_NOT_SUPPORTED',
          '该项已有明确兼容／无关判断或合法提案，不能把假设的未来失败写为本轮未解决。若确实有新证据，应修订对应判断；否则删除这条未解决事项。',
          400,
          { changeId: u.changeId, refId: u.refId, status: f.status, committed: false },
        );
    }
    const missing = state.outstanding.filter(
      (f) => !unresolved.some((u: any) => u.changeId === f.changeId && u.refId === f.refId),
    );
    if (missing.length)
      return {
        accepted: false,
        code: 'PROPOSAL_GAP',
        items: missing.map((f) => ({
          changeId: f.changeId,
          refId: f.refId,
          reason: 'needs_update 尚无合法提案或具体未解决说明',
        })),
      };
    const documents = documentReviewCoverage(run, this.store.proposals(run.id));
    if (!documents.complete)
      return {
        accepted: false,
        code: 'DOCUMENT_REVIEW_GAP',
        documents: documents.gaps,
        note: '逐片段覆盖完成后还需review_document复核目标整体，不能据此宣称语义正确。',
      };
    const problems =
      run.findings.filter((f) => ['conflict', 'uncertain'].includes(f.status)).length +
      run.changes.filter((c) => c.kind === 'unknown').length +
      unresolved.length;
    const actionable = this.store.proposals(run.id).some((p) => ['pending', 'deferred'].includes(p.state));
    run.status = problems ? 'needs_input' : actionable ? 'awaiting_review' : 'no_changes';
    run.unresolved = unresolved;
    run.summary = args.summary;
    run.stopReason = problems
      ? '有冲突／依据不足或定位未解决项'
      : actionable
        ? '调查结束，等待用户审阅'
        : '调查结束，无需同步';
    return { accepted: true, status: run.status, coverageComplete: true, unresolved, summary: run.summary };
  }
}
