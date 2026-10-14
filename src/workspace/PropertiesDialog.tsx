import React, { useEffect, useState } from 'react';
import FloatingDialog from '../components/FloatingDialog';
import { api, type Snapshot } from '../api/client';
import type { Role, Version, View } from '../../shared/contracts/workspace';
import { roleLabel } from './ImportDialog';
export default function PropertiesDialog({
  view,
  snapshot,
  onClose,
  onSaved,
}: {
  view: View;
  snapshot: Snapshot;
  onClose: () => void;
  onSaved: (s: Snapshot) => void;
}) {
  const [role, setRole] = useState(view.member.role),
    [scope, setScope] = useState(view.scope.name),
    [pin, setPin] = useState(view.member.pinVersionId || view.version.id),
    [baseline, setBaseline] = useState(view.member.baselineVersionId),
    [compare, setCompare] = useState(view.member.compareDocumentId || view.document.id),
    [versions, setVersions] = useState<Version[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    api<Version[]>(`/views/${view.member.id}/versions`)
      .then(setVersions)
      .catch((e) => setError(e.message));
  }, [view.member.id]);
  async function save() {
    setBusy(true);
    setError('');
    try {
      const result = await api<Snapshot>(
        `/views/${view.member.id}/properties`,
        {
          role,
          scopeName: scope,
          pinVersionId: pin,
          baselineVersionId: baseline,
          compareDocumentId: compare,
          expectedPolicyRevision: view.scope.revision,
        },
        'PATCH',
      );
      onSaved(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const docs = Array.from(new Map(snapshot.views.map((v) => [v.document.id, v.document])).values());
  return (
    <FloatingDialog
      title="文档属性"
      onClose={() => !busy && onClose()}
      footer={
        <>
          <span>角色与固定版本由你明确设置</span>
          <button
            className="primary-button"
            disabled={busy || !versions.length || !scope.trim()}
            onClick={save}
          >
            {busy ? '保存中…' : '保存属性'}
          </button>
        </>
      }
    >
      <p className="scope-explanation">{view.document.title}</p>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <label className="field-label">
        文档属性
        <select
          aria-label="文档角色"
          value={role}
          disabled={busy}
          onChange={(e) => setRole(e.target.value as Role)}
        >
          {Object.entries(roleLabel).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="property-description">
        {role === 'anchor'
          ? '底本固定为只读约束；未来 Agent 如发现冲突会暂停相关同步。'
          : role === 'history'
            ? '历史快照只读，可以与指定当前文档比较，不参与同步修改。'
            : role === 'sync'
              ? 'Markdown 当前工作版可编辑。PDF 原文只读，后续只能保存修订建议。'
              : '尚未配置用途，当前仅查看；不纳入完整检查。'}
      </div>
      <label className="field-label">
        资料组
        <input
          aria-label="资料组名称"
          value={scope}
          disabled={busy}
          onChange={(e) => setScope(e.target.value)}
          list="property-scopes"
        />
        <datalist id="property-scopes">
          {snapshot.scopes.map((s) => (
            <option key={s.id} value={s.name} />
          ))}
        </datalist>
      </label>
      {(role === 'anchor' || role === 'history') && (
        <label className="field-label">
          固定只读版本
          <select aria-label="固定版本" value={pin} disabled={busy} onChange={(e) => setPin(e.target.value)}>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                V{v.seq} · {v.reason}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field-label">
        修改比较基线
        <select
          aria-label="比较基线"
          value={baseline}
          disabled={busy}
          onChange={(e) => setBaseline(e.target.value)}
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              V{v.seq} · {v.reason}
            </option>
          ))}
        </select>
      </label>
      {role === 'history' && (
        <label className="field-label">
          历史比较对象
          <select
            aria-label="历史比较对象"
            value={compare}
            disabled={busy}
            onChange={(e) => setCompare(e.target.value)}
          >
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="scope-explanation">
        配置改变不会改写底本或历史内容；比较基线不会在保存或查看差异后自动推进。
      </p>
    </FloatingDialog>
  );
}
