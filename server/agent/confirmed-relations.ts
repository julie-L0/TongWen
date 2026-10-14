import { hash, uid } from '../domain/rules.ts';
import type { View } from '../domain/types.ts';
import type { ConfirmedRelation } from '../../shared/contracts/agent.ts';
import type { AgentService } from './service.ts';
import type { Proposal, ReviewBatch, Run } from './types.ts';

export function contextHash(v: View) {
  return hash({ title: v.document.title, role: v.member.role, scopeId: v.member.scopeId,
    blocks: v.version.blocks.filter(b => b.kind === 'heading') });
}
export function singleParagraph(v: View, id: string) {
  const bodies = v.version.blocks.filter(b => b.kind !== 'heading');
  return bodies.length === 1 && bodies[0].id === id && bodies[0].kind === 'paragraph';
}
export function numericShape(text: string) { return text.replace(/\d+(?:\.\d+)?/gu, '<number>'); }

export function invalidateRelation(s: AgentService, r: ConfirmedRelation, reason: string) {
  if (r.status !== 'valid') return;
  s.store.saveConfirmedRelation({ ...r, status: 'invalidated', invalidReason: reason, updatedAt: new Date().toISOString() });
}
export function validateRelation(s: AgentService, r: ConfirmedRelation, source: View, targets: View[]) {
  const target = targets.find(v => v.member.id === r.targetMemberId);
  if (source.scope.revision !== r.policyRevision || source.document.id !== r.sourceDocumentId ||
      source.member.role !== 'sync' || !target || target.member.role !== 'sync' || !target.editable ||
      target.document.id !== r.targetDocumentId || target.member.scopeId !== source.member.scopeId)
    return '资料身份、角色或范围已变化';
  if (!singleParagraph(source,r.sourceBlockId) || !singleParagraph(target,r.targetBlockId))
    return '关系端点已删除、拆分，或超出单段演示范围';
  if (contextHash(source) !== r.sourceContextHash || contextHash(target) !== r.targetContextHash)
    return '标题或用途上下文已变化';
  if (target.version.id !== r.targetVersionId || hash(target.version.blocks.find(b=>b.id===r.targetBlockId)!.text) !== r.targetTextHash)
    return '目标被独立修改，需重新发现关系';
  if (numericShape(source.version.blocks.find(b=>b.id===r.sourceBlockId)!.text) !== numericShape(r.sourceText))
    return '来源发生非数值内容变化，需重新发现关系';
  // Anchors require the original independent constraint investigation. This small
  // prototype optimizes only two complete single-paragraph documents, never drops anchors.
  if (targets.some(v=>v.member.role === 'anchor' || v.member.role === 'history') || targets.length !== 2)
    return '存在额外约束或资料，继续完整调查';
  return null;
}

export function rememberMergedRelations(s: AgentService, run: Run, proposals: Proposal[], batch: ReviewBatch) {
  const source = s.workspace.view(run.manifest.sourceMemberId);
  for (const p of proposals) {
    const c = run.changes.find(c=>c.id===p.changeId);
    const relation = run.relations.find(r=>r.type!=='ambiguous' && r.changeIds.includes(p.changeId) &&
      p.targetRefIds.every(id=>r.targetRefIds.includes(id)));
    const sourceBlocks = [...new Set(c?.after.map(q=>run.evidence.find(e=>e.id===q.evidenceId))
      .map(e=>run.manifest.refs.find(r=>r.id===e?.refId)?.blockId).filter(Boolean) || [])];
    const targets = p.targetRefIds.map(id=>run.manifest.refs.find(r=>r.id===id)!);
    if (!c || !relation || sourceBlocks.length!==1 || targets.length!==1 ||
      !singleParagraph(source,sourceBlocks[0]!) || relation.targetRefIds.length!==1) continue;
    const target = s.workspace.view(p.targetMemberId);
    if (!singleParagraph(target,targets[0].blockId)) continue;
    const old = s.store.confirmedRelations().find(r=>r.scopeId===source.scope.id && r.sourceMemberId===source.member.id &&
      r.sourceBlockId===sourceBlocks[0] && r.targetMemberId===target.member.id && r.targetBlockId===targets[0].blockId);
    const now = new Date().toISOString();
    const saved: ConfirmedRelation = { id:old?.id || uid(), scopeId:source.scope.id,
      policyRevision:source.scope.revision, policyHash:run.manifest.policyHash,
      sourceMemberId:source.member.id,sourceDocumentId:source.document.id,sourceBlockId:sourceBlocks[0]!,
      sourceVersionId:source.version.id,sourceText:source.version.blocks.find(b=>b.id===sourceBlocks[0])!.text,
      sourceContextHash:contextHash(source),targetMemberId:target.member.id,targetDocumentId:target.document.id,
      targetBlockId:targets[0].blockId,targetVersionId:target.version.id,
      targetTextHash:hash(target.version.blocks.find(b=>b.id===targets[0].blockId)!.text),targetContextHash:contextHash(target),
      type:relation.type,direction:'source_to_target',coverageMode:relation.coverageMode,businessObject:c.businessObject,
      reason:relation.reason,confirmedRunId:run.id,confirmedBatchId:batch.id,confirmedRequestId:batch.requestId,
      confirmedAt:now,status:'valid',updatedAt:now };
    s.store.saveConfirmedRelation(saved);
    s.store.event(run.id,'confirmed_relation_saved','用户合并后的关系和新鲜版本检查点已保存。',
      { relation:saved,previousCheckpoint:old || null, actor:'local-human-merge' });
  }
}
