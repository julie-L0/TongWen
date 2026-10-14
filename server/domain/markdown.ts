import { fail, normalizeBlocks, uid } from './rules.ts';
import type { Block } from './types.ts';
import { markdownTokens } from './markdown-structure.ts';
export const businessVersionLabel = (name: string) =>
  name.match(/_([A-Z]\d+(?:\.\d+)*[A-Z]?)(?:_|\.md$)/)?.[1] || '';
export function parseMarkdown(name: string, text: string): { title: string; blocks: Block[] } {
  if (!/\.md$/i.test(name) || typeof text !== 'string')
    fail('FORMAT_UNSUPPORTED', '目前上传支持 .md；PDF 使用只读预处理资料，不支持扫描件 OCR。');
  const blocks: Block[] = [];
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let fence = '';
  for (const line of source.split('\n')) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (m) {
      if (!fence) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = '';
    }
  }
  if (fence) fail('MARKDOWN_INCOMPLETE', 'Markdown 代码块未闭合，请修正文档后上传。');
  try {
    for (const token of markdownTokens(source)) {
      const kinds: Record<string, Block['kind']> = {
        paragraph: 'paragraph',
        heading: 'heading',
        table: 'table',
        list: 'list',
        blockquote: 'blockquote',
        code: 'code_block',
      };
      const kind = kinds[token.type];
      if (!kind) throw new Error(`暂不支持 ${token.type} Markdown 结构。`);
      blocks.push({
        id: uid(),
        kind,
        text: token.type === 'heading' ? (token as any).text : token.raw.trim(),
        ...(token.type === 'heading' ? { level: (token as any).depth } : {}),
      });
    }
  } catch (e) {
    fail('MARKDOWN_STRUCTURE', e instanceof Error ? e.message : 'Markdown 解析失败。');
  }
  if (!blocks.length) fail('EMPTY_DOCUMENT', '文档为空。');
  return {
    title: blocks.find((b) => b.kind === 'heading')?.text || name.replace(/\.md$/i, ''),
    blocks: normalizeBlocks(blocks),
  };
}
export function serializeMarkdown(blocks: Block[]) {
  return (
    blocks
      .map((b) =>
        b.kind === 'heading'
          ? '#'.repeat(b.level || 2) + ' ' + b.text
          : b.kind === 'list_item'
            ? '- ' + b.text
            : b.text,
      )
      .join('\n\n') + '\n'
  );
}
// Importing a version never trusts line number as identity. Match unchanged blocks, then anchored replacements.
export function alignImportedBlocks(before: Block[], imported: Block[]) {
  const used = new Set<string>();
  const result = imported.map((b) => ({ ...b }));
  for (const b of result) {
    const matches = before.filter((a) => !used.has(a.id) && a.kind === b.kind && a.text === b.text);
    if (matches.length === 1) {
      b.id = matches[0].id;
      used.add(b.id);
    }
  }
  for (const [i, b] of result.entries()) {
    if (used.has(b.id)) continue;
    const prev = result[i - 1],
      next = result[i + 1],
      lo = prev && used.has(prev.id) ? before.findIndex((a) => a.id === prev.id) + 1 : 0,
      hi = next && used.has(next.id) ? before.findIndex((a) => a.id === next.id) : before.length;
    const candidates = before.slice(lo, hi).filter((a) => !used.has(a.id) && a.kind === b.kind);
    if (candidates.length === 1) {
      b.id = candidates[0].id;
      used.add(b.id);
    }
  }
  return result;
}
