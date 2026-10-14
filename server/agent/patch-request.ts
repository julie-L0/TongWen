import { fail } from '../domain/rules.ts';
import { ref } from './investigation.ts';
import type { Run } from './types.ts';
import type { View } from '../domain/types.ts';

// Resolve model-facing reference aliases into physical IDs; no text is written.
export function resolvePatchRequest(run: Run, view: View, raw: any) {
  const resolve = (id: string) => {
    const r = ref(run, id);
    if (r.memberId !== view.member.id || r.baseline)
      fail('ROLE_FORBIDDEN', '补丁引用必须属于当前目标的冻结工作版。');
    return r.blockId;
  };
  if (raw.kind === 'insert_block') {
    const boundary = raw.afterRefId === '' ? '' : raw.afterRefId ? resolve(raw.afterRefId) : raw.afterBlockId;
    if (raw.afterRefId && raw.afterBlockId && raw.afterBlockId !== boundary)
      fail('INVALID_PATCH', '插入引用与物理边界不一致。');
    return { kind: raw.kind, afterBlockId: boundary, block: raw.block };
  }
  const blockId = raw.refId ? resolve(raw.refId) : raw.blockId;
  if (raw.refId && raw.blockId && raw.blockId !== blockId) fail('INVALID_PATCH', '引用与物理块ID不一致。');
  return raw.kind === 'replace_text'
    ? { kind: raw.kind, blockId, before: raw.before, after: raw.after }
    : { kind: raw.kind, blockId, expectedText: raw.expectedText };
}
