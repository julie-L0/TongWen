import { hash } from '../domain/rules.ts';
import { changedTableRows } from '../domain/markdown-structure.ts';
import type { Run, Change, Ref } from './types.ts';

// Physical business evidence anchors identity; phrasing of a model's explanation does not.
// Tables use cited changed rows. Other blocks conservatively couple facts within the block.
export function canonicalDifference(run: Run, c: Change, refs: Ref[]) {
  const source = (['before', 'after'] as const).map((side) => {
    const units = c[side].flatMap((q) => {
      const e = run.evidence.find((e) => e.id === q.evidenceId),
        r = run.manifest.refs.find((r) => r.id === e?.refId);
      if (!r) return [];
      if (r.kind !== 'table') {
        const shared =
          run.changes.filter((other) =>
            [...other.before, ...other.after].some((q) => {
              const proof = run.evidence.find((e) => e.id === q.evidenceId);
              return run.manifest.refs.some((ref) => ref.id === proof?.refId && ref.blockId === r.blockId);
            }),
          ).length > 1;
        return [
          {
            blockId: r.blockId,
            text: shared ? q.quote : r.text,
            mode: shared ? 'quoted_shared_block' : 'single_change_block',
          },
        ];
      }
      const d = run.deltas.find((d) => (side === 'before' ? d.beforeRefId : d.afterRefId) === r.id);
      if (!d) return [];
      const rows = changedTableRows(
        d.before?.kind === 'table' ? d.before.text : undefined,
        d.after?.kind === 'table' ? d.after.text : undefined,
      )[side];
      const cited = rows.filter((row) => row.includes(q.quote));
      return (cited.length ? cited : rows).map((text) => ({ blockId: r.blockId, text, mode: 'table_row' }));
    });
    return [...new Map(units.map((u) => [JSON.stringify(u), u])).values()].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  });
  return hash({
    scopeId: run.manifest.source.scope.id,
    sourceDocumentId: run.manifest.source.document.id,
    policy: run.manifest.policyHash,
    source,
    target: refs
      .map((r) => ({ memberId: r.memberId, blockId: r.blockId, text: r.text }))
      .sort((a, b) => a.blockId.localeCompare(b.blockId)),
  });
}
