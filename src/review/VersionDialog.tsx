import React, { useEffect, useState } from 'react';
import { ArrowLeft, History } from 'lucide-react';
import FloatingDialog from '../components/FloatingDialog';
import { api, requestId, type Snapshot, type Comparison } from '../api/client';
import type { Version, View } from '../../shared/contracts/workspace';
export default function VersionDialog({
  view,
  onClose,
  onChanged,
  startCompare = false,
}: {
  view: View;
  onClose: () => void;
  onChanged: (s: Snapshot, message: string) => void;
  startCompare?: boolean;
}) {
  const [versions, setVersions] = useState<Version[]>([]),
    [comparison, setComparison] = useState<Comparison | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    api<Version[]>(`/views/${view.member.id}/versions`)
      .then(setVersions)
      .catch((e) => setError(e.message));
    if (startCompare) compare();
  }, [view.member.id]);
  async function compare(id?: string) {
    setBusy(true);
    setError('');
    try {
      setComparison(await api<Comparison>(`/views/${view.member.id}/compare${id ? '?before=' + id : ''}`));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function history(v: Version) {
    setBusy(true);
    setError('');
    try {
      onChanged(
        await api<Snapshot>(`/views/${view.member.id}/history`, {
          versionId: v.id,
          expectedPolicyRevision: view.scope.revision,
        }),
        `已固定“${view.document.title}” ${v.label || ''}（快照 V${v.seq}）；入口在该文档的“历史与其他视图”下。当前工作版没有改变。`,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function restore(v: Version) {
    setBusy(true);
    setError('');
    try {
      const result = await api(`/views/${view.member.id}/restore`, {
        versionId: v.id,
        expectedRevision: view.document.revision,
        requestId: requestId(),
      });
      onChanged(
        result.workspace,
        `已将 V${v.seq} 的内容恢复为新工作版本 V${result.view.version.seq}；旧版本均保留，可撤销。`,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <FloatingDialog
      title={comparison ? '版本差异' : '不可变版本记录'}
      wide
      onClose={() => !busy && onClose()}
      footer={
        <>
          <span>此浮窗仅显示确定性文本／结构差异，不是 AI 语义调查</span>
          <button className="quiet-button" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </>
      }
    >
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {busy && <p className="scope-explanation">正在读取或保存…</p>}
      {comparison ? (
        <>
          <button className="quiet-button" onClick={() => setComparison(null)}>
            <ArrowLeft size={14} />
            返回版本记录
          </button>
          <p className="scope-explanation">
            V{comparison.before.seq} → V{comparison.after.seq} ·{' '}
            {comparison.sameDocument ? '同一逻辑文档' : '跨文档参考差异'} · {comparison.deltas.length}{' '}
            处结构或文字变化。
            {view.member.role === 'history' ? '历史原版不会被修改。' : '不构成跨文档同步建议。'}
          </p>
          {!comparison.deltas.length && <div className="empty-result">这两个版本没有文字或结构变化。</div>}
          {comparison.deltas.map((d, i) => (
            <div className="version-delta" key={d.blockId + i}>
              <span>{{ added: '新增', removed: '删除', updated: '修改', moved: '位置变化' }[d.kind]}</span>
              {d.before && <pre className="before-text">{d.before.text}</pre>}
              {d.after && <pre className="after-text">{d.after.text}</pre>}
            </div>
          ))}
        </>
      ) : (
        <>
          <p className="scope-explanation">
            历史内容不覆盖。恢复会创建新的工作版本，可以撤销；固定历史版本会收进所属文档，不改变工作版。
          </p>
          {versions.map((v) => (
            <div className="version-row" key={v.id}>
              <div>
                <b>
                  <History size={14} />
                  {v.label || ''} · 快照 V{v.seq}
                  {v.id === view.version.id ? ' · 当前查看' : ''}
                </b>
                <small>
                  {v.reason} · {new Date(v.createdAt).toLocaleString('zh-CN')}
                </small>
              </div>
              <div className="version-actions">
                <button disabled={busy} onClick={() => compare(v.id)}>
                  对比当前
                </button>
                <button disabled={busy} onClick={() => history(v)}>
                  固定为历史版本
                </button>
                {view.editable && v.id !== view.version.id && (
                  <button disabled={busy} onClick={() => restore(v)}>
                    恢复为工作版
                  </button>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </FloatingDialog>
  );
}
