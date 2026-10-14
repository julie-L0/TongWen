import React, { useEffect, useRef, useState } from 'react';
import FloatingDialog from '../components/FloatingDialog';
import { requestId, type Snapshot } from '../api/client';
import { agentApi } from '../api/agent';
import type {
  AgentReport,
  ProposalEvidence,
  ProposalSummary,
  ReviewResult,
  RunStatus,
} from '../../shared/contracts/agent';
import type { Patch } from '../../shared/contracts/workspace';
import MarkdownRevision, { RevisionText, RevisionPreview } from './MarkdownRevision';
import AgentRoundTrace from './AgentRoundTrace';
import { LoaderCircle, CheckCircle2, AlertTriangle, ChevronUp } from 'lucide-react';
import { runProgress } from './run-progress';
import './review-window.css';
export default function AgentRunDialog({
  runId,
  onClose,
  onWorkspace,
  beforeAction,
  onRun,
  minimized = false,
  onRestore,
}: {
  runId: string;
  onClose: () => void;
  onWorkspace: (snapshot: Snapshot) => void;
  beforeAction: () => Promise<void>;
  onRun: (runId: string) => void;
  minimized?: boolean;
  onRestore: () => void;
}) {
  const [report, setReport] = useState<AgentReport | null>(null),
    [error, setError] = useState(''),
    [detail, setDetail] = useState<ProposalEvidence | null>(null);
  const [selected, setSelected] = useState<string[]>([]),
    [acting, setActing] = useState(false),
    [feedback, setFeedback] = useState(''),
    [decision, setDecision] = useState<{ p: ProposalSummary; action: 'retain' | 'defer' } | null>(null),
    [reason, setReason] = useState('');
  const [now, setNow] = useState(Date.now()), [lastContact, setLastContact] = useState(0), [pollError, setPollError] = useState('');
  const reportEpoch = useRef(0);
  const commandBusy = useRef(false);
  function reviewUpdate(result: ReviewResult) {
    reportEpoch.current++;
    onWorkspace(result.workspace);
    setReport(result.report);
  }
  async function command<T>(action: () => Promise<T>, onResult?: (result: T) => void | Promise<void>) {
    if (commandBusy.current) return null;
    commandBusy.current = true;
    setActing(true);
    reportEpoch.current++;
    setError('');
    setFeedback('');
    try {
      await beforeAction();
      const result = await action();
      if (onResult) await onResult(result);
      else setReport(await agentApi.report(runId));
      return result;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      commandBusy.current = false;
      setActing(false);
    }
  }
  useEffect(() => {
    setReport(null);
    setSelected([]);
    setError('');
    setDetail(null);
    setFeedback('');
    let closed = false, timer: ReturnType<typeof setTimeout>, controller: AbortController;
    const refresh = async () => {
      const epoch = reportEpoch.current;
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let interval = 3000;
      try {
        const r = await agentApi.report(runId, controller.signal);
        if (!closed && epoch === reportEpoch.current) { setReport(r); setLastContact(Date.now()); setPollError(''); }
        interval = ['queued', 'running'].includes(r.status) ? 1200 : 5000;
      } catch (e) {
        if (!closed) setPollError('暂时无法读取检查状态，正在重连；后台任务不会因此取消。');
      } finally {
        clearTimeout(timeout);
        if (!closed) timer = setTimeout(refresh, interval);
      }
    };
    refresh();
    return () => {
      closed = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [runId]);
  const proposalName = (p: ProposalSummary) =>
    report?.documents.find((d) => d.memberId === p.targetMemberId)?.displayName || p.title || '目标文档';
  async function openProposal(p: ProposalSummary) {
    setError('');
    try {
      setDetail(await agentApi.evidence(p.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取详情失败');
    }
  }
  const running = report && ['queued', 'running'].includes(report.status);
  const progress = runProgress(report);
  useEffect(() => {
    if (!progress.active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [progress.active]);
  const elapsed = Math.max(0, Math.floor((now - (report?.stats.startedAt || now)) / 1000));
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const Icon = pollError || ['warning', 'error'].includes(progress.tone) ? AlertTriangle : progress.active ? LoaderCircle : CheckCircle2;
  const count = report?.proposals.filter((p) => p.state !== 'withdrawn').length || 0;
  const readyCount = report?.proposals.filter((p) => p.applicable).length || 0;
  const draftCount = report?.proposals.filter((p) => ['pending', 'deferred'].includes(p.state)).length || 0;
  const readySelected = selected.filter((id) => report?.proposals.some((p) => p.id === id && p.applicable));
  const pendingSelected = selected.filter((id) => report?.proposals.some((p) => p.id === id &&
    ['pending', 'deferred'].includes(p.state) && !p.applicable));
  if (minimized) return (
    <button className={`review-dock ${progress.tone}`} onClick={onRestore} aria-label={'展开检查：' + progress.title}>
      <Icon size={18} className={progress.active && !pollError ? 'review-spinner' : ''} />
      <span><strong>{pollError ? '检查状态连接中断' : progress.title}</strong><small>{progress.active ? `后台继续 · ${clock}` : '点击查看结果与处理事项'}</small></span>
      <ChevronUp size={17} />
    </button>
  );
  return (
    <>
      <FloatingDialog
        title="修改检查"
        modal={false}
        className={`review-results ${!count ? 'review-compact' : ''}`}
        closeLabel="收起检查，后台继续运行"
        onClose={onClose}
        footer={
          <>
            <span>
              {acting
                ? '正在保存并回读…'
                : `已选 ${readySelected.length} 条可确认${pendingSelected.length ? ` · ${pendingSelected.length} 条待核验` : ''}`}
            </span>
            {report && (
              <button
                className="primary-button"
                disabled={
                  acting || !readySelected.length
                }
                onClick={async () => {
                  const ids = selected.filter((id) =>
                    report.proposals.some((p) => p.id === id && p.applicable),
                  );
                  const result = await command(() => agentApi.apply(runId, ids, requestId()), reviewUpdate);
                  if (result) {
                    setSelected((current) => current.filter((id) => !ids.includes(id)));
                    setFeedback(
                      `已确认 ${ids.length} 项，保存并回读 ${result.batch?.operations.length || 0} 份文档；${running ? '其余文档继续检查。' : '其余提案保留。'}`,
                    );
                  }
                }}
              >
                确认修改
              </button>
            )}
            {report && !running && ['failed', 'stale', 'budget_exhausted', 'interrupted', 'cancelled'].includes(report.status) && (
              <button
                className="quiet-button"
                disabled={acting}
                onClick={async () => {
                  await command(() => agentApi.retry(runId, requestId()), (result) => onRun(result.runId));
                }}
              >
                重新检查
              </button>
            )}
            <button className="quiet-button" onClick={onClose}>
              收起
            </button>
          </>
        }
      >
        {error && (
          <div role="alert" className="inline-error">
            {error}
          </div>
        )}
        {feedback && (
          <p role="status" className="scope-explanation">
            {feedback}
          </p>
        )}
        <section className={`review-progress ${progress.tone}`}>
          <div role="status" aria-live="polite">
          <div className="review-progress-title"><Icon size={20} className={progress.active && !pollError ? 'review-spinner' : ''} /><h3>{pollError ? '暂时无法读取状态' : progress.title}</h3></div>
          <p>{pollError || progress.detail}</p>
          </div>
          {progress.active && <div className="review-progress-meta"><span>{clock} 已用时</span><span>{readyCount ? `${readyCount} 条已完成检查，请核对后确认` : `${draftCount} 条草案，可先勾选待检查`}</span></div>}
          {running && <button
            key="stop-current-check"
            className="quiet-button review-stop-check"
            disabled={acting}
            onClick={() => agentApi.cancel(runId).then(setReport).catch((e) => setError(e.message))}
          >停止本次检查</button>}
          {progress.active && report?.coverage.expected > 0 && <progress aria-label="关联判断覆盖" value={report.coverage.judged} max={report.coverage.expected} />}
          {pollError && lastContact > 0 && <small>最近读取状态：{new Date(lastContact).toLocaleTimeString()}</small>}
        </section>
        {!report ? (
          <p className="review-context">检查在后台进行，可收起浮窗继续工作。</p>
        ) : (
          <>
            <p className="review-context">
              {report.documents.find((d) => d.isSource)?.displayName || report.source.title} →
              {' '}{report.documents.filter((d) => !d.isSource && d.role !== 'anchor').length} 份目标资料
            </p>
            {!report.inputValid && (
              <p role="alert" className="inline-error">
                资料已经变化，这些旧建议不能确认，请重新检查。
              </p>
            )}
            {!running && !report.proposals.filter((p) => p.state !== 'withdrawn').length && (
              <p>
                {report.status === 'no_changes'
                  ? report.stats.modelCalls > 0
                    ? '调查已完成，没有需要确认的同步修改。'
                    : '所选位置没有待比较的修改。'
                  : report.coverage.complete && report.status === 'awaiting_review'
                    ? '这次检查没有发现需要修改的条目。'
                    : report.status === 'needs_input' && report.coverage.complete && report.documentReview?.complete !== false
                      ? '本次检查已完成；请先处理下方冲突或待澄清事项，暂不提供可确认的修订。'
                    : '暂未生成可确认的修订条目；检查尚未完成或有问题需处理。'}
              </p>
            )}
            <div className="revision-list">
              {report.conflicts?.map((c, i) => (
                <article className="revision-entry" key={'constraint-' + i}>
                  <div className="revision-entry-heading">
                    <input type="checkbox" disabled aria-label="底本约束不可修改" />
                    <b>{report.documents.find((d) => d.memberId === c.memberId)?.displayName || c.title}</b>
                  </div>
                  <p className="revision-state">{c.section} · 只读约束，相关修订暂停</p>
                  <p>底本要求：</p>
                  <MarkdownRevision before={c.original} after={c.original} />
                  <p>本次来源修改：</p>
                  <MarkdownRevision before="" after={c.sourceAfter} />
                  <p>{c.reason}</p>
                </article>
              ))}
              {report.proposals
                .filter((p) => p.state !== 'withdrawn')
                .map((p) => (
                  <article className="revision-entry" key={p.id}>
                    <div className="revision-entry-heading">
                      <input
                        type="checkbox"
                        aria-label={'选择 ' + proposalName(p) + ' 的修订'}
                        disabled={acting || !report.inputValid || !['pending', 'deferred'].includes(p.state) || (!running && !p.applicable)}
                        checked={selected.includes(p.id) && ['pending', 'deferred'].includes(p.state)}
                        onChange={(e) =>
                          setSelected((ids) =>
                            e.target.checked ? [...ids, p.id] : ids.filter((id) => id !== p.id),
                          )
                        }
                      />
                      <button className="revision-entry-title" onClick={() => openProposal(p)}>
                        {proposalName(p)}
                        <span>查看详情</span>
                      </button>
                    </div>
                    <button
                      className="revision-diff-button"
                      aria-label={'查看 ' + proposalName(p) + ' 的差异详情'}
                      onClick={() => openProposal(p)}
                    >
                      {p.patches.map((patch, i) => (
                        <span className="revision-diff" key={i}>
                          <RevisionPreview before={beforeText(patch)} after={afterText(patch)} />
                        </span>
                      ))}
                    </button>
                    <div className="revision-actions">
                      <span className="revision-state">
                        {
                          {
                            pending: p.applicable ? '检查完成 · 待你核对' : running ? '草案 · 检查中，可先勾选' : '检查未完成，不可确认',
                            deferred: '稍后处理',
                            retained: '已保留差异',
                            needs_revalidation: '需重新检查',
                            applied: '已保存并回读',
                            withdrawn: '已撤回',
                          }[p.state]
                        }
                      </span>
                      {p.applicable && (
                        <>
                          <button
                            className="quiet-button"
                            disabled={acting}
                            onClick={() => {
                              setDecision({ p, action: 'retain' });
                              setReason('');
                            }}
                          >
                            保留差异
                          </button>
                          <button
                            className="quiet-button"
                            disabled={acting}
                            onClick={() => {
                              setDecision({ p, action: 'defer' });
                              setReason('');
                            }}
                          >
                            稍后处理
                          </button>
                        </>
                      )}
                      <details>
                        <summary>修改依据</summary>
                        <p>{p.reason}</p>
                      </details>
                    </div>
                  </article>
                ))}
            </div>
            {report.reviewBatches?.map((b) => (
              <div className="version-delta" key={b.id}>
                <b>{b.undoneAt ? '修订批次已撤销' : '已确认修订批次'}</b>
                <p>
                  {b.proposalIds.length} 项 · {b.operations.length} 份文档 ·{' '}
                  {new Date(b.createdAt).toLocaleString()}
                </p>
                {!b.undoneAt && (
                  <button
                    className="quiet-button"
                    disabled={acting}
                    onClick={async () => {
                      const result = await command(() => agentApi.undo(b.id, requestId()), reviewUpdate);
                      if (result) setFeedback('整批修订已恢复为新版本；来源修改保留，建议需重新检查。');
                    }}
                  >
                    撤销此批修订
                  </button>
                )}
              </div>
            ))}
            {report.decisions?.map((d) => (
              <div className="version-delta" key={d.id}>
                <b>
                  {d.action === 'retain' ? '保留差异' : '稍后处理'}
                  {d.revokedAt ? '（已撤销）' : ''}
                </b>
                <p>{d.reason || '未填写理由'}</p>
                {!d.revokedAt && (
                  <button
                    className="quiet-button"
                    disabled={acting}
                    onClick={async () => {
                      const result = await command(() => agentApi.revoke(d.id));
                      if (result) {
                        onWorkspace(result);
                        setFeedback('已撤销决定，原文未修改；请重新检查后恢复合法建议。');
                      }
                    }}
                  >
                    撤销此决定
                  </button>
                )}
              </div>
            ))}
            {report.unresolved.length > 0 && (
              <div className="required-anchors">
                <b>未解决事项</b>
                {report.unresolved.map((u, i) => (
                  <p key={i}>{u.reason}</p>
                ))}
              </div>
            )}
            <details className="revision-process">
              <summary>本次修改与检查过程</summary>
              {report.sourceEdits?.length ? (
                <details className="source-edit-details">
                  <summary>检查的修改 · {report.sourceEdits.length} 处</summary>
                  {report.sourceEdits.map((d, i) => (
                    <span className="revision-diff" key={i}><RevisionText before={d.before} after={d.after} compact /></span>
                  ))}
                </details>
              ) : null}
              <p className="scope-explanation">
                状态：
                {
                  (
                    {
                      queued: '等待运行',
                      running: '调查中',
                      awaiting_review: '等待审阅',
                      needs_input: '需要澄清',
                      no_changes: '无需同步',
                      budget_exhausted: '预算耗尽',
                      cancelled: '已取消',
                      interrupted: '已中断',
                      stale: '输入失效',
                      failed: '运行失败',
                    } as Record<RunStatus, string>
                  )[report.status]
                }{' '}
                · 模型请求 {report.stats.modelCalls} 次 · 工具 {report.stats.toolCalls} 次
              </p>
              <p className="scope-explanation">
                冻结范围：
                {report.documents
                  ?.map(
                    (d) =>
                      `${d.displayName}${d.isSource ? '（来源）' : d.role === 'anchor' ? '（必需底本）' : d.role === 'history' ? '（历史）' : ''}`,
                  )
                  .join('、')}
              </p>
              <p className="scope-explanation">
                已判定 {report.coverage.judged}/
                {report.coverage.expected || (report.coverage.missingDeltas.length ? '业务变化尚未形成' : 0)}
                ；未解释的来源变更 {report.coverage.missingDeltas.length}；待检查 {report.coverage.unchecked}
                。{report.inputValid ? '' : '资料已变化，旧提案不可执行。'}
              </p>
              <p>{report.stopReason || 'Agent 正在选择查询、读取与判断工具。'}</p>
              <AgentRoundTrace
                key={runId}
                rounds={report.rounds || []}
                identity={report.executionIdentity}
                loadFeedback={(callId) => agentApi.toolResult(runId, callId)}
              />
              {report.summary && (
                <details>
                  <summary>查看完整调查报告</summary>
                  <p>{report.summary}</p>
                </details>
              )}
              {report.changes.map((c) => (
                <div className="version-delta" key={c.id}>
                  <b>{c.businessObject}</b>
                  <p>{c.summary}</p>
                </div>
              ))}
            </details>
            {!report.coverage.complete && !running && (
              <p className="inline-error">检查尚未完成，不能据此认定其他目标无需修改。</p>
            )}
          </>
        )}
      </FloatingDialog>
      {detail && (
        <FloatingDialog
          title="修订详情"
          modal={false}
          className="review-detail"
          onClose={() => setDetail(null)}
          footer={
            <button className="primary-button" onClick={() => setDetail(null)}>
              返回修订列表
            </button>
          }
        >
          <p className="scope-explanation">
            {detail.target?.document.title} · {detail.target?.version.label || '工作版'} · 快照 V
            {detail.target?.version.seq}
          </p>
          <p>高亮位置是本条修订涉及的内容；删除线为原文，红字下划线为建议新增。</p>
          {detail.evidence
            .filter((e) => e.ref?.memberId === detail.target?.member.id && !e.ref?.baseline)
            .map((e) => (
              <section className="revision-detail-block" key={e.id}>
                <h3>{e.ref?.section || '相关原文'}</h3>
                <MarkdownRevision before={e.quote} after={patchedEvidence(e, detail)} />
                {detail.patches
                  .filter((p) => p.kind === 'insert_block' && p.afterBlockId === e.ref?.blockId)
                  .map((p, i) =>
                    p.kind === 'insert_block' ? (
                      <div key={i}>
                        <p>
                          <mark>在此位置之后新增</mark>
                        </p>
                        <MarkdownRevision before="" after={p.block.text} />
                      </div>
                    ) : null,
                  )}
              </section>
            ))}
          {detail.patches
            .filter((p) => p.kind === 'insert_block' && !p.afterBlockId)
            .map((p, i) =>
              p.kind === 'insert_block' ? (
                <section key={i}>
                  <h3>文档开头新增</h3>
                  <MarkdownRevision before="" after={p.block.text} />
                </section>
              ) : null,
            )}
          <details className="revision-process">
            <summary>查看来源与修改依据</summary>
            {detail.evidence
              .filter((e) => e.ref?.memberId !== detail.target?.member.id)
              .map((e) => (
                <section className="revision-detail-block" key={e.id}>
                  <h3>
                    {e.ref?.title} · {e.ref?.section}
                    {e.ref?.baseline ? ' · 修改前' : ' · 修改后/关联依据'}
                  </h3>
                  <pre>{markedEvidence(e, detail)}</pre>
                </section>
              ))}
          </details>
          <p>{detail.reason}</p>
        </FloatingDialog>
      )}
      {decision && (
        <FloatingDialog
          title={decision.action === 'retain' ? '明确保留这项差异' : '稍后处理这项差异'}
          modal={false}
          className="review-decision"
          onClose={() => !acting && setDecision(null)}
          footer={
            <>
              <button className="quiet-button" disabled={acting} onClick={() => setDecision(null)}>
                取消
              </button>
              <button
                className="primary-button"
                disabled={acting}
                onClick={async () => {
                  const result = await command(() =>
                    agentApi.decide(decision.p.differenceId, {
                      action: decision.action,
                      reason,
                    }),
                  );
                  if (result) {
                    setFeedback(
                      decision.action === 'retain'
                        ? '已记录保留；相关事实不变时不再重复纠正。'
                        : '已标记稍后处理，仍可确认。',
                    );
                    setSelected((ids) => ids.filter((id) => id !== decision.p.id));
                    setDecision(null);
                  }
                }}
              >
                {acting ? '保存中…' : '记录决定'}
              </button>
            </>
          }
        >
          <p>{decision.p.title}</p>
          <p>
            {decision.action === 'retain'
              ? '这是一项明确的保留决定；不修改正文。相关业务事实发生新变化时仍需调查。'
              : '暂不处理，不是永久拒绝；后续仍列为待处理。'}
          </p>
          <label>
            理由（选填）
            <textarea value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
          </label>
        </FloatingDialog>
      )}
    </>
  );
}
function beforeText(p: Patch): string {
  return p.kind === 'replace_text' ? p.before : p.kind === 'remove_block' ? p.expectedText : '';
}
function afterText(p: Patch): string {
  return p.kind === 'replace_text' ? p.after : p.kind === 'insert_block' ? p.block.text : '';
}
function markedEvidence(e: ProposalEvidence['evidence'][number], detail: ProposalEvidence) {
  const patch = detail.patches.find(
    (p) => p.kind !== 'insert_block' && p.blockId === e.ref?.blockId && beforeText(p),
  );
  const source = [...(detail.change?.before || []), ...(detail.change?.after || [])].find(
    (q) => q.evidenceId === e.id,
  );
  const quote = (patch && beforeText(patch)) || source?.quote,
    index = quote ? e.quote.indexOf(quote) : -1;
  return index < 0 ? (
    e.quote
  ) : (
    <>
      {e.quote.slice(0, index)}
      <mark>{quote}</mark>
      {e.quote.slice(index + quote.length)}
    </>
  );
}

function patchedEvidence(e: ProposalEvidence['evidence'][number], detail: ProposalEvidence) {
  let result = e.quote;
  for (const patch of detail.patches) {
    if (patch.kind === 'insert_block' || patch.blockId !== e.ref?.blockId) continue;
    if (patch.kind === 'remove_block') {
      if (result === patch.expectedText) result = '';
    } else if (result.split(patch.before).length === 2)
      result = result.replace(patch.before, () => patch.after);
  }
  return result;
}
