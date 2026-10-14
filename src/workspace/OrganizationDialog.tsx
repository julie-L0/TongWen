import React, { useState } from 'react';
import FloatingDialog from '../components/FloatingDialog';
import { api, type Snapshot } from '../api/client';
import type { Folder, View } from '../../shared/contracts/workspace';
export default function OrganizationDialog({
  snapshot,
  target,
  onClose,
  onSaved,
}: {
  snapshot: Snapshot;
  target: { folder?: Folder; view?: View };
  onClose: () => void;
  onSaved: (s: Snapshot) => void;
}) {
  const p = snapshot.presentations.find((p) => p.documentId === target.view?.document.id);
  const [name, setName] = useState(target.folder?.name || p?.displayName || ''),
    [parent, setParent] = useState(target.folder?.parentId || p?.folderId || ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    try {
      if (target.view)
        onSaved(
          await api(
            `/documents/${target.view.document.id}/presentation`,
            { displayName: name, folderId: parent || null, expectedLayoutRevision: snapshot.layoutRevision },
            'PATCH',
          ),
        );
      else {
        const result = await api(
          target.folder ? `/folders/${target.folder.id}` : '/folders',
          { name, parentId: parent || null, expectedLayoutRevision: snapshot.layoutRevision },
          target.folder ? 'PATCH' : 'POST',
        );
        onSaved(result.workspace);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <FloatingDialog
      title={target.view ? '文档名称与位置' : target.folder ? '管理文件夹' : '新建文件夹'}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <span>整理文件不会改变同步组或权限</span>
          <button className="primary-button" disabled={busy || !name.trim()} onClick={save}>
            保存
          </button>
        </>
      }
    >
      {error && (
        <div role="alert" className="inline-error">
          {error}
        </div>
      )}
      <label className="field-label">
        {target.view ? '业务显示名' : '文件夹名称'}
        <input aria-label="显示名称" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </label>
      <label className="field-label">
        移动到
        <select aria-label="目标文件夹" value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">文档库根目录</option>
          {snapshot.folders
            .filter((f) => f.id !== target.folder?.id)
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
        </select>
      </label>
      {target.view && (
        <dl className="document-identity">
          <dt>原文件名</dt>
          <dd>{target.view.version.sourceName || p?.fileName}</dd>
          <dt>逻辑文档 ID</dt>
          <dd>{target.view.document.id}</dd>
          <dt>当前查看版本</dt>
          <dd>
            {target.view.version.label || ''} · 快照 V{target.view.version.seq} · {target.view.member.role}
          </dd>
        </dl>
      )}
    </FloatingDialog>
  );
}
