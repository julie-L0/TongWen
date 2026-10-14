import type { Block, View } from '../../shared/contracts/workspace.ts';
export function changedBlockIds(blocks: Block[], baseline: Block[]) {
  return blocks
    .filter((b) => {
      const old = baseline.find((p) => p.id === b.id);
      return !old || old.kind !== b.kind || old.text !== b.text || old.level !== b.level;
    })
    .map((b) => b.id);
}
export function selectedTargets(views: View[], selected: string[], sourceId: string) {
  return views.filter((v) => selected.includes(v.member.id) && v.member.id !== sourceId);
}
