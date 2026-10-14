import { fail, hash } from '../domain/rules.ts';
import type { Change, Run, SourceDelta, SourceQuote } from './types.ts';

type Span = { start: number; end: number };
export function sourceScopeContextRefs(run: Run) {
  return run.manifest.refs.filter(r => r.memberId === run.manifest.sourceMemberId &&
    !r.baseline && r.kind !== 'heading' && !run.deltas.some(d => d.afterRefId === r.id))
    .sort((a, b) => a.order - b.order).slice(0, 2);
}

export function unreadSourceScopeContext(run: Run) {
  return sourceScopeContextRefs(run).filter(r => !run.readRefIds.includes(r.id) ||
    !run.evidence.some(e => e.refId === r.id));
}

export function bindAnchorScope(run: Run, input: {
  status: string; scopeBasis?: 'current_source' | 'source_exception' | 'needs_definition';
  scopeWitness?: SourceQuote;
}) {
  const unread = unreadSourceScopeContext(run);
  if (unread.length) fail('SOURCE_SCOPE_NOT_READ', '底本判断前须读取当前来源的用途／范围正文，不能仅凭变化句中的名词切换范围。', 400,
    { sourceRefIds: unread.map(r => r.id), committed: false });
  const basis = input.scopeBasis || 'current_source';
  if (basis === 'needs_definition' && input.status !== 'uncertain')
    fail('SOURCE_SCOPE_UNCERTAIN', '适用范围缺证时必须登记uncertain并提出具体澄清，不能先断言相容或禁止。');
  if (basis === 'source_exception') {
    const witness = input.scopeWitness;
    const e = witness && run.evidence.find(e => e.id === witness.evidenceId);
    const r = e && run.manifest.refs.find(r => r.id === e.refId);
    if (!witness?.quote.trim() || !e || !r || r.memberId !== run.manifest.sourceMemberId || r.baseline ||
      !run.readRefIds.includes(r.id) || !e.quote.includes(witness.quote))
      fail('SOURCE_EXCEPTION_NOT_WITNESSED', '另一范围的例外必须由当前来源自己的真实正文证明适用；底本、目标、历史或关键词不能代替来源证据。', 400,
        { allowedSourceRefIds: run.manifest.refs.filter(r => r.memberId === run.manifest.sourceMemberId && !r.baseline).map(r => r.id), committed: false });
  }
  return { basis, scopeId: run.manifest.source.scope.id, scopeName: run.manifest.source.scope.name,
    sourceMemberId: run.manifest.sourceMemberId, sourceVersionId: run.manifest.source.version.id,
    sourceTitle: run.manifest.source.document.title,
    contextEvidenceIds: sourceScopeContextRefs(run).map(r => run.evidence.find(e => e.refId === r.id)!.id),
    ...(input.scopeWitness ? { witness: input.scopeWitness } : {}) };
}
// Text witnesses constrain the investigation; they do not decide business meaning.
// Offsets use JS/UTF-16, while alignment uses complete Unicode code points.
export function textChangeSpans(before: string, after: string) {
  const a = Array.from(before), b = Array.from(after);
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const x = a.slice(prefix, a.length - suffix), y = b.slice(prefix, b.length - suffix);
  const offsets = (chars: string[]) => {
    const result = [0];
    for (const c of chars) result.push(result.at(-1)! + c.length);
    return result;
  };
  const ao = offsets(a), bo = offsets(b);
  const removed: Span[] = [], inserted: Span[] = [];
  const push = (spans: Span[], positions: number[], index: number) => {
    const start = positions[prefix + index], end = positions[prefix + index + 1];
    const last = spans.at(-1);
    if (last?.end === start) last.end = end;
    else spans.push({ start, end });
  };
  // Bounded memory; exceptionally large rewrites use a conservative envelope.
  if (x.length * y.length > 262144) {
    if (x.length) removed.push({ start: ao[prefix], end: ao[a.length - suffix] });
    if (y.length) inserted.push({ start: bo[prefix], end: bo[b.length - suffix] });
    return { before: removed, after: inserted, precision: 'envelope' as const };
  }
  const width = y.length + 1, lcs = new Uint32Array((x.length + 1) * width);
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i * width + j] = x[i] === y[j] ? lcs[(i + 1) * width + j + 1] + 1 :
        Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { i++; j++; }
    else if (i < x.length && (j === y.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]))
      push(removed, ao, i++);
    else push(inserted, bo, j++);
  }
  return { before: removed, after: inserted, precision: 'aligned' as const };
}

