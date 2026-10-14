import { createHash, randomUUID } from 'node:crypto';
import type { Block, Delta, Patch, Role, View, Decision } from './types.ts';
import { markdownTokens, tableStructure } from './markdown-structure.ts';
export class AppError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
export const fail = (code: string, message: string, status = 400, details?: unknown): never => {
  throw new AppError(code, message, status, details);
};
export const uid = () => randomUUID();
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const roles: Role[] = ['unconfigured', 'anchor', 'sync', 'history'];
export function assertRole(value: unknown): asserts value is Role {
  if (!roles.includes(value as Role)) fail('INVALID_ROLE', '文档属性无效。');
}
export function assertRequestId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100)
    fail('INVALID_REQUEST', '操作必须携带有效的请求 ID。');
}
export function assertEditable(view: View) {
  if (view.member.role !== 'sync' || view.document.format !== 'md')
    fail('ROLE_FORBIDDEN', '仅同步属性的 Markdown 当前工作版可以修改。', 403);
}
export function normalizeBlocks(input: unknown): Block[] {
  if (!Array.isArray(input) || input.length > 1000) fail('INVALID_BLOCKS', '段落数量无效或超过 1000。');
  const ids = new Set<string>();
  let size = 0;
  return (input as any[]).map((raw) => {
    if (!raw || typeof raw.id !== 'string' || !raw.id || raw.id.length > 100 || ids.has(raw.id))
      fail('INVALID_BLOCK_ID', '每个段落必须具有唯一、稳定的 ID。');
    if (
      !['paragraph', 'heading', 'list_item', 'list', 'table', 'blockquote', 'code_block'].includes(
        raw.kind,
      ) ||
      typeof raw.text !== 'string'
    )
      fail('INVALID_BLOCK', '段落类型或内容无效。');
    size += raw.text.length;
    if (raw.text.length > 30000 || size > 500000) fail('CONTENT_TOO_LARGE', '文档内容超过本地工作台限制。');
    ids.add(raw.id);
    const block: Block = { id: raw.id, kind: raw.kind, text: raw.text };
    try {
      if (raw.kind === 'table') tableStructure(raw.text);
      if (['list', 'table', 'blockquote', 'code_block'].includes(raw.kind)) {
        const tokens = markdownTokens(raw.text),
          expected = { list: 'list', table: 'table', blockquote: 'blockquote', code_block: 'code' }[
            raw.kind as 'list' | 'table' | 'blockquote' | 'code_block'
          ];
        if (tokens.length !== 1 || tokens[0].type !== expected)
          throw new Error('结构块类型不匹配，不允许保存为另一种结构。');
      } else if (raw.text) markdownTokens(raw.text);
    } catch (e) {
      fail('MARKDOWN_STRUCTURE', e instanceof Error ? e.message : 'Markdown 结构无效。');
    }
    if (raw.kind === 'heading') block.level = Math.min(3, Math.max(1, Number(raw.level) || 2));
    return block;
  });
}
export function contentDiff(before: Block[], after: Block[]): Delta[] {
  const left = new Map(before.map((b, i) => [b.id, { b, i }]));
  const right = new Map(after.map((b, i) => [b.id, { b, i }]));
  const result: Delta[] = [];
  for (const b of before)
    if (!right.has(b.id)) result.push({ kind: 'removed', blockId: b.id, before: b, after: null });
  for (const [i, b] of after.entries()) {
    const old = left.get(b.id);
    if (!old) result.push({ kind: 'added', blockId: b.id, before: null, after: b });
    else if (old.b.text !== b.text || old.b.kind !== b.kind || old.b.level !== b.level)
      result.push({ kind: 'updated', blockId: b.id, before: old.b, after: b });
  }
  // Insertions/removals shift positions; only report moves when common blocks changed relative order.
  const oldOrder = before.filter((b) => right.has(b.id)).map((b) => b.id),
    newOrder = after.filter((b) => left.has(b.id)).map((b) => b.id);
  for (const [i, id] of newOrder.entries())
    if (oldOrder[i] !== id && !result.some((d) => d.blockId === id))
      result.push({ kind: 'moved', blockId: id, before: left.get(id)!.b, after: right.get(id)!.b });
  return result;
}
export function applyPatches(input: Block[], patches: Patch[]): Block[] {
  if (!Array.isArray(patches) || !patches.length || patches.length > 100)
    fail('INVALID_PATCH', '请选择有效的修改动作。');
  const replacements = new Map<string, { start: number; end: number; after: string }[]>(),
    removals = new Set<string>(),
    insertions = new Set<string>();
  for (const p of patches) {
    if (!p || !['replace_text', 'insert_block', 'remove_block'].includes(p.kind))
      fail('INVALID_PATCH', '不支持的修改动作。');
    if (p.kind === 'insert_block') {
      const boundary = p.afterBlockId ?? '__start__';
      if (p.afterBlockId !== null && !input.some((b) => b.id === p.afterBlockId))
        fail('ANCHOR_NOT_FOUND', '插入位置不存在。');
      if (insertions.has(boundary)) fail('OVERLAPPING_PATCH', '同一插入位置需要合并为一个提案。');
      insertions.add(boundary);
      continue;
    }
    const block = input.find((b) => b.id === p.blockId);
    if (!block) fail('ANCHOR_NOT_FOUND', '目标段落不存在。');
    if (p.kind === 'remove_block') {
      if (block!.text !== p.expectedText) fail('INPUT_STALE', '删除目标已变化。', 409);
      if (removals.has(p.blockId)) fail('OVERLAPPING_PATCH', '重复删除目标。');
      removals.add(p.blockId);
      continue;
    }
    if (typeof p.before !== 'string' || !p.before.length || typeof p.after !== 'string')
      fail('INVALID_PATCH', '文字替换必须提供原文与新文。');
    const at = block!.text.indexOf(p.before);
    if (at < 0) fail('ANCHOR_NOT_FOUND', '原文锚点不存在，请重新读取。');
    if (block!.text.indexOf(p.before, at + 1) >= 0)
      fail('ANCHOR_NOT_UNIQUE', '锚点出现多次，需要更完整的原文。');
    const list = replacements.get(p.blockId) || [];
    if (list.some((r) => at < r.end && at + p.before.length > r.start))
      fail('OVERLAPPING_PATCH', '所选文字修改相互交叠。');
    list.push({ start: at, end: at + p.before.length, after: p.after });
    replacements.set(p.blockId, list);
  }
  if ([...removals].some((id) => replacements.has(id) || insertions.has(id)))
    fail('OVERLAPPING_PATCH', '删除与修改／插入使用了同一位置。');
  let blocks = structuredClone(input);
  for (const [id, list] of replacements) {
    const b = blocks.find((b) => b.id === id)!;
    for (const r of list.sort((a, b) => b.start - a.start))
      b.text = b.text.slice(0, r.start) + r.after + b.text.slice(r.end);
  }
  blocks = blocks.filter((b) => !removals.has(b.id));
  for (const p of patches)
    if (p.kind === 'insert_block') {
      const added = normalizeBlocks([{ ...p.block, id: uid() }])[0];
      const at = p.afterBlockId === null ? 0 : blocks.findIndex((b) => b.id === p.afterBlockId) + 1;
      blocks.splice(at, 0, added);
    }
  const normalized = normalizeBlocks(blocks);
  for (const b of input.filter((b) => b.kind === 'table')) {
    const after = normalized.find((n) => n.id === b.id);
    if (after && tableStructure(after.text).columns.length !== tableStructure(b.text).columns.length)
      fail('TABLE_SHAPE_CHANGED', '局部修订不得改变表格列数；请在编辑器中明确调整结构。');
  }
  return normalized;
}
export function matchesDecision(
  d: Decision,
  context: Pick<Decision, 'issueKey' | 'sourceHash' | 'targetHash' | 'policyHash'>,
) {
  return (
    !d.revokedAt &&
    d.issueKey === context.issueKey &&
    d.sourceHash === context.sourceHash &&
    d.targetHash === context.targetHash &&
    d.policyHash === context.policyHash
  );
}
