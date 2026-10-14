import { hash } from '../domain/rules.ts';
import type { Change, Run } from './types.ts';
import type { SourceObligation, SourceQuote } from '../../shared/contracts/agent.ts';
import { changedTableRows } from '../domain/markdown-structure.ts';

// Preserve independently checkable source clauses. These are text obligations,
// not inferred business facts or golden answers. The model still decides their
// meaning, target scope and relation; review requires a real target witness.
function clauses(source: SourceQuote): SourceQuote[] {
  const spans = [...source.quote.matchAll(/[^。；;\n]+[。；;]?/gu)]
    .map((match) => ({ start: match.index!, end: match.index! + match[0].length }));
  const merged: typeof spans = [];
  for (const span of spans) {
    const text = source.quote.slice(span.start, span.end).trim();
    if (text.replace(/[\s|。；;，,]/gu, '').length < 4 && merged.length)
      merged.at(-1)!.end = span.end;
    else merged.push(span);
  }
  return merged.map(({ start, end }) => ({ evidenceId: source.evidenceId,
    quote: source.quote.slice(start, end).trim().replace(/^[|\s]+|[|\s。；;，,]+$/gu, ''),
  })).filter((q) => q.quote.length > 0);
}
export function sourceObligations(change: Change): SourceObligation[] {
  if (['editorial', 'unknown'].includes(change.kind)) return [];
  const sources = change.kind === 'remove' ? change.before : change.after.length ? change.after : change.before;
  const seen = new Set<string>();
  return sources.flatMap(clauses).filter((q) => {
    if (seen.has(q.quote)) return false;
    seen.add(q.quote); return true;
  }).map((source) => ({ id: change.id + '.Q-' + hash(source.quote).slice(0, 8), source }));
}

// Closing the cited clauses is separate from merely naming a changed block.
// Do not reveal unread originals here; quoted text appears only after real read.
export function unassignedSourceClauses(run: Run) {
  if (run.sourceObligationProtocol !== 'clauses-v1') return [];
  const missing: { deltaId: string; side: 'before' | 'after'; refId: string; evidenceId?: string; quote?: string }[] = [];
  const normalize = (text: string) => text.replace(/\s+/gu, '');
  for (const delta of run.deltas) {
    const tableRows = delta.before?.kind === 'table' || delta.after?.kind === 'table'
      ? changedTableRows(delta.before?.kind === 'table' ? delta.before.text : undefined,
        delta.after?.kind === 'table' ? delta.after.text : undefined) : undefined;
    for (const side of ['before', 'after'] as const) {
      const block = delta[side], refId = side === 'before' ? delta.beforeRefId : delta.afterRefId;
      if (!block || !refId || ['heading', 'code_block'].includes(block.kind)) continue;
      const opposite = delta[side === 'before' ? 'after' : 'before']?.text || '';
      const registered = run.evidence.find((e) => e.refId === refId && run.readRefIds.includes(refId));
      for (const quote of tableRows ? tableRows[side] : [block.text])
        for (const clause of clauses({ evidenceId: registered?.id || '', quote })) {
          if (normalize(opposite).includes(normalize(clause.quote))) continue;
          const assigned = run.changes.some((c) => c.deltaIds.includes(delta.id) && c[side].some((q) =>
            run.evidence.some((e) => e.id === q.evidenceId && e.refId === refId) && q.quote.includes(clause.quote)));
          if (!assigned) missing.push({ deltaId: delta.id, side, refId,
            ...(registered ? { evidenceId: registered.id, quote: clause.quote } : {}) });
        }
    }
  }
  return missing;
}
