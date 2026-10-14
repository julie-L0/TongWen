import React, { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import UniqueID from '@tiptap/extension-unique-id';
import { TableKit } from '@tiptap/extension-table';
import { Bold, Plus, List, ListOrdered, Quote, Table2, Trash2, Check } from 'lucide-react';
import type { Block } from '../../shared/contracts/workspace';
import { blocksToContent, contentToBlocks, reconcileBlocks } from './markdown-codec';
import { changedBlockIds } from './change-selection';
export default function DocumentEditor({
  blocks,
  editable,
  title,
  onChange,
  onError,
  baseline = [],
  onCheck,
  checking = false,
}: {
  blocks: Block[];
  editable: boolean;
  title: string;
  onChange: (blocks: Block[]) => void;
  onError?: (message: string) => void;
  baseline?: Block[];
  onCheck?: (blockId: string) => void;
  checking?: boolean;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  const [markers, setMarkers] = useState<{ id: string; top: number; label: string }[]>([]);
  const [inTable, setInTable] = useState(false);
  const callback = useRef(onChange),
    error = useRef(onError);
  callback.current = onChange;
  error.current = onError;
  const original = useRef(blocks);
  original.current = blocks;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, underline: false, trailingNode: false }),
      TableKit.configure({ table: { resizable: false } }),
      UniqueID.configure({
        types: ['paragraph', 'heading', 'bulletList', 'orderedList', 'table', 'blockquote', 'codeBlock'],
      }),
    ],
    content: blocksToContent(blocks),
    editable,
    onUpdate: ({ editor }) => {
      if (!editableRef.current || !editor.isEditable) return;
      try {
        callback.current(reconcileBlocks(contentToBlocks(editor.getJSON()), original.current));
      } catch (e) {
        error.current?.(e instanceof Error ? e.message : '结构转换失败');
      }
    },
    editorProps: {
      attributes: { class: 'document-editor rich-document', 'aria-label': `${title} 文本编辑器` },
    },
  });
  useEffect(() => {
    editor?.setEditable(editable, false);
  }, [editor, editable]);
  useEffect(() => {
    if (!editor) return;
    const updateTableContext = () => setInTable(editor.isActive('table'));
    editor.on('selectionUpdate', updateTableContext);
    editor.on('transaction', updateTableContext);
    updateTableContext();
    return () => {
      editor.off('selectionUpdate', updateTableContext);
      editor.off('transaction', updateTableContext);
    };
  }, [editor]);
  useEffect(() => {
    if (editor) {
      const expected = blocksToContent(blocks),
        actual = contentToBlocks(editor.getJSON());
      if (JSON.stringify(actual) !== JSON.stringify(contentToBlocks(expected)))
        editor.commands.setContent(expected, { emitUpdate: false });
    }
  }, [editor, blocks]);
  useEffect(() => {
    if (!editor || !surface.current) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          const changed = new Set(
            changedBlockIds(
              reconcileBlocks(contentToBlocks(editor.getJSON()), original.current),
              baselineRef.current,
            ),
          );
          const origin = surface.current!.getBoundingClientRect();
          const next: { id: string; top: number; label: string }[] = [];
          editor.state.doc.forEach((node, offset) => {
            if (!changed.has(node.attrs.id)) return;
            const dom = editor.view.nodeDOM(offset);
            if (dom instanceof HTMLElement)
              next.push({
                id: node.attrs.id,
                top: Math.max(0, dom.getBoundingClientRect().bottom - origin.top - 28),
                label: node.textContent.slice(0, 24) || '结构块',
              });
          });
          setMarkers((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
        } catch {
          /* Existing format error handler keeps the unsaved draft. */
        }
      });
    };
    editor.on('transaction', measure);
    const observer = new ResizeObserver(measure);
    observer.observe(surface.current);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      editor.off('transaction', measure);
    };
  }, [editor, blocks, baseline]);
  const act = (fn: () => unknown) => {
    if (editable && editor) fn();
  };
  const remove = () => {
    if (!editor) return;
    const cursor = editor.state.selection.$from;
    if (cursor.depth < 1) return;
    const from = cursor.before(1);
    editor
      .chain()
      .focus()
      .deleteRange({ from, to: from + cursor.node(1).nodeSize })
      .run();
  };
  return (
    <>
      {editable && (
        <div className="editor-structure-toolbar rich-toolbar">
          <button onClick={() => act(() => editor!.chain().focus().toggleBold().run())} title="粗体">
            <Bold size={14} />
          </button>
          <button onClick={() => act(() => editor!.chain().focus().toggleHeading({ level: 2 }).run())}>
            H2
          </button>
          <button onClick={() => act(() => editor!.chain().focus().toggleHeading({ level: 3 }).run())}>
            H3
          </button>
          <button
            onClick={() => act(() => editor!.chain().focus().toggleBulletList().run())}
            title="无序列表"
          >
            <List size={14} />
          </button>
          <button
            onClick={() => act(() => editor!.chain().focus().toggleOrderedList().run())}
            title="编号列表"
          >
            <ListOrdered size={14} />
          </button>
          <button onClick={() => act(() => editor!.chain().focus().toggleBlockquote().run())} title="引用">
            <Quote size={14} />
          </button>
          <button
            onClick={() =>
              act(() => editor!.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())
            }
          >
            <Table2 size={14} />
            表格
          </button>
          {inTable && (
            <>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => act(() => editor!.chain().focus().addRowAfter().run())}>加一行</button>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => act(() => editor!.chain().focus().deleteRow().run())}>删当前行</button>
            </>
          )}
          <button
            onClick={() =>
              act(() =>
                editor!
                  .chain()
                  .focus('end')
                  .insertContentAt(editor!.state.doc.content.size, {
                    type: 'paragraph',
                    attrs: { id: crypto.randomUUID() },
                  })
                  .run(),
              )
            }
          >
            <Plus size={13} />
            段落
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={remove}
            title="删除当前结构块；Ctrl+Z 可撤销"
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
      <div className="document-edit-surface" ref={surface}>
        <EditorContent editor={editor} />
        {editable &&
          onCheck &&
          markers.map((marker) => (
            <button
              key={marker.id}
              className="paragraph-check"
              style={{ top: marker.top }}
              disabled={checking}
              aria-label={`检查这处修改：${marker.label}`}
              title="检查这处修改：当前文档为来源，目标为左侧勾选资料"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onCheck(marker.id)}
            >
              <Check size={17} />
            </button>
          ))}
      </div>
    </>
  );
}
