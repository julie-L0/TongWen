import React, { useState } from 'react';
import { Upload, FileText } from 'lucide-react';
import FloatingDialog from '../components/FloatingDialog';
import { api, requestId, type Snapshot } from '../api/client';
import type { Role } from '../../shared/contracts/workspace';
export const roleLabel: Record<Role, string> = {
  unconfigured: '待配置',
  anchor: '底本 · 只读约束',
  sync: '同步文档 · 可编辑',
  history: '备份／历史 · 只比对',
};
type Row = { name: string; text: string; role: Role; existingDocumentId: string; compareDocumentId: string };
export default function ImportDialog({
  snapshot,
  onClose,
  onImported,
}: {
  snapshot: Snapshot;
  onClose: () => void;
  onImported: (s: Snapshot, activeId: string) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]),
    [scopeName, setScopeName] = useState('我的文档项目'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const documents = Array.from(new Map(snapshot.views.map((v) => [v.document.id, v.document])).values());
  async function choose(files: FileList | null) {
    if (!files?.length) return;
    setError('');
    try {
      if (files.length > 20 || Array.from(files).reduce((n, f) => n + f.size, 0) > 5 * 1024 * 1024)
        throw new Error('请选择至多 20 个、总量不超过 5 MB 的 .md 文件。');
      const values = await Promise.all(
        Array.from(files).map(async (f) => {
          if (!/\.md$/i.test(f.name)) throw new Error(`${f.name} 不是 Markdown 文件。`);
          return {
            name: f.name,
            text: await f.text(),
            role: 'sync' as Role,
            existingDocumentId: '',
            compareDocumentId: '',
          };
        }),
      );
      setRows(values);
    } catch (e: any) {
      setError(e.message);
    }
  }
  function patch(i: number, data: Partial<Row>) {
    setRows((s) => s.map((r, index) => (index === i ? { ...r, ...data } : r)));
  }
  async function submit() {
    setBusy(true);
    setError('');
    try {
      const result = await api('/imports', {
        requestId: requestId(),
        scopeName,
        files: rows.map((r) => ({
          ...r,
          existingDocumentId: r.existingDocumentId || undefined,
          compareDocumentId: r.compareDocumentId || undefined,
        })),
      });
      onImported(result.workspace, result.imported[0]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <FloatingDialog
      title="导入 Markdown 文档"
      onClose={() => !busy && onClose()}
      wide
      footer={
        <>
          <span>原文件不被覆盖 · 本地保存工作副本</span>
          <button
            className="primary-button"
            disabled={busy || !rows.length || !scopeName.trim()}
            onClick={submit}
          >
            {busy ? '正在导入…' : `导入 ${rows.length || ''} 份文档`}
          </button>
        </>
      }
    >
      <p className="scope-explanation">
        可以批量导入普通文档，也可追加为已有文档的新版本。角色由你设置；Agent
        不读取预期答案，请只选择业务资料。
      </p>
      <label className="field-label">
        资料组
        <input
          aria-label="导入资料组"
          value={scopeName}
          onChange={(e) => setScopeName(e.target.value)}
          disabled={busy}
          list="known-scopes"
        />
        <datalist id="known-scopes">
          {snapshot.scopes.map((s) => (
            <option key={s.id} value={s.name} />
          ))}
        </datalist>
      </label>
      <label className="upload-zone">
        <Upload size={22} />
        <strong>选择 .md 文件</strong>
        <span>支持标题、平级段落和单层列表；一次最多 20 份</span>
        <input
          aria-label="选择 Markdown 文件"
          type="file"
          accept=".md,text/markdown"
          multiple
          disabled={busy}
          onChange={(e) => choose(e.target.files)}
        />
      </label>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {rows.map((r, i) => (
        <div className="import-row" key={r.name + i}>
          <div className="import-file-name">
            <FileText size={15} />
            <b>{r.name}</b>
            <span>{r.text.length} 字符</span>
          </div>
          <div className="import-options">
            <label>
              文档属性
              <select
                aria-label={`${r.name} 属性`}
                value={r.role}
                disabled={busy}
                onChange={(e) => patch(i, { role: e.target.value as Role })}
              >
                {Object.entries(roleLabel).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              逻辑文档
              <select
                aria-label={`${r.name} 版本归属`}
                value={r.existingDocumentId}
                disabled={busy}
                onChange={(e) => {
                  patch(i, { existingDocumentId: e.target.value });
                  const v = snapshot.views.find(
                    (v) => v.document.id === e.target.value && v.member.role === 'sync',
                  );
                  if (v) setScopeName(v.scope.name);
                }}
              >
                <option value="">作为新文档导入</option>
                {documents.map((d) => (
                  <option key={d.id} value={d.id}>
                    追加版本：{d.title}
                  </option>
                ))}
              </select>
            </label>
            {r.role === 'history' && (
              <label>
                历史比较对象
                <select
                  aria-label={`${r.name} 比较对象`}
                  disabled={busy}
                  value={r.compareDocumentId}
                  onChange={(e) => patch(i, { compareDocumentId: e.target.value })}
                >
                  <option value="">同一逻辑文档的当前版</option>
                  {documents.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
      ))}
      {!rows.length && (
        <p className="scope-explanation">
          文档还没准备好时，可先使用旧资料并在“文档属性”中配置角色；旧资料已完整保留。
        </p>
      )}
    </FloatingDialog>
  );
}
