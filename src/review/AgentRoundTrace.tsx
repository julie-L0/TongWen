import React, { useState } from 'react';
import type { AgentRound, ExecutionIdentity } from '../../shared/contracts/agent';

const toolNames: Record<string, string> = {
  list_fragments: '查看目录',
  search_fragments: '搜索关联',
  read_context: '读取原文',
  describe_change: '解释变化',
  record_relation: '登记关系',
  record_finding: '登记判断',
  propose_patch: '准备修订',
  review_document: '复核文档',
  finish_task: '提交结论',
};
const roundStates = {
  requested: '等待模型返回',
  executing: '执行模型请求',
  completed: '本轮已结束',
  rejected: '响应未通过',
  stopped: '本轮已停止',
};

export default function AgentRoundTrace({
  rounds,
  identity,
  loadFeedback,
}: {
  rounds: AgentRound[];
  identity?: ExecutionIdentity;
  loadFeedback: (callId: string) => Promise<unknown>;
}) {
  const [feedback, setFeedback] = useState<Record<string, { loading?: boolean; result?: unknown; error?: string }>>({});
  return (
    <details className="agent-round-trace">
      <summary>查看逐轮调查记录（{rounds.length} 轮）</summary>
      <p>这里显示模型请求的动作和程序实际执行结果。结束一轮不代表业务检查通过。</p>
      {identity && (
        <p>
          策略包：{identity.packId} · 指纹 {identity.strategyFingerprint.slice(0, 12)}
        </p>
      )}
      {!rounds.length && <p>此任务尚未发起模型请求，或属于未记录逐轮摘要的旧任务。</p>}
      <ol>
        {rounds.map((r) => (
          <li key={r.round}>
            <details>
              <summary>
                第 {r.round} 轮 · {roundStates[r.status]}{r.status === 'requested' ? '' : ` · ${r.actions.length} 个动作已反馈`}
              </summary>
              <p>
                输入：{r.input.messageCount} 条消息，{r.input.characters.toLocaleString()} 个字符。
                {r.usage &&
                  ` 用量：输入 ${r.usage.input.toLocaleString()} / 输出 ${r.usage.output.toLocaleString()} token${r.usage.estimated ? '（估计）' : ''}。`}
              </p>
              {r.requestedActions?.map((request, i) => {
                const result = r.actions.find((a) => a.callId === request.callId);
                return (
                  <div key={`${request.callId}-${i}`} className="round-action">
                    <b>{toolNames[request.tool] || request.tool}</b>
                    <span>
                      {' '}
                      ·{' '}
                      {result
                        ? result.status === 'rejected'
                          ? '请求未通过校验，请查看执行反馈'
                          : result.status === 'reused'
                            ? '复用原结果，无新增执行'
                            : '执行成功'
                        : '未执行'}
                    </span>
                    {result && (
                      <p>
                        实际改变：证据 {result.effects.evidenceIds.length}，变化{' '}
                        {result.effects.changeIds.length}， 关系 {result.effects.relationIds.length}，判断{' '}
                        {result.effects.findingKeys.length}， 提案 {result.effects.proposalIds.length}，复核{' '}
                        {result.effects.reviewedMemberIds.length}。
                      </p>
                    )}
                    <details>
                      <summary>查看工具参数</summary>
                      <pre>{JSON.stringify(request.arguments, null, 2)}</pre>
                    </details>
                    {result && <>
                      <button className="quiet-button" disabled={feedback[request.callId]?.loading}
                        onClick={async () => {
                          setFeedback((state) => ({ ...state, [request.callId]: { loading: true } }));
                          try {
                            const actual = await loadFeedback(request.callId);
                            setFeedback((state) => ({ ...state, [request.callId]: { result: actual } }));
                          } catch (e) {
                            setFeedback((state) => ({ ...state, [request.callId]: { error: e instanceof Error ? e.message : '读取反馈失败，请重试。' } }));
                          }
                        }}>{feedback[request.callId]?.loading ? '正在读取反馈…' : '查看执行反馈'}</button>
                      {feedback[request.callId]?.error && <p role="alert">{feedback[request.callId].error}</p>}
                      {feedback[request.callId]?.result !== undefined && <pre>{JSON.stringify(feedback[request.callId].result, null, 2)}</pre>}
                    </>}
                  </div>
                );
              })}
              {r.outcome && (
                <p>
                  {r.outcome.missingDeltas > 0
                    ? `本轮后：还有 ${r.outcome.missingDeltas} 处来源变化待解释，目标判定和复核的完整待办尚无法计算。`
                    : `本轮后：待判定 ${r.outcome.unjudged}，待准备提案 ${r.outcome.outstanding}，待文档复核 ${r.outcome.documentReviewGaps}，未解决 ${r.outcome.unresolved}。`}
                  {r.outcome.stopReason}
                </p>
              )}
              {r.remaining && (
                <p>
                  剩余预算：模型 {r.remaining.modelCalls} 次，工具 {r.remaining.toolCalls} 次，输入{' '}
                  {r.remaining.inputTokens.toLocaleString()} token。
                </p>
              )}
            </details>
          </li>
        ))}
      </ol>
    </details>
  );
}
