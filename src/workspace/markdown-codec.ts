import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { MarkdownManager } from '@tiptap/markdown';
import type { JSONContent } from '@tiptap/core';
import type { Block } from '../../shared/contracts/workspace.ts';
export const markdownManager = new MarkdownManager({ extensions: [StarterKit, TableKit] });
export function blocksToContent(blocks: Block[]): JSONContent {
  const content: JSONContent[] = [];
  for (const b of blocks) {
    const markdown =
      b.kind === 'heading'
        ? '#'.repeat(b.level || 2) + ' ' + b.text
        : b.kind === 'list_item'
          ? '- ' + b.text
          : b.text;
    const parsed = markdownManager.parse(markdown).content;
    const nodes = parsed?.length ? parsed : [{ type: 'paragraph' } as JSONContent];
    if (nodes.length !== 1) throw new Error('该结构不能无损载入编辑器，请检查 Markdown。');
    nodes[0].attrs = { ...nodes[0].attrs, id: b.id };
    content.push(nodes[0]);
  }
  return { type: 'doc', content };
}
export function contentToBlocks(doc: JSONContent): Block[] {
  return (doc.content || []).map((node) => {
    const kinds: Record<string, Block['kind']> = {
      paragraph: 'paragraph',
      heading: 'heading',
      bulletList: 'list',
      orderedList: 'list',
      table: 'table',
      blockquote: 'blockquote',
      codeBlock: 'code_block',
    };
    if (!kinds[node.type!]) throw new Error(`暂不支持 ${node.type} 结构，编辑未保存。`);
    const markdown = markdownManager.serialize({ type: 'doc', content: [node] }).trim();
    return {
      id: node.attrs?.id || crypto.randomUUID(),
      kind: kinds[node.type!],
      text: node.type === 'heading' ? markdown.replace(/^#{1,3}\s+/, '') : markdown,
      ...(node.type === 'heading' ? { level: node.attrs?.level || 2 } : {}),
    };
  });
}
export function reconcileBlocks(next: Block[], original: Block[]): Block[] {
  const canonical = contentToBlocks(blocksToContent(original));
  return next.map((b) => {
    const prior = canonical.find((p) => p.id === b.id),
      raw = original.find((p) => p.id === b.id);
    return prior && raw && JSON.stringify(prior) === JSON.stringify(b) ? raw : b;
  });
}
