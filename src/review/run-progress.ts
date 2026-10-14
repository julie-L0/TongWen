import type { AgentReport } from '../../shared/contracts/agent.ts';

export function runProgress(report: AgentReport | null) {
  if (!report) return { active: true, title: '读取检查状态', detail: '正在连接本地任务…', tone: 'running' };
  const count = report.proposals.filter((p) => p.state !== 'withdrawn').length;
  const readyCount = report.proposals.filter((p) => p.applicable).length;
  const hasInvalidated = report.proposals.some((p) => p.state === 'needs_revalidation');
  const savedDocuments = new Set(report.proposals.filter((p) => p.state === 'applied').map((p) => p.targetMemberId)).size;
  const savedDetail = savedDocuments ? `已保存并回读 ${savedDocuments} 份文档。` : '';
  const noProgress = report.stopCode === 'NO_PROGRESS' || report.stopReason.includes('没有新增调查状态');
  const investigationComplete = report.status === 'needs_input' && report.coverage.complete && report.documentReview?.complete !== false;
  const noProgressState = { title: '检查已停止 · 调查未推进', detail: savedDetail + `连续多轮没有形成新的判断，检查尚未完成。${readyCount ? `有 ${readyCount} 条建议已完成文档复核，可以先确认；其余未完成事项保留。` : '尚未核验的草案不能确认。'}请查看过程记录中的阻塞问题后重新检查。`, tone: 'warning' };
  const last = report.rounds?.at(-1);
  const focus = report.documents.find((d) => d.memberId === last?.input.focusMemberId)?.displayName;
  if (report.status === 'queued' || report.status === 'running') {
    const action = last?.status === 'requested' ? '等待模型返回' : last?.status === 'executing' ? '正在执行检查动作' : '正在核对关联内容';
    return { active: true, title: count ? `已找到 ${count} 条修订草案` : '正在检查修改',
      detail: report.inputValid ? `${focus ? focus + ' · ' : ''}${action}${readyCount ? `；${readyCount} 条建议已完成检查，请核对后确认，其余继续检查` : ''}` : '资料已变化，旧检查正在停止', tone: 'running' };
  }
  const states = {
    awaiting_review: hasInvalidated && !readyCount
      ? { title: '旧建议需要重新检查', detail: savedDetail + '旧建议不能直接确认。收起检查并选择目标资料后，按当前版本重新检查。', tone: 'warning' }
      : { title: count ? `${count} 条修订建议` : '检查完成，无需修订', detail: count ? '勾选需要修改的条目，再确认保存' : '本次检查未发现需要同步修改的内容', tone: 'success' },
    needs_input: { title: investigationComplete ? '检查完成 · 有冲突或待澄清' : '有事项需要确认', detail: '查看下方冲突或待澄清事项；核对来源与依据后再确认建议', tone: 'warning' },
    no_changes: report.stats.modelCalls > 0
      ? { title: '检查完成，无需修订', detail: '本次调查没有需要确认的同步修改；已保留的差异仍有效', tone: 'success' }
      : { title: '没有待检查的修改', detail: '所选位置与比较基线一致，未调用模型', tone: 'neutral' },
    budget_exhausted: noProgress
      ? noProgressState
      : { title: '检查已停止 · 预算用尽', detail: savedDetail + (readyCount ? `有 ${readyCount} 条建议已完成文档复核，可以先确认。其余未完成事项仍保留。` : '本次检查未完成；尚未核验的草案不能确认。请查看未完成事项后重新检查。'), tone: 'warning' },
    failed: noProgress
      ? noProgressState
      : { title: '检查失败', detail: report.stopReason.startsWith('MODEL_') ? '模型连接或响应失败。你的修改已保存，可以重试。' : '本次检查未完成；修改仍保留，请查看过程记录后重试。', tone: 'error' },
    stale: { title: '资料已变化', detail: '旧证据和建议已失效，请按当前资料重新检查。', tone: 'warning' },
    cancelled: { title: '本次检查已取消', detail: '已收到停止检查指令；可以重新检查，正文修改仍保留。', tone: 'neutral' },
    interrupted: { title: '检查已中断', detail: '服务中断前的记录已保留，请重新检查。', tone: 'warning' },
  };
  return { active: false, ...states[report.status] };
}