function touches(text: string, quote: string, spans: Span[]) {
  if (!quote) return false;
  for (let offset = text.indexOf(quote); offset >= 0; offset = text.indexOf(quote, offset + 1))
    if (spans.some((s) => offset < s.end && offset + quote.length > s.start)) return true;
  return false;
}

export function assertSourceChangeWitness(run: Run, deltas: SourceDelta[], input: {
  before: SourceQuote[]; after: SourceQuote[];
}) {
  for (const delta of deltas) {
    const spans = textChangeSpans(delta.before?.text || '', delta.after?.text || '');
    // Kind/heading-level changes can legitimately have identical text.
    if (!spans.before.length && !spans.after.length) continue;
    const witnessed = (['before', 'after'] as const).some((side) =>
      input[side].some((q) =>
        run.evidence.find((e) => e.id === q.evidenceId)?.refId ===
          (side === 'before' ? delta.beforeRefId : delta.afterRefId) &&
        touches(delta[side]?.text || '', q.quote, spans[side]),
      ),
    );
    if (!witnessed)
      fail('SOURCE_CHANGE_NOT_WITNESSED', '引用仅落在该段未变化的内容，不能代表本次修改。请读取所选 delta 前后原文，引用实际增删改位置；其他内容仅作上下文。', 400,
        { deltaId: delta.id, beforeRefId: delta.beforeRefId, afterRefId: delta.afterRefId,
          changedSpans: spans, committed: false });
  }
}

export function sourceGoalFingerprint(run: Run) {
  return hash({ sourceMemberId: run.manifest.sourceMemberId,
    versionId: run.manifest.source.version.id, baselineId: run.manifest.source.baseline.id,
    sourceBlockIds: run.sourceBlockIds ? [...run.sourceBlockIds].sort() : null,
    deltas: run.deltas });
}

export function assertScopedChange(run: Run, change: Change) {
  if (run.documentCoverageProtocol === 'scoped-v1' && change.kind === 'editorial')
    fail('NO_SEMANTIC_CHANGE', '纯文字/结构变化不构成传播修订，不能创建或确认业务补丁。', 409);
  if (!change.deltaIds.length || change.deltaIds.some((id) => !run.deltas.some((d) => d.id === id)))
    fail('SOURCE_CHANGE_OUT_OF_SCOPE', '提案的来源变化不属于本次检查，请重新检查。', 409);
  assertSourceChangeWitness(run, run.deltas.filter((d) => change.deltaIds.includes(d.id)), change);
}

export function sourceScope(run: Run) {
  return {
    mode: run.sourceBlockIds ? 'selected_blocks' : 'all_changed_blocks',
    sourceMemberId: run.manifest.sourceMemberId,
    scope: { id: run.manifest.source.scope.id, name: run.manifest.source.scope.name },
    sourceTitle: run.manifest.source.document.title,
    sourceBlockIds: run.sourceBlockIds || null,
    goalFingerprint: sourceGoalFingerprint(run),
    allowedDeltaIds: run.deltas.map((d) => d.id),
    rule: '仅传播 allowedDeltaIds 的实际变化；其他来源原文只用于理解，不得另建变化。输出目标资料的局部修订提案，未解决项单列；不以调查报告代替提案。',
    targetMemberIds: run.manifest.views.filter((v) => v.member.id !== run.manifest.sourceMemberId && v.member.role === 'sync').map((v) => v.member.id),
    mandatoryAnchorIds: run.manifest.views.filter((v) => v.member.role === 'anchor').map((v) => v.member.id),
  };
}
