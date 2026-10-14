import type { WorkspaceStore } from './ports.ts';
import {
  assertEditable,
  assertRole,
  assertRequestId,
  applyPatches,
  contentDiff,
  normalizeBlocks,
  uid,
  fail,
  hash,
  matchesDecision,
} from '../domain/rules.ts';
import { parseMarkdown, alignImportedBlocks, businessVersionLabel } from '../domain/markdown.ts';
import type { View, ImportItem, Role, Block, Patch, Decision } from '../domain/types.ts';
export class Workspace {
  private store: WorkspaceStore;
  constructor(store: WorkspaceStore) {
    this.store = store;
  }
  view(memberId: string): View {
    const member = this.store.member(memberId),
      document = this.store.document(member.documentId),
      version = this.store.version(member.pinVersionId || document.headVersionId);
    return {
      member,
      document,
      version,
      baseline: this.store.version(member.baselineVersionId),
      scope: this.store.scope(member.scopeId),
      editable: member.role === 'sync' && document.format === 'md',
    };
  }
  snapshot() {
    return {
      views: this.store.members().map((m) => this.view(m.id)),
      scopes: this.store.scopes(),
      operations: this.store.operations(),
      decisions: this.store.decisions(),
      folders: this.store.folders(),
      presentations: this.store.presentations(),
      layoutRevision: Number(this.store.meta('layoutRevision') || 0),
      stage: 'foundation',
    };
  }
  versions(memberId: string) {
    const v = this.view(memberId);
    return this.store.versions(v.document.id);
  }
  importDocuments(input: { files: ImportItem[]; scopeName: string; requestId: string }) {
    if (
      !input ||
      !Array.isArray(input.files) ||
      !input.files.length ||
      input.files.length > 20 ||
      !input.requestId
    )
      fail('INVALID_IMPORT', '一次请选择 1—20 个 Markdown 文档。');
    assertRequestId(input.requestId);
    // Parse every file before any write. A failed file must not leave half a corpus behind.
    const parsed = input.files.map((f) => {
      if (!f || typeof f !== 'object') fail('INVALID_IMPORT', '文件内容无效。');
      assertRole(f.role);
      return { file: f, ...parseMarkdown(f.name, f.text) };
    });
    return this.store.transaction(() => {
      const prior = this.store.priorRequest(input.requestId, 'import', input);
      if (prior) return prior;
      const scope = this.store.ensureScope(input.scopeName);
      const imported: string[] = [];
      for (const item of parsed) {
        const f = item.file;
        let docId: string, version;
        if (f.existingDocumentId) {
          const d = this.store.document(f.existingDocumentId);
          if (d.format !== 'md') fail('FORMAT_UNSUPPORTED', '不能把 Markdown 导入为 PDF 版本。');
          if (
            (f.role === 'sync' || f.role === 'unconfigured') &&
            !this.store
              .members()
              .some((m) => m.documentId === d.id && m.scopeId === scope.id && m.role === 'sync')
          )
            fail('ROLE_FORBIDDEN', '追加工作版本前，请将对应资料设为本组同步文档。', 403);
          const old = this.store.version(d.headVersionId);
          version = this.store.insertVersion(
            d.id,
            alignImportedBlocks(old.blocks, item.blocks),
            f.role === 'history' ? '导入历史副本' : '导入新版本',
          );
          docId = d.id;
          if (f.role === 'sync' || f.role === 'unconfigured') this.store.setHead(docId, version.id);
        } else {
          docId = this.store.insertDocument(item.title, 'md');
          version = this.store.insertVersion(docId, item.blocks, '首次导入');
          this.store.setHead(docId, version.id);
        }
        this.store.labelVersion(version.id, f.name, businessVersionLabel(f.name));
        if (f.role === 'sync') {
          const layout = this.store.presentations().find((p) => p.documentId === docId)!;
          this.store.savePresentation({ ...layout, fileName: f.name });
          const existing = this.store
            .members()
            .find((m) => m.documentId === docId && m.scopeId === scope.id && m.role === 'sync');
          if (existing) {
            imported.push(existing.id);
            continue;
          }
        }
        if (f.compareDocumentId) this.store.document(f.compareDocumentId);
        const member = this.store.insertMember({
          scopeId: scope.id,
          documentId: docId,
          role: f.role,
          pinVersionId: f.role === 'anchor' || f.role === 'history' ? version.id : null,
          baselineVersionId: version.id,
          compareDocumentId: f.role === 'history' ? f.compareDocumentId || docId : null,
        });
        imported.push(member.id);
        const layout = this.store.presentations().find((p) => p.documentId === docId)!;
        if (!f.existingDocumentId) this.store.savePresentation({ ...layout, fileName: f.name });
      }
      this.store.bumpScope(scope.id);
      const result = { imported, workspace: this.snapshot() };
      this.store.saveRequest(input.requestId, 'import', input, result);
      return result;
    });
  }
  save(memberId: string, expectedRevision: number, blocks: unknown) {
    const normalized = normalizeBlocks(blocks);
    return this.store.transaction(() => {
      const v = this.view(memberId);
      assertEditable(v);
      this.assertRevision(v, expectedRevision);
      const own = new Set(this.store.versions(v.document.id).flatMap((s) => s.blocks.map((b) => b.id)));
      const others = new Set(
        this.store
          .documents()
          .filter((d) => d.id !== v.document.id)
          .flatMap((d) => this.store.versions(d.id).flatMap((s) => s.blocks.map((b) => b.id))),
      );
      if (normalized.some((b) => !own.has(b.id) && others.has(b.id)))
        fail('BLOCK_OWNERSHIP', '不能复制其他文档的段落 ID。');
      if (hash(normalized) !== v.version.hash) {
        const next = this.store.insertVersion(v.document.id, normalized, '编辑保存');
        this.store.setHead(v.document.id, next.id);
      }
      return this.view(memberId);
    });
  }
  batchProperties(input: {
    memberIds: string[];
    role?: Role;
    scopeName?: string;
    expectedPolicyRevisions: Record<string, number>;
  }) {
    if (
      !input ||
      !Array.isArray(input.memberIds) ||
      !input.memberIds.length ||
      input.memberIds.length > 100 ||
      new Set(input.memberIds).size !== input.memberIds.length
    )
      fail('INVALID_SELECTION', '请选择 1–100 个资料。');
    return this.store.transaction(() => {
      const views = input.memberIds.map((id) => this.view(id));
      for (const v of views)
        if (input.expectedPolicyRevisions?.[v.scope.id] !== v.scope.revision)
          fail('POLICY_STALE', '选中资料属性已变化，请重新配置。', 409);
      for (const v of views)
        if (input.role || input.scopeName?.trim())
          this.updateProperties(v.member.id, {
            role: input.role || v.member.role,
            scopeName: input.scopeName?.trim() || v.scope.name,
            pinVersionId:v.member.pinVersionId||undefined,
            baselineVersionId:v.member.baselineVersionId,
            compareDocumentId:v.member.compareDocumentId||undefined,
            expectedPolicyRevision: this.store.scope(v.scope.id).revision,
          });
      return this.snapshot();
    });
  }
  updateProperties(
    memberId: string,
    input: {
      role: Role;
      scopeName: string;
      pinVersionId?: string;
      baselineVersionId?: string;
      compareDocumentId?: string;
      expectedPolicyRevision: number;
    },
  ) {
    if (!input) fail('INVALID_REQUEST', '缺少资料属性。');
    assertRole(input.role);
    return this.store.transaction(() => {
      const v = this.view(memberId);
      if (v.scope.revision !== input.expectedPolicyRevision)
        fail('POLICY_STALE', '资料属性已变化，请重新打开配置。', 409);
      const scope = this.store.ensureScope(input.scopeName),
        pin = input.role === 'anchor' || input.role === 'history' ? input.pinVersionId || v.version.id : null,
        baseline = input.baselineVersionId || v.member.baselineVersionId;
      for (const id of [pin, baseline].filter(Boolean))
        if (this.store.version(id!).documentId !== v.document.id)
          fail('VERSION_OWNERSHIP', '所选版本属于其他文档。');
      if (
        input.role === 'sync' &&
        this.store
          .members()
          .some(
            (m) =>
              m.id !== memberId &&
              m.documentId === v.document.id &&
              m.scopeId === scope.id &&
              m.role === 'sync',
          )
      )
        fail('DUPLICATE_SYNC', '本组已有该文档的当前同步视图。');
      const compare = input.role === 'history' ? input.compareDocumentId || v.document.id : null;
      if (compare) this.store.document(compare);
      this.store.updateMember({
        ...v.member,
        role: input.role,
        scopeId: scope.id,
        pinVersionId: pin,
        baselineVersionId: baseline,
        compareDocumentId: compare,
      });
      this.store.bumpScope(v.scope.id);
      if (scope.id !== v.scope.id) this.store.bumpScope(scope.id);
      return this.snapshot();
    });
  }
  createHistory(memberId: string, versionId: string, expectedPolicyRevision: number) {
    return this.store.transaction(() => {
      const v = this.view(memberId);
      if (v.scope.revision !== expectedPolicyRevision) fail('POLICY_STALE', '资料属性已变化。', 409);
      const version = this.store.version(versionId);
      if (version.documentId !== v.document.id) fail('VERSION_OWNERSHIP', '历史版本属于其他文档。');
      const old = this.store
        .members()
        .find(
          (m) =>
            m.documentId === v.document.id &&
            m.scopeId === v.scope.id &&
            m.role === 'history' &&
            m.pinVersionId === versionId,
        );
      if (!old) {
        this.store.insertMember({
          scopeId: v.scope.id,
          documentId: v.document.id,
          role: 'history',
          pinVersionId: versionId,
          baselineVersionId: versionId,
          compareDocumentId: v.document.id,
        });
        this.store.bumpScope(v.scope.id);
      }
      return this.snapshot();
    });
  }
  compare(memberId: string, beforeVersionId?: string, afterVersionId?: string) {
    const v = this.view(memberId),
      before = beforeVersionId
        ? this.store.version(beforeVersionId)
        : v.member.role === 'history'
          ? v.version
          : v.baseline;
    const target =
        v.member.role === 'history'
          ? this.store.document(v.member.compareDocumentId || v.document.id)
          : v.document,
      after = this.store.version(afterVersionId || target.headVersionId);
    if (before.documentId !== v.document.id || after.documentId !== target.id)
      fail('VERSION_OWNERSHIP', '比较版本不属于指定文档。');
    return {
      before,
      after,
      sameDocument: before.documentId === after.documentId,
      deltas: contentDiff(before.blocks, after.blocks),
      kind: v.member.role === 'history' ? 'history' : 'baseline',
      semanticAnalysis: false,
    };
  }
  patch(memberId: string, input: { expectedRevision: number; patches: Patch[]; requestId: string }) {
    assertRequestId(input?.requestId);
    return this.store.transaction(() => {
      const previous = this.store.priorRequest(input.requestId, 'patch', { memberId, ...input });
      if (previous) return previous;
      const v = this.view(memberId);
      assertEditable(v);
      this.assertRevision(v, input.expectedRevision);
      const after = applyPatches(v.version.blocks, input.patches);
      const result = this.commitOperation(v, after, input.requestId, '手动受控补丁');
      this.store.saveRequest(input.requestId, 'patch', { memberId, ...input }, result);
      return result;
    });
  }
  restore(memberId: string, input: { versionId: string; expectedRevision: number; requestId: string }) {
    assertRequestId(input?.requestId);
    return this.store.transaction(() => {
      const previous = this.store.priorRequest(input.requestId, 'restore', { memberId, ...input });
      if (previous) return previous;
      const v = this.view(memberId);
      assertEditable(v);
      this.assertRevision(v, input.expectedRevision);
      const target = this.store.version(input.versionId);
      if (target.documentId !== v.document.id) fail('VERSION_OWNERSHIP', '不能恢复其他文档的版本。');
      const result = this.commitOperation(v, target.blocks, input.requestId, '恢复历史内容为新工作版');
      this.store.saveRequest(input.requestId, 'restore', { memberId, ...input }, result);
      return result;
    });
  }
  undo(operationId: string, requestId: string) {
    assertRequestId(requestId);
    return this.store.transaction(() => {
      const prior = this.store.priorRequest(requestId, 'undo', { operationId });
      if (prior) return prior;
      const operations = this.store.operations(),
        op = operations.find((o) => o.id === operationId);
      if (!op || op.undoneAt || operations.find((o) => !o.undoneAt)?.id !== operationId)
        fail('UNDO_CONFLICT', '只能撤销最近一次尚未撤销的恢复／补丁操作。', 409);
      const v = this.view(op!.memberId);
      assertEditable(v);
      if (v.document.headVersionId !== op!.afterVersionId || v.document.revision !== op!.expectedRevision)
        fail('UNDO_CONFLICT', '文档后来已被编辑，不能覆盖后续内容。', 409);
      const restored = this.store.insertVersion(
        v.document.id,
        this.store.version(op!.beforeVersionId).blocks,
        '撤销操作',
      );
      this.store.setHead(v.document.id, restored.id);
      this.store.markUndone(operationId);
      const result = this.snapshot();
      this.store.saveRequest(requestId, 'undo', { operationId }, result);
      return result;
    });
  }
  recordDecision(
    input: Pick<Decision, 'issueKey' | 'sourceHash' | 'targetHash' | 'policyHash' | 'action' | 'reason'>,
  ) {
    if (
      !input ||
      !['retain', 'defer'].includes(input.action) ||
      typeof input.reason !== 'string' ||
      input.reason.length > 1000 ||
      ['issueKey', 'sourceHash', 'targetHash', 'policyHash'].some(
        (k) => typeof (input as any)[k] !== 'string' || !(input as any)[k],
      )
    )
      fail('INVALID_DECISION', '差异决定缺少有效内容指纹或理由。');
    return this.store.transaction(() => {
      const existing = this.store
        .decisions()
        .find((d) => matchesDecision(d, input) && d.action === input.action);
      if (existing) return existing;
      const d: Decision = { ...input, id: uid(), createdAt: new Date().toISOString(), revokedAt: null };
      this.store.addDecision(d);
      return d;
    });
  }
  revokeDecision(id: string) {
    return this.store.transaction(() => {
      if (!this.store.decisions().some((d) => d.id === id)) fail('NOT_FOUND', '差异决定不存在。', 404);
      this.store.revokeDecision(id);
      return this.snapshot();
    });
  }
  private assertRevision(v: View, revision: number) {
    if (v.document.revision !== revision)
      fail('SAVE_CONFLICT', '当前版本已变化，保存未覆盖原文。请重新核对。', 409);
  }
  private commitOperation(v: View, blocks: Block[], requestId: string, reason: string) {
    const next = this.store.insertVersion(v.document.id, blocks, reason);
    this.store.setHead(v.document.id, next.id);
    const document = this.store.document(v.document.id),
      operationId = uid();
    this.store.addOperation({
      id: operationId,
      memberId: v.member.id,
      documentId: v.document.id,
      beforeVersionId: v.version.id,
      afterVersionId: next.id,
      expectedRevision: document.revision,
      requestId,
      createdAt: new Date().toISOString(),
      undoneAt: null,
    });
    const reread = this.store.version(document.headVersionId);
    if (reread.hash !== hash(blocks)) fail('VERIFY_FAILED', '保存后的回读校验失败。', 500);
    return { operationId, view: this.view(v.member.id), workspace: this.snapshot() };
  }
}
