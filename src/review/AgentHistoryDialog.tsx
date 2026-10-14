import React, { useEffect, useState } from 'react';
import FloatingDialog from '../components/FloatingDialog';
import { type Snapshot } from '../api/client';
import { agentApi } from '../api/agent';
import type { RunSummary } from '../../shared/contracts/agent';
import { displayName } from '../workspace/file-tree';
export default function AgentHistoryDialog({
  snapshot,
  onClose,
  onOpen,
}: {
  snapshot: Snapshot;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null),
    [error, setError] = useState('');
  const statusName: Record<RunSummary['status'], string> = { queued: '等待运行', running: '检查中', awaiting_review: '待确认', needs_input: '待澄清', no_changes: '无需同步', budget_exhausted: '检查未完成，查看结果', failed: '检查失败', stale: '资料已变化', cancelled: '已取消', interrupted: '已中断' };
  useEffect(() => {
    let closed = false;
    agentApi.list()
      .then((r) => {
        if (!closed) setRuns(r);
      })
      .catch((e) => {
        if (!closed) setError(e.message);
      });
    return () => {
      closed = true;
    };
  }, []);
  return (
    <FloatingDialog
      title="修订记录"
      onClose={onClose}
      footer={
        <button className="primary-button" onClick={onClose}>
          返回文档
        </button>
      }
    >
      <p>打开记录不切换正在阅读的文档；旧任务保留原证据，版本变化后需重新检查。</p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {runs === null ? (
        <p>正在读取记录…</p>
      ) : !runs.length ? (
        <p>还没有调查任务。</p>
      ) : (
        runs.map((r) => {
          const v = snapshot.views.find((v) => v.member.id === r.sourceMemberId);
          return (
            <div className="version-delta" key={r.id}>
              <b>{v ? displayName(snapshot, v) : '原来源资料'}</b>
              <p>
                {new Date(r.createdAt).toLocaleString()} · {statusName[r.status]}
              </p>
              <button className="quiet-button" onClick={() => onOpen(r.id)}>
                查看结果
              </button>
            </div>
          );
        })
      )}
    </FloatingDialog>
  );
}
