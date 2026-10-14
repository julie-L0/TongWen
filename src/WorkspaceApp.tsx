import React, { useState, useEffect } from 'react';
import {
  Layers2,
  FileText,
  Search,
  ChevronRight,
  Settings2,
  Upload,
  History,
  RotateCcw,
  Check,
  AlertTriangle,
  X,
  ArrowLeft,
  ArrowRight,
  Download,
} from 'lucide-react';
import { useWorkspace } from './workspace/useWorkspace';
import DocumentEditor from './workspace/DocumentEditor';
import ImportDialog, { roleLabel } from './workspace/ImportDialog';
import VersionDialog from './review/VersionDialog';
import FloatingDialog from './components/FloatingDialog';
import PdfPreview from './PdfPreview';
import { api, requestId, type Snapshot } from './api/client';
import { agentApi } from './api/agent';
import FileTree from './workspace/FileTree';
import OrganizationDialog from './workspace/OrganizationDialog';
import SelectionDialog from './workspace/SelectionDialog';
import AgentRunDialog from './review/AgentRunDialog';
import AgentHistoryDialog from './review/AgentHistoryDialog';
import { displayName } from './workspace/file-tree';
import type { Folder, View } from '../shared/contracts/workspace';
import { selectedTargets } from './workspace/change-selection';
export default function WorkspaceApp() {
  const w = useWorkspace(),
    [filter, setFilter] = useState(''),
    [modal, setModal] = useState<
      'import' | 'versions' | 'compare' | 'settings' | 'organization' | 'selection' | 'agent' | 'runs' | null
    >(null),
    [notice, setNotice] = useState(''),
    [acting, setActing] = useState(false),
    [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]),
    [organize, setOrganize] = useState<{ folder?: Folder; view?: View }>({}),
    [runId, setRunId] = useState('');
  const [reviewMinimized, setReviewMinimized] = useState(false);
  const [pendingCheck, setPendingCheck] = useState<{ sourceMemberId: string; sourceBlockIds?: string[] } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 8000);
    return () => clearTimeout(timer);
  }, [notice]);
  function select(ids: string[]) {
    setSelected(ids);
  }
  async function check(sourceBlockIds?: string[], sourceMemberId = w.activeId) {
    setActing(true);
    w.setError('');
    try {
      await w.flush();
      if (!w.snapshot?.views.find((v) => v.member.id === sourceMemberId)?.editable) throw new Error('请在可编辑文档中修改后检查。');
      const targets = selectedTargets(w.snapshot!.views, selected, sourceMemberId);
      if (!targets.length) {
        setPendingCheck({ sourceMemberId, sourceBlockIds });
        return;
      }
      if (targets.every((v) => v.member.role === 'anchor'))
        throw new Error('请勾选需要修订或比较的目标资料；底本会自动核对，无需单独发起同步。');
      const result = await agentApi.create({
        sourceMemberId,
        memberIds: targets.map((v) => v.member.id),
        sourceBlockIds,
        requestId: requestId(),
      });
      setRunId(result.runId);
      setPendingCheck(null);
      setReviewMinimized(false);
      setModal(null);
    } catch (e: any) {
      w.setError(e.message);
    } finally {
      setActing(false);
    }
  }
  const snapshot = w.snapshot,
    view = w.active;
  const readonly = !view?.editable,
    latestOperation = snapshot?.operations.find((o) => !o.undoneAt);
  const startsWithTitle = w.blocks[0]?.kind === 'heading' && w.blocks[0]?.level === 1;
  async function open(kind: typeof modal) {
    try {
      await w.flush();
      setNotice('');
      setModal(kind);
    } catch (e: any) {
      w.setError(e.message);
    }
  }
  async function activate(id: string) {
    await w.activate(id);
    setPage(1);
    setModal(null);
  }
  function done(s: Snapshot, message: string, id?: string) {
    w.synchronize(s, id);
    setModal(null);
    setNotice(message);
  }
  async function undo() {
    if (!latestOperation) return;
    setActing(true);
    w.setError('');
    try {
      await w.flush();
      done(
        await api(`/operations/${latestOperation.id}/undo`, { requestId: requestId() }),
        '已撤销最近的恢复／受控补丁操作，原历史快照仍保留。',
      );
    } catch (e: any) {
      w.setError(e.message);
    } finally {
      setActing(false);
    }
  }
  if (!snapshot)
    return (
      <div className="boot">
        <Layers2 size={25} />
        <p>{w.error || '正在读取本地版本库…'}</p>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Layers2 size={21} />
          </span>
          <strong>同文</strong>
          <span className="brand-caption">文档工作台</span>
        </div>
        <div className="workspace-name">
          <div className="workspace-avatar">W</div>
          <div>
            <strong>本地文档工作区</strong>
            <small>资料属性 · 不可变版本</small>
          </div>
        </div>
        <div className="sidebar-heading">
          <span>文档</span>
          <span>{new Set(snapshot.views.map((v) => v.document.id)).size}</span>
        </div>
        <button className="import-button" onClick={() => open('import')}>
          <Upload size={15} />
          导入 Markdown
        </button>
        <label className="search-box">
          <Search size={14} />
          <input
            aria-label="查找文档"
            placeholder="查找文档"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <FileTree
          snapshot={snapshot}
          activeId={w.activeId}
          sourceId={view?.editable ? w.activeId : ''}
          selected={selected}
          onSelect={select}
          onOpen={activate}
          onOrganize={(target) => {
            setOrganize(target);
            open('organization');
          }}
          onNewFolder={() => {
            setOrganize({});
            open('organization');
          }}
          filter={filter}
          disabled={w.switching || acting}
        />
        <div className="selection-summary">
          <span>已选 {selected.length} 份</span>
          <button disabled={!selected.length} onClick={() => select([])}>
            清空
          </button>
          <button disabled={!selected.length} onClick={() => open('selection')}>
            范围设置
          </button>
        </div>
        <button className="sidebar-bottom" onClick={() => open('settings')}>
          <Settings2 size={16} />
          当前能力与接入
          <ChevronRight size={14} />
        </button>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            {view?.scope.name || '本地工作区'}
            <ChevronRight size={13} />
            <span>{view ? displayName(snapshot, view) : '准备导入资料'}</span>
          </div>
          <div className="top-actions">
            <span className="mode-chip demo" title="编辑后点段落旁的勾，检查跨文档影响；当前判断仍在验收中，确认前请核对来源和依据。">
              <i />
              待验收试用 · 判断结果请核对依据
            </span>
            <button className="icon-button" aria-label="当前能力设置" onClick={() => open('settings')}>
              <Settings2 size={17} />
            </button>
          </div>
        </header>
        {view && (
          <div className="document-toolbar">
            <div className="document-tab">
              <FileText size={16} />
              <span className="document-kind">
                {view.document.format.toUpperCase()} · {view.version.label || '快照 V' + view.version.seq} ·{' '}
                {readonly ? '只读' : '可编辑'}
              </span>
            </div>
            <div className="toolbar-actions">
              {!readonly && (
                <button
                  className="primary-button direct-check"
                  disabled={acting || w.switching}
                  onClick={() => check()}
                >
                  <Check size={14} />
                  {acting ? '正在保存并检查…' : '检查本次修改'}
                </button>
              )}
              <span className={`save-indicator ${w.saving === 'failed' ? 'failed' : ''}`}>
                <Check size={12} />
                {readonly
                  ? '只读文档'
                  : ({ saved: '已保存', saving: '保存中', unsaved: '编辑中', failed: '保存失败' } as any)[
                      w.saving
                    ]}
              </span>
              <button className="quiet-button" disabled={!selected.length} onClick={() => open('selection')}>
                <Settings2 size={14} />
                检查范围 · {selected.length}
              </button>
              <button className="quiet-button" onClick={() => open('versions')}>
                <History size={14} />
                版本记录
              </button>
              <button className="revision-toggle" onClick={() => open('compare')}>
                版本差异
              </button>
              <button className="quiet-button" onClick={() => open('runs')}>
                修订记录
              </button>
            </div>
          </div>
        )}
        {w.error && (
          <div className="workspace-error" role="alert">
            <AlertTriangle size={16} />
            <span>{w.error}</span>
            {w.saving === 'failed' && (
              <button
                onClick={() =>
                  w
                    .flush()
                    .then(() => w.setError(''))
                    .catch((e) => w.setError(e.message))
                }
              >
                重试保存
              </button>
            )}
            <button aria-label="关闭错误提示" onClick={() => w.setError('')}>
              <X size={14} />
            </button>
          </div>
        )}
        {pendingCheck && (
          <div className="pending-check" role="status">
            <Check size={16} />
            <div><strong>修改已保留，无需重新编辑</strong><span>
              {displayName(snapshot, snapshot.views.find((v) => v.member.id === pendingCheck.sourceMemberId)!)} ·
              {selectedTargets(snapshot.views, selected, pendingCheck.sourceMemberId).length ? '目标已选好，可以继续检查' : '在左侧勾选需要核对的目标资料'}
            </span></div>
            <button className="primary-button" disabled={acting || !selectedTargets(snapshot.views, selected, pendingCheck.sourceMemberId).length}
              onClick={() => check(pendingCheck.sourceBlockIds, pendingCheck.sourceMemberId)}>继续检查</button>
            <button className="icon-button" aria-label="收起待检查提示" onClick={() => setPendingCheck(null)}><X size={15} /></button>
          </div>
        )}
        <div className="content-scroll">
          <div className="document-and-context">
            {view ? (
              <main className={`paper ${view.document.format === 'pdf' ? 'pdf-paper' : ''}`}>
                <div className="document-eyebrow">
                  <span>{roleLabel[view.member.role]}</span>
                  <span className="version-tag">
                    {view.version.label || '工作版'} · 快照 V{view.version.seq} · 基线 V{view.baseline.seq}
                  </span>
                </div>
                {(!startsWithTitle || view.document.format === 'pdf') && <h1>{view.document.title}</h1>}
                <div className="document-meta">
                  <span>{view.scope.name}</span>
                  <span>·</span>
                  <span>
                    {readonly
                      ? view.member.role === 'unconfigured'
                        ? '请先配置资料属性'
                        : '固定快照／原文件只读'
                      : '正文可编辑 · Enter 新段落 · 自动保存'}
                  </span>
                </div>
                {view.document.format === 'pdf' ? (
                  <>
                    <div className="pdf-toolbar">
                      <button aria-label="上一页" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                        <ArrowLeft size={14} />
                      </button>
                      <span>第 {page} / 2 页</span>
                      <button aria-label="下一页" disabled={page === 2} onClick={() => setPage((p) => p + 1)}>
                        <ArrowRight size={14} />
                      </button>
                      <span>预处理只读 PDF</span>
                    </div>
                    <PdfPreview
                      url={`/api/assets/${view.document.id}`}
                      locator={{ assetId: view.document.id, page }}
                    />
                  </>
                ) : (
                  <DocumentEditor
                    key={view.member.id}
                    title={view.document.title}
                    blocks={w.blocks}
                    baseline={view.baseline.blocks}
                    onCheck={(id) => check([id])}
                    checking={acting}
                    editable={view.editable && !w.switching && !acting}
                    onChange={w.changed}
                    onError={w.formatError}
                  />
                )}
                <div className="paper-footer">
                  <span>快照原文不会被覆盖</span>
                  <span>
                    {view.document.format === 'md' && (
                      <a
                        href={`/api/views/${view.member.id}/export`}
                        download={`${displayName(snapshot, view)}.md`}
                        onClick={async (e) => {
                          e.preventDefault();
                          try {
                            await w.flush();
                            const response = await fetch(`/api/views/${view.member.id}/export`);
                            if (!response.ok) throw new Error('导出失败');
                            const url = URL.createObjectURL(await response.blob()),
                              a = document.createElement('a');
                            a.href = url;
                            a.download = displayName(snapshot, view) + '.md';
                            a.click();
                            setTimeout(() => URL.revokeObjectURL(url), 1000);
                          } catch (error: any) {
                            w.setError(error.message);
                          }
                        }}
                      >
                        <Download size={12} />
                        导出 Markdown
                      </a>
                    )}
                  </span>
                </div>
              </main>
            ) : (
              <div className="empty-library">
                <Upload size={34} />
                <h1>准备你的文档资料</h1>
                <p>导入 Markdown，设置底本、同步或历史属性。上传后可查看、编辑和比较版本。</p>
                <button className="primary-button" onClick={() => open('import')}>
                  导入 Markdown
                </button>
              </div>
            )}
          </div>
        </div>
        <footer className="statusbar">
          <span>
            <i className="small-green-dot" />
            本地版本库 · {new Set(snapshot.views.map((v) => v.document.id)).size} 份文档 ·{' '}
            {snapshot.views.filter((v) => v.member.role === 'history').length} 个历史视图
          </span>
          <button className="status-undo" disabled={!latestOperation || acting} onClick={undo}>
            <RotateCcw size={12} />
            撤销最近恢复／补丁
          </button>
        </footer>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={15} />
          <span>{notice}</span>
          <button aria-label="关闭操作提示" onClick={() => setNotice('')}>
            <X size={13} />
          </button>
        </div>
      )}
      {modal === 'import' && (
        <ImportDialog
          snapshot={snapshot}
          onClose={() => setModal(null)}
          onImported={(s, id) => done(s, '文档已导入，原文件未覆盖。', id)}
        />
      )}
      {(modal === 'versions' || modal === 'compare') && view && (
        <VersionDialog
          view={view}
          startCompare={modal === 'compare'}
          onClose={() => setModal(null)}
          onChanged={(s, message) => done(s, message)}
        />
      )}
      {modal === 'organization' && (
        <OrganizationDialog
          snapshot={snapshot}
          target={organize}
          onClose={() => setModal(null)}
          onSaved={(s) => done(s, '名称与文件夹已保存；资料组和文档保护规则未改变。')}
        />
      )}
      {modal === 'selection' && (
        <SelectionDialog
          snapshot={snapshot}
          selected={selected}
          sourceId={w.activeId}
          onClose={() => setModal(null)}
          onSaved={(s) => {
            w.synchronize(s);
            setNotice('已保存选中配置；发生文档角色或资料组变化的旧运行需重新核对。');
          }}
          onCheck={() => check()}
        />
      )}
      {runId && (
        <AgentRunDialog
          key={runId}
          runId={runId}
          minimized={reviewMinimized}
          onClose={() => setReviewMinimized(true)}
          onRestore={() => setReviewMinimized(false)}
          beforeAction={w.flush}
          onWorkspace={(s) => w.synchronize(s)}
          onRun={(id) => { setRunId(id); setReviewMinimized(false); }}
        />
      )}
      {modal === 'runs' && (
        <AgentHistoryDialog
          snapshot={snapshot}
          onClose={() => setModal(null)}
          onOpen={(id) => {
            setRunId(id);
            setReviewMinimized(false);
            setModal(null);
          }}
        />
      )}
      {modal === 'settings' && (
        <FloatingDialog
          title="当前能力与 Agent 接入"
          onClose={() => setModal(null)}
          footer={
            <button className="primary-button" onClick={() => setModal(null)}>
              继续整理文档
            </button>
          }
        >
          <div className="foundation-capabilities">
            <b>现在可用</b>
            <p>
              在本机整理自己的文档：Markdown 导入、三类文档角色、不可变版本、段落／列表增删、历史比较、工作版恢复与撤销、本地持久化。
            </p>
            <b>Agent 当前进度</b>
            <p>
              当前是待验收试用版，判断可能错误解释资料的适用范围。请查看来源改动和原文依据，核对后再确认修订。
              已支持选中确认、保存回读、保留／稍后处理、批次撤销与检查记录；最终业务验收仍在进行。
              版本差异只比较文本和结构，不代表 AI 判断已通过验收。
            </p>
            <b>你的文档准备好后</b>
            <p>
              直接导入业务
              Markdown，设置文档角色和资料组。旧版与新版可追加到同一逻辑文档；底本和历史快照按文档用途保持只读。
            </p>
            <b>模型 API 配置</b>
            <p>
              在本机 .env 中配置自己的模型 API key。检查仅读取显式选中资料及必需底本；密钥保留在后端，不发送到浏览器。
            </p>
          </div>
        </FloatingDialog>
      )}
    </div>
  );
}
