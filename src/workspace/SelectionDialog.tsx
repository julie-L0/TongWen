import React, { useState } from 'react';
import FloatingDialog from '../components/FloatingDialog';
import { api, type Snapshot } from '../api/client';
import type { Role } from '../../shared/contracts/workspace';
import { displayName } from './file-tree';
import { roleLabel } from './ImportDialog';
import PropertiesDialog from './PropertiesDialog';
export default function SelectionDialog({
  snapshot,
  selected,
  sourceId,
  onClose,
  onSaved,
  onCheck,
}: {
  snapshot: Snapshot;
  selected: string[];
  sourceId: string;
  onClose: () => void;
  onSaved: (s: Snapshot) => void;
  onCheck: () => void;
}) {
  const views = snapshot.views.filter((v) => selected.includes(v.member.id) && v.member.id !== sourceId),
    source = snapshot.views.find((v) => v.member.id === sourceId && v.editable);
  const anchors = source
    ? snapshot.views.filter((v) => v.scope.id === source.scope.id && v.member.role === 'anchor')
    : [];
  const [role, setRole] = useState('keep'),
    [scope, setScope] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [detailId, setDetailId] = useState('');
  const detail = views.find((v) => v.member.id === detailId);
  const invalid =
    !source || views.some((v) => v.scope.id !== source.scope.id || v.member.role === 'unconfigured');
  async function save() {
    setBusy(true);
    setError('');
    try {
      onSaved(
        await api('/selection/properties', {
          memberIds: views.map((v) => v.member.id),
          ...(role !== 'keep' ? { role: role as Role } : {}),
          ...(scope.trim() ? { scopeName: scope.trim() } : {}),
          expectedPolicyRevisions: Object.fromEntries(views.map((v) => [v.scope.id, v.scope.revision])),
        }),
      );
      setRole('keep');
      setScope('');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <FloatingDialog
        title={`检查范围 · ${views.length} 份目标资料`}
        wide
        onClose={() => !busy && onClose()}
        footer={
          <>
            <span>关闭不会清除选择；未选资料不参与调查</span>
            <button className="quiet-button" onClick={save} disabled={busy || !views.length}>
              保存选中配置
            </button>
            <button
              className="primary-button"
              disabled={busy || invalid || role !== 'keep' || !!scope.trim()}
              onClick={onCheck}
            >
              检查选中资料
            </button>
          </>
        }
      >
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <p className="current-source">
          当前来源：{source ? displayName(snapshot, source) : '请打开可编辑文档'}
          。由正在编辑的文档自动确定，无需重新选择。
        </p>
        <div className="selected-config-list">
          {views.map((v) => (
            <div key={v.member.id}>
              <b>
                {displayName(snapshot, v)}
                {v.member.id === sourceId && <em>来源</em>}
              </b>
              <span>
                {roleLabel[v.member.role]} · {v.scope.name} · {v.version.label || '快照 V' + v.version.seq}
              </span>
              <button className="quiet-button" onClick={() => setDetailId(v.member.id)}>
                版本与属性
              </button>
            </div>
          ))}
        </div>
        <div className="batch-fields">
          <label className="field-label">
            批量角色
            <select aria-label="批量角色" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="keep">保留每份已有角色</option>
              {Object.entries(roleLabel).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            批量资料组
            <input
              aria-label="批量资料组"
              placeholder="留空保留各自的资料组"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            />
          </label>
        </div>
        <section className="required-anchors">
          <b>必须核对的底本依赖 · {anchors.length}</b>
          {anchors.map((v) => (
            <p key={v.member.id}>
              {displayName(snapshot, v)} · {v.version.label || '底本'}（固定快照 {v.version.seq}） · 只读
              {!selected.includes(v.member.id) ? ' · 自动作为约束依赖' : ''}
            </p>
          ))}
          {!source && <p>打开可编辑文档后显示其已绑定的底本。</p>}
        </section>
        {invalid && (
          <p className="scope-explanation">
            请确保目标资料已配置并与当前文档属于同一资料组；不用每次重新配置。
          </p>
        )}
        <p className="scope-explanation">
          检查使用已配置的 DeepSeek，读取本轮选中资料和必须核对的底本；只生成提案，不自动修改文档。
        </p>
      </FloatingDialog>
      {detail && (
        <PropertiesDialog
          view={detail}
          snapshot={snapshot}
          onClose={() => setDetailId('')}
          onSaved={(s) => {
            onSaved(s);
            setDetailId('');
          }}
        />
      )}
    </>
  );
}
