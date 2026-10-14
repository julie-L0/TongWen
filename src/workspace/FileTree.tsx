import React, { useRef, useEffect, useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FileText,
  MoreHorizontal,
  History,
  FolderPlus,
} from 'lucide-react';
import type { Snapshot } from '../api/client';
import type { View, Folder as FolderType } from '../../shared/contracts/workspace';
import { displayName, folderDocuments, primaryViews, toggleSelection } from './file-tree';
export function SelectionCheckbox({
  ids,
  selected,
  onChange,
  label,
}: {
  ids: string[];
  selected: string[];
  onChange: (ids: string[]) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null),
    count = ids.filter((id) => selected.includes(id)).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && count < ids.length;
  }, [count, ids.length]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={ids.length > 0 && count === ids.length}
      disabled={!ids.length}
      onChange={(e) => onChange(toggleSelection(selected, ids, e.target.checked))}
    />
  );
}
export default function FileTree({
  snapshot,
  activeId,
  sourceId,
  selected,
  onSelect,
  onOpen,
  onOrganize,
  onNewFolder,
  filter,
  disabled,
}: {
  snapshot: Snapshot;
  activeId: string;
  sourceId: string;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onOpen: (id: string) => void;
  onOrganize: (target: { folder?: FolderType; view?: View }) => void;
  onNewFolder: () => void;
  filter: string;
  disabled: boolean;
}) {
  const [closed, setClosed] = useState<Set<string>>(
      new Set(snapshot.folders.filter((f) => f.name === '旧资料').map((f) => f.id)),
    ),
    [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());
  const toggle = (id: string, set: typeof setClosed) =>
    set((prior) => {
      const next = new Set(prior);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const roots = primaryViews(snapshot);
  const matches = (v: View) =>
    displayName(snapshot, v).includes(filter) ||
    v.document.title.includes(filter) ||
    snapshot.presentations.find((p) => p.documentId === v.document.id)?.fileName.includes(filter);
  const renderView = (v: View, history = false) => (
    <div
      className={`tree-file ${activeId === v.member.id ? 'active' : ''} ${history ? 'history-child' : ''}`}
      key={v.member.id}
    >
      <SelectionCheckbox
        ids={[v.member.id]}
        selected={selected}
        onChange={onSelect}
        label={`选择${history ? '历史 V' + v.version.seq : displayName(snapshot, v)}`}
      />
      <button
        className="tree-open"
        aria-current={activeId === v.member.id ? 'page' : undefined}
        disabled={disabled}
        onClick={() => onOpen(v.member.id)}
        title={`${v.document.title}\n文件：${snapshot.presentations.find((p) => p.documentId === v.document.id)?.fileName}\n逻辑文档：${v.document.id}`}
      >
        {history ? <History size={14} /> : <FileText size={15} />}
        <span>
          <b>{history ? `历史 ${v.version.label || 'V' + v.version.seq}` : displayName(snapshot, v)}</b>
          <small>
            {sourceId === v.member.id ? '来源 · ' : ''}
            {
              { sync: '同步', anchor: '底本 · 只读', history: '固定快照', unconfigured: '待配置' }[
                v.member.role
              ]
            }{' '}
            · {v.version.label || 'V' + v.version.seq}
            {history && v.version.label ? ` · 快照 ${v.version.seq}` : ''}
          </small>
        </span>
      </button>
      {!history && (
        <button
          className="tree-more"
          aria-label={`整理${displayName(snapshot, v)}`}
          onClick={() => onOrganize({ view: v })}
        >
          <MoreHorizontal size={14} />
        </button>
      )}
    </div>
  );
  const renderDocument = (v: View) => {
    const children = snapshot.views.filter(
      (h) => h.document.id === v.document.id && h.member.id !== v.member.id,
    );
    return (
      <div key={v.document.id}>
        {renderView(v)}
        {children.length > 0 && (
          <>
            <button
              className="history-toggle"
              aria-expanded={expandedHistory.has(v.document.id)}
              onClick={() => toggle(v.document.id, setExpandedHistory)}
            >
              {expandedHistory.has(v.document.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              历史与其他视图 · {children.length}
            </button>
            {expandedHistory.has(v.document.id) &&
              children.map((h) => renderView(h, h.member.role === 'history'))}
          </>
        )}
      </div>
    );
  };
  const renderFolder = (f: FolderType, depth: number, showAll = false) => {
    const all = folderDocuments(snapshot, f.id),
      children = snapshot.folders.filter((c) => c.parentId === f.id);
    if (filter && !showAll && !all.some(matches) && !f.name.includes(filter)) return null;
    const folderMatch = showAll || (!!filter && f.name.includes(filter));
    const expanded = !!filter || !closed.has(f.id);
    return (
      <div className="tree-folder" key={f.id} style={{ '--tree-depth': depth } as React.CSSProperties}>
        <div className="folder-line">
          <SelectionCheckbox
            ids={all.map((v) => v.member.id)}
            selected={selected}
            onChange={onSelect}
            label={`选择文件夹${f.name}全部资料`}
          />
          <button
            aria-label={`${expanded ? '收起' : '展开'}${f.name}`}
            aria-expanded={expanded}
            onClick={() => toggle(f.id, setClosed)}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Folder size={15} />
            <span>{f.name}</span>
            <small>{all.length}</small>
          </button>
          <button
            className="tree-more"
            aria-label={`管理文件夹${f.name}`}
            onClick={() => onOrganize({ folder: f })}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
        {expanded && (
          <div className="folder-contents">
            {children.map((c) => renderFolder(c, depth + 1, folderMatch))}
            {roots
              .filter(
                (v) =>
                  (snapshot.presentations.find((p) => p.documentId === v.document.id)?.folderId || null) ===
                    f.id &&
                  (folderMatch || matches(v)),
              )
              .map(renderDocument)}
            {!all.length && !children.length && <span className="tree-empty">空文件夹</span>}
          </div>
        )}
      </div>
    );
  };
  return (
    <>
      <div className="tree-tools">
        <span>文档库</span>
        <button aria-label="新建文件夹" onClick={onNewFolder}>
          <FolderPlus size={16} />
        </button>
      </div>
      <nav className="reference-list file-tree" aria-label="文档文件树">
        {snapshot.folders.filter((f) => !f.parentId).map((f) => renderFolder(f, 0))}
        {roots
          .filter(
            (v) =>
              !snapshot.presentations.find((p) => p.documentId === v.document.id)?.folderId && matches(v),
          )
          .map(renderDocument)}
      </nav>
    </>
  );
}
